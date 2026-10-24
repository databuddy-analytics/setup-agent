import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dedupeFindings,
  renderReportMarkdown,
  runDatabuddyReport,
  scanBacklog,
  validateFindingRecommendations,
  validateWorklist,
  worklistFor,
} from "../databuddy-report.js";
import { isLiteralValue } from "../model-output.js";
import { parseScanOutput, renderActionMap, runScanPrepass } from "../scan-prepass.js";
import type { DatabuddyDiagnosisFinding } from "../schema.js";

type RunTask = NonNullable<Parameters<typeof runDatabuddyReport>[0]["runTask"]>;

const roots: string[] = [];

function write(repository: string, file: string, contents: string): void {
  const destination = path.join(repository, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function fixture(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-report-"));
  roots.push(repository);
  write(repository, "package.json", JSON.stringify({ dependencies: { next: "fixture" } }));
  write(
    repository,
    "app/layout.tsx",
    'import { Databuddy } from "@databuddy/sdk/react";\nexport default function Layout({ children }) {\n  return <html><body><Databuddy clientId="x" trackErrors={false} />{children}</body></html>;\n}\n',
  );
  write(
    repository,
    "app/actions.ts",
    'import { track } from "@databuddy/sdk";\nexport async function signup() {\n  const user = { id: "synthetic-user" };\n  track("signup_completed", { method: "email" });\n  return { created: true, user };\n}\nexport async function checkout() {\n  return { paid: true };\n}\n',
  );
  return repository;
}

const scanJson = JSON.stringify({
  summary: { includedFiles: 2, warnings: [] },
  rows: [
    {
      path: "app/actions.ts",
      start: 7,
      end: 9,
      coverage: "missing",
      category: "revenue",
      priority: 1.5,
      action: { label: "checkout" },
      suggestedEvent: { name: "checkout_completed", properties: [] },
    },
    {
      path: "app/actions.ts",
      start: 2,
      end: 6,
      coverage: "covered",
      category: "activation",
      priority: 0.2,
      action: { label: "signup" },
    },
  ],
});

function finding(
  area: string,
  index: number,
  overrides: Partial<DatabuddyDiagnosisFinding>,
): DatabuddyDiagnosisFinding {
  return {
    id: `${area}_${index}`,
    area: "events",
    category: "working",
    basis: "source",
    title: `${area} finding ${index}`,
    explanation: "Established from the handler.",
    evidence: [
      { path: "app/actions.ts", line: 4, quote: 'track("signup_completed"', reason: "call" },
    ],
    nextCheck: "Send one synthetic event.",
    ...overrides,
  };
}

const investigations: Record<
  string,
  { summary: string; findings: DatabuddyDiagnosisFinding[]; unknowns: string[] }
> = {
  events: {
    summary: "Signup is tracked; checkout is not.",
    findings: [
      finding("events", 1, {}),
      finding("events", 2, {
        category: "recommendation",
        title: "Track checkout completion",
        evidence: [
          { path: "app/actions.ts", line: 8, quote: "return { paid: true };", reason: "outcome" },
        ],
        recommendation: {
          kind: "custom_event",
          priority: "journey",
          eventName: "checkout_completed",
          properties: { plan: "plan tier" },
        },
      }),
      finding("events", 3, {
        category: "recommendation",
        title: "Signup to checkout funnel",
        recommendation: {
          kind: "funnel",
          priority: "journey",
          steps: [
            { type: "event", value: "signup_completed" },
            { type: "event", value: "checkout_completed" },
          ],
        },
      }),
    ],
    unknowns: ["Delivery not verified"],
  },
  tracker: {
    summary: "The tracker is mounted once without error tracking.",
    findings: [
      finding("tracker", 1, {
        area: "sdk",
        category: "recommendation",
        title: "Enable error tracking",
        evidence: [
          { path: "app/layout.tsx", line: 3, quote: "trackErrors={false}", reason: "option" },
        ],
        recommendation: {
          kind: "tracker_setting",
          priority: "quality",
          option: "trackErrors",
          value: "true",
        },
      }),
    ],
    unknowns: [],
  },
};

function reviewFor(prompt: string) {
  const area = /Area: (\w+)\./.exec(prompt)?.[1] ?? "events";
  const expected = JSON.parse(
    /Expected finding IDs: (\[[^\]]*\])/.exec(prompt)?.[1] ?? "[]",
  ) as string[];
  const originals = investigations[area]?.findings ?? [];
  return {
    summary: `${area} verified`,
    verdicts: expected.map((id) => {
      const original = originals.find((item) => item.id === id)!;
      return {
        findingId: id,
        verdict: "supported",
        reason: "Independently confirmed in source.",
        evidence: original.evidence,
        checks: {
          source: "checked",
          callers: "checked",
          contracts: "checked",
          safeguards: "checked",
        },
        finding: original,
      };
    }),
    unknowns: ["Runtime not verified"],
  };
}

afterEach(() => {
  for (const repository of roots.splice(0)) fs.rmSync(repository, { recursive: true, force: true });
});

describe("scan prepass", () => {
  it("parses scan output and renders a ranked action map", async () => {
    const parsed = parseScanOutput(`notice\n${scanJson}`);
    expect(parsed.rows).toHaveLength(2);
    const map = renderActionMap(parsed.rows, ".databuddy-scan/actions.json");
    expect(map).toContain(
      "app/actions.ts:7 [missing/revenue p1.50] checkout -> suggest checkout_completed",
    );
    expect(map.indexOf("Missing or partial")).toBeLessThan(map.indexOf("Already tracked"));
    const prepass = await runScanPrepass({
      scopes: [],
      mode: "auto",
      runner: async () => scanJson,
    });
    expect(prepass.summary).toMatchObject({
      status: "complete",
      actions: 2,
      coverage: { missing: 1, covered: 1 },
    });
    const failed = await runScanPrepass({
      scopes: ["app"],
      mode: "auto",
      runner: async () => {
        throw new Error("npx offline");
      },
    });
    expect(failed.summary).toMatchObject({ status: "unavailable", detail: "npx offline" });
    expect(failed.actionMap).toBe("");
  });
});

describe("recommendation validation", () => {
  it("requires kind-specific fields and known funnel steps", () => {
    const contents = new Map([["a.ts", 'track("existing_event")']]);
    const ok = [
      finding("events", 1, {
        category: "recommendation",
        recommendation: {
          kind: "funnel",
          priority: "journey",
          steps: [
            { type: "path", value: "/pricing" },
            { type: "event", value: "existing_event" },
          ],
        },
      }),
    ];
    expect(() => validateFindingRecommendations(ok, contents, new Set())).not.toThrow();
    const bad = [
      finding("events", 2, {
        category: "recommendation",
        recommendation: { kind: "tracker_setting", priority: "quality", option: "trackErrors" },
      }),
      finding("events", 3, {
        category: "recommendation",
        recommendation: {
          kind: "goal",
          priority: "journey",
          target: { type: "event", value: "never_emitted" },
        },
      }),
    ];
    expect(() => validateFindingRecommendations(bad, contents, new Set())).toThrow(
      /needs value.*never_emitted/s,
    );
    const fromTest = [
      finding("events", 4, {
        category: "recommendation",
        evidence: [{ path: "src/auth/sign-in.test.ts", line: 3, quote: "x", reason: "y" }],
        recommendation: {
          kind: "goal",
          priority: "journey",
          target: { type: "path", value: "/x" },
        },
      }),
    ];
    expect(() => validateFindingRecommendations(fromTest, contents, new Set())).toThrow(
      /not the test file/,
    );
  });
});

describe("scan backlog and literal values", () => {
  it("lists untracked scan actions that no recommendation covers", () => {
    const rows = parseScanOutput(scanJson).rows;
    const covering = finding("events", 1, {
      category: "recommendation",
      evidence: [{ path: "app/actions.ts", line: 8, quote: "x", reason: "y" }],
      recommendation: { kind: "custom_event", priority: "journey", eventName: "paid" },
    });
    expect(scanBacklog(rows, [])).toMatchObject([
      {
        path: "app/actions.ts",
        line: 7,
        suggestedEvent: "checkout_completed",
        coverage: "missing",
      },
    ]);
    expect(scanBacklog(rows, [covering])).toEqual([]);
  });

  it("accepts literal tracker values and rejects prose", () => {
    for (const value of ["true", "0.5", "https://cdn.databuddy.cc/databuddy.js", '["/users/*"]'])
      expect(isLiteralValue(value)).toBe(true);
    expect(isLiteralValue("Preserve the current array and add /insights/*.")).toBe(false);
  });
});

describe("salvage", () => {
  it("keeps the area and drops only the finding whose recommendation stays invalid", async () => {
    const repository = fixture();
    const prose = {
      ...investigations.tracker,
      findings: [
        investigations.tracker.findings[0],
        finding("tracker", 2, {
          area: "sdk",
          category: "recommendation",
          title: "Mask paths",
          recommendation: {
            kind: "tracker_setting",
            priority: "quality",
            option: "maskPatterns",
            value: "add /insights/* to the array",
          },
        }),
      ],
    };
    const investigationCalls: string[] = [];
    const runTask: RunTask = async ({ prompt }) => {
      if (prompt.startsWith("Independently verify")) return JSON.stringify(reviewFor(prompt));
      investigationCalls.push(prompt.includes("Validation failed") ? "repair" : "first");
      return JSON.stringify(prose);
    };
    const result = await runDatabuddyReport({
      repository,
      request: { areas: ["tracker"], scope: [] },
      runTask,
      scanRunner: async () => scanJson,
    });
    expect(investigationCalls).toEqual(["first", "repair"]);
    expect(result.findings.map((item) => item.id)).toEqual(["tracker_1"]);
    expect(result.unknowns.some((unknown) => unknown.startsWith("tracker_2: dropped"))).toBe(true);
  });
});

describe("worklist", () => {
  it("requires a nearby recommendation or an explicit decision for every top gap", () => {
    const rows = parseScanOutput(scanJson).rows;
    const worklist = worklistFor(rows);
    expect(worklist.map((row) => row.start)).toEqual([7]);
    const base = {
      summary: "s",
      unknowns: [],
      decisions: [] as { path: string; line: number; decision: "skip"; reason: string }[],
    };
    expect(() => validateWorklist({ ...base, findings: [] }, worklist)).toThrow(
      /app\/actions.ts:7/,
    );
    expect(() =>
      validateWorklist(
        {
          ...base,
          findings: [],
          decisions: [{ path: "app/actions.ts", line: 7, decision: "skip", reason: "operational" }],
        },
        worklist,
      ),
    ).not.toThrow();
    const covering = finding("events", 1, {
      category: "recommendation",
      evidence: [{ path: "app/actions.ts", line: 9, quote: "x", reason: "y" }],
      recommendation: { kind: "custom_event", priority: "journey", eventName: "paid" },
    });
    expect(() => validateWorklist({ ...base, findings: [covering] }, worklist)).toThrow(
      /use the scanner's name checkout_completed/,
    );
    const named = finding("events", 1, {
      category: "recommendation",
      evidence: [{ path: "app/actions.ts", line: 9, quote: "x", reason: "y" }],
      recommendation: {
        kind: "custom_event",
        priority: "journey",
        eventName: "checkout_completed",
      },
    });
    expect(() => validateWorklist({ ...base, findings: [named] }, worklist)).not.toThrow();
    const justified = finding("events", 1, {
      category: "recommendation",
      explanation:
        "The scanner suggested checkout_completed, but payment is confirmed later, so paid is the outcome.",
      evidence: [{ path: "app/actions.ts", line: 9, quote: "x", reason: "y" }],
      recommendation: { kind: "custom_event", priority: "journey", eventName: "paid" },
    });
    expect(() => validateWorklist({ ...base, findings: [justified] }, worklist)).not.toThrow();
    const backlog = scanBacklog(
      rows,
      [],
      [{ path: "app/actions.ts", line: 7, decision: "skip", reason: "operational only" }],
    );
    expect(backlog[0]).toMatchObject({ decision: "skip", reason: "operational only" });
  });
});

describe("dedupeFindings", () => {
  it("collapses the same recommendation or problem found by two areas, keeping the higher priority", () => {
    const funnel = (area: string, priority: "journey" | "enrichment") =>
      finding(area, 1, {
        category: "recommendation",
        recommendation: {
          kind: "funnel",
          priority,
          steps: [
            { type: "path", value: "/pricing" },
            { type: "event", value: "signup_completed" },
          ],
        },
      });
    const problem = (area: string) =>
      finding(area, 2, { category: "problem", title: `${area} problem` });
    const deduped = dedupeFindings([
      funnel("events", "enrichment"),
      problem("events"),
      funnel("server", "journey"),
      problem("tracker"),
      finding("tracker", 3, {
        category: "working",
        evidence: [{ path: "app/layout.tsx", line: 1, quote: "x", reason: "y" }],
      }),
    ]);
    expect(deduped.map((item) => item.id)).toEqual(["events_2", "server_1", "tracker_3"]);
    expect(deduped[0].explanation).toContain("Also found as tracker_2");
    expect(deduped[1].recommendation?.priority).toBe("journey");
    const near = dedupeFindings([
      finding("events", 5, {
        category: "problem",
        evidence: [{ path: "a.ts", line: 10, quote: "x", reason: "y" }],
      }),
      finding("server", 5, {
        category: "problem",
        evidence: [{ path: "a.ts", line: 40, quote: "z", reason: "y" }],
      }),
      finding("growth", 5, {
        category: "problem",
        evidence: [{ path: "a.ts", line: 400, quote: "w", reason: "y" }],
      }),
    ]);
    expect(near.map((item) => item.id)).toEqual(["events_5", "growth_5"]);
  });

  it("merges one outcome reported under different kinds, names and funnel entries", () => {
    const checkout = [{ path: "components/cart/modal.tsx", line: 218, quote: "x", reason: "y" }];
    const event = (
      area: string,
      index: number,
      kind: "custom_event" | "server_event",
      eventName: string,
      priority: "journey" | "enrichment",
    ) =>
      finding(area, index, {
        category: "recommendation",
        evidence: checkout,
        recommendation: { kind, priority, eventName },
      });
    const funnel = (area: string, entry: string, end: string) =>
      finding(area, 9, {
        category: "recommendation",
        recommendation: {
          kind: "funnel",
          priority: "journey",
          steps: [
            { type: "path", value: entry },
            { type: "event", value: end },
          ],
        },
      });
    const deduped = dedupeFindings([
      event("events", 1, "custom_event", "checkout_started", "journey"),
      event("tracker", 1, "custom_event", "checkout_started", "enrichment"),
      event("server", 1, "server_event", "checkout_handoff_started", "enrichment"),
      funnel("events", "/search", "checkout_started"),
      funnel("growth", "/", "checkout_handoff_started"),
      finding("tracker", 2, {
        category: "gap",
        evidence: [{ path: "app/layout.tsx", line: 36, quote: "x", reason: "y" }],
      }),
      finding("events", 2, {
        category: "problem",
        evidence: [{ path: "app/layout.tsx", line: 36, quote: "x", reason: "y" }],
      }),
    ]);
    expect(deduped.map((item) => item.id)).toEqual(["events_1", "events_9", "tracker_2"]);
    expect(deduped[0].explanation).toContain("Also found as server_1");
    expect(deduped[1].explanation).toContain("Also found as growth_9");
  });
});

describe("Databuddy utilization report", () => {
  it("keeps the other areas when one area fails after its repair", async () => {
    const repository = fixture();
    const runTask: RunTask = async ({ prompt }) => {
      const area = /Area: (\w+)\./.exec(prompt)?.[1];
      if (area === "events") return "{ not json at all";
      return JSON.stringify(
        prompt.startsWith("Independently verify") ? reviewFor(prompt) : investigations.tracker,
      );
    };
    const result = await runDatabuddyReport({
      repository,
      request: { areas: ["events", "tracker"], scope: [] },
      runTask,
      scanRunner: async () => scanJson,
    });
    expect(Object.keys(result.areas)).toEqual(["tracker"]);
    expect(result.findings.map((item) => item.id)).toEqual(["tracker_1"]);
    expect(
      result.unknowns.some((unknown) => unknown.startsWith("The events area did not complete")),
    ).toBe(true);
  });

  it("runs areas in parallel, verifies each, merges findings, resumes from the checkpoint and renders markdown", async () => {
    const repository = fixture();
    const inFlight = new Set<string>();
    let maxParallel = 0;
    const phases: string[] = [];
    const runTask: RunTask = async ({ prompt }) => {
      const area = /Area: (\w+)\./.exec(prompt)?.[1] ?? "unknown";
      const kind = prompt.startsWith("Independently verify") ? "verify" : "investigate";
      phases.push(`${kind}:${area}`);
      inFlight.add(`${kind}:${area}`);
      maxParallel = Math.max(maxParallel, inFlight.size);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight.delete(`${kind}:${area}`);
      if (kind === "verify") return JSON.stringify(reviewFor(prompt));
      if (kind === "investigate" && area === "events")
        expect(prompt).toContain("checkout -> suggest checkout_completed");
      return JSON.stringify(investigations[area]);
    };
    const result = await runDatabuddyReport({
      repository,
      request: { journey: "Sign up and pay", areas: ["events", "tracker"], scope: [] },
      runTask,
      scanRunner: async () => scanJson,
    });
    expect(maxParallel).toBeGreaterThanOrEqual(2);
    expect(phases.filter((phase) => phase.startsWith("investigate")).sort()).toEqual([
      "investigate:events",
      "investigate:tracker",
    ]);
    expect(result.framework).toBe("nextjs");
    expect(result.scan).toMatchObject({ status: "complete", actions: 2 });
    expect(result.findings.map((item) => item.id).sort()).toEqual([
      "events_1",
      "events_2",
      "events_3",
      "tracker_1",
    ]);
    expect(result.findings.find((item) => item.id === "tracker_1")?.recommendation).toMatchObject({
      option: "trackErrors",
      value: "true",
    });
    const markdown = renderReportMarkdown(result);
    expect(markdown).toContain("### Tracker settings");
    expect(markdown).toContain("trackErrors: true");
    expect(markdown).toContain("steps signup_completed -> checkout_completed");
    expect(result.backlog).toEqual([]);

    const calls = phases.length;
    const cached = await runDatabuddyReport({
      repository,
      request: { journey: "Sign up and pay", areas: ["events", "tracker"], scope: [] },
      runTask,
      scanRunner: async () => scanJson,
    });
    expect(phases.length).toBe(calls);
    expect(cached).toEqual(result);
  });

  it("continues without the scan when it is unavailable and records that as an unknown", async () => {
    const repository = fixture();
    const runTask: RunTask = async ({ prompt }) =>
      JSON.stringify(
        prompt.startsWith("Independently verify") ? reviewFor(prompt) : investigations.tracker,
      );
    const result = await runDatabuddyReport({
      repository,
      request: { areas: ["tracker"], scope: [] },
      runTask,
      scanRunner: async () => {
        throw new Error("scan missing");
      },
    });
    expect(result.scan.status).toBe("unavailable");
    expect(result.unknowns.some((unknown) => unknown.includes("scan"))).toBe(true);
  });
});
