<!--
Sources:
apps/docs/content/docs/api/query.mdx
apps/docs/content/docs/api/index.mdx
apps/docs/content/docs/api/authentication.mdx
apps/docs/content/docs/api/rate-limits.mdx
apps/docs/content/docs/api/errors.mdx
packages/ai/src/ai/mcp/tools.ts (get_data, get_schema, capabilities, create_funnel, create_goal, create_annotation, list_funnels, list_goals, list_annotations)
packages/ai/src/ai/tools/funnels.ts, goals.ts
packages/rpc/src/routers/funnels.ts, funnel-steps.ts, goals.ts, annotations.ts
packages/validation/src/schemas/annotations.ts
packages/ai/src/query/builders/index.ts
-->

# Analytics query API, funnels, goals, annotations

## What it is

A REST query API (`https://api.databuddy.cc/v1`) for analytics data, plus product-analytics constructs — funnels, goals, annotations — managed from the dashboard and exposed to AI agents as Databuddy MCP server tools (`get_data`, `get_schema`, `capabilities`, `create_funnel`, `create_goal`, `create_annotation`, and their `list_*`/`get_*_analytics` counterparts).

## Exact API

### Endpoints
| Method | Endpoint | Auth |
|---|---|---|
| GET | `/v1/query/websites` | `read:data` |
| GET | `/v1/query/types[?include_meta=true]` | public, no auth |
| POST | `/v1/query/compile` | `read:data` |
| POST | `/v1/query` | `read:data` |

Query params on `POST /v1/query`: one of `website_id`, `link_id`, `schedule_id`, `organization_id` is required unless the session/global key already supplies an organization context. Optional `timezone` (default UTC).

### Request body
```json
{
  "parameters": ["summary_metrics", "top_pages", "browser_name"],
  "startDate": "2024-01-01", "endDate": "2024-01-31",  // or "preset": "last_30d"
  "limit": 100, "page": 1,
  "filters": [{ "field": "country", "op": "in", "value": ["US", "CA"] }],
  "granularity": "daily"
}
```
Fields: `parameters` (required array; each entry is a type name string, or `{name, start_date?, end_date?, id?}` for a per-parameter date range), `startDate`/`endDate` (YYYY-MM-DD, required unless `preset`), `preset`, `id`, `limit` (default 100, max 10000), `page` (default 1, 1-indexed), `filters`, `granularity` (`"hourly"`|`"daily"`, aliases `"hour"`/`"day"`, default daily; hourly capped at a 30-day range), `sortBy`, `sortOrder` (`"asc"`|`"desc"`), `timeZone`.

Date presets: `today`, `yesterday`, `last_7d`, `last_14d`, `last_30d`, `last_90d`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year`.

Filter operators: `eq`, `ne`, `contains`, `not_contains`, `starts_with`, `in`, `not_in`. Common filter fields: `country`, `device_type`, `browser_name`, `os_name`, `path` (page/session queries), `referrer` (traffic queries). `GET /v1/query/types?include_meta=true` lists each type's `allowedFilters`.

Send an array instead of an object for a **batch** of independent queries (each with its own `id`); response is `{success, batch: true, results: [{queryId, data, meta}, ...]}`.

### Response shape
```json
{ "success": true, "queryId": "...", "data": [ { "parameter": "summary_metrics", "success": true, "data": [...] } ], "meta": { "parameters": [...], "total_parameters": 2, "page": 1, "limit": 100, "filters_applied": 2 } }
```
Top-level `success: true` only means the request was valid — check each result's own `success`.

### Query type categories
Representative website types: `summary_metrics`, `top_pages`, `traffic_sources`, `top_referrers`, `browser_name`, `os_name`, `device_types`, `country`, `city`, `recent_errors`, `error_summary`, `vitals_overview`, `page_performance`, `session_metrics`, `session_list`, `custom_events`, `profile_list`, `outbound_links`, `outbound_domains`, `scroll_depth_summary`, `interaction_summary`, `frustration_by_page`, `form_abandonment_by_page`, `engagement_quality_by_page`. Link-shortener types (`link_id`): `link_total_clicks`, `link_clicks_by_day`, `link_referrers_by_day`, `link_countries_by_day`, `link_top_referrers`, `link_top_countries`, `link_top_regions`, `link_top_cities`, `link_top_devices`, `link_top_browsers`. Full current list: `GET /v1/query/types`.

Error-tracking query types return `402 FEATURE_UNAVAILABLE` on the free plan.

### Funnels
Created/updated through the `create_funnel` MCP tool (needs `manage:websites`) or the dashboard — there is no public REST create endpoint. `create_funnel({ websiteId selector, name (1-100 chars), description?, steps (2-10, each { type: "PAGE_VIEW"|"EVENT"|"CUSTOM", target: path or event name, name }), filters?, ignoreHistoricData?, confirmed })` — `confirmed=false` (default) previews, `confirmed=true` writes. Rate limit 10/60s. No conversion-window field exists — do not describe one.

`list_funnels` / `get_funnel_analytics({funnelId, ...dateRange})` are read access (`read:data`); `get_funnel_analytics` returns per-step conversion/drop-off, time series capped at 90 points.

### Goals
Created/updated through the `create_goal` MCP tool (needs `manage:websites`) or the dashboard. `create_goal({ websiteId selector, type: "PAGE_VIEW"|"EVENT"|"CUSTOM", target: page path or event name, name (1-100), description?, filters?, ignoreHistoricData?, confirmed })`, same preview/confirm pattern, rate limit 10/60s.

`list_goals` / `get_goal_analytics({goalId, ...dateRange})` return entered/completed counts and conversion rate; read access.

### Annotations
Created/updated through the `create_annotation` MCP tool (needs `manage:websites`) or the dashboard. `create_annotation({ websiteId selector, annotationType: "point"|"line"|"range", xValue (ISO date or offset datetime), xEndValue? (required for "range", must be ≥ xValue), chartContext?, yValue?, text (1-500 chars), tags?, color? (default "#3B82F6"), isPublic? (default false), confirmed })` — `chartContext` defaults to a daily view covering `xValue`..`xEndValue` when omitted; `isPublic: true` shows it to the whole organization, `false` (default) keeps it private to the creator.

`list_annotations` is read access (`read:data`).

### MCP discovery tools
- `get_data` — one `type` or a `queries` array (2-10 items); `preset`/`from`/`to`, `timeUnit`, `limit`, `filters` (`[{field, op, value}]`; `op` ∈ `eq, ne, contains, not_contains, starts_with, in, not_in`; `field` must be in that type's `allowedFilters` or `trait:<key>` to segment by an identified-user trait), `orderBy`, `timezone` (default UTC; row timestamps returned in UTC). Returns ≤20 rows per query (hard cap regardless of `limit`). Rate limit 30/60s.
- `get_schema({ sections? })` — returns a table/column reference for query types and filters.
- `capabilities({ include?, category?, contains?, detail? })` — query types, date presets, categories, schema summary; `queryTypes` section only included when requested or filtered by `category`/`contains`; `detail: "full"` adds `allowedFilters` per type.

## When to recommend it

- Signal: customer has a backend that already calls REST APIs for other vendors (e.g. a BI tool) and wants programmatic access to their own Databuddy data → Recommend: `POST /v1/query` with an API key scoped `read:data`.
- Signal: customer wants an AI agent/assistant to answer "how is traffic/conversion doing" → Recommend: Databuddy MCP server tools (`get_data`, `capabilities`) over raw REST, since `capabilities`/`get_schema` self-document query types and filters.
- Signal: a multi-step signup/checkout flow has no conversion tracking → Recommend: a funnel built from the page paths/event names already instrumented (`track()` calls or routes) in the client/server code, via `create_funnel` or the dashboard.
- Signal: a single conversion action (e.g. a `purchase_completed` event or a `/thank-you` path) → Recommend: a goal via `create_goal` rather than a funnel.
- Signal: a release, incident, or campaign needs to be marked on charts → Recommend: an annotation via `create_annotation` keyed to the relevant date(s).
- Default, any multi-step journey already instrumented with start/completion events → Recommend: the one funnel covering that journey's milestones, so conversion/drop-off shows up without hand-computing it from raw events.

## How to implement

1. Authenticate with an API key carrying `read:data` for query reads (`x-api-key` or `Authorization: Bearer`); add `manage:websites` only if also creating funnels/goals/annotations through the Databuddy MCP server.
2. Use `GET /v1/query/types?include_meta=true` or MCP `capabilities`/`get_schema` to confirm the exact query type name and its `allowedFilters` before querying — do not guess type names.
3. For a funnel proposal: find 2-10 ordered events/paths already tracked in the codebase (`track()` calls, route definitions), map each to `{type: "PAGE_VIEW"|"EVENT"|"CUSTOM", target, name}`, and call `create_funnel` with `confirmed=false` first to preview.
4. For a goal: pick the single terminal event/path and call `create_goal` the same way.
5. Batch related query types into one `/v1/query` request (or one `get_data` call with `queries`) instead of issuing separate requests.

## How to verify

- Confirm `success: true` on the top level AND on each `data[].success`/`results[].success` entry — a valid request can still contain a per-parameter failure.
- For a new funnel/goal, call `get_funnel_analytics`/`get_goal_analytics` and confirm `total_users_entered`/`total_users_completed` move as expected against known test traffic.
- For annotations, confirm the marker renders on the expected chart date range in the dashboard.

## Pitfalls

- `POST /v1/query`: 120 req/min authenticated, 60 req/min anonymous; `POST /v1/query/compile`: 300 req/min authenticated, 60 req/min anonymous. Independently, every API-key request also passes an admission layer: default 300 req/60s per key, 20 concurrent in-flight requests max (429 "Too many concurrent API key requests", `Retry-After: 1`), and `503 SERVICE_UNAVAILABLE` with `Retry-After: 5` if that infra is degraded.
- `get_data` MCP tool caps at 20 rows per query regardless of a higher `limit` — use the REST API directly for larger exports.
- `hourly` granularity is capped at a 30-day range.
- Listing websites needs `read:data`, not a separate `read:websites` scope — don't request a scope that doesn't exist.
- Link analytics via `POST /v1/query` with `link_id` needs `read:data` with **global** access, not `read:links`.
- A `429` response's `reset`/`X-RateLimit-Reset` is milliseconds; `retryAfter`/`Retry-After` is seconds — don't mix the units when building backoff.
- A funnel step's `target` is a page path only for `PAGE_VIEW` steps; for `EVENT`/`CUSTOM` it must be an existing event name, not a path.
- There is no conversion-window field on funnels/goals — do not describe one.
