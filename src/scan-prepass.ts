import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabuddyScanSummary } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface ScanRow {
  path: string;
  start: number;
  end: number;
  coverage: "missing" | "partial" | "covered" | "operational" | "uncertain";
  category: string;
  priority: number;
  action?: { label: string; sites?: { path: string; start: number; end: number }[] };
  suggestedEvent?: { name: string; properties: string[] };
}

interface ScanOutput {
  summary: { includedFiles?: number; skippedFiles?: number; warnings?: string[] };
  rows: ScanRow[];
}

export interface ScanPrepass {
  summary: DatabuddyScanSummary;
  rows: ScanRow[];
  actionMap: string;
  snapshotJson: string;
}

export type ScanRunner = (scope: string) => Promise<string>;

function resolveScanCommand(explicit?: string): { file: string; args: string[] } {
  const bin = explicit ?? process.env.DATABUDDY_SCAN_BIN;
  if (bin) {
    if (!fs.existsSync(bin)) throw new Error(`Scan binary not found: ${bin}`);
    return bin.endsWith(".js") || bin.endsWith(".mjs")
      ? { file: process.execPath, args: [bin] }
      : { file: bin, args: [] };
  }
  // The scanner is an exact-pinned dependency installed with this package, so
  // a run never downloads or executes an unpinned package.
  const manifest = createRequire(import.meta.url).resolve("@databuddy/scan/package.json");
  const { bin: scanBin } = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
    bin: Record<string, string>;
  };
  return {
    file: process.execPath,
    args: [path.join(path.dirname(manifest), scanBin["databuddy-scan"])],
  };
}

/**
 * Write the redacted snapshot the scanner reads. @databuddy/scan only reads
 * files Git tracks, so the copy is a fresh repository with everything staged,
 * built without hooks or the user's global ignore file.
 */
export function prepareScanRoot(
  root: string,
  contents: Map<string, string>,
  redact: (value: string) => string,
): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [file, source] of contents) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, redact(source), { mode: 0o600 });
  }
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "core.excludesFile=", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      stdio: "ignore",
    });
  git(["init", "--quiet", "--template="]);
  git(["add", "--all", "--force", "--", "."]);
  return root;
}

// The scanner needs only these; credentials and tokens in the user's shell
// never reach it. AI_GATEWAY_API_KEY sends the scan to the user's own gateway.
const SCAN_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CACHE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "AI_GATEWAY_API_KEY",
];

export function createScanRunner(options: {
  /** The redacted snapshot to scan, never the repository itself. */
  root: string;
  bin?: string;
  timeoutMs?: number;
}): ScanRunner {
  const command = resolveScanCommand(options.bin);
  const env: Record<string, string> = { CI: "1" };
  for (const name of SCAN_ENV) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return async (scope: string) => {
    const target = scope ? path.join(options.root, scope) : options.root;
    const { stdout } = await execFileAsync(command.file, [...command.args, target, "--json"], {
      cwd: options.root,
      timeout: options.timeoutMs ?? 180_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    return stdout;
  };
}

export function parseScanOutput(stdout: string): ScanOutput {
  const start = stdout.indexOf("{");
  const parsed = JSON.parse(stdout.slice(start)) as Partial<ScanOutput> & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  if (!Array.isArray(parsed.rows)) throw new Error("Scan output has no rows");
  return { summary: parsed.summary ?? {}, rows: parsed.rows as ScanRow[] };
}

function count(rows: ScanRow[], pick: (row: ScanRow) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[pick(row)] = (out[pick(row)] ?? 0) + 1;
  return out;
}

const PROMPT_MAP_LIMIT = 36_000;

function describeRow(row: ScanRow): string {
  const suggestion = row.suggestedEvent?.name ? ` -> suggest ${row.suggestedEvent.name}` : "";
  const label = row.action?.label ? ` ${row.action.label}` : "";
  return `- ${row.path}:${row.start} [${row.coverage}/${row.category} p${row.priority.toFixed(2)}]${label}${suggestion}`;
}

export function renderActionMap(rows: ScanRow[], snapshotPath: string): string {
  const ranked = [...rows].sort((a, b) => b.priority - a.priority);
  const gaps = ranked.filter((row) => row.coverage === "missing" || row.coverage === "partial");
  const covered = ranked.filter((row) => row.coverage === "covered");
  const operational = ranked.filter((row) => row.coverage === "operational");
  const header = `Action map from @databuddy/scan (${rows.length} user actions: ${gaps.length} missing or partial, ${covered.length} covered, ${operational.length} operational). Each line is path:line [coverage/category priority] handler -> suggested event name. The scan is a deterministic parse of handlers, form actions, DOM listeners and route handlers; it does not see every surface (template files, server jobs), so treat it as a starting map, verify each line in source, and look beyond it. Full rows with call sites: ${snapshotPath}.`;
  const lines: string[] = [header, "Missing or partial tracking, highest priority first:"];
  let size = lines.join("\n").length;
  for (const row of gaps) {
    const line = describeRow(row);
    if (size + line.length > PROMPT_MAP_LIMIT) {
      lines.push(`- ... ${gaps.length - lines.length + 2} more in the full rows`);
      break;
    }
    lines.push(line);
    size += line.length;
  }
  if (covered.length) {
    lines.push("Already tracked:");
    for (const row of covered) {
      const line = `- ${row.path}:${row.start} ${row.action?.label ?? ""}`;
      if (size + line.length > PROMPT_MAP_LIMIT) {
        lines.push(`- ... ${covered.length} covered actions in the full rows`);
        break;
      }
      lines.push(line);
      size += line.length;
    }
  }
  return lines.join("\n");
}

export const SCAN_SNAPSHOT_FILE = ".databuddy-scan/actions.json";

export async function runScanPrepass(options: {
  scopes: string[];
  runner: ScanRunner;
  mode: "on" | "off";
}): Promise<ScanPrepass> {
  if (options.mode === "off")
    return { summary: { status: "off" }, rows: [], actionMap: "", snapshotJson: "" };
  const targets = options.scopes.length ? options.scopes : [""];
  const rows: ScanRow[] = [];
  let includedFiles = 0;
  const warnings: string[] = [];
  try {
    for (const scope of targets) {
      const output = parseScanOutput(await options.runner(scope));
      includedFiles += output.summary.includedFiles ?? 0;
      warnings.push(...(output.summary.warnings ?? []));
      rows.push(...output.rows);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      summary: { status: "unavailable", detail: detail.slice(0, 2_000) },
      rows: [],
      actionMap: "",
      snapshotJson: "",
    };
  }
  const deduped = [...new Map(rows.map((row) => [`${row.path}:${row.start}`, row])).values()];
  return {
    summary: {
      status: "complete",
      includedFiles,
      actions: deduped.length,
      coverage: count(deduped, (row) => row.coverage),
      categories: count(deduped, (row) => row.category),
      ...(warnings.length ? { detail: [...new Set(warnings)].join(" ").slice(0, 2_000) } : {}),
    },
    rows: deduped,
    actionMap: renderActionMap(deduped, SCAN_SNAPSHOT_FILE),
    snapshotJson: JSON.stringify(deduped, null, 1),
  };
}
