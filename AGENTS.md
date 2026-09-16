# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, etc.) working in this repository.

## What this is

**Scheduled Subscription Search** (`id: gmf-app`) is a [Stripe App](https://docs.stripe.com/stripe-apps)
that adds a UI extension to the Stripe Dashboard. It is built with TypeScript + React
(React 17) using Stripe's [UI Extensions SDK](https://docs.stripe.com/stripe-apps/reference/extensions-sdk-api.md)
and [UI toolkit](https://docs.stripe.com/stripe-apps/design.md).

The app must obey **Stripe Apps constraints** — it is not a general web app. See "Stripe
Apps constraints" below before adding dependencies, network calls, or DOM/browser APIs.

## The problem this app solves

Support agents need to find schedules by first-phase `AccountNumber` and/or
`ConfirmationNumber` metadata. Stripe has no schedule metadata search endpoint.
The app lists schedules in a user-selected creation-date range (default: one calendar
month ago through today), then filters first-phase metadata locally with case-insensitive
prefix matching (AND when both fields are set). All statuses, including released
schedules, are always eligible; there is no status filter.

The page-by-page scanner lives in `ui/src/views/scheduleSearchEngine.ts`;
`ScheduleSearch.tsx` renders the form and `useScheduleSearch.ts` manages its lifecycle.
It retains up to 100 compact rows and
stops at the 101st match. Searches pause after 20 pages and can be continued; failures
retain partial matches and can retry the failed page. Never present an incomplete
zero-match scan as a completed search.

The earlier customer `account_id` lookup is no longer the current metadata contract.
Do not replace the phase-metadata workflow with it or invent a schedule metadata
search endpoint. Date inputs use the SDK `DateField`. Both dates are inclusive in local
time; use `created.gte` and the next calendar day's `created.lt` (not a fixed 24 hours).
The form stays visible and keeps edited criteria separate from submitted results.

Schedule Ends comes from the **final** phase's `end_date`, already calculated by Stripe.
Do not infer a total subscription term from price billing frequency or fetch prices for
this display. Omit actual cancellation timestamps from results, keeping the Canceled
badge and planned end. Keep completed/released timestamps separate from the planned
end, and explain that releasing a schedule does not cancel its subscription.

## Repository layout

pnpm workspace (`pnpm-workspace.yaml`). Packages: `ui`, `custom-objects`, `extensions/*`.

- `stripe-app.yaml` — the app manifest (schema v2.0.0). Declares the app id/name,
  `stripe_api_access` permissions, and `ui_extension.views` (viewport → component).
  **Edit this via the Stripe CLI, not by hand, where possible** (see commands below).
- `ui/` — the UI extension (the only substantive package today).
  - `src/views/` — one file per view component. The four views registered in the manifest
    (`ScheduleSearch`, `ScheduleSearchCustomerDetail`, `ScheduleSearchSubscriptionDetail`,
    `ScheduleSearchDrawer`) **all render the same `ScheduleSearch` component**; the latter
    three are thin wrappers. `drawer.default` provides Dashboard-wide availability,
    including subscription schedule list/detail pages, and has no `objectContext`.
    Page-specific views take precedence. A former drawer implementation had a re-render
    crash: keep this wrapper free of separate storage hydration effects and object-based
    previous/next navigation. Cover storage writes and restoration in regression tests.
  - `Home.tsx`, `Customers.tsx`, `CustomerDetails.tsx` (+ their tests) are **leftover
    CLI scaffolding and are NOT wired into `stripe-app.yaml`**. Don't assume they're live;
    prefer deleting or ignoring them over building on them.
  - Tests are `*.test.tsx` alongside views, run with **Jest** (`@stripe/ui-extension-sdk/testing`).
- `custom-objects/` — scaffold for Stripe custom objects (no `src/` yet; builds/tests are no-ops). Uses **vitest**.
- `extensions/*` — script extensions (none present yet). Uses **vitest**.
- `tools/test.mts` — orchestrates the split test runners (vitest for extensions/custom-objects,
  jest for `ui/`). Failures from either runner fail the command.

## Commands

Run from the repo root unless noted. Package manager is **pnpm 10.x**; Node **>= 20**.

| Task                                         | Command                             |
| -------------------------------------------- | ----------------------------------- |
| Install                                      | `pnpm install`                      |
| Start dev server / live preview in Dashboard | `stripe apps start`                 |
| Build all packages                           | `pnpm build`                        |
| Lint (types + eslint + prettier)             | `pnpm lint`                         |
| Auto-fix lint + format                       | `pnpm fix:lint` / `pnpm fix:format` |
| Run all tests                                | `pnpm test`                         |
| Watch UI/extension tests                     | `pnpm test:watch`                   |
| Full gate (build + lint + test)              | `pnpm check`                        |
| Package image for upload                     | `pnpm image`                        |

Stripe CLI operations that edit the manifest:

```bash
stripe apps add view                       # scaffold a new view + test, register in manifest
stripe apps remove view VIEW_NAME
stripe apps grant permission "customer_read" "why the app needs it"
stripe apps grant url "https://api.example.com/path/" "why"   # adds connect-src CSP entry
stripe apps revoke connect-src "https://api.example.com/path/"
```

**Before claiming done, run `pnpm check` (or at minimum `pnpm lint` and `pnpm test`) and
report the actual output.** Do not assert success without running the commands.

## Stripe Apps constraints (important)

- **Stripe API access** goes through the SDK's authenticated client, not raw keys:
  ```ts
  import { createHttpClient, STRIPE_API_KEY } from '@stripe/ui-extension-sdk/http_client';
  import Stripe from 'stripe';
  const stripe = new Stripe(STRIPE_API_KEY, {
    apiVersion: '2023-08-16',
    httpClient: createHttpClient(),
  });
  ```
  The pinned `apiVersion` (`2023-08-16`) matches the `stripe` SDK types (`^13`). Changing it
  can break types — update deliberately.
- **Permissions are enforced.** Any Stripe read/write must have a matching permission in
  `stripe-app.yaml` (`customer_read`, `subscription_read` today). Add via
  `stripe apps grant permission`. Reads that lack a permission will fail at runtime.
- **Network calls to non-Stripe hosts** require a `connect-src` entry in the manifest's
  `content_security_policy` (add via `stripe apps grant url`, must be HTTPS with a path
  and trailing slash; wildcard only in the left-most DNS label). Without it you'll hit CSP errors.
- **UI is built from the UI toolkit only** — import components from
  `@stripe/ui-extension-sdk/ui` (`ContextView`, `Box`, `Table`, `Button`, `TextField`,
  `Banner`, `Link`, `Spinner`, etc.) and style with the `css` prop tokens (e.g. `stack`,
  `rowGap`, `font`). There is no raw HTML/DOM, no arbitrary CSS, and browser globals are
  restricted. Every view's root should be a `ContextView` (or another top-level view component).
- **Persisting UI state** uses `useStorage` from `@stripe/ui-extension-sdk/data`
  (see `useScheduleSearch.ts` — values are JSON strings and must be defensively validated
  on read). Cache keys and bodies include account/mode; legacy cache schemas are ignored.
  The owning view is keyed by scope to reset state and invalidate in-flight work on an
  account/mode change. Hydrate on mount without a storage-write/restore effect loop.
- **React is v17** (`@types/react` pinned to `^17`). Don't use React 18+ APIs.
- **Object context**: viewport components receive `environment` (mode, `objectContext`) and
  `userContext` via `ExtensionContextValue`. Use `environment.mode` to build `/test`-prefixed
  Dashboard links (see `getDashboardUrl`).

## Conventions

- **Adding a view**: prefer `stripe apps add view` so the manifest, component, and test are
  created consistently. If a new viewport should reuse existing search behavior, mirror the
  thin-wrapper pattern (`ScheduleSearchCustomerDetail.tsx` etc.).
- **UI tests** (Jest): render with `getMockContextProps()`, then assert on toolkit components
  via the wrapper (`wrapper.find(TextField)`, `.toContainText(...)`, `.toHaveProps(...)`).
- **Pagination/limits**: preserve `MAX_PAGES_PER_BATCH` and `MAX_RESULTS`. Keep overflow,
  pause, cancellation, failure, and completion distinct. Resuming uses the existing
  search's criteria, creation bounds, matches, and cursor. Only settled scans (complete
  or overflow) are cached; starting a new scan clears the prior result cache.
- **Search terms**: normalize prefixes once per scan, and match only the first phase's
  exact metadata keys. There is no Stripe Search query interpolation in this workflow.
- **Formatting/linting**: Prettier + ESLint are enforced (husky + lint-staged on commit).
  The root ESLint flat config ignores `ui/`, `custom-objects/`, and `extensions/**`; those
  packages carry their own lint config (`ui/` uses `@stripe/ui-extension-tools`). Run lint
  from the root so all packages are covered.
- TypeScript is `strict` with `verbatimModuleSyntax`; use `import type { ... }` for type-only
  imports (the codebase already does).

## Do / don't

- **Do** keep Stripe calls behind declared permissions and the SDK http client.
- **Do** run `pnpm check` before finishing and report real results.
- **Don't** add raw `fetch` to external hosts without a `connect-src` grant.
- **Don't** introduce React 18+ features, raw DOM, or non-toolkit UI.
- **Don't** invent schedule metadata search endpoints — list schedules and filter phase metadata locally.
