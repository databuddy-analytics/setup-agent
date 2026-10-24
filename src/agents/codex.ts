// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";
import { findAgentExecutable } from "../model.js";
import { makeWorkDir } from "../workdir.js";
import { classifyQuotaError, QuotaExhaustedError } from "./shared.js";
import type { AgentProgress, BatchMeta, SetupTaskParams } from "./types.js";

const DEFAULT_MODEL = "gpt-6-sol";
const DEFAULT_EFFORT: ModelReasoningEffort = "xhigh";

/**
 * Codex's read-only sandbox blocks writes but still lets commands read any
 * file the user can, so a prompt injection in the repository could pull in
 * ~/.ssh or a .env from elsewhere. This permission profile lets commands read
 * only the workspace (the redacted snapshot) and the platform paths tools
 * need, with no network. Codex enforces it with Seatbelt on macOS and
 * bubblewrap on Linux, and refuses to run a command it cannot sandbox. It
 * must not be combined with --sandbox, which makes Codex ignore profiles.
 */
export function snapshotPermissionProfile(codexExecutable?: string): string {
  // Codex re-executes its own binary inside the sandbox for some helpers, so
  // the install it runs from must stay readable.
  return snapshotProfileText(codexInstallPaths(codexExecutable));
}

/**
 * Directories Codex needs to re-execute itself: the one holding the binary on
 * PATH and, when it is plainly a Codex package (a path segment names codex),
 * the package root above the real binary. Never the home directory or one of
 * its ancestors, which would widen what the model can read.
 */
export function codexInstallPaths(codexExecutable?: string, home = os.homedir()): string[] {
  if (!codexExecutable) return [];
  const real = fs.realpathSync(codexExecutable);
  const root = path.dirname(path.dirname(real));
  const candidates = [path.dirname(codexExecutable), path.dirname(real)];
  if ([path.basename(root), path.basename(path.dirname(root))].some((name) => /codex/i.test(name)))
    candidates.push(root);
  const coversHome = (dir: string) => {
    const relative = path.relative(dir, home);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return [...new Set(candidates)].filter((dir) => !coversHome(dir));
}

function snapshotProfileText(installs: string[]): string {
  return [
    // A repository's AGENTS.md is untrusted text, but Codex would load it as
    // trusted instructions; the agent reads it as ordinary source instead.
    "project_doc_max_bytes = 0",
    // A login shell sources the user's profile, re-exporting secrets the
    // allowlisted environment removed, and a shell snapshot would save them.
    "allow_login_shell = false",
    'default_permissions = "databuddy-snapshot"',
    "",
    "[permissions.databuddy-snapshot.filesystem]",
    '":root" = "deny"',
    '":minimal" = "read"',
    // The minimal set leaves /tmp readable. The snapshot lives in a private
    // cache directory (see workdir.ts), so denying both temp roots is safe.
    '":slash_tmp" = "deny"',
    '":tmpdir" = "deny"',
    ...installs.map((dir) => `${JSON.stringify(dir)} = "read"`),
    "",
    '[permissions.databuddy-snapshot.filesystem.":workspace_roots"]',
    '"." = "read"',
    "",
    "[permissions.databuddy-snapshot.network]",
    "enabled = false",
    "",
    "[features]",
    "shell_snapshot = false",
    "",
  ].join("\n");
}

/**
 * The codex CLI persists thread state to `$CODEX_HOME/sessions/` (defaulting
 * to `~/.codex`). Multiple concurrent codex CLI processes within one host
 * stomp on each other's session DB — empirically observed as ~99% of runs
 * completing in ~1s with 1 turn / 0 tool calls / 0 tokens / $0 (the CLI
 * silently no-ops when its session writes fail).
 *
 * Fix: give every Codex SDK instance a unique CODEX_HOME, keyed off PID +
 * a counter + random bytes. Tempdirs auto-cleanup on process exit; even if
 * a few leak they're tiny.
 */
// mkdtempSync creates a 0700 directory atomically (and refuses if the
// target already exists), which closes the symlink-clobber race a
// pre-creating local attacker would otherwise win.
function makeCodexHome(): string {
  const home = makeWorkDir("codex-home-");
  fs.writeFileSync(
    path.join(home, "config.toml"),
    snapshotPermissionProfile(findAgentExecutable("codex")),
    { mode: 0o600 },
  );
  return home;
}

/**
 * Locate a usable `~/.codex/auth.json` for subscription-mode auth (the user
 * has run `codex login` on the laptop and we want to reuse that session
 * instead of forcing them to set OPENAI_API_KEY).
 *
 * Returns the parent dir (the "user codex home"), or null if no auth file
 * is present. Honors `CODEX_HOME` for users who run codex with a
 * non-default data dir; we look for auth.json in that override before
 * falling back to `$HOME/.codex`.
 */
function findCodexSubscriptionAuth(): string | null {
  const candidates: string[] = [];
  if (process.env.CODEX_HOME) candidates.push(process.env.CODEX_HOME);
  candidates.push(path.join(os.homedir(), ".codex"));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "auth.json"))) return dir;
  }
  return null;
}

/**
 * Mirror the user's auth.json into our per-invocation CODEX_HOME so the
 * codex CLI sees their subscription credentials while still writing
 * sessions/* into the isolated tempdir. We prefer a symlink so token
 * refresh writes propagate back to the user's real auth.json — only fall
 * back to copy on platforms/filesystems that can't symlink (e.g. some
 * Windows configurations).
 *
 * config.toml is intentionally NOT mirrored: a user-supplied
 * `model_provider = "..."` could conflict with our defaults, and we
 * specifically want the built-in `openai` provider in subscription mode.
 */
function mirrorCodexAuthJson(userCodexHome: string, codexHome: string): void {
  const src = path.join(userCodexHome, "auth.json");
  const dst = path.join(codexHome, "auth.json");
  try {
    fs.symlinkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

/**
 * Variables the codex CLI / spawned shell legitimately needs. Anything
 * outside this set is dropped before the agent process inherits the
 * environment — defense against prompt-injection-driven exfiltration
 * via `env` / `printenv` / `cat /proc/self/environ`.
 *
 * Adding new entries: only do so if codex genuinely fails without them.
 * Values matching `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD` should
 * basically never be added — the model has unrestricted Bash and we
 * cannot trust prompt-level instructions to keep its hands off them.
 */
const CODEX_ENV_ALLOWLIST = new Set<string>([
  // Shell + locale
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
  // Node/JS toolchain (codex CLI is node)
  "NODE_PATH",
  "NODE_OPTIONS",
  "NPM_CONFIG_USERCONFIG",
  // Rust tracing (codex's Rust binary respects RUST_LOG/RUST_BACKTRACE)
  "RUST_LOG",
  "RUST_BACKTRACE",
  // Codex itself
  "CODEX_HOME",
]);

/**
 * Allowlist match for keys whose names start with a known-safe prefix.
 * Useful for cases like `LC_*` we already enumerate, plus a few
 * codex-specific knobs that may grow over time.
 */
const CODEX_ENV_ALLOWLIST_PREFIXES = ["LC_"];

/**
 * Build the env passed to the codex child process. The SDK's `env`
 * option REPLACES process.env (no merge), so we explicitly construct a
 * minimal environment: allowlisted basics + caller-supplied extras
 * (CODEX_HOME, wrapper paths) + the credential variable codex actually
 * needs in the current mode.
 *
 * Crucially, this means the agent's Bash tool can NOT see CI secrets
 * (GITHUB_TOKEN, AWS_*, *_API_KEY, etc.) that the orchestrator process
 * received. Only the credential explicitly forwarded via `extras`
 * reaches the agent.
 */
function buildCodexEnv(extras: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (CODEX_ENV_ALLOWLIST.has(k) || CODEX_ENV_ALLOWLIST_PREFIXES.some((p) => k.startsWith(p))) {
      env[k] = v;
    }
  }
  Object.assign(env, extras);
  return env;
}

interface CodexInvocation {
  options: CodexOptions;
  /** Tempdir under /tmp that was created for this invocation; cleanup on exit */
  codexHome: string;
}

/**
 * Codex homes retained after a task so a later repair can resume the same
 * thread (its rollout lives in that home). Bounded and removed at exit.
 */
const retainedCodexHomes = new Map<string, string>();
const MAX_RETAINED_CODEX_HOMES = 4;
let retainedCleanupRegistered = false;

function retainCodexHome(threadId: string, home: string): void {
  retainedCodexHomes.set(threadId, home);
  while (retainedCodexHomes.size > MAX_RETAINED_CODEX_HOMES) {
    const oldest = retainedCodexHomes.keys().next().value;
    if (oldest === undefined) break;
    const dir = retainedCodexHomes.get(oldest);
    retainedCodexHomes.delete(oldest);
    if (dir) cleanupCodexHome(dir);
  }
  if (!retainedCleanupRegistered) {
    retainedCleanupRegistered = true;
    process.once("exit", () => {
      for (const dir of retainedCodexHomes.values()) cleanupCodexHome(dir);
    });
  }
}

function buildCodexInvocation(existingHome?: string): CodexInvocation {
  // An explicit OPENAI_API_KEY selects API billing; otherwise reuse the
  // machine's `codex login` session through a mirrored auth.json.
  const apiKey = process.env.OPENAI_API_KEY;
  const subscriptionHome = apiKey ? null : findCodexSubscriptionAuth();
  const codexHome = existingHome ?? makeCodexHome();
  if (subscriptionHome) mirrorCodexAuthJson(subscriptionHome, codexHome);
  const extras: Record<string, string> = { CODEX_HOME: codexHome };
  if (apiKey) extras.OPENAI_API_KEY = apiKey;

  // Codex 0.143+ enables remote_plugin by default; a read-only setup task
  // never wants marketplace or plugin installs.
  const options: CodexOptions = {
    codexPathOverride: findAgentExecutable("codex"),
    ...(apiKey ? { apiKey } : {}),
    config: { features: { plugins: false, remote_plugin: false } },
    env: buildCodexEnv(extras),
  };
  return { options, codexHome };
}

/**
 * Delete the per-invocation CODEX_HOME tempdir. Without this, /tmp fills
 * up over a long run and codex's bootstrap writes start failing silently
 * (the SDK surfaces this as the now-familiar zero-token silent failure).
 */
function cleanupCodexHome(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function shortPath(p: string): string {
  return p.split("/").slice(-3).join("/");
}

/**
 * Map a Codex thread item to one of our progress events. Returns `undefined`
 * for items we don't surface (turn-internal noise).
 */
/**
 * When `DATABUDDY_AGENT_DEBUG=1` is set, surface a lot more raw signal:
 *   - command_execution: include exit code + a tail of aggregated_output
 *   - agent_message: emit the full text (so we can see what's being captured
 *     as resultText vs lost as narration)
 *   - reasoning: longer excerpt
 *   - turn.completed: detailed token + cost breakdown
 *   - parse step: report whether the captured text contains a JSON block,
 *     length, and which filePaths the parser matched vs missed
 */
const DEBUG = process.env.DATABUDDY_AGENT_DEBUG === "1";

const REASONING_LEN = DEBUG ? 1200 : 200;
const COMMAND_LEN = DEBUG ? 400 : 120;
const OUTPUT_LEN = DEBUG ? 600 : 0;
const AGENT_MSG_LEN = DEBUG ? 4000 : 0;

function tail(s: string | undefined, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return "…" + s.slice(s.length - n);
}

function itemToProgress(item: ThreadItem): AgentProgress | undefined {
  switch (item.type) {
    case "command_execution": {
      const cmd = item.command ?? "";
      const head = cmd.split("\n")[0]?.slice(0, COMMAND_LEN) ?? "";
      let suffix = "";
      if (DEBUG) {
        const parts: string[] = [];
        if (item.exit_code !== undefined) parts.push(`exit=${item.exit_code}`);
        if (item.status) parts.push(item.status);
        const out = tail(item.aggregated_output, OUTPUT_LEN).replace(/\n+/g, "\\n");
        if (out) parts.push(`out=${out}`);
        if (parts.length) suffix = `  [${parts.join(" ")}]`;
      }
      return {
        type: "tool_use",
        message: `bash: ${head}${suffix}`,
      };
    }
    case "file_change": {
      const paths = item.changes
        .slice(0, 3)
        .map((c) => `${c.kind} ${shortPath(c.path)}`)
        .join(", ");
      return {
        type: "tool_use",
        message: `file_change: ${paths}${DEBUG ? `  [status=${item.status}]` : ""}`,
      };
    }
    case "mcp_tool_call":
      return {
        type: "tool_use",
        message: `${item.server}/${item.tool}${DEBUG ? `  [status=${item.status}]` : ""}`,
      };
    case "web_search":
      return {
        type: "tool_use",
        message: `web_search: ${item.query.slice(0, 100)}`,
      };
    case "reasoning":
      return {
        type: "thinking",
        message: item.text.slice(0, REASONING_LEN),
      };
    case "todo_list": {
      const total = item.items.length;
      const done = item.items.filter((t) => t.completed).length;
      const next = item.items.find((t) => !t.completed)?.text;
      return {
        type: "thinking",
        message: `todo ${done}/${total}${next ? `: ${next.slice(0, 120)}` : ""}`,
      };
    }
    case "error":
      return { type: "error", message: `Codex item error: ${item.message.slice(0, 300)}` };
    case "agent_message": {
      if (!DEBUG) return undefined;
      const text = item.text ?? "";
      const looksJson = /```json|^\s*\[/m.test(text);
      const head = text.slice(0, AGENT_MSG_LEN);
      return {
        type: "thinking",
        message: `agent_message (${text.length} chars, json=${looksJson}): ${head}${text.length > AGENT_MSG_LEN ? "…" : ""}`,
      };
    }
  }
  return undefined;
}

/**
 * Per-1M-token rates for cost estimation. Codex (OpenAI Responses API)
 * doesn't return cost like Anthropic does, so we compute it here.
 *
 * Source: https://developers.openai.com/api/docs/pricing (April 2026).
 * Update when OpenAI repprices or new GPT-5.x SKUs ship.
 */
const MODEL_PRICING_USD_PER_M_TOKENS: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.5-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 }, // pro tier has no cached discount today
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 },
};

/** Whether a run on this model reports an estimated cost a limit can use. */
export function hasCodexPricing(model: string): boolean {
  return model in MODEL_PRICING_USD_PER_M_TOKENS;
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

/**
 * OpenAI Responses API convention:
 *   - `input_tokens` = total input (cached + uncached)
 *   - `cached_input_tokens` = subset billed at the cached rate
 *   - `output_tokens` = total output (visible + reasoning)
 *   - `reasoning_output_tokens` = subset, informational only — already
 *     included in output_tokens, so DON'T double-count.
 *
 * Our internal `inputTokens` follows the Anthropic convention: uncached
 * input only. Subtract the cached portion so downstream rollups (cost,
 * cache hit rate) don't double-count it.
 */
function mapUsage(usage: CodexUsage) {
  const cached = usage.cached_input_tokens ?? 0;
  const totalInput = usage.input_tokens ?? 0;
  return {
    inputTokens: Math.max(0, totalInput - cached),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
  };
}

/**
 * The shared investigation prompt was written for Claude (mentions "Read
 * tool", "Glob", "Grep"). Codex uses shell `command_execution` instead, and
 * we observed agents repeatedly running `pwd` because they were unsure where
 * relative paths resolved to. Prepending an environment block grounds them.
 */
function codexEnvironmentPreamble(projectRoot: string): string {
  return `## Environment

You are running inside the Codex CLI in a sandbox that can read only the project root below and has no network access.

- **Project root** (the codebase under investigation): \`${projectRoot}\`
  - File paths in the "Target Files" list below are RELATIVE to this root.
  - When you read a file, ALWAYS resolve it against this root — either by \`cd ${projectRoot}\` once at the start, or by using absolute paths like \`${projectRoot}/<relative-path>\`.
  - Do NOT run \`pwd\` repeatedly to figure out where you are; the working directory is what's stated above.
- **Available tools**: shell only. Use \`cat\`, \`sed -n\`, \`rg\` (ripgrep — installed; preferred over grep for tree-wide search), \`grep -r\`, \`fd\` / \`find\`, \`head\`, \`wc\`, \`python3\` (installed, useful for parsing JSON / AST when shell isn't enough). There is no dedicated "Read"/"Glob"/"Grep" tool — those are conceptual references in the instructions below. Use shell equivalents.
- **Investigation discipline**: Read each target file fully. Trace imports. Don't guess at content; verify with the shell.
- **Line numbers**: read files with \`nl -ba <file>\` (or search with \`rg -n\`) so every line you see already carries its number. Never re-read a file only to recover line numbers, and never quote a line-number prefix as source.
- **Output**: end your turn with a single fenced \`\`\`json ... \`\`\` block matching the schema in "Output Format". Do NOT split the JSON across multiple messages. Conversational narration before the JSON is fine; the JSON block must appear in your final message.`;
}

function estimateCostUsd(model: string, usage: CodexUsage): number | undefined {
  const rates = MODEL_PRICING_USD_PER_M_TOKENS[model];
  if (!rates) return undefined;
  const cached = usage.cached_input_tokens ?? 0;
  const uncachedInput = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const output = usage.output_tokens ?? 0;
  return (
    (uncachedInput * rates.input + cached * rates.cachedInput + output * rates.output) / 1_000_000
  );
}

export async function runCodexSetupTask(params: SetupTaskParams): Promise<string> {
  const started = Date.now();
  const meta: Partial<BatchMeta> = {};
  let invocation: CodexInvocation | undefined;
  try {
    const model = (params.config.model as string) ?? DEFAULT_MODEL;
    const effort = (params.config.reasoningEffort as ModelReasoningEffort) ?? DEFAULT_EFFORT;
    // Resume only when the earlier thread's home is still retained; otherwise
    // a fresh thread is correct, since repair prompts carry the prior output.
    const resumeHome = params.resumeAgentSessionId
      ? retainedCodexHomes.get(params.resumeAgentSessionId)
      : undefined;
    const resumeThreadId = resumeHome ? params.resumeAgentSessionId : undefined;
    invocation = buildCodexInvocation(resumeHome);
    const codex = new Codex(invocation.options);
    const messages: string[] = [];
    let failure = "";
    params.onProgress?.({
      type: "started",
      message: `Understanding repository with Codex (${model})`,
    });
    const threadOptions = {
      model,
      workingDirectory: params.projectRoot,
      skipGitRepoCheck: true,
      // No sandboxMode or networkAccessEnabled: both select Codex's legacy
      // sandbox, which would override the snapshot-only permission profile.
      approvalPolicy: "never" as const,
      modelReasoningEffort: effort,
      webSearchEnabled: false,
    };
    const thread = resumeThreadId
      ? codex.resumeThread(resumeThreadId, threadOptions)
      : codex.startThread(threadOptions);
    const prompt = `${codexEnvironmentPreamble(params.projectRoot)}\n\n${params.prompt}\n\nFor this schema task, return one complete JSON object in your final response. Do not add narration, markdown fences or a footer.`;
    const { events } = await thread.runStreamed(prompt, { signal: params.signal });
    for await (const event of events as AsyncGenerator<ThreadEvent>) {
      if (event.type === "thread.started") {
        meta.agentSessionId = event.thread_id;
      } else if (event.type === "turn.started") {
        meta.numTurns = (meta.numTurns ?? 0) + 1;
      } else if (event.type === "turn.completed") {
        if (event.usage) {
          meta.usage = mapUsage(event.usage);
          const cost = estimateCostUsd(model, event.usage);
          if (cost !== undefined) meta.costUsd = (meta.costUsd ?? 0) + cost;
        }
      } else if (event.type === "item.completed") {
        const progress = itemToProgress(event.item);
        if (progress) params.onProgress?.(progress);
        if (event.item.type === "agent_message" && event.item.text) {
          messages.push(event.item.text);
        }
      } else if (event.type === "turn.failed") {
        failure = event.error?.message ?? "Codex setup turn failed";
      } else if (event.type === "error") {
        failure = event.message;
      }
    }
    params.signal?.throwIfAborted();
    const text = finalizeCodexSetupResult(messages, failure);
    params.onProgress?.({ type: "complete", message: "Repository setup analysis complete" });
    return text;
  } finally {
    if (invocation) {
      if (meta.agentSessionId) retainCodexHome(meta.agentSessionId, invocation.codexHome);
      else cleanupCodexHome(invocation.codexHome);
    }
    params.onMeta?.({ ...meta, durationMs: Date.now() - started });
  }
}

export function finalizeCodexSetupResult(messages: string[], failure: string): string {
  const text = messages.at(-1)?.trim() ?? "";
  if (failure) {
    const quotaSource = classifyQuotaError(failure, "codex");
    if (quotaSource) throw new QuotaExhaustedError(quotaSource, failure);
    throw new Error(failure);
  }
  if (!text) throw new Error("Codex produced no setup result");
  return text;
}
