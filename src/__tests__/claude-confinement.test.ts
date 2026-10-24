import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotToolDecision } from "../agents/claude.js";

describe("Claude snapshot confinement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-snapshot-"));
  fs.mkdirSync(path.join(root, "src"));
  const allowed = (tool: string, input: Record<string, unknown>) =>
    snapshotToolDecision(root, tool, input).behavior === "allow";

  it("allows reads, globs and greps inside the snapshot", () => {
    expect(allowed("Read", { file_path: path.join(root, "src/app.ts") })).toBe(true);
    expect(allowed("Read", { file_path: "src/app.ts" })).toBe(true);
    expect(allowed("Glob", { pattern: "**/*.tsx" })).toBe(true);
    expect(allowed("Grep", { pattern: "track\\(", path: "src", glob: "*.ts" })).toBe(true);
  });

  it("refuses every way out of the snapshot", () => {
    expect(allowed("Read", { file_path: path.join(os.homedir(), ".ssh/id_ed25519") })).toBe(false);
    expect(allowed("Read", { file_path: "../outside/.env" })).toBe(false);
    expect(allowed("Read", {})).toBe(false);
    expect(allowed("Glob", { pattern: `${os.homedir()}/.aws/*` })).toBe(false);
    expect(allowed("Glob", { pattern: "../**/*.env" })).toBe(false);
    expect(allowed("Glob", { pattern: "{..,x}/*" })).toBe(false);
    expect(allowed("Glob", { pattern: "{/etc,src}/*" })).toBe(false);
    expect(allowed("Glob", { pattern: "src/{app,lib}/**/*.ts" })).toBe(true);
    expect(allowed("Glob", { pattern: "~/.ssh/*" })).toBe(false);
    expect(allowed("Grep", { pattern: "KEY", path: "/etc" })).toBe(false);
    expect(allowed("Grep", { pattern: "KEY", glob: "../../**/*" })).toBe(false);
    expect(allowed("Bash", { command: "cat ~/.ssh/id_ed25519" })).toBe(false);
  });
});
