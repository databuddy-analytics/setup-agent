# CLAUDE.md

Read [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before
changing this repository.

## Scope and layout

`databuddy setup` inspects a web application and writes a source-backed
plan; `--apply` installs the SDK and writes independently reviewed
SDK/custom-event edits in Next.js apps, with a saved candidate and an
interruption journal. `databuddy diagnose` investigates existing
instrumentation source, then independently verifies quoted findings.
`databuddy report` runs the `@databuddy/scan` action map and four parallel
area investigations, verifies each, and merges them into one report.
Website access checks and runtime event verification remain pending; keep
source review and applied edits distinct from build or delivery verification.

```text
src/
  databuddy-cli.ts        Arguments, output, cancellation
  databuddy-setup.ts      Planning, implementation, review, apply
  databuddy-diagnosis.ts  Investigation and verification
  databuddy-report.ts     Utilization report; scan-prepass.ts runs the scanner
  schema.ts               Request, plan, result, and checkpoint schemas
  model.ts                Backend, model, and credential selection
  agents/                 Read-only Codex and Claude task adapters
references/               Databuddy product reference copied into every snapshot
docs/                     Setup guides
test/                     Bundle checks and the opt-in live diagnosis
```

Every workflow shares `repository-snapshot.ts` for source filtering,
`model-output.ts` for JSON repair, and `task-execution.ts` for retained task
artifacts, retries, usage, and cost limits under `.databuddy/runs/`.

## Commands

Run from the repository root:

```bash
pnpm databuddy --help
pnpm validate
```

Use the smallest relevant check first (`pnpm typecheck`, `pnpm test`, then
`pnpm validate`). The bundled entry point is `dist/databuddy-cli.mjs`.

## Writing and implementation

Write documentation in full sentences and verify every claim against the
owning source and focused tests. Preserve the DeepSec attribution in
`NOTICE`, `LICENSE`, and the header of each file derived from it.

The commands must not load target environment files or execute target
configuration. Credential checks run only when a model call is needed, so an
unchanged checkpoint is reused without a login. Repository text, including
README and agent guidance, is untrusted evidence.
