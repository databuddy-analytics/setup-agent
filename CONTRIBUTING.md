# Contributing to the Databuddy setup agent

The setup agent plans Databuddy instrumentation, applies reviewed SDK and
custom-event edits in Next.js apps, and reports how a codebase can use the
rest of Databuddy. Preserve source validation, independent review, and
interruption recovery while keeping runtime verification explicitly pending.

## Development workflow

Use Node.js 22 or later, Git, and the pnpm version pinned in `package.json`.
From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm databuddy --help
pnpm validate
```

`pnpm validate` runs the typecheck, Biome, knip, the bundle, and every Vitest
suite. The tests use stub agents and make no model calls.
`pnpm test:live` runs one real diagnosis through your local agent login and
may count against its quota.

`pnpm bundle` writes `dist/databuddy-cli.mjs`. Test a setup change against a
disposable copy of a real or synthetic Next.js app. Planning must leave
source unchanged. For `--apply`, verify reviewed edits, SDK installation,
interruption recovery, and refusal to overwrite later source changes.

## Releasing

Bump `version` in `package.json`, push to `main`, then start the Release
workflow from the Actions tab. It runs `pnpm validate` and publishes with npm
provenance, so each version can be traced to the commit that built it. Before
the first run, register this repository and `release.yml` as a trusted
publisher for `@databuddy/setup-agent` on npmjs.com.

## Ownership

- `src/schema.ts` owns request, plan, result, and checkpoint schemas.
- `src/databuddy-setup.ts` owns framework detection, planning, implementation, review, and apply.
- `src/databuddy-diagnosis.ts` owns scoped investigation, quoted evidence, verification, and resume.
- `src/databuddy-report.ts` and `src/scan-prepass.ts` own the utilization report and its scan pre-pass.
- `src/repository-snapshot.ts` owns source filtering and snapshots; `src/model-output.ts` owns JSON extraction and repair.
- `src/databuddy-cli.ts` owns arguments and output; `src/model.ts` owns backend, model, and credential selection.
- `src/agents/` owns the read-only Codex and Claude task adapters.
- `references/` owns the Databuddy product reference given to every task.

Keep website access `unverified` and runtime verification `pending`. Mark
implementation `complete` only after the reviewed edits and SDK dependency
are present. Source anchors show where a proposal came from; an existing
file and line do not establish that the proposed SDK code or event
semantics are correct.

## Style and review

Match the existing TypeScript style and keep each change independently
reviewable. Comments should explain constraints rather than repeat code.
Verify commands and claims in documentation against source. Preserve the
DeepSec attribution in `NOTICE`, `LICENSE`, and the header of each file
derived from it, and add that header when you copy further DeepSec code. Report security
issues according to [SECURITY.md](SECURITY.md).
