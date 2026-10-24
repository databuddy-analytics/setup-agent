# Databuddy setup agent

The Databuddy setup agent reads a web application's source and tells you how
to get Databuddy working in it. It runs on the Codex or Claude Code login you
already have, keeps every task read-only against a filtered snapshot of your
code, and has a second agent independently check each claim against the
source before it reaches you.

It has three commands:

- `databuddy report` maps every user action with `@databuddy/scan`, then
  investigates custom events, the browser tracker, server events, and the
  growth products (flags, links, uptime, AI crawler and MCP analytics) in
  parallel. The result lists what works, what is broken, and each addition
  as a structured recommendation anchored on the source line that justifies
  it.
- `databuddy setup` plans SDK placement and custom events around one user
  journey. With `--apply` in a Next.js app it installs the SDK and writes
  edits that a separate reviewer has approved.
- `databuddy diagnose` answers one question about existing instrumentation
  with quoted evidence and an independent verdict for every finding.

None of the commands query live analytics or check website permissions, and
applied edits are not built or exercised in a browser. Those verification
steps are still pending.

## Run it

Use Node.js 22 or later, Git, and a signed-in `codex` or `claude` CLI. The
package has no runtime dependencies, so `npx` (or `bunx`) starts it in a few
seconds:

```bash
npx @databuddy/setup-agent report /path/to/app \
  --journey "A visitor signs up and creates their first project" \
  --markdown report.md
```

```bash
npx @databuddy/setup-agent setup /path/to/next-app \
  --website website_id \
  --journey "A new user signs up and creates their first project" \
  --apply
```

```bash
npx @databuddy/setup-agent diagnose /path/to/repository \
  --question "Which signup and checkout events can fire twice?" \
  --scope apps/web
```

Each command writes one JSON artifact to stdout and redacted progress to
stderr, and saves an atomic checkpoint under `<repository>/.databuddy/`.
Repeating a command with unchanged source and options returns the saved
result without a model call; an interrupted run resumes the work it has
not finished. Private task records, including redacted prompts and usage,
stay in `.databuddy/runs/`. Add `.databuddy/` to the target's `.gitignore`.

`report` runs `@databuddy/scan` first. It uses `--scan-bin` when given, then
`databuddy-scan` on `PATH`, then `npx @databuddy/scan`. The scan sends code
excerpts to Databuddy's scan API under its zero-retention terms; `--scan off`
skips it. Limit any command to part of a monorepo with repeatable `--scope`
options, and `report` to some areas with `--areas events,tracker`.

## Keep working in your agent

`npx @databuddy/setup-agent mcp --agent claude` (or `--agent codex`) adds
Databuddy's hosted MCP server to that agent's user config, so the same
Claude Code or Codex session can query your analytics and create the
recommended funnels, goals, flags and links. Pass `--mcp` to `setup` or
`report` to do this when the run finishes. It uses the agent's own
`mcp add` command and leaves an existing `databuddy` entry unchanged. Sign
in afterwards with `/mcp` in Claude Code or `codex mcp login databuddy`.

## Check applied edits

The agent never runs your project's tools on its own, because a formatter or
typecheck executes the project's configuration. Pass the commands you trust
with `--check`, and they run in the repository after `--apply` writes the
reviewed edits:

```bash
npx @databuddy/setup-agent setup . --website website_id \
  --journey "A shopper adds a product to the cart and starts checkout" \
  --apply --check "pnpm exec tsc --noEmit" --check "pnpm exec prettier --check ."
```

Each result, with its exit code and the end of its output, is added to the
artifact under `checks`, and a failing check makes the command exit 1.

## Models and privacy

The default backend is Codex at `medium` reasoning effort using your local
login. `--agent claude` switches to Claude Code, and `--model-auth api-key`
bills `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` instead of a subscription.
[Models](docs/models.md) lists the defaults and credential checks.

The selected model provider receives a temporary snapshot of your source,
manifests, and Markdown. Hidden files, dependencies, build output, tests,
symlinks, and credential-named files are excluded, and known credential
values and token shapes are redacted. Filtering is not complete secret
detection, so only run the agent on code you allow that provider to read.
The agent never loads the target's environment files or executes its
configuration.

- [Getting started](docs/getting-started.md) walks through a first plan.
- [Setup planning](docs/databuddy-setup.md) covers products, checkpoints, and the snapshot.
- [Models](docs/models.md) covers backends and credentials.
- [Architecture](docs/architecture.md) describes the flow and the pending work.
- [Contributing](CONTRIBUTING.md) covers development.

## License and attribution

The Databuddy setup agent is licensed under Apache 2.0. It is derived from
[DeepSec](https://github.com/vercel-labs/deepsec) by Vercel, Inc. and
contributors, also Apache 2.0. Databuddy removed DeepSec's security-audit
pipeline and built the setup, diagnose, and report workflows on its agent
adapters. [NOTICE](NOTICE) lists what was kept and changed, and files derived
from DeepSec carry a header naming it. See [LICENSE](LICENSE) for the full
license text.
