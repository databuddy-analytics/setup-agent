# Databuddy setup agent

The Databuddy setup agent reads a web application's source and tells you how
to get Databuddy working in it. It runs on the Codex or Claude Code login you
already have, keeps every task read-only against a filtered snapshot of your
code, and has a second agent independently check each claim against the
source before it reaches you.

It has three commands:

- `databuddy report` investigates custom events, the browser tracker, server events, and the
  growth products (flags, links, uptime, AI crawler and MCP analytics) in
  parallel. The result lists what works, what is broken, and each addition
  as a structured recommendation anchored on the source line that justifies
  it. An optional action scan can map every user action first.
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

### The optional action scan

`report --scan on` first runs `@databuddy/scan` to map every user action in
the code and whether it is already tracked, which usually surfaces more
tracking gaps. It is off unless you turn it on, because it sends code to
Databuddy:

- It reads the same filtered, redacted snapshot the model receives, never your
  repository, so excluded files (including every `.env`) and redacted secrets
  never reach it, and it gets only a minimal environment.
- Only the user actions it finds and the functions they call are sent, not
  whole files. Swift files and files it cannot parse are sent whole.
- Databuddy's scan API classifies them with the Jev model on Vercel AI Gateway
  with zero data retention. Your code is never stored or logged. Databuddy
  records only request metadata (size, counts, timing and a random run ID), and
  uses your IP only as a hashed rate-limit key.
- Set `AI_GATEWAY_API_KEY` in your shell to send the code to your own Vercel AI
  Gateway account instead, and Databuddy receives nothing. A key in the
  repository's `.env` is not used, because the scanner never sees that file.
- `npx @databuddy/scan@0.1.3 --dry-run` lists every line that would be sent
  without sending anything. Results are cached in `~/.cache/databuddy/scan`.
- The scanner is an exact dependency of this package (or `--scan-bin`), so
  nothing is downloaded at run time. `setup` and `diagnose` never run it.

[How the scanner handles your code](https://www.databuddy.cc/docs/privacy/event-scanner).

Limit any command to part of a monorepo with repeatable `--scope`
options, and `report` to some areas with `--areas events,tracker`.

## Keep working in your agent

`setup` and `report` never change your agent's configuration. When they
finish, they print a command that adds Databuddy's hosted MCP server so the
same Claude Code or Codex session can query your analytics and create the
recommended funnels, goals, flags and links:

```bash
npx @databuddy/setup-agent mcp /path/to/app --agent claude
```

It prints exactly what it will change and asks before changing it (pass
`--yes` when not running in a terminal). For Claude Code it writes the
repository's own `.mcp.json` unless you pass `--scope user`. Codex has only a
user-level config (`~/.codex/config.toml`), and the command says so before
asking. It uses the agent's own `mcp add` command and leaves an existing
`databuddy` entry unchanged. Sign in afterwards with `/mcp` in Claude Code or
`codex mcp login databuddy`.

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

## Telemetry and feedback

When you pass `--website`, `setup` and `report` send one short report to
Databuddy after each run, so we can see which stacks the agent handles and
where it fails. It contains the outcome, the steps that completed, typed
issue codes such as `review_rejected` or `sdk_install_failed`, the first line
of any error with file paths and credentials removed, the framework and
package manager, which of a fixed list of well-known packages you use (for
example `next`, `better-auth` or `stripe`; other dependency names are never
sent), the agent backend and model, and finding and check counts. It never
contains source code, file paths, repository names or prompts. Turn it off
with `--no-telemetry`, `DATABUDDY_TELEMETRY=0` or `DO_NOT_TRACK=1`, or set
`DATABUDDY_TELEMETRY=print` to see the exact payload without sending it.

Send a bug report, feature request or other feedback with:

```bash
npx @databuddy/setup-agent feedback "Apply stopped after the SDK install" \
  --website website_id --category bug_report
```

## Models and privacy

The default backend is Codex at `medium` reasoning effort using your local
login. `--agent claude` switches to Claude Code, and `--model-auth api-key`
bills `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` instead of a subscription.
[Models](docs/models.md) lists the defaults and credential checks.

The selected model provider reads a temporary snapshot of your source,
manifests, and Markdown. Hidden files (including every `.env`), dependencies,
build output, test files and directories, lockfiles, symlinks, credential or
key files (such as `secrets.ts`, `keys.ts` or `service-account.json`), and any
service-account key JSON whatever its name are excluded. In every file that
remains, the agent redacts credential values from your environment, private
key blocks, keys in the formats AWS, GitHub, Stripe, Slack, Google, npm,
Resend, Mailgun, OpenAI, Anthropic, Vercel and Databuddy use, JWTs, passwords
in URLs, values assigned to secret-named keys and identifiers (quoted in code
such as `apiKey: "..."` or `const dbPass = "..."`, unquoted in YAML, TOML and
env files), and random-looking quoted strings of 32 or more characters.
Detection is pattern-based, so a secret in a format it does not recognise can
still reach the provider; only run the agent on code you allow that provider
to read. The model can read only that snapshot: Codex runs under a permission
profile that denies every other path, and Claude's file tools refuse paths
outside it.
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
