export function extractJsonObject(raw: string): string {
  let text = raw.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = fenced.exec(text)) !== null) last = match[1];
  if (last !== undefined) text = last.trim();
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

const CATEGORY_SLIPS: Record<string, string> = {
  issue: "problem",
  bug: "problem",
  defect: "problem",
  risk: "problem",
  missing: "gap",
  hypothesis: "gap",
  ok: "working",
  works: "working",
  recommend: "recommendation",
  suggestion: "recommendation",
  improvement: "recommendation",
};

const BASIS_SLIPS: Record<string, string> = {
  code: "source",
  evidence: "source",
  observed: "source",
  inferred: "hypothesis",
  assumption: "hypothesis",
  hypothetical: "hypothesis",
};

export function normalizeFindingSlips(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.findings)) return value;
  const findings = envelope.findings.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return finding;
    const record = { ...(finding as Record<string, unknown>) };
    if (typeof record.category === "string") {
      const key = record.category.trim().toLowerCase();
      if (key === "hypothesis") {
        record.category = "gap";
        if (record.basis === undefined) record.basis = "hypothesis";
      } else if (CATEGORY_SLIPS[key]) record.category = CATEGORY_SLIPS[key];
      else record.category = key;
    }
    if (typeof record.basis === "string") {
      const key = record.basis.trim().toLowerCase();
      record.basis = BASIS_SLIPS[key] ?? key;
    }
    return record;
  });
  return { ...envelope, findings };
}

export function isLiteralValue(value: string): boolean {
  const text = value.trim();
  if (/^\S+$/.test(text)) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// A supported problem with a limited check is left to the verifier on purpose:
// downgrading it here hid confirmed defects whose limited check concerned code
// the claim never depended on.
export function normalizeVerdictSlips(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.verdicts)) return value;
  const verdicts = envelope.verdicts.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const verdict = { ...(raw as Record<string, unknown>) };
    const finding =
      verdict.finding && typeof verdict.finding === "object" && !Array.isArray(verdict.finding)
        ? { ...(verdict.finding as Record<string, unknown>) }
        : undefined;
    if (verdict.verdict === "rejected") {
      delete verdict.finding;
      return verdict;
    }
    if (!finding) return verdict;
    if (verdict.verdict === "supported" && finding.basis === "hypothesis")
      verdict.verdict = "uncertain";
    if (verdict.verdict === "uncertain") finding.basis = "hypothesis";
    verdict.finding = finding;
    return verdict;
  });
  return { ...envelope, verdicts };
}

interface Anchor {
  path: string;
  line: number;
  quote: string;
}

export function relocateAnchor<T extends Anchor>(anchor: T, contents: Map<string, string>): T {
  const source = contents.get(anchor.path);
  if (source === undefined) return anchor;
  const lines = source.split(/\r?\n/);
  const quote = anchor.quote;
  const quoteLines = quote.split(/\r?\n/);
  const matchesAt = (index: number): boolean => {
    if (quoteLines.length === 1) return lines[index]?.includes(quote) ?? false;
    return lines
      .slice(index, index + quoteLines.length + 1)
      .join("\n")
      .includes(quote);
  };
  const cited = anchor.line - 1;
  if (cited >= 0 && cited < lines.length) {
    const window = lines.slice(cited, cited + 20).join("\n");
    if (window.includes(quote)) return anchor;
  }
  let best: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    if (!matchesAt(index)) continue;
    if (best === undefined || Math.abs(index - cited) < Math.abs(best - cited)) best = index;
  }
  if (best !== undefined) return { ...anchor, line: best + 1 };
  // Backslash and whitespace slips (escaped regexes, template literals): match
  // loosely, then quote the real source line so the evidence stays exact.
  if (quoteLines.length !== 1) return anchor;
  const loose = looseForm(quote);
  if (loose.length < 12) return anchor;
  let looseBest: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    if (!looseForm(lines[index] ?? "").includes(loose)) continue;
    if (looseBest === undefined || Math.abs(index - cited) < Math.abs(looseBest - cited))
      looseBest = index;
  }
  if (looseBest === undefined) return anchor;
  return { ...anchor, line: looseBest + 1, quote: (lines[looseBest] ?? "").trim() };
}

function looseForm(text: string): string {
  return text.replace(/\\/g, "").replace(/\s+/g, " ").trim();
}

export function relocateInvestigationAnchors(
  value: unknown,
  contents: Map<string, string>,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.findings)) return value;
  return {
    ...envelope,
    findings: envelope.findings.map((finding) => relocateFindingAnchors(finding, contents)),
  };
}

function relocateFindingAnchors(finding: unknown, contents: Map<string, string>): unknown {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return finding;
  const record = finding as Record<string, unknown>;
  if (!Array.isArray(record.evidence)) return finding;
  return {
    ...record,
    evidence: record.evidence.map((anchor) =>
      isAnchor(anchor) ? relocateAnchor(anchor, contents) : anchor,
    ),
  };
}

export function relocateVerdictAnchors(value: unknown, contents: Map<string, string>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.verdicts)) return value;
  return {
    ...envelope,
    verdicts: envelope.verdicts.map((verdict) => {
      const relocated = relocateFindingAnchors(verdict, contents);
      if (!relocated || typeof relocated !== "object") return relocated;
      const record = relocated as Record<string, unknown>;
      if (record.finding === undefined) return record;
      return { ...record, finding: relocateFindingAnchors(record.finding, contents) };
    }),
  };
}

function isAnchor(value: unknown): value is Anchor {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    typeof record.line === "number" &&
    typeof record.quote === "string"
  );
}

export function evidenceWindows(
  anchors: readonly Anchor[],
  contents: Map<string, string>,
  radius = 8,
  maxChars = 60_000,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  let total = 0;
  for (const anchor of anchors) {
    const key = `${anchor.path}:${anchor.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = contents.get(anchor.path);
    if (source === undefined) continue;
    const lines = source.split(/\r?\n/);
    const start = Math.max(0, anchor.line - 1 - radius);
    const end = Math.min(lines.length, anchor.line + radius);
    const body = lines
      .slice(start, end)
      .map((text, index) => `${String(start + index + 1).padStart(6)}\t${text}`)
      .join("\n");
    const part = `--- ${anchor.path} lines ${start + 1}-${end}\n${body}`;
    if (total + part.length > maxChars) break;
    total += part.length;
    parts.push(part);
  }
  return parts.join("\n");
}
