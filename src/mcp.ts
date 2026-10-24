import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { type AgentBackend, findAgentExecutable } from "./model.js";

export const DATABUDDY_MCP_URL = "https://api.databuddy.cc/v1/mcp";
const SERVER_NAME = "databuddy";

export type McpScope = "project" | "user";
type Runner = (file: string, args: string[], cwd: string) => Promise<unknown>;
const run: Runner = (file, args, cwd) => promisify(execFile)(file, args, { cwd, timeout: 15_000 });

interface McpPlan {
  agent: AgentBackend;
  executable: string;
  args: string[];
  cwd: string;
  /** What the change writes, shown to the user before it runs. */
  writes: string;
  next: string;
}

/**
 * Describe the change before anything runs. Claude defaults to the
 * repository's own `.mcp.json`; Codex has only a user-level config, so it
 * always says so.
 */
export function planMcpInstall(
  agent: AgentBackend,
  options: { repository: string; scope?: McpScope; env?: NodeJS.ProcessEnv },
): McpPlan {
  const executable = findAgentExecutable(agent, options.env);
  if (!executable)
    throw new Error(`No ${agent} executable on PATH to add the Databuddy MCP server to.`);
  const cwd = path.resolve(options.repository);
  if (agent === "codex") {
    if (options.scope === "project")
      throw new Error("Codex has no project-level MCP config; use --scope user for Codex.");
    return {
      agent,
      executable,
      args: ["mcp", "add", SERVER_NAME, "--url", DATABUDDY_MCP_URL],
      cwd,
      writes: "your user-level Codex config (~/.codex/config.toml)",
      next: `Run \`codex mcp login ${SERVER_NAME}\` to sign in to Databuddy.`,
    };
  }
  const scope = options.scope ?? "project";
  return {
    agent,
    executable,
    args: ["mcp", "add", "--transport", "http", "--scope", scope, SERVER_NAME, DATABUDDY_MCP_URL],
    cwd,
    writes:
      scope === "project"
        ? `${path.join(cwd, ".mcp.json")} (this repository only)`
        : "your user-level Claude Code config (every project)",
    next: "Open Claude Code in this repository and run /mcp to sign in to Databuddy.",
  };
}

/**
 * Run a planned change with the agent CLI's own `mcp add`. An existing
 * `databuddy` entry, such as a local development server, is left alone.
 */
export async function installDatabuddyMcp(
  plan: McpPlan,
  options: { runner?: Runner } = {},
): Promise<{ status: "added" | "exists"; next: string }> {
  const runner = options.runner ?? run;
  const get = () => runner(plan.executable, ["mcp", "get", SERVER_NAME], plan.cwd);
  try {
    await get();
    return {
      status: "exists",
      next: `A "${SERVER_NAME}" MCP server is already configured; it was left unchanged.`,
    };
  } catch {
    // Not configured yet.
  }
  try {
    await runner(plan.executable, plan.args, plan.cwd);
  } catch (error) {
    // `codex mcp add` saves the server, then waits for an interactive OAuth
    // login; the timeout ends that wait, so confirm the entry was written.
    try {
      await get();
    } catch {
      throw error;
    }
  }
  return { status: "added", next: plan.next };
}
