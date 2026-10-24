// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
// --- Retry / backoff -------------------------------------------------------

export const MAX_ATTEMPTS = 3;

/**
 * Out-of-quota / out-of-credits is permanent for the duration of this run —
 * retrying just burns minutes against an empty wallet, and continuing to
 * the next batch fails the same way. We classify these separately from
 * transient rate-limits so the agents can throw a `QuotaExhaustedError` and
 * the processor can stop launching new batches.
 *
 * Provider-specific signatures:
 * - `claude-subscription`     — Claude Pro/Max weekly or 5-hour limit
 * - `anthropic-credits`       — direct Anthropic API: credit balance too low
 * - `openai-quota`            — direct OpenAI API: insufficient_quota / 402
 * - `openai-subscription`     — ChatGPT Plus quota via `codex login`
 * - `gateway-credits`         — Vercel AI Gateway: out of gateway credits
 * - `unknown`                 — bare HTTP 402 we couldn't pin to a source
 */
type QuotaSource =
  | "claude-subscription"
  | "anthropic-credits"
  | "openai-quota"
  | "openai-subscription"
  | "gateway-credits"
  | "unknown";

/**
 * Optional agent hint passed by the per-plugin caller. The same prose
 * ("usage limit") appears in both the Claude and codex binaries, but a
 * caller in `claude-agent-sdk.ts` only ever sees Claude/Anthropic errors,
 * and a caller in `codex-sdk.ts` only ever sees codex/OpenAI errors. The
 * hint resolves the prose-only ambiguity without us trying to fingerprint
 * the source from text alone.
 */
type QuotaAgentHint = "claude" | "codex";

/**
 * Classify an error message as quota-exhausted, returning the most
 * specific source we can identify, or `undefined` if the message is not
 * a quota error.
 *
 * Patterns below were extracted from the actual platform binaries via
 * `strings`:
 *   - Claude: `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
 *   - Codex:  `@openai/codex/vendor/.../bin/codex`
 * plus the well-known stable strings from the upstream HTTP error
 * envelopes (Anthropic `billing_error`, OpenAI `insufficient_quota` /
 * "You exceeded your current quota") which don't appear in the bundled
 * binaries because the binaries just relay them.
 *
 * Matching is intentionally loose — false-positives degrade to a
 * generic but accurate stop-and-direct-to-AI-Gateway message; misses
 * fall through to the existing fail-loud retry logic. Loose > strict.
 */
export function classifyQuotaError(msg: string, hint?: QuotaAgentHint): QuotaSource | undefined {
  if (!msg) return undefined;
  const m = msg.toLowerCase();

  // --- Vercel AI Gateway (matched first; the gateway forwards provider
  // bodies, so a gateway-credits error can incidentally contain provider
  // prose like "Claude" or "OpenAI" — we want gateway attribution to win).
  //
  // Strings extracted from the gateway source itself
  // (vercel/ai-gateway/lib/gateway/check-billing.ts and friends):
  //   - HTTP 402, `error.type: "insufficient_funds"`,
  //     prose: "Insufficient funds. Please add credits to your account…"
  //   - HTTP 403, `error.type: "customer_verification_required"`,
  //     prose: "AI Gateway requires a valid credit card on file…"
  //   - HTTP 429, `error.type: "quota_for_entity_exceeded"`,
  //     prose: 'Quota limit exceeded for "<id>". Current spend: $X, limit: $Y'
  //   - HTTP 429, `error.type: "rate_limit_exceeded"` for video tier limits.
  // The gateway WRAPS upstream provider errors rather than passing them
  // through; client-facing bodies always use the canonical gateway types.
  if (
    /\binsufficient_funds\b/.test(m) ||
    /\bcustomer_verification_required\b/.test(m) ||
    /\bquota_for_entity_exceeded\b/.test(m) ||
    /\binsufficient funds\.?\s+please add credits/.test(m) ||
    /ai gateway requires a valid credit card/.test(m) ||
    // Prose form of `quota_for_entity_exceeded` from check-quota-entity.ts:
    //   `Quota limit exceeded for "<id>". Current spend: $X, limit: $Y.`
    /\bquota limit exceeded for\b/.test(m) ||
    /ai[_ -]?gateway[^.]*?(insufficient[_ ]?credits?|credit balance|out of credits|payment required)/.test(
      m,
    ) ||
    /ai[_ -]?gateway.*\b402\b/.test(m) ||
    // Plain "insufficient credits" without provider attribution typically
    // comes from the gateway; direct providers say "credit balance" or
    // "insufficient_quota" instead.
    /\binsufficient[_ ]credits?\b/.test(m)
  ) {
    return "gateway-credits";
  }

  // --- Anthropic (Claude binary + direct API)
  // Extracted strings from the Claude binary: "Credit balance is too low",
  // "Credit balance too low" (no "is"), "credit balance", and the
  // structured tags `billing_error` / `out_of_credits` / `credit_balance_low`
  // that surface in error envelopes. Match all variants.
  if (
    /credit balance (is )?too low/.test(m) ||
    /\bcredit_balance_low\b/.test(m) ||
    /\bout_of_credits\b/.test(m) ||
    /\bbilling_error\b/.test(m) ||
    // Loose net for prose like "low credit balance" / "insufficient
    // balance" near a Claude/Anthropic mention.
    /(claude|anthropic|claude\.com)[^.]{0,80}\b(low|insufficient)\b[^.]{0,40}\bbalance\b/.test(m) ||
    // The Claude binary also emits `platform.claude.com/settings/billing`
    // alongside the credit message — a hard correlation.
    /platform\.claude\.com\/settings\/billing/.test(m)
  ) {
    return "anthropic-credits";
  }

  // --- Codex / ChatGPT subscription
  // The dominant codex-binary phrase is "You've hit your usage limit"
  // (with several follow-on suffixes pointing at chatgpt.com/explore/plus
  // or chatgpt.com/codex/settings/usage). Internal tags include
  // `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`,
  // `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`,
  // `usage_limit_exceeded`, `usage_limit_reached`, `usageLimitExceeded`.
  if (
    /you'?ve hit your usage limit/.test(m) ||
    /chatgpt\.com\/(explore\/plus|codex\/settings\/usage)/.test(m) ||
    /workspace_(owner|member)_credits_depleted/.test(m) ||
    /workspace_(owner|member)_usage_limit_reached/.test(m) ||
    /\busagelimitexceeded\b/.test(m) ||
    /\busage_limit_(exceeded|reached)\b/.test(m) ||
    // Plus/Pro upgrade prose.
    /upgrade to plus to continue/.test(m) ||
    /\bchatgpt\s+(plus|pro)\b.*\b(quota|limit)\b/.test(m) ||
    /\bplan limit reached\b/.test(m)
  ) {
    return "openai-subscription";
  }

  // --- Direct OpenAI API quota (insufficient_quota / "exceeded your
  // current quota"). These don't appear in the codex binary because the
  // binary relays whatever the OpenAI API HTTP response says; both are
  // documented stable error codes / phrases from OpenAI.
  if (
    /\binsufficient_quota\b/.test(m) ||
    /\byou exceeded your current quota\b/.test(m) ||
    /\bquota exceeded\b.*\bopenai\b/.test(m) ||
    /\bopenai\b.*\bquota exceeded\b/.test(m)
  ) {
    return "openai-quota";
  }

  // --- Generic "usage limit" / "weekly limit" / "monthly limit" prose
  // appears in BOTH binaries. The agent hint disambiguates the source;
  // without a hint we still want to bail (it's still a quota stop), so
  // we attribute to subscription on whichever side the hint points at,
  // or `unknown` if no hint is available.
  if (
    /\b(weekly|monthly|hourly|5[ -]?hour) limit\b/.test(m) ||
    /\bextra usage limit\b/.test(m) ||
    /\busage limit\b/.test(m)
  ) {
    if (hint === "codex") return "openai-subscription";
    if (hint === "claude") return "claude-subscription";
    // No hint — still a real quota stop; classify generically so the run
    // halts and the CLI shows the gateway-aware fallback message.
    return "unknown";
  }

  // --- Bare HTTP 402 anywhere — payment required, definitely not
  // transient. Falls through to "unknown" so we still bail.
  if (/\b402\b/.test(m) && /payment required|insufficient/.test(m)) {
    return "unknown";
  }

  return undefined;
}

/**
 * Thrown by an agent plugin when the upstream credential is out of
 * quota/credits. The processor catches this, aborts the shared
 * AbortController so in-flight batches stop, and prevents new batches
 * from launching — retrying is pointless when every batch is going to hit
 * the same wall.
 */
export class QuotaExhaustedError extends Error {
  readonly source: QuotaSource;
  readonly rawMessage: string;

  constructor(source: QuotaSource, rawMessage: string) {
    super(`Quota exhausted (${source}): ${rawMessage.slice(0, 300)}`);
    this.name = "QuotaExhaustedError";
    this.source = source;
    this.rawMessage = rawMessage;
  }
}

/**
 * Transient = worth retrying. Quota errors are NOT transient even though
 * many of them surface with status 429 — the gateway/upstream re-emits the
 * same body on every retry, so we'd just burn our backoff budget.
 *
 * Callers should consult `classifyQuotaError` *first* and short-circuit
 * with a `QuotaExhaustedError`; this function then handles whatever's left.
 * As a defense-in-depth, we also early-return false when the message
 * classifies as quota — covers any caller that forgot to check.
 */
export function isTransientError(msg: string): boolean {
  if (classifyQuotaError(msg)) return false;
  return /\b(5\d\d|429|eager_input_streaming|temporarily unavailable|timeout|ETIMEDOUT|ECONNRESET|overloaded|rate[_ -]?limit)\b/i.test(
    msg,
  );
}

export async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const ms = 2000 * 2 ** (attempt - 1) + Math.random() * 1000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
