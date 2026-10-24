<!--
Sources:
.agents/skills/databuddy/references/event-design.md
.agents/skills/databuddy/references/instrumentation-planning.md
apps/docs/content/docs/hooks.mdx
apps/docs/content/docs/hooks/form-tracking.mdx
apps/docs/content/docs/hooks/modal-tracking.mdx
apps/docs/content/docs/hooks/feature-usage.mdx
apps/docs/content/docs/hooks/feedback-tracking.mdx
apps/docs/content/docs/hooks/toast-tracking.mdx
apps/docs/content/docs/sdk/identify-users.mdx
apps/docs/content/docs/sdk/react.mdx
apps/docs/content/docs/sdk/vue.mdx
apps/docs/content/docs/sdk/nuxt.mdx
packages/sdk/src/core/types.ts
-->

# Custom events, identify, hooks

## What it is

`track()` sends custom events; `identify()`/`setTraits()`/`clearProfile()`/`getProfileId()` link browser activity to a known user (a "profile"); `setGlobalProperties()` attaches properties to every future event; `flush()` force-sends the queue; `clear()` resets anonymous/session IDs. The docs' hooks are copy-paste recipes for common UI tracking.

## Exact API

Tracker functions, importable from `@databuddy/sdk` (also documented in `sdk/identify-users.mdx`):

- `track(eventName: string, properties?: Record<string, unknown>): void` — safe to call server-side (no-op) or before the tracker loads.
- `trackError(message, properties?)` — convenience wrapper around `track("error", ...)` for manual error capture.
- `identify(profileId: string, traits?: ProfileTraits): void` — links the browser to a user ID from your system. Max 128 chars, stored verbatim (pass an opaque ID, not an email). Persists across sessions, attaches to every subsequent event including earlier pageviews in the same session. Safe to call on every page load — repeat calls with the same ID and no traits send one request per session.
- `setTraits(traits: ProfileTraits): void` — merges traits into the identified user's profile. Requires a prior `identify()`; otherwise a no-op that warns in debug builds.
- `clearProfile(): void` — forgets the identified user (call on logout); anonymous ID is kept.
- `getProfileId(): string | null` — currently identified user ID, or `null`.
- `clear(): void` — resets the whole session: generates new anonymous and session IDs.
- `flush(): void` — force-sends all queued events immediately (important before navigation, and in serverless handlers).
- `setGlobalProperties(properties: Record<string, unknown>): void` — attaches properties to all future events (plan, role, A/B variant, etc.).
- `getAnonymousId(urlParams?)`, `getSessionId(urlParams?)`, `getTrackingIds(urlParams?)`, `getTrackingParams(urlParams?)` — for cross-domain/server attribution. `getTrackingParams()` returns `"anonId=xxx&sessionId=yyy"` or `""`.

`ProfileTraits = Record<string, string | number | boolean | null>`. Scalars only; nested objects/arrays rejected. Limits: 50 keys, 2KB serialized. Setting a trait to `null` removes it. Special keys promoted to profile fields: `email` (lowercased), `username` and `name` (display name; `username` wins). Display names/emails are encrypted at rest (AES-256-GCM).

Node SDK identify (needs an API key with `track:events` scope for the target website):
```ts
await client.identify({
  profileId: user.id,
  anonymousId: cookies.get("did"),
  traits: { email: user.email, plan: "pro" },
});
```

Nuxt (`useDatabuddy()`), same functions auto-imported: `track`, `trackError`, `screenView`, `setGlobalProperties`, `clear`, `flush`, `getAnonymousId`, `getSessionId`, `getTrackingIds`, `getTrackingParams`. Options API/templates also get `$databuddy`.

## When to recommend it

- Signal: the journey continues on another origin (a marketing site CTA to the app's signup, a docs site to the dashboard) → Recommend: carry `anonId` and `sessionId` from `getTrackingIds()` to the destination as URL parameters so the receiving site's SDK (`getTrackingIds(urlParams)`) and any server events attribute the later outcome to the same visitor; server-side events must use the same anonymousId and sessionId the web SDK generated.

- Signal: a button/CTA/form/modal/toast exists with no event call, and it answers a product/growth/support/reliability question → Recommend: add a `track()` call per the selection rubric (decision value → authority → funnel value → segmentability → stability → privacy); prefer one authoritative completion event over several guesses.
- Signal: an auth flow resolves (login/logout) with no `identify()`/`clearProfile()` call → Recommend: call `identify()` where auth state resolves and `clearProfile()` on logout, so known users stop reporting as anonymous visitors.
- Signal: checkout/webhook/job handlers exist with no outcome or failure event → Recommend: track the outcome on the server after the durable success or expected failure, with `status: "failed"` and `error_type` on failure (never the raw error).
- Default, signup journey → Recommend: `signup_started` (browser, before the auth redirect) and `signup_completed` (server, after the user record is created); add `signup_failed` only for expected failures.
- Default, checkout journey → Recommend: `checkout_started` (browser) plus a server-side completion/failure pair after payment confirmation (see server-sdk.md for revenue attribution via `getTrackingIds()`).
- Default, any multi-step journey with milestone events in place → Recommend: one funnel built from the ordered events/pages (see query-api.md's `create_funnel`) instead of computing conversion by hand.

## How to implement

Smallest useful plan: 3-7 events, each with a start/completion/failure semantic where a flow exists; prefer one authoritative completion event over several guesses. Place `identify()` where auth state resolves; `clearProfile()` on logout.

### Naming rules and property design

- `snake_case`, stable names. Prefer completed outcomes for facts (`signup_completed`) and started/selected/opened for intent (`signup_started`).
- One reusable event with properties beats many near-duplicate events: `track("report_exported", { format: "csv", source: "dashboard" })`.
- Low-cardinality property keys: `source`, `feature`, `variant`, `step`, `method`, `status`, `page_type`, `environment`, `provider`, `stage`, `error_type`.
- Never send: raw URL paths with IDs, emails, names, order IDs, UUIDs, exact search text, stack traces, timestamps, request bodies, API keys, auth tokens, credit card digits.
- Don't duplicate what the SDK already auto-captures (page views, errors, web vitals).
- Don't track generic clicks/hovers/scrolls/keystrokes with no business meaning, or implementation details that churn with UI refactors.

### Placement: the success-boundary rule

- Browser events are for intent/interaction: track before navigation or route transition; call `flush()` if the user is about to leave the page.
- Backend/server events are the authoritative outcome: track after the database write, external API success, file creation, or job completion is confirmed — not on the click that starts the flow.
- Failure events: send `status: "failed"` and `error_type`, never the raw error message/stack.
- Don't record the same outcome twice from both sides — use distinct semantics (`*_started` on browser, `*_completed`/`*_failed` on server).
- When a browser-started flow finishes on the server, pass `getTrackingIds()` output to the backend and map `anonId` → `anonymousId` (keep `sessionId` as-is) so the server event still attributes to the browser session.

### Hook recipes

| Recipe | Hook | Event(s) | Key properties |
|---|---|---|---|
| Form tracking | `useFormTracking(formName)` → `trackSubmit(success, errors?)` | `form_submit` | `form_name`, `success`, `error_count`, `has_errors` |
| Modal tracking | `useModalTracking(modalName, isOpen)` | `modal_opened`, `modal_closed` | `modal_name` |
| Feature usage | `useFeatureTracking(featureName)` → `trackUsage(action, properties?)` | `feature_used` | `feature`, `action` (e.g. `started`/`completed`/`failed`), plus custom |
| Feedback tracking | server action + `useFeedbackTracking()` → `trackFeedback(url, opinion, message?)` | `docs_feedback` (server, via Node SDK), `feedback_submitted` (client) | `url`, `opinion` (`"good"`/`"bad"`), `has_message`, `message_length` |
| Toast tracking | `useToastTracking()` (wraps `useSonner`) | `toast_shown` | `type` (success/error/warning/info), `message` |

General best practices: dedupe with a ref/Set of already-tracked IDs; track only essential data (no PII); wrap tracking calls in try/catch so tracking errors never break the app; gate tracking calls outside the `<Databuddy />` component with an explicit production check (the component's own `disabled` prop already covers dev gating for itself).

### Attribution patterns (browser → server)

| Flow | Pattern |
|---|---|
| Browser button → API route | `getTrackingIds()` client-side → send `{ anonId, sessionId }` → server maps to `{ anonymousId: anonId, sessionId }` |
| Browser form → server action | populate hidden fields from `getTrackingIds()` before submit |
| Browser → another owned domain | append `?${getTrackingParams()}` to the destination URL; install Databuddy there too |
| Async job started in browser | persist `anonId`/`sessionId` with the job record; reuse on completion |

Do not invent a separate Databuddy "identify" shape for app-specific endpoints — public event tracking uses `anonymousId` and `sessionId`; use the real `identify()`/Node `client.identify()` API for profiles.

## How to verify

Trigger the event once, then check the Events page in the Databuddy dashboard for the event name; check the Users page for identified users after `identify()`. A working pageview does not prove a custom event is wired — verify each event explicitly.

## Pitfalls

- Calling `setTraits()` before `identify()` is a no-op (warns in debug builds only).
- Sending email/name as the `profileId` argument instead of an opaque ID — traits carry PII, the ID should not.
- Tracking the same outcome from both browser and server without `*_started`/`*_completed` separation causes double counting.
- High-cardinality properties (raw IDs, free text) break segmentation even though the event itself is harmless.
