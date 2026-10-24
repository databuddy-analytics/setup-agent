// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { describe, expect, it } from "vitest";
import { createSetupRedactor, normalizeTerminalLine } from "../terminal.js";

describe("terminal output", () => {
  it("removes terminal control sequences and caps pathological lines", () => {
    expect(normalizeTerminalLine("\u001B[32mDone\u001B[0m\u0008")).toBe("Done");
    expect(normalizeTerminalLine("x".repeat(20), 5)).toBe("xxxxx… [truncated]");
  });

  it("redacts credential-named environment values", () => {
    const redact = createSetupRedactor({ OPENAI_API_KEY: "sk-super-secret-value" });
    expect(redact("key=sk-super-secret-value")).toBe("key=[REDACTED]");
  });

  it("redacts Databuddy keys, bearer tokens, JWTs, and URL passwords", () => {
    const redact = createSetupRedactor({});
    const value = redact(
      "dbdy_syntheticKey00000000000000000000000000000000000000 Bearer abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln https://user:password@example.com/path",
    );
    expect(value).not.toContain("dbdy_syntheticKey");
    expect(value).not.toContain("abcdefghijklmnop");
    expect(value).not.toContain("cGF5bG9hZA");
    expect(value).not.toContain("password");
  });
});
