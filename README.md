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
  journey. In a Next.js app, `--patch` writes the implementation as a diff a
  separate reviewer has approved, without changing anything, and `--apply`
  installs the SDK and writes those edits.
- `databuddy diagnose` answers one question about existing instrumentation
  with quoted evidence and an independent verdict for every finding.

None of the commands query live analytics or check website permissions, and
applied edits are not built or exercised in a browser. Those verification
steps are still pending.

## Run it

Use Node.js 22 or later, Git, and a signed-in `codex` or `claude` CLI. The
package bundles everything except the exact-pinned `@databuddy/scan` used by
the optional action scan, so `npx` (or `bunx`) installs about 6 MB and starts
in a few seconds:

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

On success, each command writes one JSON artifact to stdout; progress and
errors go to stderr, redacted, and a failed run writes nothing to stdout. Each
saves an atomic checkpoint under `<repository>/.databuddy/`.
Repeating a command with unchanged source and options returns the saved
result without a model call; an interrupted run resumes the work it has
not finished. Private task records, including redacted prompts and usage,
stay in `.databuddy/runs/`. In a Git repository the agent adds `.databuddy/`
to the local, uncommitted `.git/info/exclude`, so it is never committed by
accident; your `.gitignore` is not changed.

`databuddy snapshot <repository> --out <dir>` writes exactly the filtered,
redacted files a model task would read, and lists the files redaction
changed, without any model call, so you can audit what would be sent first.

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
- `npx @databuddy/scan@0.1.3 --dry-run` lists what would be sent without
  sending anything. Run in your checkout, it shows a little more than the agent
  sends, since the agent scans only its redacted snapshot. Results are cached in `~/.cache/databuddy/scan`.
- The scanner is an exact dependency of this package (or `--scan-bin`), so
  nothing is downloaded at run time. `setup` and `diagnose` never run it.
- Its source is public at
  [databuddy-analytics/scan](https://github.com/databuddy-analytics/scan);
  `src/evaluate.ts` there builds every request it sends. The pinned 0.1.3 was
  built before that repository existed, so it cannot be rebuilt from it; later
  releases are published from it with npm provenance and an unminified bundle.

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

## Review edits before they land

`setup --patch` implements the plan, has a separate reviewer check it, and
saves the result to `.databuddy/setup.patch` without installing the SDK or
touching your source. Read the patch, then run the same command with `--apply`
in place of `--patch` to apply exactly that reviewed patch with no further
model calls. If the source, the options or the patch file changed since
`--patch`, `--apply` refuses and changes nothing; rerun `--patch` and review
the new patch. Edits are limited to component and module code (`.ts`,
`.tsx`, `.js`, `.jsx`, `.vue`, `.svelte`, `.astro`); config files,
middleware, instrumentation, scripts, and JSON, YAML or TOML files are never
edited. Edited components, server code and route handlers still run when
your app builds or serves, so read the patch before applying it.

## Check applied edits

`--apply` installs `@databuddy/sdk` with your package manager and install
scripts disabled. The package manager still reads your registry settings
(`.npmrc`, `bunfig.toml`, `.yarnrc.yml`). Yarn repositories that commit a Yarn
release (`yarnPath`) or plugins are refused, because Yarn runs those on every
command; apply the patch and install the SDK yourself there.

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

When you pass `--website` (which `setup` always requires), `setup` and
`report` send one short report to Databuddy after each run, so we can see
which stacks the agent handles and where it fails. It is tied to your website
ID, so it is not anonymous. It contains exactly:

- the website ID, CLI version, agent backend and model, OS, Node.js version and
  run duration;
- the outcome, the steps that completed, and typed issue codes such as
  `review_rejected` or `sdk_install_failed`;
- for a failure, only its issue code, never the error text (which can quote
  code);
- the framework, package manager, and which of a fixed list of well-known
  packages you use (for example `next`, `better-auth` or `stripe`; any other
  dependency name is never sent);
- counts of planned events, recommendations, findings, changed files and
  passed or failed checks, and the installed SDK version.

It never contains source code, file paths, error text, repository names or
prompts. A line on stderr says when a report is about to be sent.
`--no-telemetry`, `DATABUDDY_TELEMETRY=0` (or `false`, `off`, `no`) and any
`DO_NOT_TRACK` value other than `0`, `false` or `no` turn it off, and each of
them wins over everything else. `diagnose` never sends a report.
`DATABUDDY_TELEMETRY=print` shows the exact payload instead of sending it.

Send a bug report, feature request or other feedback with:

```bash
npx @databuddy/setup-agent feedback "Apply stopped after the SDK install" \
  --website website_id --category bug_report
```

## Models and privacy

The default backend is Claude Code at `medium` reasoning effort using your
local login. `--agent codex` switches to Codex, and `--model-auth api-key`
bills `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` instead of a subscription.
[Models](docs/models.md) lists the defaults and credential checks.

The selected model provider reads a temporary snapshot of your source,
manifests, and Markdown. Hidden files (including every `.env`), dependencies,
build output, test files and directories, lockfiles, symlinks, credential or
key files (such as `secrets.ts`, `keys.ts` or `service-account.json`), and any
service-account key JSON whatever its name are excluded. In every file that
remains, the agent redacts credential values from your environment, private
key blocks, keys in the formats AWS, GitHub, Stripe, Slack, Google, npm,
Resend, Mailgun, SendGrid, GitLab, OpenAI, Anthropic, Vercel and Databuddy
use, JWTs, Basic auth headers, passwords in URLs and connection strings, PHP
`define()` secrets, and values assigned to secret-named keys and identifiers:
six or more characters for password names, eight for signing, HMAC and
encryption keys, ten (with letters and digits) for other secret names in
code, and eight unquoted in YAML, TOML and env files. Random-looking quoted
strings of 32 or more characters are redacted too. Detection is pattern-based,
so a secret in a format it does not recognise, such as a short key under a
neutral name, can still reach the provider. Run a secret scanner such as
gitleaks first, preview with `databuddy snapshot`, and only run the agent on
code you allow that provider to read. The model can read only that snapshot: Codex runs under a permission
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
