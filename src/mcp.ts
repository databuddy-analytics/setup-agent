import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AgentBackend, findAgentExecutable } from "./model.js";

export const DATABUDDY_MCP_URL = "https://api.databuddy.cc/v1/mcp";
const SERVER_NAME = "databuddy";

type Runner = (file: string, args: string[]) => Promise<unknown>;
const run: Runner = (file, args) => promisify(execFile)(file, args, { timeout: 15_000 });

interface McpInstallResult {
  agent: AgentBackend;
  status: "added" | "exists";
  next: string;
}

/**
 * Register Databuddy's hosted MCP server with the user's own agent so the same
 * session can keep querying analytics and creating funnels, goals and flags.
 * Uses each CLI's own `mcp add`, never edits its config files, and leaves an
 * existing `databuddy` entry (for example a local development server) alone.
 */
export async function installDatabuddyMcp(
  agent: AgentBackend,
  options: { env?: NodeJS.ProcessEnv; runner?: Runner } = {},
): Promise<McpInstallResult> {
  const executable = findAgentExecutable(agent, options.env);
  if (!executable)
    throw new Error(`No ${agent} executable on PATH to add the Databuddy MCP server to.`);
  const runner = options.runner ?? run;
  const next =
    agent === "codex"
      ? `Run \`codex mcp login ${SERVER_NAME}\` to sign in to Databuddy.`
      : "Open Claude Code and run /mcp to sign in to Databuddy.";
  try {
    await runner(executable, ["mcp", "get", SERVER_NAME]);
    return {
      agent,
      status: "exists",
      next: `A "${SERVER_NAME}" MCP server is already configured; it was left unchanged.`,
    };
  } catch {
    // Not configured yet.
  }
  try {
    await runner(
      executable,
      agent === "codex"
        ? ["mcp", "add", SERVER_NAME, "--url", DATABUDDY_MCP_URL]
        : ["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, DATABUDDY_MCP_URL],
    );
  } catch (error) {
    // `codex mcp add` saves the server, then waits for an interactive OAuth
    // login; the timeout ends that wait, so confirm the entry was written.
    try {
      await runner(executable, ["mcp", "get", SERVER_NAME]);
    } catch {
      throw error;
    }
  }
  return { agent, status: "added", next };
}
