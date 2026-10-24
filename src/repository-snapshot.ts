import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeReferenceSnapshot } from "./databuddy-reference.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
  ".astro",
  ".php",
  ".liquid",
  ".hbs",
  ".njk",
  ".yaml",
  ".yml",
  ".toml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  "vendor",
  "generated",
  "__tests__",
  "test",
  "tests",
  "fixtures",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "yarn.lock",
]);

export function isSourcePath(relative: string): boolean {
  const segments = relative.split("/");
  return (
    Boolean(relative) &&
    !segments.some((segment) => segment.startsWith(".") || EXCLUDED_DIRECTORIES.has(segment)) &&
    SOURCE_EXTENSIONS.has(path.extname(relative)) &&
    !relative.endsWith(".d.ts") &&
    // Lockfiles are generated, often huge, and rewritten by the SDK installer.
    !LOCKFILES.has(path.basename(relative)) &&
    !/(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|api[-_]?keys?|private[-_]?keys?|service[-_]?accounts?)(?:[._-]|$)/i.test(
      path.basename(relative),
    ) &&
    !/^keys?\./i.test(path.basename(relative)) &&
    // Tests often hold realistic fixtures and are not instrumentation targets.
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)
  );
}

export function sourceFiles(repository: string, gitDir: string): string[] {
  // A temporary index honors .gitignore even for directories without a Git checkout.
  const inventory = execFileSync(
    "git",
    [
      "--git-dir",
      gitDir,
      "--work-tree",
      repository,
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
  );
  return inventory
    .split("\0")
    .filter((relative) => {
      if (!isSourcePath(relative)) return false;
      let absolute = repository;
      for (const segment of relative.split("/")) {
        absolute = path.join(absolute, segment);
        if (fs.lstatSync(absolute).isSymbolicLink()) return false;
      }
      return fs.statSync(absolute).isFile();
    })
    .sort();
}

export function readSource(repository: string, files: string[]): Map<string, string> {
  const contents = new Map<string, string>();
  let totalBytes = 0;
  for (const relative of files) {
    const absolute = path.join(repository, relative);
    const size = fs.statSync(absolute).size;
    if (size > 1024 * 1024 || totalBytes + size > 10 * 1024 * 1024) {
      throw new Error("Repository exceeds the setup snapshot limit (1 MiB per file, 10 MiB total)");
    }
    const source = fs.readFileSync(absolute, "utf8");
    if (source.includes("\0")) continue;
    // Cloud service-account keys are JSON with any file name.
    if (/"type"\s*:\s*"service_account"/.test(source)) continue;
    totalBytes += size;
    contents.set(relative, source);
  }
  return contents;
}

export function writeSnapshot(
  snapshot: string,
  contents: Map<string, string>,
  redact: (value: string) => string,
): void {
  fs.rmSync(snapshot, { recursive: true, force: true });
  fs.mkdirSync(snapshot, { mode: 0o700 });
  for (const [file, source] of contents) {
    const target = path.join(snapshot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, redact(source), { mode: 0o400 });
  }
  writeReferenceSnapshot(snapshot);
}

// Reject absolute, parent-relative, empty-segment, backslash and null-byte
// paths before they are joined to a repository root.
export function assertSafeFilePath(filePath: string): void {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("Invalid filePath: must be a non-empty string");
  }
  if (filePath.includes("\0")) throw new Error("Invalid filePath: contains null byte");
  if (filePath.includes("\\")) throw new Error("Invalid filePath: contains backslash");
  if (path.isAbsolute(filePath)) throw new Error("Invalid filePath: must not be absolute");
  for (const part of filePath.split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw new Error(`Invalid filePath: contains "${part}" segment`);
    }
  }
}

/**
 * Keep `.databuddy/` (prompts, responses, plans) out of commits by listing it
 * in the repository's local, uncommitted `.git/info/exclude`. Repositories
 * without Git, or where Git cannot be asked, are left alone.
 */
export function excludeStateDirFromGit(repository: string): void {
  let exclude: string;
  try {
    exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
  const file = path.resolve(repository, exclude);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).some((line) => line.trim() === ".databuddy/")) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}.databuddy/\n`);
}

/**
 * Write exactly what a model task would receive, without any model call, so
 * a user can audit it first: the filtered, redacted files, plus which ones the
 * redaction changed.
 */
export function exportSnapshot(
  repository: string,
  files: string[],
  out: string,
  redact: (value: string) => string,
): { files: number; redactedFiles: string[] } {
  if (fs.existsSync(out) && fs.readdirSync(out).length)
    throw new Error(`${out} is not empty; choose a new or empty directory`);
  const contents = readSource(repository, files);
  const redactedFiles: string[] = [];
  for (const [file, source] of contents) {
    const target = path.join(out, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const redacted = redact(source);
    if (redacted !== source) redactedFiles.push(file);
    fs.writeFileSync(target, redacted, { mode: 0o600 });
  }
  return { files: contents.size, redactedFiles };
}
