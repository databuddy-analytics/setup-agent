<!--
Sources:
.agents/skills/databuddy/references/frameworks.md
apps/docs/content/docs/Integrations/index.mdx
apps/docs/content/docs/Integrations/nextjs.mdx
apps/docs/content/docs/Integrations/react.mdx
apps/docs/content/docs/Integrations/angular.mdx
apps/docs/content/docs/Integrations/svelte.mdx
apps/docs/content/docs/Integrations/sveltekit.mdx
apps/docs/content/docs/Integrations/laravel.mdx
apps/docs/content/docs/Integrations/wordpress.mdx
apps/docs/content/docs/Integrations/shopify.mdx
apps/docs/content/docs/Integrations/webflow.mdx
apps/docs/content/docs/Integrations/framer.mdx
apps/docs/content/docs/Integrations/wix.mdx
apps/docs/content/docs/Integrations/squarespace.mdx
apps/docs/content/docs/Integrations/bubble.mdx
apps/docs/content/docs/Integrations/mintlify.mdx
apps/docs/content/docs/Integrations/hugo.mdx
apps/docs/content/docs/Integrations/jekyll.mdx
apps/docs/content/docs/Integrations/gtm.mdx
apps/docs/content/docs/Integrations/cal.mdx
-->

# Per-framework install (Databuddy)

## What it is

The browser tracker is installed once per site through the framework's shared entry point: a React/Vue component for React/Vue-based apps, a script tag for everything else.

## Exact API

Two forms only. React-family apps import `Databuddy` from `@databuddy/sdk/react` (Vue/Nuxt equivalents named below) and mount it once with the public `clientId`. All other platforms load the script tag below with `data-client-id`; tracker options map to `data-*` attributes as documented in tracker.md.

Common script tag shape used across most static/CMS integrations:
```html
<script
  src="https://cdn.databuddy.cc/databuddy.js"
  data-client-id="YOUR_CLIENT_ID"
  crossorigin="anonymous"
  async
></script>
```
Get the Client ID from the Databuddy dashboard (Website → tracking setup) first in every flow.

## When to recommend it

- Signal: `next` in `package.json` with an `app/layout.tsx` or `pages/_app.tsx` and no Databuddy component/script → Recommend: the Next.js section below.
- Signal: a `nuxt.config`/`nuxt.config.ts` with no `@databuddy/nuxt` module → Recommend: the Nuxt section below.
- Signal: a WordPress theme, Shopify theme, Webflow/Framer/Wix/Squarespace/Bubble project, or a static site generator config (Hugo, Jekyll) with no Databuddy script tag → Recommend: the matching platform section below.
- Signal: a tracker, component, or script with a Databuddy client ID already present anywhere in the app → Recommend: do not add a second install; point out the existing one instead.
- Signal: Cal.com booking pages, GTM, or a Mintlify docs site with no Databuddy setup → Recommend: the dedicated section below rather than a hand-placed script where one is documented.

## How to implement

Follow the matching section below: add the component or script in the named shared entry file, with the public client ID from configuration, and nothing else. Do not add manual pageview calls; the tracker records initial and client-side navigation views itself.

### Next.js (App Router and Pages Router)

Install `@databuddy/sdk`, set `NEXT_PUBLIC_DATABUDDY_CLIENT_ID`. App Router — mount in `app/layout.tsx` (stays a Server Component):
```tsx
import { Databuddy } from "@databuddy/sdk/react";
<Databuddy clientId={process.env.NEXT_PUBLIC_DATABUDDY_CLIENT_ID!} />
```
Pages Router: same component in `pages/_app.tsx`, or the script tag in `pages/_document.tsx`. Pageviews and route changes are automatic. Disable outside production with `disabled={process.env.NODE_ENV !== "production"}` — `NODE_ENV` is also `"production"` on many preview deployments, so use a separate website/Client ID there. The tracker skips `localhost`; use the `debug` prop or a test website locally.

### React (non-Next.js)

Install `@databuddy/sdk`, mount once in `App.tsx`:
```tsx
import { Databuddy } from '@databuddy/sdk/react';
<Databuddy clientId="YOUR_CLIENT_ID" trackAttributes />
```
Pageviews, including React Router SPA navigation, are automatic.

### Vue

Mount once near `RouterView` in `App.vue`:
```vue
<script setup>
import { Databuddy } from "@databuddy/sdk/vue";
const clientId = import.meta.env.VITE_DATABUDDY_CLIENT_ID;
</script>
<template>
  <Databuddy :client-id="clientId" track-web-vitals track-errors />
  <RouterView />
</template>
```
Props are kebab-case (`:client-id`, `:track-web-vitals`, `:enable-batching`, `:skip-patterns`, `:mask-patterns`).

### Nuxt

Preferred over a manual Vue plugin: `bun add @databuddy/nuxt`, then in `nuxt.config.ts`:
```ts
export default defineNuxtConfig({
  modules: ["@databuddy/nuxt"],
  databuddy: { clientId: process.env.NUXT_PUBLIC_DATABUDDY_CLIENT_ID },
})
```
No `app.vue` edits needed; pageviews and SPA route changes are automatic.

### SvelteKit

Script tag in `src/app.html`, near `%sveltekit.head%`. Never call `window.databuddy` during SSR — guard with `typeof window !== 'undefined'` and use `onMount`/`afterNavigate` (from `$app/navigation`) for the uncommon case where automatic route tracking isn't enough.

### Framer

Preferred: install the official "Databuddy Analytics" plugin (Plugins sidebar → search → Install), enter the Client ID in plugin settings, publish. Manual: Site Settings → General → Custom Code → paste an inline-loader `<script>` into "Start of `<head>` tag".

### Script-tag platforms

Same script tag as in Exact API, pasted into the platform's own custom-code location:

| Platform | Where to add the script tag | Notes |
|---|---|---|
| Angular | `src/index.html`, inside `<head>` (preferred) or before `</body>` | — |
| Svelte (Vite) | `index.html` project root, `<head>` or before `</body>` | SPA route changes automatic; a custom router needs `window.databuddy.screenView()` after navigation |
| Laravel | Main Blade layout (e.g. `resources/views/layouts/app.blade.php`), before `</body>` | Gate with `@if(app()->environment('production'))`; Client ID via `.env` or `config('services.databuddy.client_id')` |
| WordPress | A script-injection plugin (recommended, e.g. Insert Headers and Footers), `functions.php`, or `header.php` | WordPress.com requires a plan supporting plugins/custom JS |
| Shopify | `theme.liquid` (Layout folder) before `</head>` (recommended), or a Google Tag Manager Custom HTML tag | Optionally add `data-track-attributes`/`data-track-outgoing-links` |
| Webflow | Site Settings → Custom code → **Head code** | Save and publish |
| Wix | Settings → Tracking Tools & Analytics (or Custom Code, Advanced Settings; needs Wix Premium + a connected domain) | Set "Add Code to Pages" to All pages, "Place Code in" **Body - end** |
| Squarespace | Settings → Website → Code Injection (Business/Commerce plans only) | **Footer** (recommended) or Header |
| Hugo | `layouts/partials/databuddy-analytics.html`, wrapped in `{{ if not .Site.IsServer }}` | Include via `{{ partial "databuddy-analytics.html" . }}` before `</body>` in the base layout or theme footer |
| Jekyll | `_layouts/default.html` before `</body>`, gated with `{% if jekyll.environment == "production" %}` | Or move into an include file referenced from the layout |

### Bubble

Settings → SEO / metatags → "Script/meta tags in header" → paste the script tag → deploy to the live version. Bubble apps are often SPA-like with no URL change between pages (shown/hidden groups) — fire `window.databuddy.track('screen_viewed', { screen: 'dashboard' })` from a workflow action instead of relying on automatic pageview detection.

### Mintlify

Create a `databuddy.js` file next to `docs.json` (Mintlify auto-loads any `.js` file in the content directory) that creates the script element at runtime (`document.createElement("script")`, set `src`, `data-client-id`, `crossOrigin`, `async`, then `document.head.appendChild`). Commit and push; no `docs.json` changes needed. No official Databuddy integration exists for Mintlify yet (community pattern).

### Google Tag Manager

Custom HTML tag with an inline loader (creates the script element, sets `data-client-id` from a GTM Constant variable, optionally `data-track-attributes`/`data-track-errors`). Trigger: All Pages, or your consent manager's granted-trigger if prior consent is required; fire **Once per page**.

### Cal.com

Install the Databuddy app from the Cal.com App Store, activate per event page with the Client ID from the dashboard. Self-hosted Databuddy: also supply the API URL and Script URL during setup. Add `cal.com` and `*.cal.com` to the website's allowed origins (Settings → Security) so Cal.com booking pages can send events under the same Client ID as the main site.

## How to verify

Load one page and confirm a single tracker request to the basket endpoint with the expected client ID, then navigate client-side and confirm exactly one additional screen view.

## Pitfalls

- Mounting the component in more than one layout, or adding both the component and the script tag, produces duplicate pageviews.
- Server-rendered frameworks must keep the tracker on the client; the React/Vue component handles its own client boundary, script tags belong in the HTML head or body template.
- Platforms with a built-in app or integration (Cal.com, Shopify, WordPress) should use it instead of a hand-placed script when one is documented above.
