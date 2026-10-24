// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runDatabuddyDiagnosis } from "../src/databuddy-diagnosis.js";
import { runDatabuddySetup } from "../src/databuddy-setup.js";
import { agentConfig } from "../src/model.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist/databuddy-cli.mjs");

function runBundle(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [BUNDLE, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf-8",
    timeout: 60_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe("bundle e2e", () => {
  it("Databuddy bundle resumes a validated plan without loading security configuration or model credentials", async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-bundle-"));
    try {
      fs.writeFileSync(
        path.join(repository, "package.json"),
        JSON.stringify({ dependencies: { next: "fixture" } }),
      );
      fs.writeFileSync(
        path.join(repository, "app.tsx"),
        "export default function App() { return <main>Signup</main>; }\n",
      );
      fs.writeFileSync(
        path.join(repository, "databuddy.config.ts"),
        "throw new Error('Security configuration was executed');\n",
      );
      const request = {
        websiteId: "synthetic-website",
        journey: "User signs up",
        products: ["sdk", "events"] as ("sdk" | "events")[],
      };
      const evidence = [{ path: "app.tsx", line: 1, reason: "Application entry point" }];
      const artifact = await runDatabuddySetup({
        repository,
        request,
        agentType: "codex",
        config: agentConfig({ agent: "codex", thinkingLevel: "medium", auth: "local" }),
        runTask: async () =>
          JSON.stringify({
            framework: "nextjs",
            summary: "Plan browser tracking and signup events",
            steps: request.products.map((product) => ({
              product,
              change: "Instrument the application entry point",
              evidence,
              verification: "Check a synthetic event arrives",
            })),
            events: [{ name: "signup_completed", source: "browser", properties: {}, evidence }],
            recommendations: [
              {
                kind: "funnel",
                product: "events",
                priority: "journey",
                title: "Signup funnel",
                change: "Create a funnel ending in signup_completed",
                rationale: "Measures the stated journey",
                evidence,
                verification: "Confirm one conversion after a synthetic signup",
                steps: [
                  { type: "path", value: "/" },
                  { type: "event", value: "signup_completed" },
                ],
              },
            ],
            unknowns: ["Website access remains unverified"],
          }),
      });
      const options = {
        cwd: repository,
        // A cache miss must fail before invoking a paid adapter.
        env: { OPENAI_API_KEY: "synthetic-cache-miss-guard" },
      };
      expect(runBundle(["--help"], options).stdout).toContain("databuddy");
      const result = runBundle(
        ["setup", repository, "--website", request.websiteId, "--journey", request.journey],
        options,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(artifact);
      expect(result.stderr).toBe("");
      expect(
        runBundle(
          [
            "setup",
            repository,
            "--website",
            request.websiteId,
            "--journey",
            request.journey,
            "--products",
            "invalid",
          ],
          options,
        ).status,
      ).toBe(1);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
  it("Databuddy bundle installs the SDK and resumes reviewed edits after an interrupted application", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-apply-bundle-"));
    const repository = path.join(temporary, "app");
    const bin = path.join(temporary, "bin");
    fs.mkdirSync(repository);
    fs.mkdirSync(bin);
    try {
      fs.writeFileSync(
        path.join(repository, "package.json"),
        JSON.stringify({
          name: "synthetic-app",
          packageManager: "npm@10.0.0",
          dependencies: { next: "fixture" },
        }),
      );
      const before = "export default function App() { return <main>Signup</main>; }\n";
      const after =
        'import { Databuddy } from "@databuddy/sdk/react";\nexport default function App() { return <><Databuddy clientId="synthetic-website" /><main>Signup</main></>; }\n';
      fs.writeFileSync(path.join(repository, "app.tsx"), before);
      const request = {
        websiteId: "synthetic-website",
        journey: "User signs up",
        products: ["sdk"] as "sdk"[],
      };
      const config = agentConfig({ agent: "codex", thinkingLevel: "medium", auth: "local" });
      const evidence = [{ path: "app.tsx", line: 1, reason: "Application entry point" }];
      const responses = [
        {
          framework: "nextjs",
          summary: "Mount browser tracking",
          steps: [
            {
              product: "sdk",
              change: "Mount the SDK once",
              evidence,
              verification: "Check synthetic pageview delivery",
            },
          ],
          events: [],
          recommendations: [],
          unknowns: ["Live delivery is unverified"],
        },
        { changes: [{ product: "sdk", path: "app.tsx", content: after }] },
        {
          passed: true,
          issues: [],
          unknowns: ["App build and live delivery are unverified"],
          hunks: [{ id: "H1", related: true, purpose: "mounts the SDK" }],
        },
      ];
      await expect(
        runDatabuddySetup({
          repository,
          request,
          config,
          apply: true,
          runTask: async () => JSON.stringify(responses.shift()),
          installSdk: async () => {
            throw new Error("Synthetic interruption before dependency installation");
          },
        }),
      ).rejects.toThrow("Synthetic interruption");
      expect(responses).toHaveLength(0);
      expect(fs.readFileSync(path.join(repository, "app.tsx"), "utf8")).toBe(before);
      const stateFile = path.join(repository, ".databuddy/setup.json");
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).status).toBe("applying");
      // This local executable exercises the host installer without network access or package scripts.
      fs.writeFileSync(
        path.join(bin, "npm"),
        `#!${process.execPath}\nconst fs = require("node:fs");
const path = require("node:path");
if (process.argv.slice(2).join(" ") !== "install @databuddy/sdk@^3 --ignore-scripts --save-prod") process.exit(2);
const failOnce = path.join(__dirname, "fail-once");
if (fs.existsSync(failOnce)) { fs.rmSync(failOnce); console.error("npm error synthetic store mismatch"); process.exit(1); }
const file = path.join(process.cwd(), "package.json");
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies["@databuddy/sdk"] = "synthetic";
fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
const sdk = path.join(process.cwd(), "node_modules/@databuddy/sdk");
fs.mkdirSync(sdk, {recursive:true});
fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({name:"@databuddy/sdk",version:"3.0.1",exports:{".":"./index.js","./react":"./react.js","./node":"./node.js"}}));
`,
        { mode: 0o700 },
      );
      const options = {
        cwd: repository,
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          OPENAI_API_KEY: "synthetic-cache-miss-guard",
        },
      };
      const args = [
        "setup",
        repository,
        "--website",
        request.websiteId,
        "--journey",
        request.journey,
        "--products",
        "sdk",
      ];
      const missingApply = runBundle(args, options);
      expect(missingApply.status).toBe(1);
      expect(missingApply.stderr).toContain("--apply");
      fs.writeFileSync(path.join(bin, "fail-once"), "");
      const failedInstall = runBundle([...args, "--apply"], options);
      expect(failedInstall.status).toBe(1);
      expect(failedInstall.stderr).toContain("npm error synthetic store mismatch");
      const applied = runBundle([...args, "--apply"], options);
      expect(applied.status, applied.stderr).toBe(0);
      const result = JSON.parse(applied.stdout);
      expect(result.phases.implementation).toBe("complete");
      expect(result.phases.verification).toBe("pending");
      expect(result.phases.websiteAccess).toBe("unverified");
      expect(result.implementation.sdkVersion).toBe("3.0.1");
      expect(fs.readFileSync(path.join(repository, "app.tsx"), "utf8")).toBe(after);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).status).toBe("applied");
      expect(JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).name).toBe(
        "synthetic-app",
      );
      const cached = runBundle([...args, "--apply"], options);
      expect(cached.status, cached.stderr).toBe(0);
      expect(JSON.parse(cached.stdout)).toEqual(result);
      expect(cached.stderr).toBe("");
      const checked = runBundle(
        [
          ...args,
          "--apply",
          "--check",
          'node -e "process.exit(0)"',
          "--check",
          'node -e "process.exit(3)"',
        ],
        options,
      );
      expect(checked.status).toBe(1);
      expect(
        JSON.parse(checked.stdout).checks.map((check: { exitCode: number }) => check.exitCode),
      ).toEqual([0, 3]);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("Databuddy diagnosis bundle returns verified scoped findings from a checkpoint without credentials", async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-diagnosis-bundle-"));
    try {
      fs.mkdirSync(path.join(repository, "src"));
      fs.writeFileSync(
        path.join(repository, "package.json"),
        JSON.stringify({ name: "synthetic-worker" }),
      );
      const source = "export const retryLimit = 3;\n";
      fs.writeFileSync(path.join(repository, "src/worker.ts"), source);
      const request = { question: "What does the retry configuration establish?", scope: ["src"] };
      const config = agentConfig({ agent: "codex", thinkingLevel: "medium", auth: "local" });
      const finding = {
        id: "retry-bound",
        area: "insights" as const,
        category: "working" as const,
        basis: "source" as const,
        title: "The worker declares a retry bound",
        explanation: "The source declares three retries; execution and its callers are unknown.",
        evidence: [
          { path: "src/worker.ts", line: 1, quote: source.trim(), reason: "Declared bound" },
        ],
        nextCheck: "Inspect callers and exercise a failed job locally",
      };
      let verificationUnavailable = true;
      const options = {
        repository,
        request,
        config,
        runTask: async ({ prompt }: { prompt: string }) => {
          if (prompt.startsWith("Independently verify")) {
            if (verificationUnavailable) throw new Error("Synthetic verifier interruption");
            return JSON.stringify({
              summary: "Source declares a retry bound; runtime behavior remains unknown",
              verdicts: [
                {
                  findingId: finding.id,
                  verdict: "supported",
                  reason: "The declaration is present; execution is not established.",
                  evidence: finding.evidence,
                  checks: {
                    source: "checked",
                    callers: "limited",
                    contracts: "not-applicable",
                    safeguards: "limited",
                  },
                  finding,
                },
              ],
              unknowns: ["Runtime behavior is unverified"],
            });
          }
          return JSON.stringify({
            summary: "A retry bound exists",
            findings: [finding],
            unknowns: [],
          });
        },
      };
      await expect(runDatabuddyDiagnosis(options)).rejects.toThrow(
        "Synthetic verifier interruption",
      );
      const stateFile = path.join(repository, ".databuddy/diagnosis.json");
      const saved = fs.readFileSync(stateFile, "utf8");
      expect(JSON.parse(saved).status).toBe("verifying");
      const cliOptions = {
        cwd: repository,
        env: { OPENAI_API_KEY: "synthetic-cache-miss-guard" },
      };
      const args = ["diagnose", repository, "--question", request.question, "--scope", "src"];
      const blocked = runBundle(args, cliOptions);
      expect(blocked.status).toBe(1);
      expect(fs.readFileSync(stateFile, "utf8")).toBe(saved);
      verificationUnavailable = false;
      const completed = await runDatabuddyDiagnosis({
        ...options,
        runTask: async (params) => {
          expect(params.prompt.startsWith("Independently verify")).toBe(true);
          return options.runTask(params);
        },
      });
      const result = runBundle(args, cliOptions);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(completed);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).phases.runtimeVerification).toBe("pending");
      expect(fs.readFileSync(path.join(repository, "src/worker.ts"), "utf8")).toBe(source);
      expect(runBundle(["diagnose", repository], cliOptions).status).toBe(1);
      expect(runBundle(["diagnose", "--help"], cliOptions).stdout).toContain("--scope");
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
  beforeAll(() => {
    if (!fs.existsSync(BUNDLE)) {
      throw new Error(`Bundle not found at ${BUNDLE}. Run \`pnpm bundle\` first.`);
    }
  });

  it("--version reports the current package version", () => {
    const { stdout, status } = runBundle(["--version"]);
    expect(status).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(stdout.trim()).toBe(pkg.version);
  });
});
