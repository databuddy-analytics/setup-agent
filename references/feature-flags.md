<!--
Sources:
.agents/skills/databuddy/references/feature-flags.md
apps/docs/content/docs/sdk/feature-flags.mdx
apps/docs/content/docs/sdk/server-flags.mdx
apps/api/src/routes/public/flags.ts
packages/ai/src/ai/mcp/tools.ts (list_flags, create_flag, update_flag, add_users_to_flag)
packages/ai/src/ai/tools/flags.ts
packages/shared/src/flags/index.ts
packages/api-keys/src/scopes.ts
-->

# Feature flags (client, server, MCP)

## What it is

Dashboard-controlled flags with boolean, rollout-percentage, and multivariant types. Evaluation hits a public endpoint keyed by website `clientId` (no API key); creating/editing/deleting flags requires an API key (or MCP session) with `manage:flags`. React/Vue hooks and a Node server manager wrap the same evaluation endpoint with caching.

## Exact API

### Evaluation endpoint (`/v1/flags`)
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/flags/evaluate` | query: `key`, `clientId` required; optional `userId`, `email`, `organizationId`, `teamId`, `properties` (JSON string), `environment`. Returns `{enabled, value, payload, reason, variant?}` |
| GET / POST | `/v1/flags/bulk` | `clientId` required; optional `keys` (comma string on GET, array max 100 on POST), `userId`, `email`, `organizationId`, `teamId`, `properties`, `environment`. Returns `{flags: Record<key, FlagResult>, count}` |
| GET | `/v1/flags/definitions` | admin-only (needs `manage:flags` key); returns full flag definitions for a `clientId` |
| POST | `/v1/flags/` | create (admin-only) |
| PATCH | `/v1/flags/:id` | update (admin-only) |
| DELETE | `/v1/flags/:id` | archive/delete (admin-only) |

Rate limit on public eval: 600 requests / 60s per `clientId`+IP (`PUBLIC_EVAL_RATE_PER_MINUTE`). Cache-Control on `evaluate`/`bulk` GETs without targeting params: `public, max-age=15, s-maxage=30, stale-while-revalidate=15`; otherwise `private, no-store`.

`FlagResult.reason` values: `USER_RULE_MATCH`, `TARGET_GROUP_MATCH`, `MULTIVARIANT_EVALUATED`, `ROLLOUT_ENABLED`, `ROLLOUT_DISABLED`, `BOOLEAN_DEFAULT`, `DEPENDENCY_NOT_SATISFIED`, `FLAG_NOT_FOUND`, `MISSING_REQUIRED_PARAMS`, `RATE_LIMITED`, `EVALUATION_ERROR`.

### Flag shape
```ts
type FlagType = "boolean" | "rollout" | "multivariant";
flagFormShape = {
  key: string,            // /^[a-zA-Z0-9_-]+$/, 1-100 chars
  name?: string,
  description?: string,
  type: FlagType,
  status: "active" | "inactive" | "archived",
  defaultValue: boolean,  // served when no rule matches
  rolloutPercentage: number,  // 0-100
  rolloutBy?: string,     // "user" | "organization" | "team"
  rules?: UserRule[],
  variants?: Variant[],
  dependencies?: string[],  // keys that must be "active" for this flag to be active
  environment?: string | null,
  targetGroupIds?: string[],
}
UserRule = {
  type: "user_id" | "email" | "property",
  operator: "equals" | "contains" | "starts_with" | "ends_with" | "in" | "not_in" | "exists" | "not_exists",
  field?: string, value?: string, values?: string[],
  enabled: boolean, batch: boolean, batchValues?: string[],
}
Variant = { key: string, value: unknown, weight?: number /* 0-100 */, description?: string, type: "string"|"number"|"json" }
```
If any variant has a `weight`, weights across all variants must sum to 100. If none have weights, assignment is an even hash split.

### Evaluation order
1. Direct user rules (`flag.rules`) — first match wins, force on/off.
2. Attached target group rules — same semantics.
3. Multivariant assignment (hash-based, weighted or even).
4. Rollout percentage (hashed by `rolloutBy`: `organization`, `team`, else `userId`/`email`).
5. Boolean `defaultValue`.

Dependencies: a flag with `dependencies` only evaluates (otherwise `DEPENDENCY_NOT_SATISFIED`) when every dependency flag is `status: "active"`.

### React (`@databuddy/sdk/react`)
- `<FlagsProvider clientId apiUrl? isPending? user? />`
- `useFlag(key)` → `{ on, loading, value, variant, status, ... }`
- `useFlags()` → `isOn`, `getFlag`, `getValue`, `fetchFlag`, `fetchAllFlags`, `updateUser`, `refresh`, `isReady`

### Vue (`@databuddy/sdk/vue`)
- `createFlagsPlugin({ clientId, apiUrl?, user? })`, installed via `app.use(...)`
- `useFlag(key)` → refs `{ on, loading, state }` (no top-level `status`/`value`/`variant`; read `state.value.variant` etc.)
- `useFlags()` → `getFlag`, `fetchAllFlags`, `updateUser`, `refresh`, `updateConfig`, `memoryFlags`, `lastError` (no `isOn`, `getValue`, `fetchFlag`, `isReady`)

### Server (`@databuddy/sdk/node`)
`createServerFlagsManager(config)`:
| Option | Type | Default |
|---|---|---|
| `clientId` | string | required |
| `apiUrl` | string | `https://api.databuddy.cc` |
| `user` | `{userId?, email?, organizationId?, teamId?, properties?}` | - |
| `environment` | string | - |
| `cacheTtl` | number | `60000` ms |
| `staleTime` | number | `30000` ms |
| `maxCacheSize` | number | `5000` |
| `autoFetch` | boolean | `false` |
| `debug` | boolean | `false` |
| `disabled` | boolean | `false` |

`await flags.waitForInit()`, then `await flags.getFlag(key, user?)` → `{enabled, value, variant?, reason}`; throws `FlagsRequestError` when the request fails with no cached result. `fetchAllFlags()` preloads for fast sync-style `isEnabled()`/`getValue()` reads.

### Shared config keys
`clientId`, `apiUrl`, `user.userId/.email/.organizationId/.teamId/.properties`, `environment`, `isPending` (browser only, defers eval during auth load), `defaults` (local fallback by key), `disabled`, `cacheTtl`/`staleTime`, `skipStorage` (browser only, skip localStorage cache, default `false`).

### MCP tools
- `list_flags({ websiteId?, websiteName?, websiteDomain?, status?, limit, offset })` → `{ flags: object[], hasMore }`. Read access.
- `create_flag({ websiteId selector, key, ...flagConfigFields, rules, confirmed })` — `confirmed=false` (default) returns a preview without writing; `confirmed=true` writes. `flagConfigFields` = `name?, description?, type?, status?, defaultValue?, payload?, persistAcrossAuth?, rolloutPercentage?, rolloutBy?, rules?, variants?, dependencies?, targetGroupIds?`. Created flag defaults: `defaultValue: false`, `rolloutPercentage: 0`, `status: "inactive"`, `type: "boolean"` when omitted. Rate limit 20/60s. Requires `manage:flags`.
- `update_flag({ websiteId selector, id, ...flagConfigFields, rules, confirmed })` — `rules` replaces every existing rule. `confirmed=false` returns current flag + full rule targets + planned diff. Rate limit 20/60s. Requires `manage:flags`.
- `add_users_to_flag({ websiteId selector, flagId, users, matchBy?, mode?, confirmed })` — `users`: 1-500 emails or IDs; `matchBy`: `"email"` (default) or `"user_id"`; `mode`: `"append"` (default, adds one rule) or `"replace"` (deletes existing rules first). Rate limit 20/60s.

### Scope required
`manage:flags` — the only scope covering create/update/delete flags and targeting rules.

## When to recommend it

- Signal: hardcoded boolean constants or `process.env.FEATURE_X` toggles gating UI/behavior that product wants to roll out gradually → Recommend: a boolean or rollout flag via `create_flag` (MCP) or the dashboard, evaluated with `useFlag`/`getFlag` instead of the env var.
- Signal: an A/B test or staged rollout is being done by duplicating components/branches → Recommend: one multivariant flag with weighted variants, read via `useFlag(key).variant`.
- Signal: an existing config-flag pattern reads env vars per deploy instead of per-request/per-user targeting → Recommend: a flag with user rules or a rollout percentage, evaluated per request against `GET /v1/flags/evaluate`.
- Default, any flag used as an experiment → Recommend: track the outcome event with `flag_key` and `variant` properties (see custom-events.md), not just the render.

## How to implement

1. `bun add @databuddy/sdk`.
2. Browser: wrap the app in `<FlagsProvider clientId={...} user={...} isPending={...}>`; replace the conditional with `useFlag("key").on`. Pass `isPending` while auth/session loads to avoid a flash of anonymous-then-real-user evaluation.
3. Server: construct one shared `createServerFlagsManager` per long-lived process (or per-request for SSR with request user context); `await waitForInit()` before calling `getFlag`.
4. Create the flag via MCP `create_flag` (preview first with `confirmed=false`, then `confirmed=true`) or the dashboard, using a stable product-concept key (not a component name).
5. Track the outcome, not just the render: one product event (e.g. via `track()`) carrying `flag_key` and `variant`, for any flag used as an experiment.

## How to verify

- Call `GET /v1/flags/evaluate?key=...&clientId=...` directly and confirm `reason` matches the expected evaluation path (e.g. `ROLLOUT_ENABLED` vs `BOOLEAN_DEFAULT`).
- In React/Vue, confirm `loading` resolves and `on`/`state.value.on` matches dashboard config for a known test user.
- For experiments, confirm the outcome event fires with the correct `variant` for both arms.

## Pitfalls

- Evaluation needs a website `clientId`, never an API key — do not gate the public evaluate/bulk endpoints behind `x-api-key`.
- Group rollouts (`rolloutBy: "organization"`/`"team"`) are inconsistent unless every member of the group is passed the same `organizationId`/`teamId`.
- Direct user rules and target group matches are force on/off gates, not variant selectors — using them on a multivariant flag intended for a clean A/B/n experiment contaminates variant metrics; use a separate boolean eligibility flag instead.
- Variant weights must sum to exactly 100 when any variant specifies a weight.
- A flag with `dependencies` stays `DEPENDENCY_NOT_SATISFIED` until every dependency is `status: "active"`.
- Browser flags cache in localStorage unless `skipStorage: true`; a stale cached value can mask a dashboard change until `refresh(true)` or TTL expiry.
- Vue's `useFlag`/`useFlags` surface is not API-identical to React's — no top-level `status`/`value`/`variant`, no `isOn`/`getValue`/`fetchFlag`/`isReady`.
