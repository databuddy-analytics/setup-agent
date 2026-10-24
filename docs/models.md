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

Accepted reasoning levels are `minimal`, `low`, `medium`, `high`, and
`xhigh`. Each backend maps them to its own reasoning control.

## Credential routes

`--model-auth local` reuses the backend's existing machine login, so runs
count against that subscription. Before the first model call, the local
route refuses to start when `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, a provider base URL, or `AI_GATEWAY_API_KEY` is set,
because any of them would silently move the run to API billing or another
endpoint. Unset them for the invocation, or choose the API route.

`--model-auth api-key` bills the provider account directly and requires the
backend's own key from the table above. Credentials stay in the environment;
never pass them in command flags.

Credentials are checked only when a task needs a model call, so `--help` and
an unchanged checkpoint run without any login. The agent never loads
environment files from the target repository, and each agent process
receives only an allowlisted environment plus the one credential it needs.

API calls may incur provider charges. `--max-cost-usd` stops further tasks
once the estimated cost reaches the limit; a task can exceed the limit
before its cost is reported, and a backend that reports no cost stops the
run under a limit. `--timeout` is cooperative cancellation, not a spending
cap.
