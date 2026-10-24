import { describe, expect, it } from "vitest";
import {
  evidenceWindows,
  extractJsonObject,
  normalizeFindingSlips,
  normalizeVerdictSlips,
  relocateAnchor,
} from "../model-output.js";

const contents = new Map([
  [
    "app/page.tsx",
    [
      "import { track } from '@databuddy/sdk';",
      "",
      "export function Page() {",
      "  const onSubmit = async () => {",
      "    await save();",
      '    track("signup_completed", { method: "email" });',
      "  };",
      "  return null;",
      "}",
      "",
      "export function Other() {",
      '  track("signup_completed", { method: "social" });',
      "}",
    ].join("\n"),
  ],
]);

describe("extractJsonObject", () => {
  it("takes the last fenced block, or the outermost object inside narration", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nDone.')).toBe('{"a":1}');
    expect(extractJsonObject('I inspected the files.\n{"a":{"b":2}}\nThat is all.')).toBe(
      '{"a":{"b":2}}',
    );
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });
});

describe("normalizeFindingSlips", () => {
  it("maps a hypothesis category onto a gap with a hypothesis basis and fixes other slips", () => {
    const value = normalizeFindingSlips({
      findings: [
        { id: "a", category: "hypothesis" },
        { id: "b", category: "Issue", basis: "code" },
        { id: "c", category: "working", basis: "source" },
      ],
    }) as { findings: Record<string, unknown>[] };
    expect(value.findings[0]).toMatchObject({ category: "gap", basis: "hypothesis" });
    expect(value.findings[1]).toMatchObject({ category: "problem", basis: "source" });
    expect(value.findings[2]).toMatchObject({ category: "working", basis: "source" });
  });
});

describe("normalizeVerdictSlips", () => {
  it("labels uncertain findings as hypotheses, strips findings from rejections, and leaves limited checks to the verifier", () => {
    const value = normalizeVerdictSlips({
      verdicts: [
        {
          findingId: "a",
          verdict: "supported",
          checks: { source: "checked", callers: "limited" },
          finding: { id: "a", category: "problem", basis: "source" },
        },
        { findingId: "b", verdict: "rejected", checks: {}, finding: { id: "b" } },
        {
          findingId: "c",
          verdict: "supported",
          checks: { source: "checked", callers: "checked" },
          finding: { id: "c", category: "recommendation", basis: "source" },
        },
      ],
    }) as { verdicts: Record<string, unknown>[] };
    expect(value.verdicts[0]).toMatchObject({ verdict: "supported", finding: { basis: "source" } });
    expect(value.verdicts[1].finding).toBeUndefined();
    expect(value.verdicts[2]).toMatchObject({ verdict: "supported", finding: { basis: "source" } });
  });
});

describe("relocateAnchor", () => {
  it("keeps anchors whose quote sits within the cited window", () => {
    const anchor = {
      path: "app/page.tsx",
      line: 4,
      quote: 'track("signup_completed", { method: "email" });',
    };
    expect(relocateAnchor(anchor, contents)).toBe(anchor);
  });

  it("moves an off-by-a-few-lines anchor to the nearest occurrence of its quote", () => {
    const quote = 'track("signup_completed"';
    expect(relocateAnchor({ path: "app/page.tsx", line: 30, quote }, contents).line).toBe(12);
    expect(relocateAnchor({ path: "app/page.tsx", line: 13, quote }, contents).line).toBe(12);
    expect(relocateAnchor({ path: "app/page.tsx", line: 1, quote }, contents).line).toBe(1);
  });

  it("repairs escaping slips by matching loosely and quoting the real line", () => {
    const source = new Map([
      ["proxy.ts", 'const matcher = [\n  "/((?!api|_next/static|.*\\\\.(?:svg|png)$).*)",\n];\n'],
    ]);
    const anchor = {
      path: "proxy.ts",
      line: 9,
      quote: '"/((?!api|_next/static|.*\\.(?:svg|png)$).*)",',
    };
    const fixed = relocateAnchor(anchor, source);
    expect(fixed.line).toBe(2);
    expect(fixed.quote).toBe('"/((?!api|_next/static|.*\\\\.(?:svg|png)$).*)",');
  });

  it("leaves anchors untouched when the quote or file is absent", () => {
    const missing = { path: "app/page.tsx", line: 2, quote: "never here" };
    expect(relocateAnchor(missing, contents)).toBe(missing);
    const unknown = { path: "nope.ts", line: 1, quote: "track" };
    expect(relocateAnchor(unknown, contents)).toBe(unknown);
  });
});

describe("evidenceWindows", () => {
  it("renders numbered source around each distinct anchor within the size cap", () => {
    const text = evidenceWindows(
      [
        { path: "app/page.tsx", line: 6, quote: "x" },
        { path: "app/page.tsx", line: 6, quote: "y" },
      ],
      contents,
      2,
    );
    expect(text).toContain("--- app/page.tsx lines 4-8");
    expect(text).toContain('     6\t    track("signup_completed", { method: "email" });');
    expect(text.split("--- ").length - 1).toBe(1);
    expect(evidenceWindows([{ path: "app/page.tsx", line: 6, quote: "x" }], contents, 2, 10)).toBe(
      "",
    );
  });

  it("drops a recommendation missing its kind or priority instead of failing the finding", () => {
    const normalized = normalizeFindingSlips({
      findings: [
        { id: "a", category: "recommendation", recommendation: { eventName: "signup_completed" } },
        {
          id: "b",
          category: "recommendation",
          recommendation: { kind: "custom_event", priority: "journey" },
        },
      ],
    }) as { findings: Record<string, unknown>[] };
    expect(normalized.findings[0]).not.toHaveProperty("recommendation");
    // Without its object, a recommendation is kept as a gap.
    expect(normalized.findings[0].category).toBe("gap");
    expect(normalized.findings[1].recommendation).toEqual({
      kind: "custom_event",
      priority: "journey",
    });
    const verdicts = normalizeVerdictSlips({
      verdicts: [
        {
          findingId: "a",
          verdict: "supported",
          finding: {
            category: "problem",
            basis: "source",
            recommendation: { kind: "goal", priority: "journey" },
          },
        },
      ],
    }) as { verdicts: { finding: Record<string, unknown> }[] };
    expect(verdicts.verdicts[0].finding).not.toHaveProperty("recommendation");
  });
});
