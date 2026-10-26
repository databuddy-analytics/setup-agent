import { z } from "zod";

export const DatabuddySetupProductSchema = z.enum([
  "sdk",
  "events",
  "flags",
  "ai-agents",
  "mcp",
  "links",
  "uptime",
]);

export const DatabuddySetupRequestSchema = z
  .object({
    websiteId: z.string().trim().min(1).max(200),
    journey: z.string().trim().min(1).max(4_000),
    products: z.array(DatabuddySetupProductSchema).min(1).max(7),
  })
  .strict()
  .refine((request) => new Set(request.products).size === request.products.length, {
    message: "Products must be unique",
  });

const evidenceSchema = z
  .object({
    path: z.string().min(1).max(500),
    line: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const DatabuddyTrackerOptionSchema = z.enum([
  "anonymizeVisitorIds",
  "apiUrl",
  "batchSize",
  "batchTimeout",
  "clientId",
  "debug",
  "disabled",
  "enableBatching",
  "enableRetries",
  "filter",
  "ignoreBotDetection",
  "initialRetryDelay",
  "maskPatterns",
  "maxRetries",
  "samplingRate",
  "scriptUrl",
  "sdk",
  "sdkVersion",
  "skipPatterns",
  "trackAttributes",
  "trackErrors",
  "trackHashChanges",
  "trackInteractions",
  "trackOutgoingLinks",
  "trackWebVitals",
  "usePixel",
]);

const DatabuddyRecommendationKindSchema = z.enum([
  "tracker_setting",
  "custom_event",
  "server_event",
  "funnel",
  "goal",
  "flag",
  "link",
  "monitor",
]);

const funnelStepSchema = z
  .object({
    type: z.enum(["event", "path"]),
    value: z.string().trim().min(1).max(500),
  })
  .strict();

const DatabuddyRecommendationSchema = z
  .object({
    kind: DatabuddyRecommendationKindSchema,
    product: DatabuddySetupProductSchema,
    priority: z.enum(["journey", "quality", "enrichment"]),
    title: z.string().trim().min(1).max(200),
    change: z.string().trim().min(1).max(2_000),
    rationale: z.string().trim().min(1).max(2_000),
    evidence: z.array(evidenceSchema).min(1).max(10),
    verification: z.string().trim().min(1).max(2_000),
    option: DatabuddyTrackerOptionSchema.optional(),
    value: z.string().trim().min(1).max(500).optional(),
    eventName: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,99}$/)
      .optional(),
    steps: z.array(funnelStepSchema).min(2).max(10).optional(),
    target: funnelStepSchema.optional(),
  })
  .strict();

export type DatabuddyRecommendation = z.infer<typeof DatabuddyRecommendationSchema>;

const DatabuddyFrameworkSchema = z.enum([
  "nextjs",
  "remix",
  "react",
  "nuxt",
  "vue",
  "sveltekit",
  "svelte",
  "astro",
  "angular",
  "laravel",
  "wordpress",
  "static",
  "other",
]);

export type DatabuddyFramework = z.infer<typeof DatabuddyFrameworkSchema>;

export const DatabuddySetupPlanSchema = z
  .object({
    framework: DatabuddyFrameworkSchema,
    summary: z.string().trim().min(1).max(4_000),
    steps: z
      .array(
        z
          .object({
            product: DatabuddySetupProductSchema,
            change: z.string().trim().min(1).max(4_000),
            evidence: z.array(evidenceSchema).min(1).max(20),
            verification: z.string().trim().min(1).max(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    events: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
            source: z.enum(["browser", "server"]),
            properties: z.record(z.string().trim().min(1).max(1_000)),
            evidence: z.array(evidenceSchema).min(1).max(20),
          })
          .strict(),
      )
      .max(40),
    recommendations: z.array(DatabuddyRecommendationSchema).max(25),
    unknowns: z.array(z.string().trim().min(1).max(2_000)).max(40),
  })
  .strict();

// A planned event the implementer could not send safely, with its reason; the
// reviewer judges the reason and the result reports it.
const deferredEventSchema = z
  .object({
    event: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const deferredEventsSchema = z.array(deferredEventSchema).max(20);

export const DatabuddySetupChangesSchema = z
  .object({
    deferred: deferredEventsSchema.optional(),
    changes: z
      .array(
        z
          .object({
            product: DatabuddySetupProductSchema,
            path: z.string().min(1).max(500),
            content: z.string().max(1_048_576),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

// Reviewers often return {path, reason} objects instead of strings; keep the
// location by folding it into the issue text.
const reviewIssueSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && "reason" in value
      ? [(value as { path?: unknown }).path, (value as { reason?: unknown }).reason]
          .filter((part) => typeof part === "string" && part.trim())
          .join(": ")
      : value,
  z.string().trim().min(1).max(2_000),
);

export const DatabuddySetupSourceReviewSchema = z
  .object({
    passed: z.boolean(),
    issues: z.array(reviewIssueSchema).max(40),
    unknowns: z.array(z.string().trim().min(1).max(2_000)).max(40),
    // The reviewer's purpose for each diff hunk; unrelated hunks become issues.
    hunks: z
      .array(
        z.object({
          id: z.string().regex(/^H\d{1,4}$/),
          related: z.boolean(),
          // Whether the hunk changes what the app does apart from sending analytics.
          changesBehavior: z.boolean().optional(),
          purpose: z.string().trim().min(1).max(500),
        }),
      )
      .max(400)
      .optional(),
  })
  .strict()
  .refine((review) => review.passed === (review.issues.length === 0), {
    message: "A passing source review must have no issues; a rejection must explain its issues",
  });

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const appliedFileSchema = z
  .object({
    product: DatabuddySetupProductSchema,
    path: z.string().min(1).max(500),
    beforeHash: hashSchema.nullable(),
    afterHash: hashSchema,
  })
  .strict();

export const DatabuddySetupResultSchema = z
  .object({
    version: z.literal(1),
    repository: z.string().min(1),
    request: DatabuddySetupRequestSchema,
    plan: DatabuddySetupPlanSchema,
    phases: z
      .object({
        inspection: z.literal("complete"),
        planning: z.literal("complete"),
        implementation: z.enum(["pending", "complete"]),
        verification: z.literal("pending"),
        websiteAccess: z.literal("unverified"),
      })
      .strict(),
    implementation: z
      .object({
        files: z.array(appliedFileSchema).max(40),
        sdkVersion: z.string().min(1).max(100),
        sourceReview: DatabuddySetupSourceReviewSchema,
        diff: z.literal(".databuddy/setup.patch"),
        deferred: deferredEventsSchema.optional(),
      })
      .strict()
      .optional(),
    // A reviewed diff saved by --patch; nothing was installed or written.
    patch: z
      .object({
        diff: z.literal(".databuddy/setup.patch"),
        files: z.number().int().min(0).max(40),
        sourceReview: DatabuddySetupSourceReviewSchema,
        deferred: deferredEventsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (result) =>
      result.phases.implementation === "complete"
        ? result.implementation?.sourceReview.passed === true
        : result.implementation === undefined,
    {
      message:
        "Completed implementation requires an applied-file record and a passing source review",
    },
  )
  .refine(
    (result) =>
      result.patch === undefined ||
      (result.phases.implementation === "pending" && result.patch.sourceReview.passed),
    { message: "A saved patch must be reviewed and not yet applied" },
  );

const journalSchema = z
  .object({
    version: z.literal(1),
    fingerprint: hashSchema,
    intent: hashSchema,
    result: DatabuddySetupResultSchema,
    sources: z.record(hashSchema),
    changes: z
      .array(
        DatabuddySetupChangesSchema.shape.changes.element.extend({
          beforeHash: hashSchema.nullable(),
        }),
      )
      .max(40),
    sourceReview: DatabuddySetupSourceReviewSchema,
    diffHash: hashSchema,
    deferred: deferredEventsSchema.optional(),
  })
  .strict();

export const DatabuddySetupCheckpointSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        version: z.literal(1),
        fingerprint: hashSchema,
        status: z.literal("planned"),
        result: DatabuddySetupResultSchema,
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        fingerprint: hashSchema.optional(),
        status: z.literal("failed"),
      })
      .strict(),
    journalSchema.omit({ diffHash: true, sourceReview: true }).extend({
      status: z.literal("reviewing"),
      attempt: z.number().int().min(0).max(2),
      sourceReview: DatabuddySetupSourceReviewSchema.optional(),
      // Set by --patch: a person may have reviewed this exact diff, so --apply
      // must apply it unchanged or refuse, never re-plan.
      savedPatchHash: hashSchema.optional(),
      // The diff the saved sourceReview passed; a review never vouches for other edits.
      reviewedDiffHash: hashSchema.optional(),
    }),
    journalSchema.extend({ status: z.literal("applying") }),
    journalSchema.extend({ status: z.literal("applied") }),
  ])
  .refine(
    (checkpoint) => {
      if (checkpoint.status === "failed") return true;
      if (checkpoint.status === "planned" || checkpoint.status === "reviewing")
        return checkpoint.result.phases.implementation === "pending";
      return (
        checkpoint.sourceReview.passed &&
        checkpoint.result.phases.implementation ===
          (checkpoint.status === "applied" ? "complete" : "pending")
      );
    },
    { message: "Checkpoint status must agree with reviewed implementation progress" },
  );

export type DatabuddySetupRequest = z.infer<typeof DatabuddySetupRequestSchema>;
export type DatabuddySetupPlan = z.infer<typeof DatabuddySetupPlanSchema>;
export type DatabuddySetupResult = z.infer<typeof DatabuddySetupResultSchema>;
export type DatabuddySetupCheckpoint = z.infer<typeof DatabuddySetupCheckpointSchema>;
export type DatabuddySetupChanges = z.infer<typeof DatabuddySetupChangesSchema>;
export type DatabuddySetupSourceReview = z.infer<typeof DatabuddySetupSourceReviewSchema>;

export const DatabuddyDiagnosisRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(4_000),
    scope: z.array(z.string().min(1).max(500)).max(20).default([]),
  })
  .strict();

/** Structured action attached to a recommendation finding so a report can act on it. */
// Extra keys a model adds to a recommendation are dropped rather than failing the run.
const DatabuddyFindingRecommendationSchema = z
  .object({
    kind: DatabuddyRecommendationKindSchema,
    priority: z.enum(["journey", "quality", "enrichment"]),
    option: DatabuddyTrackerOptionSchema.optional(),
    value: z.string().trim().min(1).max(500).optional(),
    eventName: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,99}$/)
      .optional(),
    properties: z.record(z.string().trim().min(1).max(500)).optional(),
    steps: z.array(funnelStepSchema).min(2).max(10).optional(),
    target: funnelStepSchema.optional(),
  })
  .strip();

const diagnosisFindingBaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    area: z.enum([
      "sdk",
      "events",
      "flags",
      "ai-agents",
      "mcp",
      "insights",
      "links",
      "uptime",
      "server",
      "privacy",
    ]),
    category: z.enum(["working", "problem", "gap", "recommendation"]),
    basis: z.enum(["source", "hypothesis"]),
    title: z.string().trim().min(1).max(500),
    explanation: z.string().trim().min(1).max(4_000),
    evidence: z
      .array(evidenceSchema.extend({ quote: z.string().trim().min(1).max(1_000) }))
      .min(1)
      .max(20),
    nextCheck: z.string().trim().min(1).max(2_000),
    recommendation: DatabuddyFindingRecommendationSchema.optional(),
  })
  .strict();

const diagnosisFindingSchema = diagnosisFindingBaseSchema.refine(
  (finding) => (finding.category === "recommendation") === (finding.recommendation !== undefined),
  { message: "Recommendation findings carry a structured recommendation; other categories do not" },
);

const diagnosisCheckSchema = z.enum(["checked", "limited", "not-applicable"]);
export const DatabuddyDiagnosisVerdictSchema = z
  .object({
    findingId: diagnosisFindingBaseSchema.shape.id,
    verdict: z.enum(["supported", "rejected", "uncertain"]),
    reason: z.string().trim().min(1).max(2_000),
    evidence: diagnosisFindingBaseSchema.shape.evidence,
    checks: z
      .object({
        source: z.literal("checked"),
        callers: diagnosisCheckSchema,
        contracts: diagnosisCheckSchema,
        safeguards: diagnosisCheckSchema,
      })
      .strict(),
    finding: diagnosisFindingSchema.optional(),
  })
  .strict()
  .superRefine((verdict, context) => {
    if (verdict.finding && verdict.finding.id !== verdict.findingId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Authoritative finding must retain its original ID",
      });
    if (verdict.verdict === "supported" && verdict.finding?.basis !== "source")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Supported verdict requires a source-backed authoritative finding",
      });
    if (
      verdict.verdict === "supported" &&
      verdict.finding &&
      ["problem", "gap"].includes(verdict.finding.category) &&
      Object.values(verdict.checks).includes("limited")
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Problems or gaps with limited caller, contract or safeguard evidence must remain uncertain",
      });
    if (verdict.verdict === "rejected" && verdict.finding)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rejected claims cannot produce authoritative findings",
      });
    if (
      verdict.verdict === "uncertain" &&
      verdict.finding &&
      verdict.finding.basis !== "hypothesis"
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Uncertain findings must remain explicitly labelled hypotheses",
      });
  });

const DatabuddyActionDecisionSchema = z
  .object({
    path: z.string().min(1).max(500),
    line: z.number().int().positive(),
    decision: z.enum(["recommended", "skip", "unverifiable"]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const DatabuddyDiagnosisInvestigationSchema = z
  .object({
    summary: z.string().trim().min(1).max(4_000),
    findings: z.array(diagnosisFindingSchema).max(40),
    unknowns: z.array(z.string().trim().min(1).max(2_000)).max(40),
    decisions: z.array(DatabuddyActionDecisionSchema).max(80).default([]),
  })
  .strict();

export type DatabuddyActionDecision = z.infer<typeof DatabuddyActionDecisionSchema>;

export const DatabuddyDiagnosisReviewSchema = z
  .object({
    summary: z.string().trim().min(1).max(4_000),
    verdicts: z.array(DatabuddyDiagnosisVerdictSchema).max(40),
    unknowns: z.array(z.string().trim().min(1).max(2_000)).max(40),
  })
  .strict();

export const DatabuddyDiagnosisResultSchema = z
  .object({
    version: z.literal(2),
    repository: z.string().min(1),
    request: DatabuddyDiagnosisRequestSchema,
    summary: z.string().trim().min(1).max(4_000),
    findings: z.array(diagnosisFindingSchema).max(40),
    assessments: z
      .array(
        z
          .object({
            original: diagnosisFindingSchema,
            verification: DatabuddyDiagnosisVerdictSchema,
          })
          .strict(),
      )
      .max(40),
    review: DatabuddyDiagnosisReviewSchema,
    coverage: z
      .object({
        mode: z.literal("source-only"),
        availableFiles: z.array(z.string().min(1).max(500)).max(10_000),
      })
      .strict(),
    unknowns: z.array(z.string().trim().min(1).max(2_000)).max(100),
    phases: z
      .object({
        investigation: z.literal("complete"),
        sourceVerification: z.literal("complete"),
        runtimeVerification: z.literal("pending"),
      })
      .strict(),
  })
  .strict();

const diagnosisCheckpointSchema = z
  .object({ version: z.literal(2), fingerprint: hashSchema })
  .strict();
export const DatabuddyDiagnosisCheckpointSchema = z.discriminatedUnion("status", [
  diagnosisCheckpointSchema.extend({ status: z.literal("investigating") }),
  diagnosisCheckpointSchema.extend({
    status: z.literal("verifying"),
    investigation: DatabuddyDiagnosisInvestigationSchema,
    review: DatabuddyDiagnosisReviewSchema.optional(),
  }),
  diagnosisCheckpointSchema.extend({
    status: z.literal("complete"),
    result: DatabuddyDiagnosisResultSchema,
  }),
]);

export type DatabuddyDiagnosisFinding = z.infer<typeof diagnosisFindingSchema>;
export type DatabuddyDiagnosisVerdict = z.infer<typeof DatabuddyDiagnosisVerdictSchema>;
export type DatabuddyDiagnosisRequest = z.infer<typeof DatabuddyDiagnosisRequestSchema>;
export type DatabuddyDiagnosisInvestigation = z.infer<typeof DatabuddyDiagnosisInvestigationSchema>;
export type DatabuddyDiagnosisReview = z.infer<typeof DatabuddyDiagnosisReviewSchema>;
export type DatabuddyDiagnosisResult = z.infer<typeof DatabuddyDiagnosisResultSchema>;
export type DatabuddyDiagnosisCheckpoint = z.infer<typeof DatabuddyDiagnosisCheckpointSchema>;

const DatabuddyReportAreaSchema = z.enum(["events", "tracker", "server", "growth"]);
export type DatabuddyReportArea = z.infer<typeof DatabuddyReportAreaSchema>;

export const DatabuddyReportRequestSchema = z
  .object({
    websiteId: z.string().trim().min(1).max(200).optional(),
    journey: z.string().trim().min(1).max(4_000).optional(),
    scope: z.array(z.string().min(1).max(500)).max(20).default([]),
    areas: z
      .array(DatabuddyReportAreaSchema)
      .min(1)
      .max(4)
      .default(["events", "tracker", "server", "growth"]),
    // The action scan sends code excerpts to Databuddy's scan API, so it runs
    // only when the user turns it on.
    scan: z.enum(["on", "off"]).default("off"),
  })
  .strict();

const DatabuddyScanSummarySchema = z
  .object({
    status: z.enum(["complete", "unavailable", "off"]),
    detail: z.string().max(2_000).optional(),
    includedFiles: z.number().int().nonnegative().optional(),
    actions: z.number().int().nonnegative().optional(),
    coverage: z.record(z.number().int().nonnegative()).optional(),
    categories: z.record(z.number().int().nonnegative()).optional(),
  })
  .strict();

const DatabuddyReportAreaResultSchema = z
  .object({
    investigation: DatabuddyDiagnosisInvestigationSchema,
    review: DatabuddyDiagnosisReviewSchema,
  })
  .strict();

const DatabuddyScanBacklogItemSchema = z
  .object({
    path: z.string().min(1).max(500),
    line: z.number().int().positive(),
    label: z.string().max(200).optional(),
    coverage: z.enum(["missing", "partial"]),
    category: z.string().max(40),
    priority: z.number().min(0).max(3),
    suggestedEvent: z.string().max(100).optional(),
    decision: z.enum(["skip", "unverifiable"]).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const DatabuddyReportResultSchema = z
  .object({
    version: z.literal(1),
    repository: z.string().min(1),
    request: DatabuddyReportRequestSchema,
    framework: DatabuddyFrameworkSchema,
    scan: DatabuddyScanSummarySchema,
    backlog: z.array(DatabuddyScanBacklogItemSchema).max(400).default([]),
    areas: z.record(DatabuddyReportAreaSchema, DatabuddyReportAreaResultSchema),
    findings: z.array(diagnosisFindingSchema).max(160),
    unknowns: z.array(z.string().trim().min(1).max(2_000)).max(160),
    timings: z.record(z.number().nonnegative()),
    phases: z
      .object({
        scan: z.enum(["complete", "unavailable", "off"]),
        investigation: z.literal("complete"),
        sourceVerification: z.literal("complete"),
        runtimeVerification: z.literal("pending"),
      })
      .strict(),
  })
  .strict();

export const DatabuddyReportCheckpointSchema = z
  .object({
    version: z.literal(1),
    fingerprint: hashSchema,
    status: z.enum(["running", "complete"]),
    areas: z
      .record(
        DatabuddyReportAreaSchema,
        z
          .object({
            investigation: DatabuddyDiagnosisInvestigationSchema.optional(),
            review: DatabuddyDiagnosisReviewSchema.optional(),
          })
          .strict(),
      )
      .default({}),
    result: DatabuddyReportResultSchema.optional(),
  })
  .strict();

export type DatabuddyReportRequest = z.infer<typeof DatabuddyReportRequestSchema>;
export type DatabuddyReportResult = z.infer<typeof DatabuddyReportResultSchema>;
export type DatabuddyReportCheckpoint = z.infer<typeof DatabuddyReportCheckpointSchema>;
export type DatabuddyScanSummary = z.infer<typeof DatabuddyScanSummarySchema>;
export type DatabuddyScanBacklogItem = z.infer<typeof DatabuddyScanBacklogItemSchema>;
