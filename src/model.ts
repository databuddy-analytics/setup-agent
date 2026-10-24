import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const AGENTS = ["codex", "claude"] as const;
export type AgentBackend = (typeof AGENTS)[number];

export const MODEL_AUTH = ["local", "api-key"] as const;
export type ModelAuth = (typeof MODEL_AUTH)[number];

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const DEFAULT_MODELS: Record<AgentBackend, string> = {
  codex: "gpt-6-sol",
  claude: "claude-opus-5-5",
};

const API_KEY_ENV: Record<AgentBackend, string> = {
  codex: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
};

// Any of these in a local-login run would silently switch the agent to API
// billing or another endpoint.
const AMBIENT_API_ROUTES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
];

interface AgentSelection {
  agent: AgentBackend;
  model?: string;
  thinkingLevel: ThinkingLevel;
  auth: ModelAuth;
}

/** Non-secret agent configuration; it is part of every checkpoint fingerprint. */
export function agentConfig(selection: AgentSelection): Record<string, unknown> {
  return {
    model: selection.model ?? DEFAULT_MODELS[selection.agent],
    // Same dial, different name per harness: claude reads thinkingLevel,
    // codex reads reasoningEffort.
    thinkingLevel: selection.thinkingLevel,
    reasoningEffort: selection.thinkingLevel,
    modelAuth: selection.auth,
  };
}

const INSTALL_HINTS: Record<AgentBackend, string> = {
  codex: "Install the Codex CLI (npm install -g @openai/codex) and run `codex login`",
  claude:
    "Install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in with `claude`",
};

/**
 * The agent SDKs drive the user's installed CLI instead of shipping their own
 * platform binaries, which keeps the package a few megabytes instead of ~500.
 */
export function findAgentExecutable(
  agent: AgentBackend,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = agent === "claude" ? env.CLAUDE_CODE_EXECUTABLE : env.CODEX_EXECUTABLE;
  if (override) return existsSync(override) ? override : undefined;
  const names = process.platform === "win32" ? [`${agent}.exe`, `${agent}.cmd`] : [agent];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Fail before any model call when the selected backend or credential route cannot work. */
export function assertAgentCredential(
  selection: Pick<AgentSelection, "agent" | "auth">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { agent, auth } = selection;
  if (!findAgentExecutable(agent, env)) {
    throw new Error(`No ${agent} executable on PATH. ${INSTALL_HINTS[agent]}.`);
  }
  if (auth === "api-key") {
    if (env[API_KEY_ENV[agent]]) return;
    throw new Error(`--model-auth api-key with --agent ${agent} requires ${API_KEY_ENV[agent]}.`);
  }
  const ambient = AMBIENT_API_ROUTES.filter((name) => env[name]);
  if (ambient.length) {
    throw new Error(
      `Local model authentication conflicts with ${ambient.join(", ")}. Unset them for this run, or pass --model-auth api-key to use API billing.`,
    );
  }
  if (agent === "codex") {
    const codexHome = env.CODEX_HOME || path.join(homedir(), ".codex");
    if (existsSync(path.join(codexHome, "auth.json"))) return;
    throw new Error("No Codex login found. Run `codex login`, or pass --model-auth api-key.");
  }
  // Claude Code keeps its login in the OS keychain, so the executable is the
  // only local signal; a signed-out CLI fails clearly on the first call.
}
