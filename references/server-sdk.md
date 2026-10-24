<!--
Sources:
.agents/skills/databuddy/references/server-events.md
apps/docs/content/docs/sdk/node.mdx
apps/docs/content/docs/api/events.mdx
apps/docs/content/docs/api/authentication.mdx
apps/docs/content/docs/api-keys.mdx
apps/docs/content/docs/api/errors.mdx
apps/docs/content/docs/api/rate-limits.mdx
apps/docs/content/docs/Integrations/payments.mdx
packages/sdk/src/node/index.ts
packages/sdk/src/node/types.ts
packages/api-keys/src/scopes.ts
packages/shared/src (api-scopes)
-->

# Server SDK, events, revenue, API keys

## What it is

`@databuddy/sdk/node` is a Node/Bun/Deno/serverless client (`Databuddy` class, SDK Version 2.0.0+) for sending custom events, batching, deduplicating, and identifying users server-side. Raw HTTP ingestion is also available directly against `basket.databuddy.cc` (`POST /track`) for non-JS runtimes. API keys (`dbdy_` + 48 chars) authenticate all server-to-server calls and gate operations by scope. Stripe/Paddle webhooks attribute completed payments and refunds to tracked visitors in the Revenue dashboard.

## Exact API

### `new Databuddy(config: DatabuddyConfig)`
Throws if `apiKey` missing/blank.

```ts
interface DatabuddyConfig {
  apiKey: string;                     // required, "dbdy_xxx"
  websiteId?: string;                 // default Client ID
  namespace?: string;
  source?: string;
  apiUrl?: string;                    // default "https://basket.databuddy.cc"
  debug?: boolean;
  logger?: Logger;
  enableBatching?: boolean;           // default true
  batchSize?: number;                 // default 10, max 100
  batchTimeout?: number;              // default 2000ms
  maxQueueSize?: number;              // default 1000
  enableDeduplication?: boolean;      // default true
  maxDeduplicationCacheSize?: number; // default 10000
  requestTimeoutMs?: number;          // default 10000ms
  middleware?: Middleware[];          // (event) => event | null | Promise<...>
  anonymizeVisitorIds?: boolean | "auto";
}
```

### `track(event: CustomEventInput): Promise<EventResponse>`
```ts
interface CustomEventInput {
  name: string;                               // required
  eventId?: string;                           // dedup key
  anonymousId?: string | null;
  sessionId?: string | null;
  profileId?: string | null;                  // set via identify()
  properties?: Record<string, unknown> | null;
  namespace?: string | null;                  // overrides config
  source?: string | null;                     // overrides config
  websiteId?: string | null;                  // overrides config
  timestamp?: number | null;                  // ms
  anonymizeVisitorIds?: boolean | "auto" | null;
}
interface EventResponse {
  success: boolean;
  eventId?: string;
  error?: string;
  delivery?: "delivered" | "queued" | "skipped";
  code?: string;            // e.g. "NETWORK_ERROR", "VALIDATION_ERROR", "QUEUE_FULL"
  why?: string; fix?: string; requestId?: string; retryable?: boolean; statusCode?: number;
}
```
With `enableBatching: true`, `track()` usually just confirms the event was queued; a delivery failure is only returned when the call sends immediately (`enableBatching: false`, or the queue hits `batchSize`/`maxQueueSize`). Call `flush()` for the final delivery result.

### `batch(events: BatchEventInput[]): Promise<BatchEventResponse>`
Each item: `{ type: "custom", name, ...same optional fields as CustomEventInput }`. Max 100 events per batch.

### `identify(input: IdentifyInput): Promise<EventResponse>`
```ts
interface IdentifyInput {
  profileId: string;             // required, max 128 chars, stored verbatim
  anonymousId?: string | null;   // link pre-login device activity
  traits?: ProfileTraits | null; // scalars only, 50 keys max, 2KB serialized
  websiteId?: string | null;
}
```
Requires an API key with `track:events` scope for the target website. `websiteId` comes from config default or per-call. Identify calls send immediately (not batched). Special trait keys promoted to profile fields: `email` (lowercased), `username`, `name`. Setting a trait to `null` removes it.

### `flush(): Promise<BatchEventResponse>`
Flushes the queue; critical before a serverless function returns.

### Deduplication
When `enableDeduplication` is on, events with the same `eventId` already queued or delivered are dropped (`delivery: "skipped"`). Failed sends do not poison the cache — safe to retry the same `eventId`.

### Raw HTTP ingestion
```
POST https://basket.databuddy.cc/track
Authorization: Bearer dbdy_your_api_key    (or x-api-key header, or ?website_id=)
Content-Type: application/json
```
Body fields (single event or array for batch): `name` (string, 1-256 chars, required), `properties` (object, max 50 keys / 32KB serialized), `eventId` (max 512 chars), `path` (max 2048 chars), `anonymousId` (max 256 chars), `profileId`, `anonymizeVisitorIds` (bool | "auto"), `sessionId` (max 256 chars), `timestamp` (number|string|Date), `namespace` (max 64 chars), `source` (max 64 chars), `websiteId`. Request body max 2MB. Success response: `{"status":"success","type":"custom_event","count":1}`.

### API key scopes
`read:data` (`POST /v1/query`, `/v1/query/compile`, `GET /v1/query/websites`) · `track:events` (`POST /track`, and MCP calls via `@databuddy/sdk/mcp`) · `read:links`/`write:links` · `read:monitors`/`write:monitors` · `read:status_pages`/`write:status_pages` · `manage:websites` (create/update/delete websites; MCP goals/funnels/annotations/investigation replies) · `manage:flags` (flag CRUD + targeting) · `manage:config` (integration config + org settings). Sending events needs only `track:events`. Access level per key: `global` (all websites in org) or `website` (named websites only).

### Auth headers
`x-api-key: dbdy_...` or `Authorization: Bearer dbdy_...`. Session cookies work for `*.databuddy.cc` browser apps with `credentials: 'include'`.

### Errors and rate limit
`AUTH_REQUIRED` 401, `ACCESS_DENIED` 403 are the general auth codes. Ingestion-specific: 400 invalid body / website missing organization, 401 API key or website_id required, 402 event quota exceeded, 403 API key missing track:events scope / origin or IP not authorized, 404 website not found, 413 payload too large, 429 rate limit exceeded, 503 billing check unavailable. `POST /track` on `basket.databuddy.cc` is rate-limited to 600 requests/60s per API key or website+IP.

### Revenue (Stripe/Paddle)
Generate a webhook URL per provider in **Website → Revenue**, add the signing/webhook secret. Stripe required events: subscribe to the ones listed by `STRIPE_WEBHOOK_EVENTS.required` (includes `invoice_payment.paid` — requires Stripe API `2025-05-28.basil`+ — plus `invoice.paid`, `payment_intent.succeeded`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`). Paddle: subscribe to `transaction.completed`. Pass Databuddy IDs in payment metadata:
```ts
import { getProfileId, getTrackingIds } from "@databuddy/sdk";
const { anonId, sessionId } = getTrackingIds();
const databuddyMetadata = {
  databuddy_client_id: websiteId,
  databuddy_session_id: sessionId,
  databuddy_anonymous_id: anonId,
  databuddy_profile_id: getProfileId(),
};
```
Stripe does not copy PaymentIntent metadata onto future subscription invoices — also set it on the Subscription (or `subscription_data.metadata`). Attribution match order: tracked session → profile ID → anonymous ID → previously verified session for the same provider customer on that website. **Revenue attribution** = attributed completed-payment revenue ÷ total completed-payment revenue (same currency); refunds reported separately. Anonymous IDs are hashed on arrival; profile IDs are stored as sent.

## When to recommend it

- Signal: server code has payment, webhook, cron, or background-job handlers with no analytics instrumentation → Recommend: `@databuddy/sdk/node`, `track()` at the point the action is confirmed.
- Signal: the app already uses the browser tracker but needs to attribute a server-completed action (checkout, async job, webhook) back to a session → Recommend: pass `getTrackingIds()` output from the browser into the server `track()` call (`anonId` → `anonymousId`, `sessionId` as-is).
- Signal: revenue/MRR is tracked only in the Stripe/Paddle dashboard, not surfaced in product analytics → Recommend: set up the webhook in Website → Revenue and attach `databuddy_*` metadata at checkout.
- Signal: serverless functions (Lambda, Cloudflare Workers, Vercel functions) have no explicit flush before returning → Recommend: `await client.flush()` before the handler returns, to avoid losing queued events.
- Default, any server using the SDK → Recommend: scope `websiteId`/`namespace`/`source` at client construction when the process only ever writes to one site, and call `identify()` only after a stable user ID exists.

## How to implement

1. `bun add @databuddy/sdk` (or npm/pnpm equivalent for the customer's package manager).
2. Create one client per process: `new Databuddy({ apiKey: process.env.DATABUDDY_API_KEY! })`, scoping `websiteId`/`namespace`/`source` at construction when the app only ever writes to one site.
3. Call `track()` at the point of the server-side action; pass through `anonymousId`/`sessionId` captured from the browser via `getTrackingIds()` when attribution matters — never mint new session IDs server-side.
4. In serverless/short-lived runtimes, `await client.flush()` before the handler returns (also in `SIGTERM`/`finally` handlers for long-lived processes).
5. For revenue, generate the provider webhook URL in Revenue settings and attach `databuddy_*` metadata on PaymentIntents/Subscriptions (Stripe) or `customData` (Paddle) at checkout creation.
6. Use `identify()` only after establishing the user's stable ID, passing the browser's `anonymousId` to link pre-login activity.

## How to verify

- Check `response.success` and `response.delivery` from `track()`/`flush()` in logs or a debug build (`debug: true`).
- Confirm events appear under the website's custom events view in the dashboard.
- Send a Stripe test-mode payment with metadata set; confirm it appears in **Website → Revenue** within seconds, and on the user's profile in **Website → Users** if a `profileId` was included.
- Check that `track:events`-scoped keys reject calls to endpoints needing other scopes (403 `API key missing track:events scope`).

## Pitfalls

- Server-side `track()`/`POST /track` calls are stored as **custom events**, not pageview sessions — they do not produce the referrer/campaign/country/device data revenue attribution and session reporting depend on, even if a `sessionId` is passed.
- A `sessionId` minted on the server never attributes revenue or sessions; only a `sessionId` read from the browser's `getTrackingIds()` is joinable.
- Forgetting `await client.flush()` before a serverless handler returns silently drops queued events.
- Stripe does not propagate PaymentIntent metadata to subscription invoices automatically — attach metadata to the Subscription too, or renewals go unattributed.
- `invoice.paid` and `invoice_payment.paid` carry different halves of attribution (metadata vs. amount) — both must be subscribed or subscription payments stay unattributed.
- Regenerating a webhook URL invalidates the old path; update the provider dashboard immediately after regenerating.
- Do not invent a Databuddy `identify()` endpoint on the browser side — pre-login/post-login stitching is done via `identify()` on the Node SDK, or app-owned backend code forwarding `anonymousId`/`sessionId`.
