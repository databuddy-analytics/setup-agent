// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { describe, expect, it } from "vitest";
import { isSourcePath } from "../repository-snapshot.js";
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

  it("redacts keys hardcoded in source while leaving ordinary code intact", () => {
    const redact = createSetupRedactor({});
    // Synthetic keys are assembled at runtime so no key-shaped literal sits in
    // the repository for secret scanners to flag.
    const fake = (...parts: string[]) => parts.join("");
    const config = [
      `export const stripe = new Stripe("${fake("sk_", "live_", "51Hx", "0".repeat(22))}");`,
      `const aws = { accessKeyId: "${fake("AKIA", "IOSFODNN7", "EXAMPLE")}" };`,
      `const gh = "${fake("ghp_", "0123456789", "abcdefghijklmnopqrstuvwxyz")}";`,
      `const google = "${fake("AIza", "SyD-", "0".repeat(31))}";`,
      'export const config = { apiKey: "f3a9c1d2e4b5a6978877665544332211", region: "eu" };',
      fake("-----BEGIN ", "PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ", "PRIVATE KEY-----"),
    ].join("\n");
    const output = redact(config);
    for (const secret of [
      "sk_live_51",
      "AKIAIOSFODNN7",
      "ghp_0123",
      "AIzaSyD",
      "f3a9c1d2",
      "MIIEvQ",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain('region: "eu"');
    const ordinary = [
      'placeholder: "Enter your password",',
      "const queryKeys = { leads: ['leads'] };",
      "token: process.env.DATABUDDY_TOKEN,",
      'track("checkout_started", { source: "cart_modal" });',
    ].join("\n");
    expect(redact(ordinary)).toBe(ordinary);
  });

  it("keeps key and credential files out of the snapshot by name", () => {
    for (const file of [
      "src/keys.ts",
      "lib/key.json",
      "config/service-account.json",
      "src/api-keys.ts",
    ])
      expect(isSourcePath(file), file).toBe(false);
    for (const file of ["src/lib/query-keys.ts", "src/app/keyboard.tsx", "src/config.ts"])
      expect(isSourcePath(file), file).toBe(true);
  });
});
