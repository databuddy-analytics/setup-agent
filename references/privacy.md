<!--
Sources:
apps/docs/content/docs/privacy/index.mdx
apps/docs/content/docs/privacy/cookieless-analytics-guide.mdx
apps/docs/content/docs/privacy/event-scanner.mdx
apps/docs/content/docs/compliance/gdpr-compliance-guide.mdx
apps/docs/content/docs/security.mdx
packages/sdk/src/core/types.ts (anonymizeVisitorIds, ignoreBotDetection, maskPatterns)
-->

# Privacy, cookieless model, security, event scanner

## What it is

Databuddy's browser tracker uses first-party localStorage (visitor ID) and sessionStorage (session info) instead of analytics cookies. "Cookieless" is a storage choice, not a guarantee of anonymity, consent exemption, or complete measurement — a cookieless tracker can still process personal data (page paths, titles, custom properties, errors, optional profile traits). Replacing cookies with localStorage does not, by itself, remove consent obligations; browser-storage/tracking rules apply independent of the cookie/no-cookie distinction. What counts as personal data: names/emails obviously; also user IDs, online identifiers, location, and event details that can relate to an identifiable person — hashing an identifier or omitting a name does not necessarily make data anonymous.

`npx @databuddy/scan` is a separate CLI that finds user actions in a repo with no analytics event, by sending relevant code to a classification model — see Exact API below for exactly what it sends.

## Exact API

- **Visitor ID**: random ID generated and stored in localStorage; session info in sessionStorage. Session IDs use a 30-minute reuse window; a continuously open page can keep its session longer.
- **IP/location**: standard analytics event records omit raw IP addresses after request handling; location is approximated to country/region/city.
- **Visitor ID anonymization**: ingestion hashes visitor IDs with a rotating daily salt by default. `anonymizeVisitorIds?: boolean | "auto"` (`DatabuddyConfig`, default `true`) controls this; per security.mdx it can disable the transformation or apply it based on visitor country.
- **Bot detection**: `ignoreBotDetection?: boolean` (default `false`) — set `true` to track bots instead of filtering them.
- **Path masking**: `maskPatterns?: string[]` — glob patterns to mask sensitive path segments (e.g. `/users/*`) rather than sending raw IDs in URLs. `skipPatterns?: string[]` skips tracking entirely on matching paths.
- **URL params**: query strings are stripped from page/referrer addresses; selected campaign/advertising-click parameters (UTM, etc.) are collected separately.
- **DNT / GPC / opt-out**: the browser tracker honors Global Privacy Control, Do Not Track, and a stored opt-out preference. Helpers: `window.databuddyOptOut()` / `window.databuddyOptIn()`. Opting out stops tracking and clears local tracker identifiers when localStorage is available; opting in does not override GPC/DNT. These helpers do not delete data already collected server-side.
- **Identify / profiles**: `identify()` is optional and separate from visitor-ID anonymization — it links activity to a profile ID and traits you supply, which are personal data if they include email/name. Profile display names and emails are encrypted at rest with AES-256-GCM; production ingestion requires the server encryption key to be configured. Arbitrary event properties and other profile traits are **not** covered by this field encryption.
- **Origin/IP access control** (Website Settings → Security): origin filtering is an ingestion control, not proof of domain ownership (a non-browser client can set an Origin header). No configured allow-list → requests without an Origin are accepted. Nonempty allow-list → missing/unrecognized Origin gets 403. Entries: `example.com`, `*.example.com`, `localhost`, `*`. IP allow-list: individual IPv4/IPv6 or IPv4 CIDR; empty = no restriction; uses the trusted `cf-connecting-ip` header (no fallback to `x-forwarded-for`/`x-real-ip`); with `SELFHOST=true` a configured IP allowlist rejects rather than trusting proxy headers.
- **CSP**: allow `https://cdn.databuddy.cc` in `script-src` and `https://basket.databuddy.cc` in `connect-src` for the default hosted endpoints.
- **Request validation**: requests are validated, size-limited, and rate-limited.

### Event scanner (`@databuddy/scan`)

- `--dry-run` lists every file/line range that would be sent without sending anything; `--dry-run --json` prints the exact segments and tracking catalog.
- What's sent: for JS/TS/Vue/Svelte/Astro/HTML, only the code around each detected user action (handler, called functions, route it posts to). For Python, only decorated write routes (FastAPI/Flask/Django POST/PUT/PATCH/DELETE handlers), each as its own function — other Python files are not sent. Swift files and unparseable files are sent whole.
- Never sent: files not tracked by git (including `.env`), tests/fixtures/examples/e2e/Cypress/Playwright folders, symlinks, and files that look like they contain private keys or live API tokens (a safeguard, not a guarantee).
- Default destination: Databuddy's scan API (`api.databuddy.cc`), which forwards to the Jev model on Vercel AI Gateway with zero data retention on every call. The API holds code in memory only for the request; it is not logged, stored, or used for training, and only classification labels are returned.
- What Databuddy records (sampled, not every request): method/path/status/duration/request size, HTTP client user agent, a random per-run ID + CLI version, segment counts, gateway status/timing, input token count, and findings counts. First request of a run also logs a `scan_run_started` event in Databuddy's own analytics. Rate limiting (600/min, 5,000/day) hashes the caller's IP with a server secret as an expiring server-side key; the IP itself isn't logged.
- To keep code off Databuddy entirely: set your own `AI_GATEWAY_API_KEY` (shell or scanned repo's `.env`) — requests go directly from your machine to your Vercel account with the same zero-retention setting.
- Local cache: `~/.cache/databuddy/scan` (or `$XDG_CACHE_HOME/databuddy/scan`), holding scanned file hashes, found tracking calls/locations, and classifications; delete to clear. The scanner never edits your repository; MIT licensed.

## When to recommend it

- Signal: customer wants to justify skipping or soft-gating a cookie consent banner for analytics-only tracking → Recommend: push back — cookieless alone isn't an automatic consent exemption; point at the GDPR guide's consent-decision steps rather than asserting compliance. Some jurisdictions allow limited audience-measurement analytics without consent under specific conditions (CNIL guidance) — don't assume a given configuration automatically qualifies.
- Signal: customer is running `@databuddy/scan` in CI or an agent workflow and asks what leaves their machine/repo → Recommend: run `--dry-run --json` first to show exactly what would be sent; set `AI_GATEWAY_API_KEY` if they want zero Databuddy visibility.
- Signal: customer wants to disable visitor-ID anonymization, bot filtering, or configure origin/IP allow-lists for a specific deployment (webhooks, server-to-server traffic, embedded widgets like Cal.com) → Recommend: change only `anonymizeVisitorIds`, `ignoreBotDetection`, `maskPatterns`/`skipPatterns`, or origin/IP allow-lists for a stated reason, and reflect the change in the privacy notice.
- Signal: prior consent is legally required in the customer's jurisdiction before tracking → Recommend: delay loading the tracker/mounting `<Databuddy />` until consent is granted; a privacy notice or opt-out button alone does not substitute for required prior consent, so test both refusal and withdrawal.
- Default: any site using `identify()` with email/name traits → Recommend: confirm the privacy notice discloses profile data collection — `identify()` changes what is processed/disclosed, and profile IDs are not anonymized by `anonymizeVisitorIds`.

## How to implement

Default config is privacy-preserving (`anonymizeVisitorIds: true`, bot filtering on). Only change `anonymizeVisitorIds`, `ignoreBotDetection`, `maskPatterns`/`skipPatterns`, or origin/IP allow-lists for a stated reason, and reflect any change in the customer's privacy notice. Where prior consent is required, gate tracker mount/script load behind the consent decision rather than an opt-out-only pattern. For the event scanner, run `--dry-run` before a real run, and set `AI_GATEWAY_API_KEY` when code should never reach Databuddy.

## How to verify

Inspect actual network requests and browser storage (`localStorage`/`sessionStorage`) on representative pages; confirm sensitive paths are masked/excluded before being sent; test opt-out/opt-in and consent withdrawal in the browser. For the scanner, run `--dry-run --json` and confirm the reported segments match what you expect to be sent.

## Pitfalls

- Treating "no cookies" as "no consent needed" or "fully anonymous" — both are explicitly contradicted by the docs.
- Assuming `identify()` traits are covered by the same encryption as display name/email — only `email`/`username`/`name` get AES-256-GCM field encryption; other traits and event properties do not.
- Relying on `x-forwarded-for`/`x-real-ip` for IP allow-listing — only `cf-connecting-ip` is trusted.
- Assuming GDPR-only scope — the docs explicitly note UK rules and state privacy laws have different scopes; a single configuration does not establish compliance with all of them.
- No explicit data-retention period is documented in these sources — do not state one. Databuddy assists customers with access/correction/deletion requests (contact privacy@databuddy.cc); visitors should first contact the website owner.
