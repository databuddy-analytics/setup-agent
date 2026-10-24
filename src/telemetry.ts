import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { createSetupRedactor } from "./terminal.js";

const TELEMETRY_URL = "https://api.databuddy.cc/public/v1/agent-telemetry";

// Only these well-known packages are ever named. Any other dependency, which
// may be a private package, never leaves the machine.
const STACK_PACKAGES: Record<string, string> = {
  next: "next",
  react: "react",
  vue: "vue",
  nuxt: "nuxt",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  astro: "astro",
  "@remix-run/react": "remix",
  "@angular/core": "angular",
  express: "express",
  hono: "hono",
  fastify: "fastify",
  elysia: "elysia",
  "better-auth": "better-auth",
  "next-auth": "next-auth",
  "@clerk/nextjs": "clerk",
  "@supabase/supabase-js": "supabase",
  "drizzle-orm": "drizzle",
  "@prisma/client": "prisma",
  stripe: "stripe",
  "@shopify/hydrogen": "hydrogen",
  "@databuddy/sdk": "databuddy-sdk",
  "posthog-js": "posthog",
  "@vercel/analytics": "vercel-analytics",
  "@tanstack/react-query": "tanstack-query",
  typescript: "typescript",
  tailwindcss: "tailwind",
};

const LOCKFILES: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectStack(repository: string): { packageManager?: string; packages: string[] } {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
  } catch {
    // Non-JavaScript projects have no manifest to read.
  }
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = manifest[field];
    if (deps && typeof deps === "object")
      for (const name of Object.keys(deps))
        if (STACK_PACKAGES[name]) names.add(STACK_PACKAGES[name]);
  }
  const configured =
    typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
  const packageManager =
    configured ?? LOCKFILES.find(([file]) => fs.existsSync(path.join(repository, file)))?.[1];
  return { ...(packageManager ? { packageManager } : {}), packages: [...names].sort() };
}

const ISSUE_PATTERNS: [RegExp, string][] = [
  [/source review rejected/i, "review_rejected"],
  [/never sends planned events/i, "planned_events_missing"],
  [/SDK installation failed|SDK runtime dependency/i, "sdk_install_failed"],
  [/Repository changed|Source changed/i, "source_changed"],
  [/implements Next\.js applications only|supports sdk and events only/i, "unsupported_apply"],
  [
    /No (codex|claude) executable|login found|requires (OPENAI|ANTHROPIC)_API_KEY/i,
    "agent_unavailable",
  ],
  [/Local model authentication conflicts/i, "credential_conflict"],
  [/Quota exhausted/i, "quota_exhausted"],
  [/cost limit|cost is unavailable/i, "cost_limit"],
  [/exceeded \d+ seconds/i, "timeout"],
  [/cancelled/i, "cancelled"],
  [/already running/i, "already_running"],
];

function issueCode(message: string): string {
  return ISSUE_PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? "error";
}

/** First line only, with paths and credentials removed. */
function sanitizeMessage(message: string, repository?: string): string {
  let line = message.split("\n")[0] ?? "";
  if (repository) line = line.replaceAll(repository, "<repo>");
  line = line.replaceAll(os.homedir(), "~").replace(/(?:~|<repo>|\.{0,2})?\/[^\s,;:)]+/g, "<path>");
  return createSetupRedactor()(line).slice(0, 500);
}

interface TelemetryPayload {
  websiteId: string;
  agent: string;
  status: "success" | "partial" | "failed";
  framework?: string;
  installMethod?: string;
  durationMs?: number;
  stepsCompleted?: string[];
  issues?: { type: string; detail?: string; resolved?: boolean }[];
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

type Artifact = Record<string, any>;

export function runPayload(input: {
  command: "setup" | "report";
  websiteId: string;
  repository: string;
  agent: string;
  model: string;
  durationMs: number;
  artifact?: Artifact;
  error?: unknown;
}): TelemetryPayload {
  const { artifact } = input;
  const stack = detectStack(input.repository);
  const issues: TelemetryPayload["issues"] = [];
  const steps: string[] = [];
  let status: TelemetryPayload["status"] = "success";
  const metadata: Record<string, unknown> = {
    command: input.command,
    cliVersion: packageJson.version,
    agentBackend: input.agent,
    model: input.model,
    os: process.platform,
    node: process.versions.node,
    ...stack,
  };
  if (artifact && input.command === "setup") {
    steps.push("detect", "plan");
    metadata.products = artifact.request?.products;
    metadata.plannedEvents = artifact.plan?.events?.length ?? 0;
    metadata.recommendations = artifact.plan?.recommendations?.length ?? 0;
    if (artifact.phases?.implementation === "complete") {
      steps.push("review", "install", "apply");
      metadata.filesChanged = artifact.implementation?.files?.length ?? 0;
      metadata.sdkVersion = artifact.implementation?.sdkVersion;
    }
    const checks: { passed: boolean }[] = artifact.checks ?? [];
    if (checks.length) {
      metadata.checksPassed = checks.filter((check) => check.passed).length;
      metadata.checksFailed = checks.length - (metadata.checksPassed as number);
      if (metadata.checksFailed) {
        status = "partial";
        issues.push({ type: "check_failed", resolved: false });
      } else steps.push("verify");
    }
  }
  if (artifact && input.command === "report") {
    if (artifact.scan?.status === "complete") steps.push("scan");
    steps.push("investigate", "verify");
    const findings: { category: string }[] = artifact.findings ?? [];
    const counts: Record<string, number> = {};
    for (const finding of findings) counts[finding.category] = (counts[finding.category] ?? 0) + 1;
    metadata.findings = counts;
    metadata.scanActions = artifact.scan?.actions?.length;
    const incomplete = (artifact.unknowns ?? []).filter((unknown: string) =>
      unknown.includes("did not complete"),
    ).length;
    if (incomplete) {
      status = "partial";
      issues.push({ type: "area_incomplete", detail: `${incomplete} area(s)`, resolved: false });
    }
  }
  let errorMessage: string | undefined;
  if (input.error !== undefined) {
    status = "failed";
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    errorMessage = sanitizeMessage(message, input.repository);
    issues.push({ type: issueCode(message), resolved: false });
  }
  return {
    websiteId: input.websiteId,
    agent: "databuddy-setup-agent",
    status,
    ...(artifact?.framework ? { framework: artifact.framework } : {}),
    installMethod: "sdk",
    durationMs: input.durationMs,
    ...(steps.length ? { stepsCompleted: steps } : {}),
    ...(issues.length ? { issues } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    metadata,
  };
}

export function feedbackPayload(input: {
  websiteId: string;
  category: string;
  message: string;
}): TelemetryPayload {
  const message = createSetupRedactor()(input.message).slice(0, 2_000);
  return {
    websiteId: input.websiteId,
    agent: "databuddy-setup-agent",
    status: "partial",
    issues: [{ type: `feedback_${input.category}`, detail: message }],
    metadata: { kind: "feedback", category: input.category, cliVersion: packageJson.version },
  };
}

export function telemetryMode(
  env: NodeJS.ProcessEnv = process.env,
  disabledByFlag = false,
): "send" | "print" | "off" {
  const setting = env.DATABUDDY_TELEMETRY?.toLowerCase();
  if (setting === "print") return "print";
  if (disabledByFlag || env.DO_NOT_TRACK === "1" || ["0", "false", "off"].includes(setting ?? ""))
    return "off";
  return "send";
}

/** Never throws and never delays a run by more than five seconds. */
export async function sendTelemetry(
  payload: TelemetryPayload,
  options: { mode: "send" | "print" | "off"; fetchImpl?: typeof fetch },
): Promise<"sent" | "printed" | "off" | "failed"> {
  if (options.mode === "off") return "off";
  if (options.mode === "print") {
    process.stderr.write(`Telemetry payload (not sent):\n${JSON.stringify(payload, null, 2)}\n`);
    return "printed";
  }
  try {
    const response = await (options.fetchImpl ?? fetch)(TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
