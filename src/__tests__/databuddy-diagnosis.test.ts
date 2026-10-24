import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDatabuddyDiagnosis } from "../databuddy-diagnosis.js";
import { acquireSetupLock } from "../lock.js";
import {
  type DatabuddyDiagnosisCheckpoint,
  DatabuddyDiagnosisCheckpointSchema,
  type DatabuddyDiagnosisInvestigation,
  type DatabuddyDiagnosisRequest,
  type DatabuddyDiagnosisReview,
} from "../schema.js";

type RunTask = NonNullable<Parameters<typeof runDatabuddyDiagnosis>[0]["runTask"]>;

const roots: string[] = [];
const request: DatabuddyDiagnosisRequest = {
  question: "What is implemented for signup analytics and checkout flags, and what needs checking?",
  scope: [],
};
const trackingCall = '  track("signup_completed", { method: "password" });';

function write(repository: string, file: string, contents: string): void {
  const destination = path.join(repository, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function read(repository: string, file: string): string {
  return fs.readFileSync(path.join(repository, file), "utf8");
}

function fixture(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-diagnosis-"));
  roots.push(repository);
  write(repository, "package.json", JSON.stringify({ name: "synthetic-app", type: "module" }));
  write(
    repository,
    "src/analytics.ts",
    [
      'import { track } from "@databuddy/sdk";',
      "export function recordSignup() {",
      trackingCall,
      "}",
      "",
    ].join("\n"),
  );
  write(repository, "src/flags.ts", "export const enableCheckout = false;\n");
  write(repository, "README.md", "Synthetic framework-independent application\n");
  return repository;
}

function investigation(): DatabuddyDiagnosisInvestigation {
  const trackingEvidence = {
    path: "src/analytics.ts",
    line: 3,
    quote: trackingCall.trim(),
    reason: "The helper declares one SDK custom-event call",
  };
  return {
    summary:
      "SDK event tracking and a static checkout gate appear in source; callers need checking",
    findings: [
      {
        id: "sdk-track",
        area: "events",
        category: "problem",
        basis: "source",
        title: "Signup event delivery is broken",
        explanation: "The helper declaration was incorrectly treated as proof of delivery failure.",
        evidence: [trackingEvidence],
        nextCheck:
          "Confirm the caller invokes this after success and that the collector receives an event.",
      },
      {
        id: "duplicate-signup",
        area: "events",
        category: "problem",
        basis: "hypothesis",
        title: "Repeated invocation might emit duplicate signup events",
        explanation: "This helper calls track whenever invoked; callers have not been established.",
        evidence: [trackingEvidence],
        nextCheck: "Inspect call sites before concluding signup events are duplicated.",
      },
      {
        id: "static-checkout",
        area: "flags",
        category: "gap",
        basis: "source",
        title: "Checkout uses a static local gate",
        explanation:
          "This module exports a fixed false value; dynamic evaluation is not shown here.",
        evidence: [
          {
            path: "src/flags.ts",
            line: 1,
            quote: "export const enableCheckout = false;",
            reason: "The module declares the local checkout gate",
          },
        ],
        nextCheck: "Inspect the gate's callers and ask whether remote feature flags are desired.",
      },
    ],
    unknowns: ["Signup events are duplicated; the count is unknown"],
    decisions: [],
  };
}

function review(): DatabuddyDiagnosisReview {
  const originals = investigation().findings;
  const sdk = {
    ...originals[0],
    category: "working" as const,
    title: "SDK custom-event tracking is declared",
    explanation:
      "The helper declares an SDK call; source alone cannot establish delivery success or failure.",
  };
  const flag = {
    ...originals[2],
    basis: "hypothesis" as const,
    title: "The static checkout gate may need remote evaluation if the product requires it",
    explanation:
      "The fixed declaration is present; whether remote flags are desired and how callers use it remain unknown.",
  };
  return {
    summary:
      "Source declares an event call; duplicate events are unsupported and remote flag needs are uncertain",
    verdicts: [
      {
        findingId: "sdk-track",
        verdict: "supported",
        reason: "The source establishes the declaration, not the original delivery-failure claim.",
        evidence: sdk.evidence,
        checks: {
          source: "checked",
          callers: "limited",
          contracts: "limited",
          safeguards: "limited",
        },
        finding: sdk,
      },
      {
        findingId: "duplicate-signup",
        verdict: "rejected",
        reason: "No invocation evidence establishes duplicate outcomes.",
        evidence: originals[1].evidence,
        checks: {
          source: "checked",
          callers: "limited",
          contracts: "limited",
          safeguards: "not-applicable",
        },
      },
      {
        findingId: "static-checkout",
        verdict: "uncertain",
        reason: "A static declaration does not establish missing required remote behavior.",
        evidence: flag.evidence,
        checks: {
          source: "checked",
          callers: "limited",
          contracts: "not-applicable",
          safeguards: "limited",
        },
        finding: flag,
      },
    ],
    unknowns: [
      "Website access and runtime event delivery remain unverified",
      "Signup caller order and remote flag intent are unknown",
    ],
  };
}

function expectedIds(prompt: string): string[] {
  const marker = "Expected finding IDs: ";
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error("Verifier must declare its unresolved finding IDs");
  const line = prompt.slice(start + marker.length).split("\n")[0];
  return JSON.parse(line) as string[];
}

function reviewForPrompt(prompt: string): DatabuddyDiagnosisReview {
  const response = review();
  const expected = new Set(expectedIds(prompt));
  response.verdicts = response.verdicts.filter((verdict) => expected.has(verdict.findingId));
  return response;
}

function state(repository: string): DatabuddyDiagnosisCheckpoint {
  return DatabuddyDiagnosisCheckpointSchema.parse(
    JSON.parse(read(repository, ".databuddy/diagnosis.json")),
  );
}

afterEach(() => {
  for (const repository of roots.splice(0)) fs.rmSync(repository, { recursive: true, force: true });
});

describe("Databuddy source diagnosis", () => {
  it("narrows authoritative claims, retains rejection and uncertainty, and revalidates cached evidence", async () => {
    const repository = fixture();
    const before = new Map(
      ["package.json", "src/analytics.ts", "src/flags.ts", "README.md"].map(
        (file) => [file, read(repository, file)] as const,
      ),
    );
    let investigations = 0;
    let reviews = 0;
    const runTask: RunTask = async ({ projectRoot, prompt }) => {
      expect(projectRoot).not.toBe(repository);
      expect(read(projectRoot, "src/analytics.ts")).toBe(before.get("src/analytics.ts"));
      for (const [file, contents] of before) expect(read(repository, file)).toBe(contents);
      if (prompt.startsWith("Independently verify")) {
        reviews++;
        return JSON.stringify(reviewForPrompt(prompt));
      }
      expect(prompt.startsWith("Investigate Databuddy")).toBe(true);
      investigations++;
      return JSON.stringify(investigation());
    };
    const options = { repository, request, runTask };
    const result = await runDatabuddyDiagnosis(options);

    expect(result.findings.map((finding) => finding.id)).toEqual(["sdk-track", "static-checkout"]);
    expect(result.summary).toBe(review().summary);
    expect(result.version).toBe(2);
    expect(result.findings[0]).toMatchObject({
      category: "working",
      basis: "source",
      title: "SDK custom-event tracking is declared",
    });
    expect(result.findings[1].basis).toBe("hypothesis");
    expect(result.findings.map((finding) => finding.title)).not.toContain(
      "Signup event delivery is broken",
    );
    expect(result.assessments).toHaveLength(investigation().findings.length);
    expect(result.assessments[0].original.title).toBe("Signup event delivery is broken");
    expect(result.assessments[1]).toMatchObject({
      original: { id: "duplicate-signup" },
      verification: { verdict: "rejected" },
    });
    expect(result.assessments[2].verification.verdict).toBe("uncertain");
    expect(result.coverage).toEqual({
      mode: "source-only",
      availableFiles: [...before.keys()].sort(),
    });
    expect(result.review.verdicts[0].checks.callers).toBe("limited");
    expect(result.review.verdicts).toContainEqual(
      expect.objectContaining({ findingId: "duplicate-signup", verdict: "rejected" }),
    );
    expect(result.phases).toEqual({
      investigation: "complete",
      sourceVerification: "complete",
      runtimeVerification: "pending",
    });
    expect(result.unknowns).not.toContain(investigation().unknowns[0]);
    expect(result.unknowns).toContain(review().unknowns[0]);
    expect(state(repository)).toMatchObject({ status: "complete", result });
    expect(fs.statSync(path.join(repository, ".databuddy/diagnosis.json")).mode & 0o777).toBe(
      0o600,
    );
    for (const [file, contents] of before) expect(read(repository, file)).toBe(contents);
    expect(await runDatabuddyDiagnosis(options)).toEqual(result);
    expect(investigations).toBe(1);
    expect(reviews).toBe(1);

    const forged = state(repository);
    if (forged.status !== "complete") throw new Error("Expected a completed diagnosis fixture");
    forged.result.findings[0].evidence[0].quote = "invented_source()";
    write(repository, ".databuddy/diagnosis.json", JSON.stringify(forged));
    const rebuilt = await runDatabuddyDiagnosis(options);
    expect(rebuilt.findings[0].evidence[0].quote).toBe(trackingCall.trim());
    expect(investigations).toBe(2);
    expect(reviews).toBe(2);

    const stale = state(repository);
    if (stale.status !== "complete") throw new Error("Expected a completed diagnosis fixture");
    stale.result.unknowns.push(investigation().unknowns[0]);
    write(repository, ".databuddy/diagnosis.json", JSON.stringify(stale));
    expect((await runDatabuddyDiagnosis(options)).unknowns).not.toContain(
      investigation().unknowns[0],
    );
    expect(investigations).toBe(3);
    expect(reviews).toBe(3);
    const legacy = state(repository);
    if (legacy.status !== "complete") throw new Error("Expected a completed diagnosis fixture");
    write(
      repository,
      ".databuddy/diagnosis.json",
      JSON.stringify({ ...legacy, version: 1, result: { ...legacy.result, version: 1 } }),
    );
    await runDatabuddyDiagnosis(options);
    expect(investigations).toBe(4);
    expect(reviews).toBe(4);
  });

  it("resumes only unresolved verification after a partial review followed by exception or cancellation", async () => {
    for (const interruption of ["failure", "abort"] as const) {
      const repository = fixture();
      const controller = new AbortController();
      let investigations = 0;
      let reviews = 0;
      let interrupted = false;
      const requested: string[][] = [];
      const runTask: RunTask = async ({ prompt }) => {
        if (prompt.startsWith("Independently verify")) {
          reviews++;
          requested.push(expectedIds(prompt));
          if (reviews === 1) {
            const partial = reviewForPrompt(prompt);
            partial.verdicts = partial.verdicts.slice(0, 1);
            return JSON.stringify(partial);
          }
          if (!interrupted) {
            interrupted = true;
            if (interruption === "failure") throw new Error("Synthetic verifier unavailable");
            controller.abort();
          }
          return JSON.stringify(reviewForPrompt(prompt));
        }
        investigations++;
        return JSON.stringify(investigation());
      };
      const options = { repository, request, runTask };
      await expect(
        runDatabuddyDiagnosis({ ...options, signal: controller.signal }),
      ).rejects.toThrow();
      const saved = state(repository);
      expect(saved).toMatchObject({ status: "verifying", investigation: investigation() });
      if (saved.status !== "verifying") throw new Error("Expected resumable verification");
      expect(saved.review?.verdicts.map((verdict) => verdict.findingId)).toEqual(["sdk-track"]);
      expect(investigations).toBe(1);
      expect(reviews).toBe(2);
      const resumed = await runDatabuddyDiagnosis(options);
      expect(investigations).toBe(1);
      expect(reviews).toBe(3);
      expect(requested).toEqual([
        ["sdk-track", "duplicate-signup", "static-checkout"],
        ["duplicate-signup", "static-checkout"],
        ["duplicate-signup", "static-checkout"],
      ]);
      expect(resumed.assessments[0].verification).toEqual(saved.review?.verdicts[0]);
      expect(resumed.phases.runtimeVerification).toBe("pending");
      expect(state(repository)).toMatchObject({ status: "complete", result: resumed });
    }
  });

  it("refuses source drift during verification and invalidates changed source, question, and model", async () => {
    const repository = fixture();
    let investigations = 0;
    let reviews = 0;
    let drift = true;
    const runTask: RunTask = async ({ prompt }) => {
      if (prompt.startsWith("Independently verify")) {
        reviews++;
        if (drift) {
          drift = false;
          write(repository, "README.md", "Customer change during source verification\n");
        }
        return JSON.stringify(reviewForPrompt(prompt));
      }
      investigations++;
      return JSON.stringify(investigation());
    };
    const options = { repository, request, runTask };
    await expect(runDatabuddyDiagnosis(options)).rejects.toThrow(/changed/i);
    expect(state(repository).status).toBe("verifying");
    expect(read(repository, "README.md")).toBe("Customer change during source verification\n");
    await runDatabuddyDiagnosis(options);
    expect(investigations).toBe(2);
    expect(reviews).toBe(2);

    const changedQuestion = {
      ...options,
      request: { ...request, question: "Which signup declarations need runtime checks?" },
    };
    await runDatabuddyDiagnosis(changedQuestion);
    const changedModel = { ...changedQuestion, config: { model: "synthetic-model-b" } };
    await runDatabuddyDiagnosis(changedModel);
    write(
      repository,
      "src/analytics.ts",
      `${read(repository, "src/analytics.ts")}// Customer source update\n`,
    );
    const result = await runDatabuddyDiagnosis(changedModel);
    expect(investigations).toBe(5);
    expect(reviews).toBe(5);
    expect(await runDatabuddyDiagnosis(changedModel)).toEqual(result);
    expect(investigations).toBe(5);
    expect(reviews).toBe(5);
    expect(state(repository).status).toBe("complete");
  });

  it("bounds repair of malformed responses, fabricated anchors, and duplicate IDs, then retries investigation", async () => {
    {
      const repository = fixture();
      let investigations = 0;
      const runTask: RunTask = async ({ prompt }) => {
        if (prompt.startsWith("Independently verify"))
          return JSON.stringify(reviewForPrompt(prompt));
        investigations++;
        const response = investigation();
        response.findings[0].evidence[0].line = 999;
        return JSON.stringify(response);
      };
      const relocated = await runDatabuddyDiagnosis({ repository, request, runTask });
      expect(investigations).toBe(1);
      expect(relocated.assessments[0].original.evidence[0].line).toBe(
        investigation().findings[0].evidence[0].line,
      );
    }
    for (const defect of ["malformed", "path", "quote", "duplicate-id"] as const) {
      const repository = fixture();
      let invalid = true;
      let investigations = 0;
      let reviews = 0;
      const runTask: RunTask = async ({ prompt }) => {
        if (prompt.startsWith("Independently verify")) {
          reviews++;
          return JSON.stringify(reviewForPrompt(prompt));
        }
        investigations++;
        if (invalid && defect === "malformed") return "{ malformed";
        const response = investigation();
        if (invalid) {
          if (defect === "path") response.findings[0].evidence[0].path = ".env.local";
          if (defect === "quote")
            response.findings[0].evidence[0].quote = 'track("invented_event")';
          if (defect === "duplicate-id") response.findings[1].id = response.findings[0].id;
        }
        return JSON.stringify(response);
      };
      const options = { repository, request, runTask };
      await expect(runDatabuddyDiagnosis(options)).rejects.toThrow();
      expect(investigations).toBe(2);
      expect(reviews).toBe(0);
      expect(state(repository).status).toBe("investigating");
      invalid = false;
      const recovered = await runDatabuddyDiagnosis(options);
      expect(investigations).toBe(3);
      expect(reviews).toBe(1);
      expect(state(repository)).toMatchObject({ status: "complete", result: recovered });
    }

    const repository = fixture();
    let calls = 0;
    const broken = investigation();
    const templateSource = "export const help = `Use \\`@databuddy/sdk\\` for events.`;";
    write(repository, "src/help.ts", `${templateSource}\n`);
    broken.findings[0].evidence.push({
      path: "src/help.ts",
      line: 1,
      quote: "Use `@databuddy/sdk` for events.",
      reason: "The template describes SDK events",
    });
    broken.findings[0].evidence[0].quote = "invented_source()";
    broken.findings[2].evidence[0].line = 999;
    const recovered = await runDatabuddyDiagnosis({
      repository,
      request,
      runTask: async ({ prompt }) => {
        calls++;
        if (prompt.startsWith("Independently verify"))
          return JSON.stringify(reviewForPrompt(prompt));
        const corrected =
          prompt.includes('sdk-track: "src/analytics.ts":3') &&
          !prompt.includes('static-checkout: "src/flags.ts"') &&
          !prompt.includes('"src/help.ts":1') &&
          prompt.includes(JSON.stringify(broken));
        if (!corrected) return JSON.stringify(broken);
        const response = investigation();
        response.findings[0].evidence.push(broken.findings[0].evidence[1]);
        return JSON.stringify(response);
      },
    });
    expect(recovered.findings.map((finding) => finding.id)).toEqual([
      "sdk-track",
      "static-checkout",
    ]);
    expect(calls).toBe(3);
    expect(recovered.assessments[0].original.evidence[1].quote).toBe(templateSource);
    expect(recovered.assessments[2].original.evidence[0].line).toBe(
      investigation().findings[2].evidence[0].line,
    );
  });

  it("applies the verdict contract deterministically instead of repairing limited or mislabelled verdicts", async () => {
    const repository = fixture();
    let reviews = 0;
    const runTask: RunTask = async ({ prompt }) => {
      if (!prompt.startsWith("Independently verify")) return JSON.stringify(investigation());
      reviews++;
      const response = reviewForPrompt(prompt);
      response.verdicts.find((verdict) => verdict.findingId === "static-checkout")!.finding!.basis =
        "source";
      return JSON.stringify(response);
    };
    const result = await runDatabuddyDiagnosis({ repository, request, runTask });
    expect(reviews).toBe(1);
    const verdicts = new Map(result.review.verdicts.map((verdict) => [verdict.findingId, verdict]));
    expect(verdicts.get("static-checkout")).toMatchObject({
      verdict: "uncertain",
      finding: { basis: "hypothesis" },
    });
  });

  it("bounds malformed or incomplete verdict repair while preserving the investigation", async () => {
    for (const defect of [
      "malformed",
      "header",
      "missing",
      "duplicate",
      "unknown",
      "evidence",
      "limited-problem",
    ] as const) {
      const repository = fixture();
      let invalid = true;
      let investigations = 0;
      let reviews = 0;
      const runTask: RunTask = async ({ prompt }) => {
        if (prompt.startsWith("Independently verify")) {
          reviews++;
          if (invalid && defect === "malformed") return "{ malformed";
          const response = reviewForPrompt(prompt);
          if (invalid) {
            if (defect === "header") response.summary = "";
            if (defect === "missing") response.verdicts.pop();
            if (defect === "duplicate") response.verdicts.push({ ...response.verdicts[0] });
            if (defect === "unknown")
              response.verdicts[response.verdicts.length - 1].findingId = "invented-finding";
            if (defect === "evidence")
              response.verdicts[0].evidence[0].quote = "invented_verifier_evidence()";
            if (defect === "limited-problem") {
              const limited = response.verdicts.find(
                (verdict) => verdict.findingId === "sdk-track",
              )!;
              limited.finding!.category = "problem";
              limited.checks.callers = "limited";
            }
          }
          return JSON.stringify(response);
        }
        investigations++;
        return JSON.stringify(investigation());
      };
      const options = { repository, request, runTask };
      await expect(runDatabuddyDiagnosis(options)).rejects.toThrow();
      expect(investigations).toBe(1);
      expect(reviews).toBe(2);
      expect(state(repository)).toMatchObject({
        status: "verifying",
        investigation: investigation(),
      });
      if (defect === "header") {
        const saved = state(repository);
        if (saved.status !== "verifying") throw new Error("Expected resumable verification");
        expect(saved.review?.verdicts).toHaveLength(3);
      }
      invalid = false;
      const resumed = await runDatabuddyDiagnosis(options);
      expect(investigations).toBe(1);
      expect(reviews).toBe(3);
      expect(resumed.findings.map((finding) => finding.id)).toEqual([
        "sdk-track",
        "static-checkout",
      ]);
    }
  });

  it("limits safe scopes to exact subtrees and ancestor manifests while excluding private source", async () => {
    const repository = fixture();
    const invalidScopes = [["../outside"], ["/absolute"], ["src\\feature"]];
    let unsafeCalls = 0;
    for (const scope of invalidScopes) {
      await expect(
        runDatabuddyDiagnosis({
          repository,
          request: { ...request, scope },
          runTask: async () => {
            unsafeCalls++;
            throw new Error("Unsafe scopes must be rejected before invoking a model");
          },
        }),
      ).rejects.toThrow();
    }
    expect(unsafeCalls).toBe(0);
    write(repository, ".gitignore", "private/\nsrc/feature/ignored.ts\n");
    write(repository, "src/package.json", JSON.stringify({ name: "synthetic-source" }));
    write(repository, "src/feature/package.json", JSON.stringify({ name: "synthetic-feature" }));
    write(
      repository,
      "src/feature/route.ts",
      "export function handleSignup() { return { created: true }; }\n",
    );
    write(
      repository,
      "src/feature/client.ts",
      'export const fixtureCredential = "dbdy_synthetic_fixture_123456";\n',
    );
    const excluded = [
      ".env.local",
      "private/hidden.ts",
      "src/feature/credentials.ts",
      "src/feature/ignored.ts",
      "src/feature-extra/route.ts",
    ];
    for (const file of excluded) write(repository, file, "SYNTHETIC_PRIVATE_MARKER\n");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-diagnosis-outside-"));
    roots.push(outside);
    write(outside, "secret.ts", "SYNTHETIC_PRIVATE_MARKER\n");
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(repository, "src/feature/linked.ts"));
    const originalClient = read(repository, "src/feature/client.ts");
    const scopedInvestigation = investigation();
    scopedInvestigation.findings = [scopedInvestigation.findings[0]];
    scopedInvestigation.findings[0].evidence = [
      {
        path: "src/feature/route.ts",
        line: 1,
        quote: "export function handleSignup() { return { created: true }; }",
        reason: "The scoped route returns a successful synthetic result",
      },
    ];
    scopedInvestigation.summary =
      "The scoped signup handler declares success; external instrumentation is unknown";
    scopedInvestigation.findings[0].category = "gap";
    scopedInvestigation.findings[0].title = "The scoped signup handler has no local tracking call";
    scopedInvestigation.findings[0].explanation =
      "The full handler returns created:true without calling tracking; instrumentation outside this scope is unknown.";
    scopedInvestigation.findings[0].nextCheck =
      "Inspect external tracking call sites and perform a synthetic runtime signup.";
    const scopedReview = review();
    scopedReview.summary =
      "The scoped handler has no local event call; runtime delivery remains unverified";
    scopedReview.verdicts = [
      {
        findingId: scopedInvestigation.findings[0].id,
        verdict: "uncertain",
        reason:
          "The scoped handler only returns a created flag; external instrumentation is unknown.",
        evidence: scopedInvestigation.findings[0].evidence,
        checks: {
          source: "checked",
          callers: "limited",
          contracts: "not-applicable",
          safeguards: "limited",
        },
        finding: { ...scopedInvestigation.findings[0], basis: "hypothesis" },
      },
    ];
    let calls = 0;
    const runTask: RunTask = async ({ projectRoot, prompt }) => {
      calls++;
      for (const file of [
        "package.json",
        "src/package.json",
        "src/feature/package.json",
        "src/feature/route.ts",
      ])
        expect(fs.existsSync(path.join(projectRoot, file))).toBe(true);
      for (const file of [...excluded, "src/analytics.ts", "src/flags.ts", "src/feature/linked.ts"])
        expect(fs.existsSync(path.join(projectRoot, file))).toBe(false);
      expect(read(projectRoot, "src/feature/client.ts")).toContain("[REDACTED]");
      expect(read(projectRoot, "src/feature/client.ts")).not.toContain(
        "dbdy_synthetic_fixture_123456",
      );
      expect(prompt).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      return JSON.stringify(
        prompt.startsWith("Independently verify") ? scopedReview : scopedInvestigation,
      );
    };
    const result = await runDatabuddyDiagnosis({
      repository,
      request: { ...request, scope: ["src/feature"] },
      runTask,
    });
    expect(calls).toBe(2);
    expect(result.request.scope).toEqual(["src/feature"]);
    expect(read(repository, "src/feature/client.ts")).toBe(originalClient);
    expect(read(outside, "secret.ts")).toBe("SYNTHETIC_PRIVATE_MARKER\n");
    expect(read(repository, ".databuddy/diagnosis.json")).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(read(repository, ".databuddy/diagnosis.json")).not.toContain(
      "dbdy_synthetic_fixture_123456",
    );
    expect(result.phases.runtimeVerification).toBe("pending");
    const fileScope = await runDatabuddyDiagnosis({
      repository,
      request: { ...request, scope: ["src/feature/route.ts"] },
      runTask: async ({ projectRoot, prompt }) => {
        calls++;
        for (const file of [
          "package.json",
          "src/package.json",
          "src/feature/package.json",
          "src/feature/route.ts",
        ])
          expect(fs.existsSync(path.join(projectRoot, file))).toBe(true);
        expect(fs.existsSync(path.join(projectRoot, "src/feature/client.ts"))).toBe(false);
        expect(fs.existsSync(path.join(projectRoot, "src/feature-extra/route.ts"))).toBe(false);
        return JSON.stringify(
          prompt.startsWith("Independently verify") ? scopedReview : scopedInvestigation,
        );
      },
    });
    expect(calls).toBe(4);
    expect(fileScope.request.scope).toEqual(["src/feature/route.ts"]);
  });

  it("holds the shared setup lock during investigation and releases it after completion", async () => {
    const repository = fixture();
    let entered!: () => void;
    let releaseTask!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const runTask: RunTask = async ({ prompt }) => {
      if (prompt.startsWith("Independently verify")) return JSON.stringify(reviewForPrompt(prompt));
      entered();
      await blocked;
      return JSON.stringify(investigation());
    };
    const first = runDatabuddyDiagnosis({ repository, request, runTask });
    const completed = expect(first).resolves.toMatchObject({
      phases: { sourceVerification: "complete" },
    });
    await started;
    try {
      expect(() => acquireSetupLock(path.join(repository, ".databuddy"))).toThrow(
        /already running/i,
      );
      await expect(
        runDatabuddyDiagnosis({
          repository,
          request,
          runTask: async () => {
            throw new Error("A concurrent run must not invoke the model");
          },
        }),
      ).rejects.toThrow(/already running/i);
    } finally {
      releaseTask();
    }
    await completed;
    const release = acquireSetupLock(path.join(repository, ".databuddy"));
    release();
    expect(state(repository).status).toBe("complete");
  });
});
