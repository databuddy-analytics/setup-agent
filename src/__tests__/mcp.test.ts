import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATABUDDY_MCP_URL, installDatabuddyMcp } from "../mcp.js";

function pathWith(binary: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-mcp-bin-"));
  fs.writeFileSync(path.join(dir, binary), "");
  return dir;
}

describe("Databuddy MCP install", () => {
  it("adds the hosted server once and never replaces an existing databuddy entry", async () => {
    const configured = new Map<string, string[]>();
    const runner = async (_file: string, args: string[]) => {
      if (args[1] === "get") {
        if (!configured.has(args[2])) throw new Error("not found");
        return;
      }
      configured.set("databuddy", args);
    };
    const env = { PATH: pathWith("claude") };

    const first = await installDatabuddyMcp("claude", { env, runner });
    expect(first.status).toBe("added");
    expect(configured.get("databuddy")).toContain(DATABUDDY_MCP_URL);
    expect(configured.get("databuddy")).toContain("user");

    configured.set("databuddy", ["mcp", "add", "databuddy", "http://localhost:3001/v1/mcp"]);
    const second = await installDatabuddyMcp("claude", { env, runner });
    expect(second.status).toBe("exists");
    expect(configured.get("databuddy")).toContain("http://localhost:3001/v1/mcp");
  });

  it("treats a codex add that saved the server before its login wait timed out as added", async () => {
    const configured = new Set<string>();
    const runner = async (_file: string, args: string[]) => {
      if (args[1] === "get") {
        if (!configured.has(args[2])) throw new Error("not found");
        return;
      }
      configured.add(args[2]);
      throw new Error("Command failed: timed out waiting for OAuth login");
    };
    const result = await installDatabuddyMcp("codex", { env: { PATH: pathWith("codex") }, runner });
    expect(result.status).toBe("added");
    expect(result.next).toContain("codex mcp login databuddy");
  });

  it("fails clearly when the agent CLI is missing", async () => {
    await expect(installDatabuddyMcp("codex", { env: { PATH: "" } })).rejects.toThrow(
      "No codex executable",
    );
  });
});
