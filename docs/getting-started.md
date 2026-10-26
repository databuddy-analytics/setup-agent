---
title: Getting started
description: Create the first Databuddy setup plan for a web application.
---

# Create your first setup plan

The Databuddy setup agent detects the framework, inspects the codebase and proposes SDK
placement and useful custom events around a user journey. The default command
saves a plan. `--apply` installs the SDK and applies separately reviewed
SDK/custom-event edits; live telemetry verification remains pending.

## Prerequisites

Use Node.js 22 or later, Git, a signed-in `codex` or `claude` CLI, and an
application whose
source you permit that model provider to process. Have your intended Databuddy website ID and a concrete
user journey ready.

Run the published package with `npx`:

```bash
npx @databuddy/setup-agent setup /path/to/next-app \
  --website website_id \
  --journey "A new user signs up and creates their first project"
```

The default Codex backend uses your existing `codex login` with `medium`
reasoning effort. Select Claude Code or API-key billing with
[model flags](models.md). The agent does not load target environment files
or execute target configuration.

## Review the result

Stdout contains one JSON artifact; stderr contains redacted progress.
The plan includes changes linked to existing source lines, custom-event
names and property proposals, verification steps, and remaining unknowns.
SDK and events are requested by default; feature flags are opt-in through
`--products sdk,events,flags`.

The phase statuses are:

| Phase | Current result |
| --- | --- |
| Inspection | Complete |
| Planning | Complete |
| Implementation | Pending, or complete after successful `--apply` |
| Verification | Pending |
| Website access | Unverified |

A source anchor proves that the cited file and line exist in the inspected
snapshot. It does not prove that the proposed integration works.

## Repeat an interrupted run

The atomic checkpoint is `<repository>/.databuddy/setup.json`. Repeat the
same command after cancellation or failure. A validated unchanged plan is
returned without another model call; changed requests, model configuration,
or inspected source require replanning.

Before running, review the snapshot exclusions and secret-detection limits
in [setup planning](databuddy-setup.md). The default deadline is 1200 seconds;
`--timeout` accepts 1 to 3600 seconds.
