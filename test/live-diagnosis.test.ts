import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDatabuddyDiagnosis } from "../src/databuddy-diagnosis.js";

// Opt in through the existing test:e2e:live script; this invokes a real local agent.
describe.skipIf(process.env.LIVE_AGENT !== "1")("Live diagnosis quality", () => {
  it("finds a reachable duplicate without misclassifying a queue contract or caller guard", async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-diagnosis-quality-"));
    const sources = {
      "package.json": JSON.stringify({ name: "synthetic-instrumentation-quality", private: true }),
      "src/events.ts": `const queue: { name: string; properties: Record<string, string> }[] = [];
// Contract: acceptance means queued, not delivered; callers must not interpret it as delivery.
export async function track(name: string, properties: Record<string, string>) {
  queue.push({ name, properties });
  return { accepted: true, delivery: "pending" };
}
`,
      "src/signup.ts": `import { track } from "./events";
// Contract: one signup_completed event for each successful signup.
export async function signup(created: boolean) {
  if (!created) return { created: false };
  await track("signup_completed", { method: "password" });
  await track("signup_completed", { method: "password" });
  return { created: true };
}
`,
      "src/outcomes.ts": `type Outcome = { type: "resolve" | "open"; verification: "passed" | "failed" };
function persist(outcome: Outcome) {
  return { status: outcome.type === "resolve" ? "resolved" : "open" };
}
// This exported entry point is the only caller; it guards resolution before persistence.
export function handleOutcome(outcome: Outcome) {
  if (outcome.type === "resolve" && outcome.verification !== "passed")
    return { status: "open" };
  return persist(outcome);
}
`,
      "src/privacy.ts": `import { sanitize } from "unavailable-privacy-dependency";
import { track } from "./events";
export async function capture(properties: Record<string, string>) {
  return track("capture", sanitize(properties));
}
`,
    };
    let passed = false;
    try {
      for (const [file, source] of Object.entries(sources)) {
        const destination = path.join(repository, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, source);
      }
      const result = await runDatabuddyDiagnosis({
        repository,
        request: {
          question:
            "Diagnose these synthetic Databuddy-style analytics flows: signup event cardinality, queue acknowledgement versus delivery, the public resolution entry point and its persistence guard, and privacy behavior behind an unavailable dependency. Return at most four findings. Trace actual callers and contracts; retain source-supported working behavior, reject incorrect problem claims, and mark unavailable evidence uncertain. Do not run the code or infer runtime delivery.",
          scope: ["src"],
        },
        config: { model: "gpt-6-sol", reasoningEffort: "medium", modelRoute: { mode: "local" } },
        signal: AbortSignal.timeout(300_000),
      });
      const problems = result.findings.filter(
        (finding) => finding.category === "problem" && finding.basis === "source",
      );
      expect(
        problems.some((finding) =>
          finding.evidence.some((evidence) => evidence.path === "src/signup.ts"),
        ),
      ).toBe(true);
      expect(
        problems.some((finding) =>
          finding.evidence.some((evidence) =>
            ["src/events.ts", "src/outcomes.ts", "src/privacy.ts"].includes(evidence.path),
          ),
        ),
      ).toBe(false);
      expect(result.phases.runtimeVerification).toBe("pending");
      for (const [file, source] of Object.entries(sources))
        expect(fs.readFileSync(path.join(repository, file), "utf8")).toBe(source);
      const history = path.join(repository, ".databuddy/runs");
      const before = fs.readdirSync(history);
      const attempts = before.flatMap(
        (file) =>
          (
            JSON.parse(fs.readFileSync(path.join(history, file), "utf8")) as {
              attempts: { agentSessionId?: string; costUsd?: number }[];
            }
          ).attempts,
      );
      expect(
        new Set(attempts.map((attempt) => attempt.agentSessionId).filter(Boolean)).size,
      ).toBeGreaterThanOrEqual(2);
      expect(attempts.every((attempt) => typeof attempt.costUsd === "number")).toBe(true);
      const cached = await runDatabuddyDiagnosis({
        repository,
        request: result.request,
        config: { model: "gpt-6-sol", reasoningEffort: "medium", modelRoute: { mode: "local" } },
        runTask: async () => {
          throw new Error("Completed proof must reuse its checkpoint");
        },
      });
      expect(cached).toEqual(result);
      expect(fs.readdirSync(history)).toEqual(before);
      passed = true;
    } finally {
      if (passed) fs.rmSync(repository, { recursive: true, force: true });
      else console.error(`Synthetic diagnosis evidence retained at ${repository}`);
    }
  }, 330_000);
});
