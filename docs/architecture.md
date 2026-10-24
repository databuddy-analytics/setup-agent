---
title: Architecture and pending work
description: Understand Databuddy planning, reviewed SDK implementation, and the remaining runtime verification work.
---

# Architecture and pending work

The intended product is an implementation agent that gets Databuddy set up
in a customer's application. Its workflow will inspect the app, plan useful
instrumentation, produce reviewable code changes, and verify resulting data.
The current command implements inspection and planning for web applications whose framework it detects from manifests
and, with `--apply`, separately reviewed SDK/custom-event edits and installation.

## Current flow

1. Validate the website ID, user journey, and requested products.
2. Inventory selected text source and manifests while honoring ignore rules
   and excluding hidden entries, build output, dependencies, tests,
   symlinks, and credential-related filenames.
3. Detect the framework from manifests (apply requires Next.js) and create a redacted temporary snapshot.
4. Invoke a read-only Codex or Claude task to propose the requested setup.
5. Validate the JSON schema, requested-product coverage, event names, and
   references to existing source lines. Invalid output receives one repair
   attempt.
6. Confirm the source did not change during planning and atomically save
   the result to `.databuddy/setup.json`.
7. With `--apply`, propose source edits in the snapshot and run a separate
   read-only review, allowing one repair after rejection.
8. Save a private source patch and interruption journal, install the SDK with
   scripts and pnpm hooks disabled, and apply edits while refusing source drift.

A fingerprint covers the request, backend/model configuration, and inspected
source. A validated matching checkpoint returns the saved artifact without
calling the model. Failed planning is retryable but does not claim to resume
inside an agent's individual tool calls.

The implementation lives in `src/databuddy-setup.ts`; request, plan, result,
and checkpoint schemas live in `src/schema.ts`. The CLI is
`src/databuddy-cli.ts` and the read-only task adapters are in `src/agents/`.

## Product scope

SDK and custom events are the default requested products. Feature flags
require explicit opt-in. AI-agent and MCP requests produce source-backed
proposals for relevant discovered surfaces, with gaps recorded as unknowns.
A plan must cover every requested product without adding unrequested ones.

Planning marks implementation `pending`; successful `--apply` marks it
`complete` and records applied files, SDK version, and the source review.
Runtime verification stays `pending` and website access stays `unverified`.
File/line checks establish proposal anchors, while the separate model review
checks candidate source and records unresolved runtime questions.

## Work still required

The next slice must define and enforce website permissions and test synthetic
journeys against the running application. Runtime verification
must check event arrival, naming, properties, duplicates, and sensitive-data
handling. Repository edits and service writes need explicit authorization
and separate permissions from source inspection.

Applying flags, AI-agent and MCP instrumentation, additional frameworks, and
independent live verification are future work.

## Privacy boundary

The snapshot is limited to 1 MiB per file and 10 MiB in total. Known
credential values and token patterns are redacted. Source exclusions and
redaction cannot identify every embedded secret or provide full filesystem
isolation. Only inspect code the user permits the selected provider to
process, and treat saved plans as private repository context.
