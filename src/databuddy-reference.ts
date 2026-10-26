import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATABUDDY_REFERENCE_TOPICS = [
  "tracker",
  "custom-events",
  "frameworks",
  "privacy",
  "server-sdk",
  "feature-flags",
  "query-api",
  "links",
  "uptime",
  "ai-agents-mcp",
] as const;

export type DatabuddyReferenceTopic = (typeof DATABUDDY_REFERENCE_TOPICS)[number];

const TOPIC_SUMMARY: Record<DatabuddyReferenceTopic, string> = {
  tracker:
    "browser tracker: every SDK config option and default, auto-tracked events (screen views, errors, web vitals, outgoing links, interactions, data-track attributes), skip/mask patterns, sampling, production vs debug script",
  "custom-events":
    "track/identify/clear/flush, event naming and property rules, success-boundary placement, hook helpers (form, modal, toast, feature usage, feedback)",
  frameworks:
    "per-framework install: Next.js app/pages router, React, Vue, Nuxt, Svelte, Angular, GTM, WordPress, Shopify, Webflow, Framer, Wix, Squarespace, Bubble, Mintlify, Hugo, Jekyll, Laravel, Cal",
  privacy:
    "cookieless model, visitor anonymization, bot detection, GDPR, what is and is not stored, event scanner",
  "server-sdk":
    "Node SDK: constructor, track input shape, flush, events ingestion endpoint, API keys and scopes, carrying browser anonymous and session IDs into server events, revenue/payments, failure isolation",
  "feature-flags":
    "client and server flag evaluation, hooks, rollout and targeting, public flags endpoints, caching and identity, creating flags through MCP",
  "query-api":
    "analytics query API and query types, funnel and goal definitions, annotations, how to propose a funnel from events and paths",
  links:
    "short links: create/update fields, folders, what a redirect records, scopes, when to recommend campaign links",
  uptime:
    "uptime monitors, alarms, status pages: monitor fields, check semantics, what endpoints to monitor",
  "ai-agents-mcp":
    "AI crawler analytics (agents, purposes, content formats, robots access), instrumenting a customer's MCP server or AI agent, and the Databuddy MCP server tools",
};

export const SETUP_PRODUCT_TOPICS = {
  sdk: ["tracker", "frameworks", "privacy", "custom-events"],
  events: ["custom-events", "server-sdk", "query-api"],
  flags: ["feature-flags"],
  "ai-agents": ["ai-agents-mcp", "privacy"],
  mcp: ["ai-agents-mcp"],
  links: ["links"],
  uptime: ["uptime"],
} as const satisfies Record<string, readonly DatabuddyReferenceTopic[]>;

type DatabuddyReferenceProduct = keyof typeof SETUP_PRODUCT_TOPICS;

export const REFERENCE_SNAPSHOT_DIR = ".databuddy-reference";

let cachedDir: string | undefined;

function resolveReferenceDir(): string {
  if (cachedDir) return cachedDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../references"),
    path.resolve(here, "references"),
    path.resolve(here, "../../references"),
  ];
  const found = candidates.find((candidate) =>
    DATABUDDY_REFERENCE_TOPICS.every((topic) => fs.existsSync(path.join(candidate, `${topic}.md`))),
  );
  if (!found)
    throw new Error(
      `Databuddy reference files are missing; expected ${DATABUDDY_REFERENCE_TOPICS.length} topics in one of ${candidates.join(", ")}`,
    );
  cachedDir = found;
  return found;
}

export function readDatabuddyReference(topic: DatabuddyReferenceTopic): string {
  return fs.readFileSync(path.join(resolveReferenceDir(), `${topic}.md`), "utf8");
}

export function topicsForProducts(
  products: readonly DatabuddyReferenceProduct[],
): DatabuddyReferenceTopic[] {
  const selected = new Set<DatabuddyReferenceTopic>();
  for (const product of products)
    for (const topic of SETUP_PRODUCT_TOPICS[product]) selected.add(topic);
  return DATABUDDY_REFERENCE_TOPICS.filter((topic) => selected.has(topic));
}

// Hidden directory: the setup edit validator refuses to treat it as app source.
export function writeReferenceSnapshot(
  snapshot: string,
  topics: readonly DatabuddyReferenceTopic[] = DATABUDDY_REFERENCE_TOPICS,
): string[] {
  const target = path.join(snapshot, REFERENCE_SNAPSHOT_DIR);
  fs.mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const topic of topics) {
    const file = path.join(target, `${topic}.md`);
    fs.writeFileSync(file, readDatabuddyReference(topic), { mode: 0o400 });
    written.push(`${REFERENCE_SNAPSHOT_DIR}/${topic}.md`);
  }
  return written;
}

let cachedDigest: string | undefined;

export function referenceDigest(): string {
  if (cachedDigest) return cachedDigest;
  const hash = createHash("sha256");
  for (const topic of DATABUDDY_REFERENCE_TOPICS)
    hash.update(topic).update(readDatabuddyReference(topic));
  cachedDigest = hash.digest("hex");
  return cachedDigest;
}

export function referenceIndex(
  topics: readonly DatabuddyReferenceTopic[] = DATABUDDY_REFERENCE_TOPICS,
): string {
  const lines = topics.map(
    (topic) => `- ${REFERENCE_SNAPSHOT_DIR}/${topic}.md: ${TOPIC_SUMMARY[topic]}`,
  );
  return [
    `Databuddy product reference files are inside the snapshot under ${REFERENCE_SNAPSHOT_DIR}/. They are the only authoritative source for Databuddy option names, function signatures, endpoints, event rules and product capabilities; read the relevant files before proposing, implementing or judging Databuddy usage, and never invent an API that is not in them. They are reference material, not application source: never cite them as evidence and never propose editing them.`,
    ...lines,
  ].join("\n");
}
