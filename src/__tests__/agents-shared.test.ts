// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { describe, expect, it } from "vitest";
import { classifyQuotaError, isTransientError, QuotaExhaustedError } from "../agents/shared.js";

describe("isTransientError", () => {
  it("flags 5xx, 429, eager_input_streaming, ECONNRESET", () => {
    expect(isTransientError("HTTP 503 Service Unavailable")).toBe(true);
    expect(isTransientError("HTTP 429 too many requests")).toBe(true);
    expect(isTransientError("Extra inputs are not permitted: eager_input_streaming")).toBe(true);
    expect(isTransientError("ECONNRESET fetch failed")).toBe(true);
    expect(isTransientError("rate-limit hit")).toBe(true);
    expect(isTransientError("overloaded")).toBe(true);
  });

  it("doesn't flag obvious permanent errors", () => {
    expect(isTransientError("ENOENT no such file")).toBe(false);
    expect(isTransientError("invalid api key")).toBe(false);
  });

  it("does NOT classify quota errors as transient (defense-in-depth)", () => {
    // A 429 carrying an `insufficient_quota` body would otherwise loop in
    // the retry budget; classifyQuotaError takes precedence so we don't
    // burn attempts on a permanently-empty wallet.
    expect(isTransientError("HTTP 429 insufficient_quota: You exceeded your current quota")).toBe(
      false,
    );
    expect(isTransientError("Claude AI usage limit reached for the week")).toBe(false);
  });
});

describe("classifyQuotaError", () => {
  // Strings in this block were extracted from the actual platform binaries
  // shipped via @anthropic-ai/claude-agent-sdk-darwin-arm64 (claude) and
  // @openai/codex/vendor/.../bin/codex (codex Rust binary), via
  // `strings | grep`. Treat these tests as ground truth — if a binary
  // upgrade breaks them, the regexes need updating.

  it("Claude binary: 'Credit balance is too low' (with 'is')", () => {
    expect(classifyQuotaError("Credit balance is too low", "claude")).toBe("anthropic-credits");
    expect(
      classifyQuotaError("Your credit balance is too low to access the Claude API", "claude"),
    ).toBe("anthropic-credits");
  });

  it("Claude binary: 'Credit balance too low' (without 'is') + funds URL", () => {
    expect(
      classifyQuotaError(
        "Credit balance too low · Add funds: https://platform.claude.com/settings/billing",
        "claude",
      ),
    ).toBe("anthropic-credits");
  });

  it("Anthropic structured tags: billing_error / out_of_credits / credit_balance_low", () => {
    expect(classifyQuotaError('{"type":"billing_error","message":"…"}', "claude")).toBe(
      "anthropic-credits",
    );
    expect(classifyQuotaError("event=out_of_credits", "claude")).toBe("anthropic-credits");
    expect(classifyQuotaError("error_code: credit_balance_low", "claude")).toBe(
      "anthropic-credits",
    );
  });

  it("Claude subscription prose ('usage limit', 'weekly limit') — needs hint to disambiguate", () => {
    // Same prose appears in both binaries; the agent hint resolves source.
    expect(classifyQuotaError("usage limit reached", "claude")).toBe("claude-subscription");
    expect(classifyQuotaError("Hit the weekly limit", "claude")).toBe("claude-subscription");
    expect(classifyQuotaError("/upgrade to increase your usage limit.", "claude")).toBe(
      "claude-subscription",
    );
    // Without a hint, it's still classified — falls back to 'unknown' so
    // the run still bails (the alternative is to silently retry, which
    // wastes the budget).
    expect(classifyQuotaError("usage limit reached")).toBe("unknown");
  });

  it("Codex binary: canonical 'You've hit your usage limit' phrasing", () => {
    expect(classifyQuotaError("You've hit your usage limit.", "codex")).toBe("openai-subscription");
    expect(
      classifyQuotaError(
        "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)",
        "codex",
      ),
    ).toBe("openai-subscription");
    expect(
      classifyQuotaError(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
        "codex",
      ),
    ).toBe("openai-subscription");
    expect(
      classifyQuotaError(
        "You've hit your usage limit. To get more access now, send a request to your admin",
        "codex",
      ),
    ).toBe("openai-subscription");
  });

  it("Codex internal tags: workspace_*_credits_depleted / *_usage_limit_reached / usageLimitExceeded", () => {
    expect(classifyQuotaError("workspace_owner_credits_depleted", "codex")).toBe(
      "openai-subscription",
    );
    expect(classifyQuotaError("workspace_member_credits_depleted", "codex")).toBe(
      "openai-subscription",
    );
    expect(classifyQuotaError("workspace_owner_usage_limit_reached", "codex")).toBe(
      "openai-subscription",
    );
    expect(classifyQuotaError("usage_limit_exceeded", "codex")).toBe("openai-subscription");
    expect(classifyQuotaError("usageLimitExceeded", "codex")).toBe("openai-subscription");
  });

  it("Direct OpenAI API: insufficient_quota / 'You exceeded your current quota'", () => {
    expect(classifyQuotaError("HTTP 429 insufficient_quota", "codex")).toBe("openai-quota");
    expect(
      classifyQuotaError(
        "You exceeded your current quota, please check your plan and billing",
        "codex",
      ),
    ).toBe("openai-quota");
  });

  it("Vercel AI Gateway: literal strings extracted from gateway source code", () => {
    // Strings extracted from vercel/ai-gateway. These are the exact
    // bodies the gateway emits to clients (see check-billing.ts:33-47,
    // check-quota-entity.ts:77-85, check-video-eligibility.ts:151-308).
    // The gateway WRAPS upstream provider errors rather than passing them
    // through, so client-facing bodies always carry these canonical types.

    // HTTP 402 — insufficient_funds (the headline scenario).
    expect(
      classifyQuotaError(
        '{"error":{"message":"Insufficient funds. Please add credits to your account to continue using AI services. Visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up to top up your credits.","type":"insufficient_funds"}}',
      ),
    ).toBe("gateway-credits");
    expect(classifyQuotaError("error.type=insufficient_funds")).toBe("gateway-credits");

    // HTTP 403 — customer_verification_required (no card on file).
    expect(
      classifyQuotaError("AI Gateway requires a valid credit card on file to service requests."),
    ).toBe("gateway-credits");
    expect(classifyQuotaError("type: customer_verification_required")).toBe("gateway-credits");

    // HTTP 429 — admin-set quota for an entity.
    expect(
      classifyQuotaError(
        'Quota limit exceeded for "team-x". Current spend: $50.00, limit: $50.00. Please contact your administrator to increase the quota.',
      ),
    ).toBe("gateway-credits");
    expect(classifyQuotaError("type: quota_for_entity_exceeded")).toBe("gateway-credits");
  });

  it("Vercel AI Gateway prose wins over provider attribution in the same body", () => {
    // The gateway WRAPS provider errors, but if any historical/loose
    // pattern leaks through with provider names alongside gateway
    // attribution, we want gateway-credits to win.
    expect(classifyQuotaError("AI Gateway: insufficient credits")).toBe("gateway-credits");
    expect(classifyQuotaError("ai_gateway: payment required")).toBe("gateway-credits");
    expect(classifyQuotaError("insufficient credits")).toBe("gateway-credits");
  });

  it("returns undefined for non-quota errors so retry/transient logic still applies", () => {
    expect(classifyQuotaError("HTTP 503 Service Unavailable")).toBeUndefined();
    expect(classifyQuotaError("ECONNRESET")).toBeUndefined();
    expect(classifyQuotaError("ENOENT")).toBeUndefined();
    expect(classifyQuotaError("")).toBeUndefined();
  });

  it("falls back to 'unknown' for bare HTTP 402 with payment-required", () => {
    expect(classifyQuotaError("HTTP 402 Payment Required (insufficient)")).toBe("unknown");
  });
});

describe("QuotaExhaustedError", () => {
  it("carries source + raw, and the message includes both", () => {
    const e = new QuotaExhaustedError("anthropic-credits", "Your credit balance is too low");
    expect(e.source).toBe("anthropic-credits");
    expect(e.rawMessage).toContain("credit balance");
    expect(e.message).toContain("anthropic-credits");
    expect(e.name).toBe("QuotaExhaustedError");
    expect(e instanceof Error).toBe(true);
  });
});
