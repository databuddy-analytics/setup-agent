// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { query, type SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { findAgentExecutable } from "../model.js";
import type { BatchMeta, SetupTaskParams } from "./types.js";

/**
 * Variables the Claude Code CLI / spawned shell legitimately needs.
 * Same defense as the codex allowlist: prompt-injection via repository
 * content cannot ask the agent to `cat /proc/self/environ` and read
 * GITHUB_TOKEN, AWS_*, etc. when none of those reach the spawn env.
 *
 * The Claude SDK's `query()` accepts an `env` option that REPLACES
 * process.env in the spawned `claude` child. We construct a minimal
 * environment from this allowlist plus the credentials Claude actually
 * needs to authenticate.
 */
const CLAUDE_ENV_ALLOWLIST = new Set<string>([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NPM_CONFIG_USERCONFIG",
  "DEBUG_CLAUDE_AGENT_SDK",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_DEBUG_LOGS_DIR",
]);

/**
 * Wrap the spawned `claude` CLI in the OS sandbox (Seatbelt on macOS,
 * bubblewrap on Linux) as defense in depth on top of the read-only tool
 * allowlist, and degrade instead of failing when it is unavailable.
 */
function buildSandbox(): SandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    failIfUnavailable: false,
  };
}

/**
 * Build the minimal env passed to the Claude Code child process.
 * Allowlist + the credential routing the SDK was about to read off
 * `process.env` itself. Anything else (CI tokens, cloud creds, custom
 * vars) is dropped.
 *
 * Exported for tests.
 */
function buildClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (CLAUDE_ENV_ALLOWLIST.has(k) || k.startsWith("LC_")) {
      env[k] = v;
    }
  }
  // Forward only the direct API key or the subscription OAuth token, so the
  // agent's shell never sees unrelated secrets such as GITHUB_TOKEN or AWS_*.
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

type ClaudeEffort = "low" | "medium" | "high" | "max";

/**
 * Map the harness-neutral thinkingLevel to the Claude SDK's effort scale.
 * Unset means full effort.
 */
function resolveMainRunEffort(config: Record<string, unknown>): ClaudeEffort {
  const level = config.thinkingLevel;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return level;
  return "max"; // xhigh and unset both mean full effort
}

export async function runClaudeSetupTask(params: SetupTaskParams): Promise<string> {
  const started = Date.now();
  const meta: Partial<BatchMeta> = {};
  const model = (params.config.model as string) ?? "claude-opus-5-5";
  const abortController = new AbortController();
  const abort = () => abortController.abort(params.signal?.reason);
  if (params.signal) {
    if (params.signal.aborted) abort();
    else params.signal.addEventListener("abort", abort, { once: true });
  }
  let resultText = "";
  try {
    params.onProgress?.({
      type: "started",
      message: `Understanding repository with Claude (${model})`,
    });
    for await (const message of query({
      prompt: params.prompt,
      options: {
        cwd: params.projectRoot,
        tools: ["Read", "Glob", "Grep"],
        allowedTools: ["Read", "Glob", "Grep"],
        permissionMode: "dontAsk",
        maxTurns: (params.config.maxTurns as number) ?? 40,
        model,
        ...(params.resumeAgentSessionId ? { resume: params.resumeAgentSessionId } : {}),
        thinking: { type: "adaptive" },
        effort: resolveMainRunEffort(params.config),
        pathToClaudeCodeExecutable: findAgentExecutable("claude"),
        env: buildClaudeEnv(),
        sandbox: buildSandbox(),
        abortController,
      },
    })) {
      const msg = message as Record<string, any>;
      if (msg.type === "assistant") {
        const toolUses = msg.message?.content?.filter((b: any) => b.type === "tool_use") ?? [];
        for (const tool of toolUses) {
          const input = tool.input ?? {};
          const target = input.file_path || input.pattern || "";
          params.onProgress?.({
            type: "tool_use",
            message: `${tool.name}${target ? `: ${String(target).split("/").slice(-3).join("/")}` : ""}`,
          });
        }
      } else if (msg.type === "result") {
        if (typeof msg.duration_api_ms === "number") meta.durationApiMs = msg.duration_api_ms;
        if (typeof msg.num_turns === "number") meta.numTurns = msg.num_turns;
        if (typeof msg.total_cost_usd === "number") meta.costUsd = msg.total_cost_usd;
        if (typeof msg.session_id === "string") meta.agentSessionId = msg.session_id;
        if (
          msg.usage &&
          typeof msg.usage.input_tokens === "number" &&
          typeof msg.usage.output_tokens === "number" &&
          typeof msg.usage.cache_read_input_tokens === "number" &&
          typeof msg.usage.cache_creation_input_tokens === "number"
        ) {
          meta.usage = {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadInputTokens: msg.usage.cache_read_input_tokens,
            cacheCreationInputTokens: msg.usage.cache_creation_input_tokens,
          };
        }
        if (msg.subtype === "success") resultText = String(msg.result ?? "");
        else if (msg.is_error) throw new Error(String(msg.result ?? "Claude setup task failed"));
      }
    }
    params.signal?.throwIfAborted();
    if (!resultText.trim()) throw new Error("Claude produced no setup result");
    params.onProgress?.({ type: "complete", message: "Repository setup analysis complete" });
    return resultText.trim();
  } finally {
    params.signal?.removeEventListener("abort", abort);
    params.onMeta?.({ ...meta, durationMs: Date.now() - started });
  }
}
