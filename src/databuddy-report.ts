import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { runSetupTask } from "./agents/run-task.js";
import type { AgentProgress } from "./agents/types.js";
import { atomicWriteFileSync } from "./atomic-file.js";
import {
  anchorsOf,
  BOUNDARY,
  parseResponse,
  reconcileReview,
  selectFiles,
  validateInvestigation,
  verifiedUnknowns,
} from "./databuddy-diagnosis.js";
import {
  type DatabuddyReferenceTopic,
  referenceDigest,
  referenceIndex,
} from "./databuddy-reference.js";
import { detectFramework } from "./databuddy-setup.js";
import { acquireSetupLock } from "./lock.js";
import type { AgentBackend } from "./model.js";
import {
  evidenceWindows,
  isLiteralValue,
  normalizeFindingSlips,
  normalizeVerdictSlips,
  relocateInvestigationAnchors,
  relocateVerdictAnchors,
} from "./model-output.js";
import {
  assertSafeFilePath,
  readSource,
  sourceFiles,
  writeSnapshot,
} from "./repository-snapshot.js";
import {
  createScanRunner,
  runScanPrepass,
  SCAN_SNAPSHOT_FILE,
  type ScanPrepass,
  type ScanRow,
  type ScanRunner,
} from "./scan-prepass.js";
import {
  type DatabuddyActionDecision,
  type DatabuddyDiagnosisFinding,
  type DatabuddyDiagnosisInvestigation,
  type DatabuddyDiagnosisReview,
  type DatabuddyReportArea,
  type DatabuddyReportCheckpoint,
  DatabuddyReportCheckpointSchema,
  type DatabuddyReportRequest,
  DatabuddyReportRequestSchema,
  type DatabuddyReportResult,
  DatabuddyReportResultSchema,
  type DatabuddyScanBacklogItem,
} from "./schema.js";
import { createRepositoryTaskRunner } from "./task-execution.js";
import { createSetupRedactor } from "./terminal.js";

interface ReportOptions {
  repository: string;
  request: {
    websiteId?: string;
    journey?: string;
    scope?: string[];
    areas?: DatabuddyReportArea[];
    scan?: "auto" | "off";
  };
  agentType?: AgentBackend;
  config?: Record<string, unknown>;
  maxCostUsd?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  runTask?: typeof runSetupTask;
  scanRunner?: ScanRunner;
  scanBin?: string;
}

interface AreaSpec {
  topics: DatabuddyReferenceTopic[];
  usesActionMap: boolean;
  focus: string;
}

const AREA_SPECS: Record<DatabuddyReportArea, AreaSpec> = {
  events: {
    topics: ["custom-events", "query-api"],
    usesActionMap: true,
    focus: `Custom events, funnels and goals. Start from the action map: for every missing or partial action that matters to the journey or to activation, revenue or retention, propose one event with a recommendation of kind custom_event (browser handler after confirmed success) or server_event (authoritative server outcome), naming the exact handler line as evidence, a snake_case past-tense name (reuse the scan's suggestion when it fits the event-design rules) and low-cardinality properties. Report existing events that fire on failure paths, fire twice, or carry sensitive or unbounded properties as problems. Then propose the funnels (kind funnel, 2 to 10 ordered event or path steps that exist or are proposed here) and goals (kind goal) that the stated journey needs. When the journey continues on another origin (a CTA to a separate app or signup domain), check whether anonId and sessionId are carried to it as the custom-events reference describes, and recommend that handoff as a custom_event finding anchored on the CTA when it is missing. Rank by priority: journey, quality, enrichment.`,
  },
  tracker: {
    topics: ["tracker", "frameworks", "privacy"],
    usesActionMap: false,
    focus: `The browser tracker. Confirm where it is mounted and that pageviews fire once per navigation. Audit every tracker option against this application: error tracking, web vitals, outgoing links, attribute tracking, interactions, hash routing, skip and mask patterns for identifier-bearing routes, sampling, and the production script URL. Each change is a recommendation of kind tracker_setting with option and the literal value to set (true, 0.5, a URL string or a JSON array; never prose), anchored on the current configuration line. Report duplicate mounts, debug builds in production, missing client IDs and consent gaps as problems.`,
  },
  server: {
    topics: ["server-sdk", "custom-events"],
    usesActionMap: true,
    focus: `Server-side measurement. Find authoritative outcomes that only the server knows: payments, subscription changes, signups confirmed by the auth layer, jobs, webhooks, API usage. Where the browser cannot see the outcome, recommend a server_event through the Node SDK with the key scope it needs, anchored on the server handler line. Report server tracking that fires before the outcome is committed, retries that can double-send, or properties that carry personal data as problems.`,
  },
  growth: {
    topics: ["feature-flags", "links", "uptime", "ai-agents-mcp"],
    usesActionMap: false,
    focus: `Feature flags, short links, uptime monitors, AI crawler analytics and MCP instrumentation. Recommend a flag (kind flag) only where the code shows a gated or staged rollout, campaign links (kind link) where campaign, share or referral URLs exist, monitors (kind monitor) for the application's own public entry points, health routes and marketing domain, AI crawler tracking at a public request boundary, and MCP tracking only where an MCP server actually exists in the source. Each recommendation names the exact tool, option or dashboard step from the reference files.`,
  },
};

const PRIORITY_ORDER: Record<string, number> = { journey: 0, quality: 1, enrichment: 2 };

const RECOMMENDATION_FIELDS = `"recommendation":{"kind":"tracker_setting|custom_event|server_event|funnel|goal|flag|link|monitor","priority":"journey|quality|enrichment","option":"trackErrors (tracker_setting only)","value":"true | 0.5 | https://cdn.databuddy.cc/databuddy.js | [\\"/users/*\\",\\"/insights/*\\"] (tracker_setting only: the literal to set, never prose)","eventName":"signup_completed (custom_event or server_event only)","properties":{"method":"allowed values (custom_event or server_event only)"},"steps":[{"type":"event|path","value":"signup_completed"}],"target":{"type":"event|path","value":"checkout_completed"}}`;

const WORKLIST_SIZE = 30;

const WORKLIST_RULES = `Required worklist: decide every item below. Each must end up either as a recommendation finding anchored within 5 lines of it, or as an entry in "decisions" with decision skip (not worth a product event, say why) or unverifiable (the success boundary is outside the snapshot). Items without a decision fail validation. When an item carries a suggested name, use it unless it misnames the business outcome (the scanner derives names from handler labels, so "action_left" for leaving an organization or "password_submitted" for a completed reset are wrong); then use a snake_case past-tense outcome name and quote the suggested name in the explanation, which is required for the override to pass validation. Skip cancel, dismiss, close, copy, expand, filter and other UI-state actions, editor save churn, and settings toggles with no product decision behind them; recommend outcomes that change what a user has or can do (created, completed, upgraded, connected, invited, removed, enabled) or that the stated journey depends on.`;

const isNear = (anchor: { path: string; line: number }, row: ScanRow) =>
  anchor.path === row.path && anchor.line >= row.start - 5 && anchor.line <= row.end + 5;

const failingIds = (message: string) =>
  new Set([...message.matchAll(/(?:^|; |: )([a-z][a-z0-9_-]{0,63}): /g)].map((m) => m[1]));

export function worklistFor(rows: ScanRow[]): ScanRow[] {
  return rows
    .filter((row) => row.coverage === "missing" || row.coverage === "partial")
    .sort((a, b) => b.priority - a.priority)
    .slice(0, WORKLIST_SIZE);
}

export function validateWorklist(
  investigation: DatabuddyDiagnosisInvestigation,
  worklist: ScanRow[],
): void {
  if (worklist.length === 0) return;
  const anchors = investigation.findings
    .filter((finding) => finding.recommendation)
    .flatMap((finding) => finding.evidence);
  const decided = new Set(
    investigation.decisions.map((decision) => `${decision.path}:${decision.line}`),
  );
  const missing = worklist.filter(
    (row) =>
      !decided.has(`${row.path}:${row.start}`) && !anchors.some((anchor) => isNear(anchor, row)),
  );
  if (missing.length)
    throw new Error(
      `Worklist items without a recommendation or decision: ${missing
        .map((row) => `${row.path}:${row.start}`)
        .join(", ")}`,
    );
  const renamed: string[] = [];
  for (const row of worklist) {
    const suggested = row.suggestedEvent?.name;
    if (!suggested) continue;
    const related = investigation.findings.filter(
      (finding) =>
        finding.recommendation?.eventName && finding.evidence.some((anchor) => isNear(anchor, row)),
    );
    for (const finding of related) {
      const name = finding.recommendation?.eventName;
      if (name === suggested || finding.explanation.includes(suggested)) continue;
      renamed.push(
        `${finding.id}: use the scanner's name ${suggested} for ${row.path}:${row.start}, or keep ${name} and state in the explanation why ${suggested} breaks the naming rules`,
      );
    }
  }
  if (renamed.length) throw new Error(`Worklist naming failed: ${renamed.join("; ")}`);
}

function findingShape(area: DatabuddyReportArea, withDecisions = false): string {
  const decisions = withDecisions
    ? `,"decisions":[{"path":"real/relative/file.ts","line":1,"decision":"recommended|skip|unverifiable","reason":"Why"}]`
    : "";
  return `Return ONLY {"summary":"What this area's code does and what it should do next","findings":[{"id":"${area}_1","area":"sdk|events|flags|ai-agents|mcp|insights|links|uptime|server|privacy","category":"working|problem|gap|recommendation","basis":"source|hypothesis","title":"Concrete behavior or recommendation","explanation":"Evidence, consequence, and what it answers","evidence":[{"path":"real/relative/file.ts","line":1,"quote":"Exact source excerpt","reason":"Why it supports the finding"}],"nextCheck":"How to verify",${RECOMMENDATION_FIELDS}}],"unknowns":["Unavailable evidence"]${decisions}}. Only category recommendation carries a recommendation object; omit its unused fields. Use IDs prefixed with ${area}_.`;
}

const TEST_PATH =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures)\/|\.(test|spec|stories)\.[a-z]+$/;

const KIND_FIELDS: Record<string, "option" | "eventName" | "steps" | "target" | undefined> = {
  tracker_setting: "option",
  custom_event: "eventName",
  server_event: "eventName",
  funnel: "steps",
  goal: "target",
};

export function scanBacklog(
  rows: ScanRow[],
  findings: DatabuddyDiagnosisFinding[],
  decisions: DatabuddyActionDecision[] = [],
): DatabuddyScanBacklogItem[] {
  const decided = new Map(
    decisions.map((decision) => [`${decision.path}:${decision.line}`, decision]),
  );
  const coveredEvents = new Set<string>();
  const anchors: { path: string; line: number }[] = [];
  for (const finding of findings) {
    if (finding.recommendation?.eventName) coveredEvents.add(finding.recommendation.eventName);
    if (finding.recommendation) for (const anchor of finding.evidence) anchors.push(anchor);
  }
  const covered = (row: ScanRow) =>
    (row.suggestedEvent?.name !== undefined && coveredEvents.has(row.suggestedEvent.name)) ||
    anchors.some((anchor) => isNear(anchor, row));
  return rows
    .filter((row) => (row.coverage === "missing" || row.coverage === "partial") && !covered(row))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 400)
    .map((row) => {
      const decision = decided.get(`${row.path}:${row.start}`);
      return {
        path: row.path,
        line: row.start,
        ...(row.action?.label ? { label: row.action.label.slice(0, 200) } : {}),
        coverage: row.coverage as "missing" | "partial",
        category: row.category.slice(0, 40),
        priority: row.priority,
        ...(row.suggestedEvent?.name
          ? { suggestedEvent: row.suggestedEvent.name.slice(0, 100) }
          : {}),
        ...(decision && decision.decision !== "recommended"
          ? { decision: decision.decision, reason: decision.reason.slice(0, 500) }
          : {}),
      };
    });
}

function literalInSource(value: string, contents: Map<string, string>): boolean {
  const forms = [`"${value}"`, `'${value}'`, `\`${value}\``];
  for (const source of contents.values())
    if (forms.some((form) => source.includes(form))) return true;
  return false;
}

export function validateFindingRecommendations(
  findings: DatabuddyDiagnosisFinding[],
  contents: Map<string, string>,
  knownEvents: Set<string>,
): void {
  const proposed = new Set(knownEvents);
  for (const finding of findings)
    if (finding.recommendation?.eventName) proposed.add(finding.recommendation.eventName);
  const stepKnown = (step: { type: "event" | "path"; value: string }) =>
    step.type === "path"
      ? step.value.startsWith("/")
      : proposed.has(step.value) || literalInSource(step.value, contents);
  const errors: string[] = [];
  for (const finding of findings) {
    const recommendation = finding.recommendation;
    if (!recommendation) continue;
    for (const anchor of finding.evidence)
      if (TEST_PATH.test(anchor.path))
        errors.push(
          `${finding.id}: recommendation evidence must cite application code, not the test file ${anchor.path}`,
        );
    const required = KIND_FIELDS[recommendation.kind];
    if (required && recommendation[required] === undefined)
      errors.push(`${finding.id}: ${recommendation.kind} needs ${required}`);
    if (recommendation.kind === "tracker_setting") {
      if (recommendation.value === undefined)
        errors.push(`${finding.id}: tracker_setting needs value`);
      else if (!isLiteralValue(recommendation.value))
        errors.push(
          `${finding.id}: tracker_setting value must be the literal to set (true, 0.5, a string or a JSON array), not prose`,
        );
    }
    for (const step of recommendation.steps ?? [])
      if (!stepKnown(step))
        errors.push(
          `${finding.id}: funnel step ${step.value} must be an existing or proposed event, or a path starting with /`,
        );
    if (recommendation.target && !stepKnown(recommendation.target))
      errors.push(
        `${finding.id}: goal target ${recommendation.target.value} must be an existing or proposed event, or a path starting with /`,
      );
  }
  if (errors.length) throw new Error(`Recommendation validation failed: ${errors.join("; ")}`);
}

function recommendationKey(finding: DatabuddyDiagnosisFinding): string | undefined {
  const recommendation = finding.recommendation;
  if (!recommendation) return undefined;
  const parts: string[] = [recommendation.kind];
  if (recommendation.option) parts.push(`option=${recommendation.option}`);
  if (recommendation.eventName) parts.push(`event=${recommendation.eventName}`);
  if (recommendation.steps)
    parts.push(`steps=${recommendation.steps.map((step) => step.value).join(">")}`);
  if (recommendation.target) parts.push(`target=${recommendation.target.value}`);
  if (parts.length === 1)
    parts.push(`anchor=${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`);
  return parts.join("|");
}

export function dedupeFindings(findings: DatabuddyDiagnosisFinding[]): DatabuddyDiagnosisFinding[] {
  const ranked = [...findings].sort(
    (a, b) =>
      (PRIORITY_ORDER[a.recommendation?.priority ?? "enrichment"] ?? 2) -
      (PRIORITY_ORDER[b.recommendation?.priority ?? "enrichment"] ?? 2),
  );
  const kept = new Map<string, DatabuddyDiagnosisFinding>();
  const order: string[] = [];
  const nearby = (finding: DatabuddyDiagnosisFinding): string | undefined => {
    const anchor = finding.evidence[0];
    if (!anchor) return undefined;
    for (const [key, candidate] of kept) {
      const other = candidate.evidence[0];
      if (
        !candidate.recommendation &&
        candidate.category === finding.category &&
        other?.path === anchor.path &&
        Math.abs(other.line - anchor.line) <= 40
      )
        return key;
    }
    return undefined;
  };
  for (const finding of ranked) {
    const key =
      recommendationKey(finding) ??
      nearby(finding) ??
      `${finding.category}|${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`;
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, finding);
      order.push(key);
      continue;
    }
    kept.set(key, {
      ...existing,
      explanation: `${existing.explanation} Also found as ${finding.id}.`.slice(0, 4_000),
    });
  }
  const originalOrder = new Map(findings.map((finding, index) => [finding.id, index]));
  return order
    .map((key) => kept.get(key)!)
    .sort((a, b) => (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0));
}

const prefixId = (id: string, area: DatabuddyReportArea) =>
  id.startsWith(`${area}_`) ? id : `${area}_${id}`;

export async function runDatabuddyReport(options: ReportOptions): Promise<DatabuddyReportResult> {
  const parsed = DatabuddyReportRequestSchema.parse(options.request);
  const request: DatabuddyReportRequest = {
    ...parsed,
    scope: [...new Set(parsed.scope)].sort(),
    areas: [...new Set(parsed.areas)],
  };
  for (const selected of request.scope) assertSafeFilePath(selected);
  const redact = createSetupRedactor();
  if (request.journey && redact(request.journey) !== request.journey)
    throw new Error("Report journeys must not contain credentials");
  const repository = fs.realpathSync(path.resolve(options.repository));
  if (!fs.statSync(repository).isDirectory()) throw new Error("Repository must be a directory");
  const stateDir = path.join(repository, ".databuddy");
  const directory = fs.lstatSync(stateDir, { throwIfNoEntry: false });
  if (directory && (directory.isSymbolicLink() || !directory.isDirectory()))
    throw new Error(".databuddy must be a regular directory inside the repository");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const release = acquireSetupLock(stateDir);
  let temporary: string | undefined;
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      timings[name] = (timings[name] ?? 0) + (Date.now() - started) / 1000;
    }
  };
  try {
    const stateFile = path.join(stateDir, "report.json");
    const state = fs.lstatSync(stateFile, { throwIfNoEntry: false });
    if (state && (state.isSymbolicLink() || !state.isFile()))
      throw new Error("Report checkpoint must be a regular file inside the repository");
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-report-"));
    const gitDir = path.join(temporary, "index");
    execFileSync("git", ["init", "--bare", "--quiet", "--template=", gitDir], { stdio: "pipe" });
    const readCurrent = () =>
      readSource(repository, selectFiles(sourceFiles(repository, gitDir), request.scope));
    const contents = readCurrent();
    if (contents.size === 0) throw new Error("Report requires included source files");
    const agentType = options.agentType ?? "codex";
    const config = options.config ?? {};
    const promptDigest = createHash("sha256")
      .update(BOUNDARY)
      .update(JSON.stringify(AREA_SPECS))
      .update(RECOMMENDATION_FIELDS)
      .update(WORKLIST_RULES)
      .update(referenceDigest())
      .digest("hex");
    const fingerprintFor = (source: Map<string, string>) =>
      createHash("sha256")
        .update(
          JSON.stringify({ version: 3, request, agentType, config, prompts: promptDigest }) +
            JSON.stringify([...source]),
        )
        .digest("hex");
    const fingerprint = fingerprintFor(contents);
    const assertCurrent = () => {
      options.signal?.throwIfAborted();
      if (fingerprintFor(readCurrent()) !== fingerprint)
        throw new Error("Repository changed during the report; rerun for the current source");
    };
    const evidenceSource = new Map([...contents].map(([file, source]) => [file, redact(source)]));
    const framework = detectFramework(contents);

    let checkpoint: DatabuddyReportCheckpoint = {
      version: 1,
      fingerprint,
      status: "running",
      areas: {},
    };
    try {
      const saved = DatabuddyReportCheckpointSchema.parse(
        JSON.parse(fs.readFileSync(stateFile, "utf8")),
      );
      if (saved.fingerprint === fingerprint) {
        if (saved.status === "complete" && saved.result) {
          assertCurrent();
          return saved.result;
        }
        checkpoint = saved;
      }
    } catch {
      // Missing or invalid checkpoints are rebuilt.
    }
    const save = () =>
      atomicWriteFileSync(stateFile, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    save();

    options.onProgress?.({
      type: "started",
      message: "Scanning user actions with @databuddy/scan",
    });
    const scan: ScanPrepass = await timed("scan", () =>
      runScanPrepass({
        scopes: request.scope,
        mode: request.scan,
        runner: options.scanRunner ?? createScanRunner({ repository, bin: options.scanBin }),
      }),
    );
    options.onProgress?.({
      type: "complete",
      message:
        scan.summary.status === "complete"
          ? `Scan found ${scan.summary.actions} user actions`
          : `Scan ${scan.summary.status}${scan.summary.detail ? `: ${scan.summary.detail.slice(0, 200)}` : ""}`,
    });

    const snapshot = path.join(temporary, "source");
    writeSnapshot(snapshot, contents, redact);
    if (scan.snapshotJson) {
      const target = path.join(snapshot, SCAN_SNAPSHOT_FILE);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, scan.snapshotJson, { mode: 0o400 });
    }
    const execute = createRepositoryTaskRunner({
      stateDir,
      operation: "diagnosis",
      fingerprint,
      maxCostUsd: options.maxCostUsd,
      runTask: options.runTask,
    });
    const task = async (
      phase: string,
      prompt: string,
      resume?: { session?: string },
    ): Promise<{ raw: string; session?: string }> => {
      assertCurrent();
      let session: string | undefined;
      const raw = await execute(phase, {
        agentType,
        projectRoot: snapshot,
        prompt: redact(prompt),
        config,
        signal: options.signal,
        onProgress: options.onProgress,
        ...(resume?.session ? { resumeAgentSessionId: resume.session } : {}),
        onMeta: (meta) => {
          if (meta.agentSessionId) session = meta.agentSessionId;
        },
      });
      assertCurrent();
      return { raw, session };
    };

    const files = [...contents.keys()];
    const knownEvents = new Set(
      scan.rows.flatMap((row) => (row.suggestedEvent?.name ? [row.suggestedEvent.name] : [])),
    );
    const framing = `This is a full Databuddy utilization report for a ${framework} application${request.websiteId ? ` (website ${request.websiteId})` : ""}. Journey: ${JSON.stringify(request.journey ?? "not supplied; infer the primary user journey from the code")}. The report tells the team exactly how to use Databuddy here: what already works, what is wrong, and every concrete addition worth making, each as a recommendation finding with a structured recommendation object. Prefer concrete recommendations over discovery steps whenever the surface exists in the snapshot, and never recommend what the code already does.`;

    const salvaged: string[] = [];
    const investigate = async (
      area: DatabuddyReportArea,
    ): Promise<DatabuddyDiagnosisInvestigation> => {
      const saved = checkpoint.areas[area]?.investigation;
      if (saved) {
        try {
          const validated = validateInvestigation(saved, evidenceSource);
          validateFindingRecommendations(validated.findings, evidenceSource, knownEvents);
          return validated;
        } catch {
          // Stale saved work is redone.
        }
      }
      const spec = AREA_SPECS[area];
      const map = spec.usesActionMap && scan.actionMap ? `\n${scan.actionMap}` : "";
      const worklist = area === "events" ? worklistFor(scan.rows) : [];
      const required = worklist.length
        ? `\n${WORKLIST_RULES}\n${worklist.map((row) => `- ${row.path}:${row.start} ${row.action?.label ?? ""}${row.suggestedEvent?.name ? ` -> suggest ${row.suggestedEvent.name}` : ""}`).join("\n")}`
        : "";
      const context = `${BOUNDARY}\n${referenceIndex(spec.topics)}\n${framing}\nArea: ${area}. ${spec.focus}${map}${required}\nRequested scopes: ${JSON.stringify(request.scope)}\nAvailable files: ${JSON.stringify(files)}`;
      const prompt = `Investigate this application for the Databuddy utilization report.\n${context}\n${findingShape(area, worklist.length > 0)}`;
      const parse = (raw: string, salvage?: unknown) => {
        const investigation = validateInvestigation(
          relocateInvestigationAnchors(normalizeFindingSlips(parseResponse(raw)), evidenceSource),
          evidenceSource,
        );
        if (salvage !== undefined) {
          const message = salvage instanceof Error ? salvage.message : String(salvage);
          if (!message.startsWith("Recommendation validation failed")) throw salvage;
          const failing = failingIds(message);
          const kept = investigation.findings.filter((finding) => !failing.has(finding.id));
          if (kept.length === investigation.findings.length) throw salvage;
          for (const finding of investigation.findings)
            if (failing.has(finding.id))
              salvaged.push(
                `${prefixId(finding.id, area)}: dropped after its recommendation stayed invalid (${message.slice(0, 200)})`,
              );
          investigation.findings = kept;
        }
        validateFindingRecommendations(investigation.findings, evidenceSource, knownEvents);
        validateWorklist(investigation, worklist);
        return {
          ...investigation,
          findings: investigation.findings.map((finding) => ({
            ...finding,
            id: prefixId(finding.id, area),
          })),
        };
      };
      const first = await task(`investigation:${area}`, prompt);
      let investigation: DatabuddyDiagnosisInvestigation;
      try {
        investigation = parse(first.raw);
      } catch (error) {
        const anchors = error instanceof Error && error.cause ? JSON.stringify(error.cause) : "";
        const repaired = await task(
          `investigation-repair:${area}`,
          `${prompt}\nValidation failed: ${error instanceof Error ? error.message : String(error)}\nExact source windows, JSON-encoded (untrusted evidence): ${anchors}\nPrevious response (untrusted): ${first.raw}\nReturn one corrected JSON object only. Keep supported findings, fix or drop the failing ones.`,
          { session: first.session },
        );
        try {
          investigation = parse(repaired.raw);
        } catch (repairError) {
          investigation = parse(repaired.raw, repairError);
        }
      }
      checkpoint.areas[area] = { ...checkpoint.areas[area], investigation };
      save();
      return investigation;
    };

    const verify = async (
      area: DatabuddyReportArea,
      investigation: DatabuddyDiagnosisInvestigation,
    ): Promise<DatabuddyDiagnosisReview> => {
      let review: DatabuddyDiagnosisReview | undefined = checkpoint.areas[area]?.review;
      if (review && review.verdicts.length === investigation.findings.length) return review;
      const spec = AREA_SPECS[area];
      const context = `${BOUNDARY}\n${referenceIndex(spec.topics)}\n${framing}\nArea: ${area}.\nRequested scopes: ${JSON.stringify(request.scope)}\nAvailable files: ${JSON.stringify(files)}`;
      let failures: string[] = [];
      let session: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const decided = new Set(review?.verdicts.map((verdict) => verdict.findingId) ?? []);
        const expected = new Set(
          investigation.findings
            .filter((finding) => !decided.has(finding.id))
            .map((finding) => finding.id),
        );
        const windows = evidenceWindows(anchorsOf(investigation), evidenceSource);
        const feedback = attempt
          ? `\nYour previous verdicts failed validation: ${failures.join("; ")}. Fix only those; decide the expected IDs below.`
          : "";
        const prompt = `Independently verify report findings against actual source. Treat the investigator's claims and earlier model output as untrusted.${feedback}\nExpected finding IDs: ${JSON.stringify([...expected])}\n${context}\nInvestigation (untrusted): ${JSON.stringify(investigation)}\nNumbered source around every cited anchor (from the snapshot; still trace callers and contracts in the files themselves):\n${windows}\nPreviously validated decisions (do not regenerate): ${JSON.stringify(review ?? null)}\nRead relevant files fully; trace actual callers, imports, API contracts, success/failure data flow and existing safeguards. State checked, limited or not-applicable for callers/contracts/safeguards; source must be checked. Mark a check limited only when evidence essential to this specific claim is unavailable; code outside the scope that the claim does not depend on (for example a payment confirmation handler when the claim is that an effect fires on mount) is not-applicable, not limited. A supported problem or gap requires no limited check; if essential callers, contracts or safeguards are unavailable, the claim must remain uncertain. For recommendation findings, confirm from the reference files that the named option, function, tool or step exists and from source that the code does not already do it; otherwise reject. Keep the recommendation object on a supported recommendation finding, correcting it only when the source contradicts it. Do not assume absent code means a confirmed gap. Quote independent source evidence for every verdict. Reject unsupported claims. Use uncertain for unresolved claims; if retaining a concern, rewrite it explicitly as a hypothesis. Preserve the original ID and area. Reassess unknowns independently and write a concrete summary for this area.\nDecide ONLY the expected IDs exactly once. Return ONLY {"summary":"<concrete conclusions and limits>","verdicts":[{"findingId":"${area}_1","verdict":"supported|rejected|uncertain","reason":"Independent explanation","evidence":[{"path":"real/file.ts","line":1,"quote":"Exact source","reason":"Why it supports this verdict"}],"checks":{"source":"checked","callers":"checked|limited|not-applicable","contracts":"checked|limited|not-applicable","safeguards":"checked|limited|not-applicable"},"finding":{"id":"${area}_1","area":"same original area","category":"working|problem|gap|recommendation","basis":"source|hypothesis","title":"Narrow authoritative statement","explanation":"What follows from the evidence","evidence":[{"path":"real/file.ts","line":1,"quote":"Exact source","reason":"Why it supports the narrowed statement"}],"nextCheck":"Remaining check",${RECOMMENDATION_FIELDS}}}],"unknowns":["Remaining source or runtime checks"]}. supported requires a source-basis finding; rejected must omit finding; uncertain may omit finding or include a hypothesis-basis finding.`;
        const response = await task(
          attempt ? `verification-repair:${area}` : `verification:${area}`,
          prompt,
          attempt ? { session } : undefined,
        );
        if (!attempt) session = response.session;
        let partial: ReturnType<typeof reconcileReview> | undefined;
        try {
          partial = reconcileReview(
            relocateVerdictAnchors(
              normalizeVerdictSlips(parseResponse(response.raw)),
              evidenceSource,
            ),
            expected,
            investigation,
            evidenceSource,
          );
        } catch (error) {
          failures = [error instanceof Error ? error.message : String(error)];
        }
        if (partial) {
          const combined = new Map(
            (review?.verdicts ?? []).map((verdict) => [verdict.findingId, verdict]),
          );
          for (const verdict of partial.review.verdicts) combined.set(verdict.findingId, verdict);
          review = {
            ...partial.review,
            verdicts: investigation.findings.flatMap((finding) => {
              const verdict = combined.get(finding.id);
              return verdict ? [verdict] : [];
            }),
          };
          failures = partial.errors;
          try {
            validateFindingRecommendations(
              review.verdicts.flatMap((verdict) => (verdict.finding ? [verdict.finding] : [])),
              evidenceSource,
              knownEvents,
            );
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
          checkpoint.areas[area] = { ...checkpoint.areas[area], review };
          save();
          if (failures.length === 0 && review.verdicts.length === investigation.findings.length)
            return review;
        }
      }
      if (
        review &&
        review.verdicts.length === investigation.findings.length &&
        failures.every((failure) => failure.startsWith("Recommendation validation failed"))
      ) {
        const failing = new Set(failures.flatMap((failure) => [...failingIds(failure)]));
        review = {
          ...review,
          verdicts: review.verdicts.map((verdict) => {
            if (!verdict.finding || !failing.has(verdict.findingId)) return verdict;
            salvaged.push(
              `${verdict.findingId}: kept as uncertain without its recommendation, which stayed invalid after repair`,
            );
            const { finding: _finding, ...rest } = verdict;
            return { ...rest, verdict: "uncertain" as const };
          }),
        };
        checkpoint.areas[area] = { ...checkpoint.areas[area], review };
        save();
        return review;
      }
      throw new Error(
        `Source verification for ${area} failed after one repair: ${failures.join("; ")}`,
      );
    };

    const failed: Record<string, string> = {};
    const failSoft = async <T>(area: DatabuddyReportArea, run: () => Promise<T>) => {
      try {
        return await run();
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof Error && /Repository changed|cost|limit/i.test(error.message))
          throw error;
        failed[area] = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    };
    const areaResults = await timed("investigation", () =>
      Promise.all(
        request.areas.map(async (area) => ({
          area,
          investigation: await failSoft(area, () => investigate(area)),
        })),
      ),
    );
    const reviewed = await timed("verification", () =>
      Promise.all(
        areaResults.map(async ({ area, investigation }) => ({
          area,
          investigation,
          review: investigation
            ? await failSoft(area, () => verify(area, investigation))
            : undefined,
        })),
      ),
    );
    if (Object.keys(failed).length === reviewed.length)
      throw new Error(
        `Every report area failed: ${Object.entries(failed)
          .map(([area, message]) => `${area}: ${message}`)
          .join("; ")}`,
      );

    const areas: DatabuddyReportResult["areas"] = {};
    const findings: DatabuddyDiagnosisFinding[] = [];
    const unknowns = new Set<string>();
    for (const note of salvaged) unknowns.add(note);
    for (const [area, message] of Object.entries(failed))
      unknowns.add(
        `The ${area} area did not complete and is missing from this report: ${message.slice(0, 300)}`,
      );
    for (const { area, investigation, review } of reviewed) {
      if (!investigation || !review) continue;
      areas[area] = { investigation, review };
      for (const verdict of review.verdicts) if (verdict.finding) findings.push(verdict.finding);
      for (const unknown of verifiedUnknowns(review)) unknowns.add(unknown);
    }
    if (scan.summary.status !== "complete")
      unknowns.add(
        scan.summary.status === "off"
          ? "The @databuddy/scan action map was disabled, so untracked handlers were found by reading only."
          : `The @databuddy/scan action map was unavailable (${scan.summary.detail ?? "unknown"}), so untracked handlers were found by reading only.`,
      );
    assertCurrent();
    const result = DatabuddyReportResultSchema.parse({
      version: 1,
      repository,
      request,
      framework,
      scan: scan.summary,
      areas,
      findings: dedupeFindings(findings),
      backlog: scanBacklog(
        scan.rows,
        findings,
        reviewed.flatMap(({ investigation }) => investigation?.decisions ?? []),
      ),
      unknowns: [...unknowns],
      timings,
      phases: {
        scan: scan.summary.status,
        investigation: "complete",
        sourceVerification: "complete",
        runtimeVerification: "pending",
      },
    });
    checkpoint = { ...checkpoint, status: "complete", result };
    save();
    return result;
  } finally {
    try {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}

const KIND_TITLES: Record<string, string> = {
  tracker_setting: "Tracker settings",
  custom_event: "Custom events",
  server_event: "Server events",
  funnel: "Funnels",
  goal: "Goals",
  flag: "Feature flags",
  link: "Short links",
  monitor: "Uptime monitors",
};

export function renderReportMarkdown(result: DatabuddyReportResult): string {
  const lines: string[] = [];
  lines.push(`# Databuddy utilization report`, "");
  lines.push(`Repository: ${result.repository}`);
  lines.push(`Framework: ${result.framework}`);
  if (result.request.websiteId) lines.push(`Website: ${result.request.websiteId}`);
  if (result.request.journey) lines.push(`Journey: ${result.request.journey}`);
  const scan = result.scan;
  if (scan.status === "complete") {
    const coverage = Object.entries(scan.coverage ?? {})
      .map(([key, value]) => `${value} ${key}`)
      .join(", ");
    lines.push(
      `Action scan: ${scan.actions} user actions in ${scan.includedFiles} files (${coverage}).`,
    );
  } else lines.push(`Action scan: ${scan.status}.`);
  lines.push("");
  for (const area of Object.keys(result.areas) as DatabuddyReportArea[]) {
    lines.push(`## ${area[0].toUpperCase()}${area.slice(1)}`, "");
    lines.push(result.areas[area]?.review.summary ?? "", "");
  }
  const recommendations = result.findings
    .filter((finding) => finding.recommendation)
    .sort(
      (a, b) =>
        (PRIORITY_ORDER[a.recommendation?.priority ?? "enrichment"] ?? 2) -
        (PRIORITY_ORDER[b.recommendation?.priority ?? "enrichment"] ?? 2),
    );
  lines.push("## What to add next", "");
  if (recommendations.length === 0) lines.push("No additions were supported by the source.", "");
  const byKind = new Map<string, DatabuddyDiagnosisFinding[]>();
  for (const finding of recommendations) {
    const kind = finding.recommendation?.kind ?? "other";
    byKind.set(kind, [...(byKind.get(kind) ?? []), finding]);
  }
  for (const [kind, items] of byKind) {
    lines.push(`### ${KIND_TITLES[kind] ?? kind}`, "");
    for (const finding of items) {
      const recommendation = finding.recommendation;
      const detail: string[] = [];
      if (recommendation?.option) detail.push(`${recommendation.option}: ${recommendation.value}`);
      if (recommendation?.eventName) detail.push(`event ${recommendation.eventName}`);
      if (recommendation?.properties)
        detail.push(
          `properties ${Object.entries(recommendation.properties)
            .map(([key, value]) => `${key} (${value})`)
            .join(", ")}`,
        );
      if (recommendation?.steps)
        detail.push(`steps ${recommendation.steps.map((step) => step.value).join(" -> ")}`);
      if (recommendation?.target) detail.push(`target ${recommendation.target.value}`);
      const anchor = finding.evidence[0];
      lines.push(
        `- **${finding.title}** (${recommendation?.priority}, ${finding.basis}). ${finding.explanation}${detail.length ? ` ${detail.join("; ")}.` : ""} Where: ${anchor.path}:${anchor.line}. Verify: ${finding.nextCheck}`,
      );
    }
    lines.push("");
  }
  const established = (category: string) =>
    result.findings.filter(
      (finding) => finding.category === category && finding.basis === "source",
    );
  const hypotheses = result.findings.filter(
    (finding) =>
      finding.basis === "hypothesis" && !finding.recommendation && finding.category !== "working",
  );
  const working = result.findings.filter((finding) => finding.category === "working");
  for (const [title, items] of [
    ["## Problems to fix", established("problem")],
    ["## Gaps", established("gap")],
    ["## Possible problems the source could not settle", hypotheses],
    ["## Already working", working],
  ] as const) {
    lines.push(title, "");
    if (items.length === 0) lines.push("None established from the source.", "");
    for (const finding of items) {
      const anchor = finding.evidence[0];
      lines.push(
        `- **${finding.title}** (${finding.basis}). ${finding.explanation} Where: ${anchor.path}:${anchor.line}.`,
      );
    }
    lines.push("");
  }
  if (result.backlog.length) {
    lines.push("## Other untracked actions from the scan", "");
    lines.push(
      "The scanner found these user actions without tracking. Items with a decision were reviewed by the agent and deliberately not turned into an event; the rest were not reviewed individually. Suggested names follow the scanner's naming, so check each handler's success boundary before adding an event.",
      "",
    );
    const byCategory = new Map<string, DatabuddyScanBacklogItem[]>();
    for (const item of result.backlog)
      byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item]);
    for (const [category, items] of byCategory) {
      lines.push(`### ${category}`, "");
      for (const item of items)
        lines.push(
          `- ${item.path}:${item.line}${item.label ? ` ${item.label}` : ""}${item.suggestedEvent ? ` -> ${item.suggestedEvent}` : ""} (${item.coverage}, priority ${item.priority.toFixed(2)})${item.decision ? ` ${item.decision}: ${item.reason}` : ""}`,
        );
      lines.push("");
    }
  }
  lines.push("## Not verified", "");
  for (const unknown of result.unknowns) lines.push(`- ${unknown}`);
  lines.push("");
  lines.push(
    `Timings (seconds): ${Object.entries(result.timings)
      .map(([key, value]) => `${key} ${value.toFixed(0)}`)
      .join(", ")}.`,
  );
  return `${lines.join("\n")}\n`;
}
