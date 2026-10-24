import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATABUDDY_MCP_URL, installDatabuddyMcp, planMcpInstall } from "../mcp.js";

function pathWith(binary: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-mcp-bin-"));
  fs.writeFileSync(path.join(dir, binary), "");
  return dir;
}

describe("Databuddy MCP install", () => {
  it("writes Claude's project config by default and says so before running", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-mcp-repo-"));
    const plan = planMcpInstall("claude", { repository, env: { PATH: pathWith("claude") } });
    expect(plan.args).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "project",
      "databuddy",
      DATABUDDY_MCP_URL,
    ]);
    expect(plan.cwd).toBe(path.resolve(repository));
    expect(plan.writes).toContain(".mcp.json");
    const user = planMcpInstall("claude", {
      repository,
      scope: "user",
      env: { PATH: pathWith("claude") },
    });
    expect(user.writes).toContain("user-level");
  });

  it("names Codex's user-level config and refuses a project scope it cannot honour", () => {
    const env = { PATH: pathWith("codex") };
    expect(planMcpInstall("codex", { repository: ".", env }).writes).toContain("~/.codex");
    expect(() => planMcpInstall("codex", { repository: ".", scope: "project", env })).toThrow(
      "no project-level",
    );
  });

  it("never replaces an existing databuddy entry", async () => {
    const plan = planMcpInstall("claude", { repository: ".", env: { PATH: pathWith("claude") } });
    const calls: string[][] = [];
    const result = await installDatabuddyMcp(plan, {
      runner: async (_file, args) => {
        calls.push(args);
      },
    });
    expect(result.status).toBe("exists");
    expect(calls).toEqual([["mcp", "get", "databuddy"]]);
  });

  it("treats a codex add that saved the server before its login wait timed out as added", async () => {
    const plan = planMcpInstall("codex", { repository: ".", env: { PATH: pathWith("codex") } });
    const configured = new Set<string>();
    const result = await installDatabuddyMcp(plan, {
      runner: async (_file, args) => {
        if (args[1] === "get") {
          if (!configured.has(args[2])) throw new Error("not found");
          return;
        }
        configured.add(args[2]);
        throw new Error("Command failed: timed out waiting for OAuth login");
      },
    });
    expect(result.status).toBe("added");
    expect(result.next).toContain("codex mcp login databuddy");
  });
});
