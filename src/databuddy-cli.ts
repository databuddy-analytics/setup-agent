import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { type RunSetupTaskParams, runSetupTask } from "./agents/run-task.js";
import type { AgentProgress } from "./agents/types.js";
import { runChecks } from "./checks.js";
import { runDatabuddyDiagnosis } from "./databuddy-diagnosis.js";
import { renderReportMarkdown, runDatabuddyReport } from "./databuddy-report.js";
import { runDatabuddySetup } from "./databuddy-setup.js";
import { DATABUDDY_MCP_URL, installDatabuddyMcp, type McpScope, planMcpInstall } from "./mcp.js";
import {
  AGENTS,
  type AgentBackend,
  agentConfig,
  assertAgentCredential,
  MODEL_AUTH,
  type ModelAuth,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./model.js";
import { setupErrorExitCode } from "./protocol.js";
import type { DatabuddyReportArea } from "./schema.js";
import { feedbackPayload, runPayload, sendTelemetry, telemetryMode } from "./telemetry.js";
import { createSetupRedactor, normalizeTerminalLine } from "./terminal.js";

type SetupProduct = Parameters<typeof runDatabuddySetup>[0]["request"]["products"][number];

interface AgentCliOptions {
  agent: AgentBackend;
  model?: string;
  thinkingLevel: ThinkingLevel;
  modelAuth: ModelAuth;
  timeout: number;
  maxCostUsd?: number;
  telemetry: boolean;
}

interface SetupCliOptions extends AgentCliOptions {
  website: string;
  journey: string;
  products: SetupProduct[];
  apply: boolean;
  patch: boolean;
  check: string[];
}

interface DiagnosisCliOptions extends AgentCliOptions {
  question: string;
  scope: string[];
}

interface ReportCliOptions extends AgentCliOptions {
  website?: string;
  journey?: string;
  scope: string[];
  areas?: string;
  scan: "on" | "off" | "auto";
  scanBin?: string;
  markdown?: string;
}

interface AgentCommandContext {
  agentType: AgentBackend;
  config: Record<string, unknown>;
  signal: AbortSignal;
  onProgress: (progress: AgentProgress) => void;
  runTask: (params: RunSetupTaskParams) => Promise<string>;
  maxCostUsd?: number;
}

function parseProducts(value: string): SetupProduct[] {
  const products = value.split(",").map((product) => product.trim());
  const supported: readonly SetupProduct[] = [
    "sdk",
    "events",
    "flags",
    "ai-agents",
    "mcp",
    "links",
    "uptime",
  ];
  if (products.some((product) => !supported.includes(product as SetupProduct))) {
    throw new InvalidArgumentError(`Products must be ${supported.join(", ")}.`);
  }
  return [...new Set(products)] as SetupProduct[];
}

function parseTimeout(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3_600) {
    throw new InvalidArgumentError("Timeout must be an integer from 1 to 3600 seconds.");
  }
  return seconds;
}

function parseCost(value: string): number {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0)
    throw new InvalidArgumentError("Cost limit must be a positive finite USD amount.");
  return cost;
}

function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function addAgentOptions(command: Command): Command {
  return command
    .addOption(new Option("--agent <backend>", "Agent backend").choices(AGENTS).default("codex"))
    .option("--model <id>", "Model ID accepted by the selected backend")
    .addOption(
      new Option("--thinking-level <level>", "Reasoning effort")
        .choices(THINKING_LEVELS)
        .default("medium"),
    )
    .addOption(
      new Option(
        "--model-auth <mode>",
        "local reuses your codex or claude login; api-key uses OPENAI_API_KEY or ANTHROPIC_API_KEY",
      )
        .choices(MODEL_AUTH)
        .default("local"),
    )
    .option("--timeout <seconds>", "Deadline in seconds, from 1 to 3600", parseTimeout, 600)
    .option(
      "--max-cost-usd <n>",
      "Stop before further tasks when estimated invocation cost reaches this amount",
      parseCost,
    )
    .option(
      "--no-telemetry",
      "Do not send the run report (outcome, framework, well-known packages; never code or paths) to Databuddy",
    );
}

const SCAN_NOTICE = `The optional action scan is off. With --scan on, @databuddy/scan first maps every user action in the code, which usually finds more tracking gaps. Only the actions it finds and the functions they call are sent, not whole files (Swift and files it cannot parse are sent whole), to Databuddy's scan API, which classifies them with the Jev model on Vercel AI Gateway under zero data retention. Your code is never stored or logged; Databuddy records only request size, counts and timing. Set AI_GATEWAY_API_KEY to send it to your own Vercel AI Gateway account instead, and Databuddy receives nothing. Preview every line with npx @databuddy/scan@0.1.3 --dry-run. Details: https://www.databuddy.cc/docs/privacy/event-scanner
`;

interface TelemetryTarget {
  command: "setup" | "report";
  websiteId?: string;
  repository: string;
}

async function reportRun(
  target: TelemetryTarget | undefined,
  options: AgentCliOptions,
  model: string,
  started: number,
  outcome: { artifact?: Record<string, unknown>; error?: unknown },
): Promise<void> {
  if (!target?.websiteId) return;
  const mode = telemetryMode(process.env, !options.telemetry);
  const payload = runPayload({
    ...target,
    websiteId: target.websiteId,
    agent: options.agent,
    model,
    durationMs: Date.now() - started,
    ...outcome,
  });
  if ((await sendTelemetry(payload, { mode })) === "sent")
    process.stderr.write(
      "Sent this run's outcome, framework and well-known packages to Databuddy to improve the setup agent (no code or paths). Turn off with --no-telemetry or DATABUDDY_TELEMETRY=0.\n",
    );
}

let redact = createSetupRedactor();

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await readline.question(`${question} [y/N] `);
  readline.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function runAgentCommand(
  name: "setup" | "diagnosis" | "report",
  options: AgentCliOptions,
  run: (context: AgentCommandContext) => Promise<unknown>,
  telemetry?: TelemetryTarget,
): Promise<void> {
  const started = Date.now();
  const agentType = options.agent;
  const config = agentConfig({
    agent: agentType,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    auth: options.modelAuth,
  });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error(`Databuddy ${name} cancelled.`));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timer = setTimeout(
    () => controller.abort(new Error(`Databuddy ${name} exceeded ${options.timeout} seconds.`)),
    options.timeout * 1_000,
  );
  timer.unref();
  try {
    const artifact = await run({
      agentType,
      config,
      signal: controller.signal,
      maxCostUsd: options.maxCostUsd,
      onProgress: (progress) =>
        process.stderr.write(`${normalizeTerminalLine(redact(progress.message))}\n`),
      // Credentials are checked only when a model call is needed, so an
      // unchanged checkpoint resumes without any login.
      runTask: async (params) => {
        assertAgentCredential({ agent: agentType, auth: options.modelAuth });
        redact = createSetupRedactor();
        return runSetupTask(params);
      },
    });
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    await reportRun(telemetry, options, String(config.model), started, {
      artifact: artifact as Record<string, unknown>,
    });
    if (telemetry && artifact && process.stderr.isTTY)
      process.stderr.write(
        `To keep working with this data in ${agentType}, run: npx @databuddy/setup-agent mcp ${telemetry.repository} --agent ${agentType}\n`,
      );
  } catch (error) {
    await reportRun(telemetry, options, String(config.model), started, { error });
    throw error;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

const program = new Command()
  .configureOutput({ writeErr: (message) => process.stderr.write(redact(message)) })
  .name("databuddy")
  .description("Diagnose source issues and plan or apply Databuddy setup")
  .version(packageJson.version);

const setup = program
  .command("setup <repository>")
  .description(
    "Inspect/plan or apply reviewed SDK/custom-event changes; event delivery and website access remain unverified",
  )
  .requiredOption("--website <id>", "Databuddy website ID to plan for")
  .requiredOption("--journey <description>", "User journey to instrument")
  .option(
    "--apply",
    "Apply reviewed SDK/custom-event changes (sdk/events only); delivery and website access remain unverified",
    false,
  )
  .option(
    "--products <csv>",
    "Products to plan: sdk,events,flags,ai-agents,mcp,links,uptime",
    parseProducts,
    ["sdk", "events"],
  )
  .option(
    "--patch",
    "Implement and independently review the edits, then save them to .databuddy/setup.patch without installing anything or changing source; a later --apply applies that reviewed patch",
    false,
  )
  .option(
    "--check <command>",
    "With --apply, run this verification command in the repository afterwards, such as a typecheck or formatter check (repeatable)",
    collectRepeatable,
    [],
  );

addAgentOptions(setup).action((repository: string, options: SetupCliOptions) =>
  runAgentCommand(
    "setup",
    options,
    async (context) => {
      if (options.check.length && !options.apply)
        throw new InvalidArgumentError("--check runs after applied edits; add --apply.");
      if (options.patch && options.apply)
        throw new InvalidArgumentError(
          "Choose --patch to save a reviewed diff, or --apply to apply it.",
        );
      const result = await runDatabuddySetup({
        repository,
        apply: options.apply || options.patch,
        patchOnly: options.patch,
        request: {
          websiteId: options.website,
          journey: options.journey,
          products: options.products,
        },
        ...context,
      });
      if (!options.check.length || result.phases.implementation !== "complete") return result;
      const checks = await runChecks(result.repository, options.check, { signal: context.signal });
      for (const check of checks)
        process.stderr.write(
          `${check.passed ? "Check passed" : `Check failed (exit ${check.exitCode})`}: ${check.command}\n`,
        );
      if (checks.some((check) => !check.passed)) process.exitCode = 1;
      return { ...result, checks };
    },
    { command: "setup", websiteId: options.website, repository },
  ),
);

const diagnose = program
  .command("diagnose <repository>")
  .description(
    "Investigate source with an independent verification pass; runtime analytics and website access remain unverified",
  )
  .requiredOption("--question <question>", "Code question to investigate")
  .option(
    "--scope <relative-path>",
    "Source file or subtree to inspect (repeatable)",
    collectRepeatable,
    [],
  );

addAgentOptions(diagnose).action((repository: string, options: DiagnosisCliOptions) =>
  runAgentCommand("diagnosis", options, (context) =>
    runDatabuddyDiagnosis({
      repository,
      request: { question: options.question, scope: options.scope },
      ...context,
    }),
  ),
);

const report = program
  .command("report <repository>")
  .description(
    "Full Databuddy utilization report: scan user actions, investigate every product area in parallel, verify independently, and list what to add",
  )
  .option("--website <id>", "Databuddy website ID the report is for")
  .option("--journey <text>", "Primary user journey to measure")
  .option(
    "--scope <relative-path>",
    "Source file or subtree to inspect (repeatable)",
    collectRepeatable,
    [],
  )
  .option("--areas <csv>", "Areas to run: events,tracker,server,growth (default: all)")
  .addOption(
    new Option(
      "--scan <mode>",
      "Optional action scan first: on sends action code excerpts (not whole files) to Databuddy's zero-data-retention scan API, or to your own AI Gateway when AI_GATEWAY_API_KEY is set",
    )
      .choices(["on", "off", "auto"])
      .default("off"),
  )
  .option("--scan-bin <path>", "Path to a databuddy-scan binary or bundled cli.js")
  .option("--markdown <file>", "Also write the report as markdown to this file");

addAgentOptions(report).action(
  (repository: string, options: ReportCliOptions, command: Command) => {
    if (command.getOptionValueSource("scan") === "default") process.stderr.write(SCAN_NOTICE);
    return runAgentCommand(
      "report",
      options,
      async (context) => {
        const areas = options.areas
          ? (options.areas.split(",").map((area) => area.trim()) as DatabuddyReportArea[])
          : undefined;
        const result = await runDatabuddyReport({
          repository,
          request: {
            websiteId: options.website,
            journey: options.journey,
            scope: options.scope,
            ...(areas ? { areas } : {}),
            scan: options.scan === "auto" ? "on" : options.scan,
          },
          scanBin: options.scanBin,
          ...context,
        });
        if (options.markdown) {
          fs.writeFileSync(options.markdown, renderReportMarkdown(result), { mode: 0o600 });
          process.stderr.write(`Markdown report written to ${options.markdown}\n`);
        }
        return result;
      },
      { command: "report", websiteId: options.website, repository },
    );
  },
);

program
  .command("mcp [repository]")
  .description(
    "Add Databuddy's hosted MCP server to your claude or codex config so your agent can query analytics and create funnels, goals and flags",
  )
  .addOption(
    new Option("--agent <backend>", "Agent to configure").choices(AGENTS).default("claude"),
  )
  .addOption(
    new Option(
      "--scope <scope>",
      "Claude: project writes the repository's .mcp.json (default); user writes your Claude config. Codex is always user-level",
    ).choices(["project", "user"]),
  )
  .option("--yes", "Apply without asking (required when not running in a terminal)", false)
  .action(
    async (
      repository: string | undefined,
      options: { agent: AgentBackend; scope?: McpScope; yes: boolean },
    ) => {
      const plan = planMcpInstall(options.agent, {
        repository: repository ?? ".",
        scope: options.scope,
      });
      process.stderr.write(
        `This adds Databuddy's MCP server (${DATABUDDY_MCP_URL}) to ${plan.writes}.\n  ${path.basename(plan.executable)} ${plan.args.join(" ")}\n`,
      );
      if (!options.yes && !(await confirm("Continue?"))) {
        process.stderr.write("Nothing was changed. Rerun with --yes to apply.\n");
        process.exitCode = 2;
        return;
      }
      const result = await installDatabuddyMcp(plan);
      process.stderr.write(
        `${result.status === "added" ? "Added the Databuddy MCP server. " : ""}${result.next}\n`,
      );
    },
  );

program
  .command("feedback <message>")
  .description(
    "Send a bug report, feature request or other feedback about the setup agent to the Databuddy team",
  )
  .requiredOption("--website <id>", "Databuddy website ID the feedback is about")
  .addOption(
    new Option("--category <category>", "Kind of feedback")
      .choices(["bug_report", "feature_request", "other"])
      .default("other"),
  )
  .action(async (message: string, options: { website: string; category: string }) => {
    const result = await sendTelemetry(
      feedbackPayload({ websiteId: options.website, category: options.category, message }),
      // Feedback is an explicit request to send, so only print mode changes it.
      { mode: process.env.DATABUDDY_TELEMETRY?.toLowerCase() === "print" ? "print" : "send" },
    );
    if (result === "failed")
      throw new Error("Feedback could not be sent; check the website ID and try again.");
    if (result === "sent")
      process.stderr.write("Thanks, your feedback was sent to the Databuddy team.\n");
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = setupErrorExitCode(error);
});
