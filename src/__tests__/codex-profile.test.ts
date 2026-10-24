import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCodexVersion,
  codexInstallPaths,
  snapshotPermissionProfile,
} from "../agents/codex.js";

function install(...segments: string[]): { home: string; binary: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-home-")));
  const binary = path.join(home, ...segments);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "");
  return { home, binary };
}

describe("Codex permission profile", () => {
  it("grants a Codex package root but never the home directory or another app's data", () => {
    const packaged = install("Caskroom", "codex", "0.163.0", "bin", "codex");
    expect(codexInstallPaths(packaged.binary, packaged.home)).toContain(
      path.join(packaged.home, "Caskroom", "codex", "0.163.0"),
    );
    const homeBin = install("bin", "codex");
    expect(codexInstallPaths(homeBin.binary, homeBin.home)).toEqual([
      path.join(homeBin.home, "bin"),
    ]);
    const otherApp = install(".local", "share", "keyring-app", "bin", "codex");
    expect(codexInstallPaths(otherApp.binary, otherApp.home)).toEqual([
      path.join(otherApp.home, ".local", "share", "keyring-app", "bin"),
    ]);
  });

  it("denies the root and temp directories, turns off login shells and snapshots, and keeps the workspace readable", () => {
    const profile = snapshotPermissionProfile();
    for (const line of [
      '":root" = "deny"',
      '":slash_tmp" = "deny"',
      '":tmpdir" = "deny"',
      '"." = "read"',
      "enabled = false",
      "allow_login_shell = false",
      "shell_snapshot = false",
      "project_doc_max_bytes = 0",
    ])
      expect(profile).toContain(line);
  });

  it("refuses a Codex older than the verified release, or one whose version it cannot read", () => {
    const version = (output: string) => () => output;
    expect(() => assertCodexVersion("/old/codex", version("codex-cli 0.150.2"))).toThrow(
      "older than 0.163.0",
    );
    expect(() => assertCodexVersion("/odd/codex", version("codex"))).toThrow("unknown version");
    expect(() => assertCodexVersion("/new/codex", version("codex-cli 0.163.0"))).not.toThrow();
    expect(() => assertCodexVersion("/next/codex", version("codex-cli 1.2.0"))).not.toThrow();
  });
});
