// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  excludeStateDirFromGit,
  exportSnapshot,
  isSourcePath,
  readSource,
  sourceFiles,
} from "../repository-snapshot.js";
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

  it("redacts unquoted config secrets, secret-named code values and random-looking literals", () => {
    const redact = createSetupRedactor({});
    const fake = (...parts: string[]) => parts.join("");
    const awsSecret = fake("wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYzEXAMPLEKEY9");
    const mailgun = fake("key-", "3ax6xnjp29jd6fds4gc373sgvjxteol0");
    const leaks = [
      `  password: ${fake("hunter2", "Hunter2hunter")}`,
      `DB_PASSWORD=${fake("s3cr3t", "-value-123")}`,
      `const dbPass = "${fake("pa55", "word123x")}";`,
      `const mailgun = "${mailgun}";`,
      `export const region = { id: "${awsSecret}" };`,
    ];
    const output = redact(leaks.join("\n"));
    for (const secret of ["hunter2", "s3cr3t", "pa55", mailgun, awsSecret])
      expect(output).not.toContain(secret);
    // Formats a re-review showed reaching the model.
    const sendgrid = fake("SG.", "abcdefghijklmnop1234", ".", "qrstuvwxyzABCDEFGH5678");
    const gitlab = fake("glpat-", "abcdefghij1234567890");
    const more = [
      `const dbPassword = "${fake("hunt", "er2x")}";`,
      `headers: { Authorization: "Basic ${fake("dXNlcjpw", "YXNzd29yZA==")}" }`,
      `define('DB_PASSWORD', '${fake("php", "-secret-1")}');`,
      `const conn = "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${fake("abc123", "DEF456ghi789==")};";`,
      `const signingKey = "${fake("0123456789", "abcdef0123456789abcdef01234567")}";`,
      `const mail = "${sendgrid}";`,
      `const gl = "${gitlab}";`,
    ].join("\n");
    const redactedMore = redact(more);
    for (const secret of [
      "hunter2x",
      "dXNlcjpw",
      "php-secret",
      "abc123DEF",
      "0123456789abcdef",
      sendgrid,
      gitlab,
    ])
      expect(redactedMore).not.toContain(secret);
    // Formats a third review showed reaching the model.
    const hexKey = fake("a1b2c3d4", "e5f60718".repeat(7));
    const third = [
      "    environment:",
      `      - POSTGRES_PASSWORD=${fake("compose", "pw1")}`,
      `      - AWS_SECRET_ACCESS_KEY=${awsSecret}`,
      `DB_PASS: ${fake("Hunter2", "Hunter2")}`,
      `url: postgres://admin:${fake("pa/ss", "@word")}@db.internal:5432/app`,
      `key: ${hexKey}`,
    ].join("\n");
    const redactedThird = redact(third);
    for (const secret of ["composepw1", awsSecret, "Hunter2Hunter2", "pa/ss", "word@", hexKey])
      expect(redactedThird).not.toContain(secret);
    expect(redactedThird).toContain("@db.internal:5432/app");
    const ordinary = [
      'const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";',
      "const profile = 'http://localhost:3000/@user';",
      "compass: northwest",
      "const options = { pass: true };",
      'const STORAGE_KEY = "databuddy_token";',
      'const url = "https://api.databuddy.cc/v1/mcp";',
      '<div className="flex items-center gap-2 rounded-md">',
      'const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";',
      "apiKey: process.env.STRIPE_SECRET_KEY,",
      "// Basic authentication is handled by the proxy.",
    ].join("\n");
    expect(redact(ordinary)).toBe(ordinary);
  });

  it("keeps key and credential files out of the snapshot by name", () => {
    for (const file of [
      "src/keys.ts",
      "lib/key.json",
      "config/service-account.json",
      "src/api-keys.ts",
      "src/pricing.test.ts",
      "app/checkout.spec.tsx",
    ])
      expect(isSourcePath(file), file).toBe(false);
    for (const file of ["src/lib/query-keys.ts", "src/app/keyboard.tsx", "src/config.ts"])
      expect(isSourcePath(file), file).toBe(true);
  });

  it("leaves out files the repository ignores only in .git/info/exclude", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-info-exclude-"));
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    fs.mkdirSync(path.join(repository, "src"));
    fs.writeFileSync(path.join(repository, "src/app.ts"), "export {};\n");
    fs.writeFileSync(path.join(repository, "src/local-only.ts"), "export {};\n");
    fs.appendFileSync(path.join(repository, ".git/info/exclude"), "src/local-only.ts\n");
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-info-exclude-index-"));
    execFileSync("git", ["init", "--bare", "--quiet", gitDir]);
    expect(sourceFiles(repository, gitDir)).toEqual(["src/app.ts"]);
  });

  it("drops service-account key files by their contents, whatever their name", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-service-account-"));
    fs.writeFileSync(
      path.join(repository, "firebase-adminsdk-x1.json"),
      JSON.stringify({ type: "service_account", project_id: "synthetic", private_key_id: "0123" }),
    );
    fs.writeFileSync(path.join(repository, "app.ts"), "export const ok = true;\n");
    const contents = readSource(repository, ["firebase-adminsdk-x1.json", "app.ts"]);
    expect([...contents.keys()]).toEqual(["app.ts"]);
  });

  it("keeps .databuddy/ out of commits once, and leaves non-Git folders alone", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-exclude-"));
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    excludeStateDirFromGit(repository);
    excludeStateDirFromGit(repository);
    const exclude = fs.readFileSync(path.join(repository, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === ".databuddy/")).toHaveLength(1);
    fs.mkdirSync(path.join(repository, ".databuddy"));
    fs.writeFileSync(path.join(repository, ".databuddy/setup.json"), "{}");
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repository,
      encoding: "utf8",
    });
    expect(status).not.toContain(".databuddy");
    expect(() =>
      excludeStateDirFromGit(fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-no-git-"))),
    ).not.toThrow();
  });

  it("exports the redacted snapshot for audit and never writes into a non-empty directory", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-export-"));
    const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
    fs.writeFileSync(path.join(repository, "aws.ts"), `export const k = "${key}";\n`);
    fs.writeFileSync(path.join(repository, "app.ts"), "export const ok = true;\n");
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-export-out-")), "snap");
    const result = exportSnapshot(repository, ["aws.ts", "app.ts"], out, createSetupRedactor({}));
    expect(result).toEqual({ files: 2, redactedFiles: ["aws.ts"] });
    expect(fs.readFileSync(path.join(out, "aws.ts"), "utf8")).not.toContain(key);
    expect(() => exportSnapshot(repository, ["app.ts"], out, createSetupRedactor({}))).toThrow(
      "not empty",
    );
  });
});
