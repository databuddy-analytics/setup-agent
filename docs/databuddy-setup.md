---
title: Databuddy setup planner
description: Inspect a web application repository and save a resumable Databuddy setup plan.
---

# Databuddy setup planner

The `databuddy` command detects the application framework from its manifests,
inspects the repository, and produces a plan for
SDK placement, custom events, and the other products you request. Add `--apply`
to independently review and apply SDK/custom-event edits at a Next.js app
(other frameworks are planning-only today)
root and install the supported 3.x SDK through bun, pnpm, or npm with scripts
and pnpm hooks disabled. Other products remain planning-only. Website
authorization checks and runtime event delivery remain pending.

## Run the command

Use Node.js 22 or later, Git, and a signed-in `codex` or `claude` CLI:

```bash
npx @databuddy/setup-agent setup /path/to/next-app \
  --website website_id \
  --journey "A new user signs up and creates their first project"
```

`--website` identifies the intended Databuddy website. Supplying an ID does
not establish permission to access that website. `--journey` gives the agent
a concrete workflow to plan instrumentation for.

The command writes one JSON artifact to stdout and redacted progress to
stderr. Redirect stdout if you want another copy of the plan:

```bash
npx @databuddy/setup-agent setup /path/to/next-app \
  --website website_id \
  --journey "A new user signs up and creates their first project" \
  > setup-plan.json
```

Review the proposed changes, source references, verification steps, and
unknowns. A completed plan does not mean the SDK is installed or that events
have arrived. Unsupported frameworks stop before an agent call.

## Choose the products

The default is `--products sdk,events`. The available product identifiers are
`sdk`, `events`, `flags`, `ai-agents`, `mcp`, `links`, and `uptime`. Feature
flags, links, and uptime are included only when you request them. Links are
campaign and share URLs created through the API or MCP; uptime means monitors
for the application's own health, API, and marketing endpoints. Both are
planning-only products:

```bash
npx @databuddy/setup-agent setup /path/to/next-app \
  --website website_id \
  --journey "A user tries the new project editor" \
  --products sdk,events,flags
```

AI-agent and MCP requests produce plans for the relevant surfaces the agent
finds. Missing integration surfaces remain unknowns or pending work.

## Recommendations

Every plan also carries `recommendations`: what the application should measure
next, each anchored in its source and taken from the product reference. Kinds
are `tracker_setting` (one SDK option with its value), `custom_event` and
`server_event` (must name a planned event), `funnel` (the journey as two to ten
ordered event or path steps; every plan with events has at least one),
`goal` (one conversion step), and `flag`, `link`, `monitor` for those
products. The validator rejects invented tracker options, events that are not
planned, funnel steps that are neither planned nor already tracked in source,
and recommendations for products that were not requested. Priority is
`journey` when a step of the stated journey is unmeasured, `quality` when
existing data is wrong or sensitive, and `enrichment` otherwise.

## Full utilization report

`databuddy report` is the whole-product command. It runs the `@databuddy/scan`
action map as a pre-pass (coverage and a suggested event name per user
action), writes the full rows into the snapshot under `.databuddy-scan/`, and
runs the `events`, `tracker`, `server` and `growth` areas as parallel
read-only investigations, each with the reference topics it needs. Each area
is verified independently, also in parallel, and the merged result carries
every supported finding, including `recommendation` findings whose
`recommendation` object is validated the same way as plan recommendations
(tracker option enum, event names, funnel steps that exist or are proposed,
goal targets; tracker values must be literals). The thirty highest-priority
untracked actions from the scan form a required worklist for the `events`
area: each must end as a recommendation anchored on that handler or as an
explicit `decisions` entry (`skip` with a reason, or `unverifiable`), and the
validator rejects an investigation that leaves one undecided. Remaining
untracked actions are kept as a `backlog` and rendered as their own section,
with the agent's skip reasons where it reviewed them, so the handover lists
every known gap. Findings that two areas reach
independently are merged, keeping the higher priority. An area that fails
after its repair is reported as missing instead of aborting the run. The
checkpoint at `.databuddy/report.json` stores finished areas so a rerun only
completes what is missing. `--markdown <file>` renders the handover document.

## Fewer model calls

Model output is cleaned deterministically before validation, so trivial slips
no longer cost a repair task: the JSON object is extracted from fences or
narration, common enum slips (for example a `hypothesis` category) are mapped
onto the contract, and a citation whose quote exists in the file but not at
the cited line is re-anchored to the nearest occurrence. A repair is only
requested when a quote cannot be found at all, and it continues the same
agent session with the validation failure and exact source windows, so the
model does not re-read the repository. The verifier receives numbered source
around every cited anchor and still traces callers in the snapshot itself.

## Product reference

Every planning, implementation, review, and diagnosis task receives the
Databuddy product reference from `references/`: one file per
topic (tracker, custom events, frameworks, privacy, server SDK, feature flags,
query API, links, uptime, AI agents and MCP). The files are copied into the
read-only source snapshot under `.databuddy-reference/`, and the prompt lists
them with a one-line summary each. The agent must take option names,
signatures, endpoints, and event rules from these files rather than from
memory. They are derived from the Databuddy docs and SDK source; update them
when the product changes.

## Select a model route

The default backend is Codex with your existing `codex login`, at `medium`
reasoning effort. Use `--agent claude` for Claude Code, `--model` for another
model, and `--model-auth api-key` to bill `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY` directly instead of a subscription. See
[models](models.md) for defaults and the checks each route runs.

The command does not load the target's environment files or execute its
configuration. Help does not refresh model credentials. Credential checks
run only when a new agent task is needed, so an unchanged cached plan can be
returned without model credentials or another model call.

`--timeout` sets a deadline in seconds, from 1 to 3600; the default is 600.
Cancellation and the deadline abort the agent task. The command exits
nonzero on failure and prints a redacted error to stderr. `--max-cost-usd`
stops further model calls when reported estimated cost reaches the limit;
an individual call can exceed it. Costs include retries and repairs. If a
provider reports no estimate, no additional paid task starts under a limit.

## Review scope and checks

The independent reviewer receives a numbered list of every hunk in the
proposed diff and states which planned step or event each one serves. A hunk
it marks unrelated, such as a restyle or reformat, becomes a rejection issue
naming its file and line. The reviewer also rejects ignored plan
requirements and missing planned event properties. After `--apply`, each
`--check <command>` you pass runs in the repository and its exit code is
recorded under `checks`; the agent does not run project tools otherwise.

## Resume and review privacy

The checkpoint is `<repository>/.databuddy/setup.json`. Repeating the same
command reuses a validated plan when its inputs and inspected source are
unchanged. Changed inputs or source require a new plan. Interrupted or
failed planning can be retried with the same command. An interrupted source
review resumes the exact saved candidate without regenerating edits. An interrupted application
requires the original `--apply` invocation, reuses reviewed edits without model
calls, and refuses changed source. The independent reviewer may reject a
candidate up to three times; each retry receives every issue raised so far.
After the third rejection the last candidate diff is kept at
`.databuddy/rejected.patch` so its remaining issues can be fixed by hand.
The private source diff is
`.databuddy/setup.patch`; package-manager manifest and lockfile changes remain
visible in the repository diff. Applied results retain pending runtime
verification and unverified website access. Private task artifacts in
`.databuddy/runs/` retain redacted prompts, responses, usage, session IDs,
and failure or interruption status across later runs.

The agent receives a temporary snapshot of selected text source, manifests,
and Markdown documents. Hidden entries, dependencies, generated output,
vendored code, test directories, symlinks, and filenames associated with
credentials or private keys are excluded. README and agent guidance are
included as untrusted source material, not instructions. Source is limited
to 1 MiB per file and 10 MiB in total.

Review the source you permit the selected model provider to process.
Snapshot filtering is not full filesystem isolation. Every snapshot file is
scanned for environment credential values, private key blocks, common
provider key formats and long quoted values assigned to secret-named keys,
and each match is redacted; `--apply` refuses to edit a file that contained
one. Detection is pattern-based and cannot recognise every secret format.
Treat the saved checkpoint and exported plan as private repository context.
