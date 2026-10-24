---
title: Models
description: Choose the Databuddy setup agent backend, model, reasoning effort, and credential route.
---

# Models and credentials

The setup agent runs each task through Codex or Claude Code. The default
backend is `codex`, the default credential route is `local`, and the default
reasoning effort is `medium`. Choose a model with `--model`; the identifier
must be one the selected backend accepts.

```bash
npx @databuddy/setup-agent setup /path/to/next-app \
  --website website_id \
  --journey "A new user signs up" \
  --agent claude --thinking-level high
```

| Backend | Default model | Local login | API key |
| --- | --- | --- | --- |
| `codex` | `gpt-6-sol` | `codex login` (reads `$CODEX_HOME/auth.json`) | `OPENAI_API_KEY` |
| `claude` | `claude-opus-5-5` | Claude Code signed in, or `CLAUDE_CODE_OAUTH_TOKEN` | `ANTHROPIC_API_KEY` |

Both backends drive the CLI already installed on your `PATH` rather than
shipping their own platform binaries. Set `CODEX_EXECUTABLE` or
`CLAUDE_CODE_EXECUTABLE` to use a specific binary.

Both backends can read only the redacted snapshot, which lives in
`~/.cache/databuddy-setup-agent` (or `$XDG_CACHE_HOME`) while a task runs.
Codex enforces this with Seatbelt on macOS and bubblewrap on Linux. On Linux
it needs `bwrap` installed and unprivileged user namespaces allowed; Docker's
default profile blocks those, so in a stock container Codex refuses every
command rather than running unconfined. There, use `--agent claude`, whose
file access is checked inside the agent, or run the container with
`--security-opt seccomp=unconfined`.

Accepted reasoning levels are `minimal`, `low`, `medium`, `high`, and
`xhigh`. Each backend maps them to its own reasoning control.

## Credential routes

`--model-auth local` reuses the backend's existing machine login, so runs
count against that subscription. Before the first model call, the local
route refuses to start when `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` or a provider base URL is set, because any of them
would silently move the run to API billing or another endpoint.
`AI_GATEWAY_API_KEY` is allowed: the agent never passes it to Codex or Claude,
and the optional action scan uses it to send code to your own gateway. Unset them for the invocation, or choose the API route.

`--model-auth api-key` bills the provider account directly and requires the
backend's own key from the table above. Credentials stay in the environment;
never pass them in command flags.

Credentials are checked only when a task needs a model call, so `--help` and
an unchanged checkpoint run without any login. The agent never loads
environment files from the target repository, and each agent process
receives only an allowlisted environment plus the one credential it needs.

API calls may incur provider charges. `--max-cost-usd` stops further tasks
once the estimated cost reaches the limit; a task can exceed the limit
before its cost is reported. Codex reports a cost only for models with known
pricing, so a limit with any other Codex model, including the default
`gpt-6-sol`, is refused before the run starts. `--timeout` is cooperative cancellation, not a spending
cap.
