import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotPermissionProfile } from "../src/agents/codex.js";
import { findAgentExecutable } from "../src/model.js";
import { makeWorkDir } from "../src/workdir.js";

// Opt in through test:live; this runs the installed codex sandbox, without model calls.
describe.skipIf(process.env.LIVE_AGENT !== "1")("Codex snapshot confinement", () => {
  it("lets sandboxed commands read the workspace and nothing else", () => {
    const codex = findAgentExecutable("codex");
    if (!codex) throw new Error("codex is not on PATH");
    // The same private layout the agent uses: homes and workspaces in the work root.
    const home = makeWorkDir("codex-home-");
    fs.writeFileSync(path.join(home, "config.toml"), snapshotPermissionProfile(codex));
    const workspace = makeWorkDir("databuddy-workspace-");
    fs.writeFileSync(path.join(workspace, "inside.txt"), "inside");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-outside-"));
    fs.writeFileSync(path.join(outside, "canary.txt"), "canary");
    const read = (file: string) =>
      spawnSync(codex, ["sandbox", "--", "cat", file], {
        cwd: workspace,
        env: { ...process.env, CODEX_HOME: home },
        encoding: "utf8",
      });
    expect(read("inside.txt").stdout).toBe("inside");
    // /tmp is outside $TMPDIR on macOS and was readable before the profile denied it.
    const slashTmp = path.join("/tmp", `databuddy-canary-${process.pid}.txt`);
    fs.writeFileSync(slashTmp, "canary");
    try {
      for (const file of [path.join(outside, "canary.txt"), slashTmp]) {
        const result = read(file);
        expect(result.stdout, file).not.toContain("canary");
        expect(result.stderr, file).toContain("Operation not permitted");
      }
    } finally {
      fs.rmSync(slashTmp, { force: true });
    }
  });
});
