# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, etc.) working in this repository.

## What this is

**Future Dated Subscriptions** (manifest `id: sub-schedules-search`; the pnpm root
package is named `schedule-intelligence`) is a [Stripe App](https://docs.stripe.com/stripe-apps)
that adds a UI extension to the Stripe Dashboard. It is built with TypeScript + React
(React 17) using Stripe's [UI Extensions SDK](https://docs.stripe.com/stripe-apps/reference/extensions-sdk-api.md)
and [UI toolkit](https://docs.stripe.com/stripe-apps/design.md).

The app must obey **Stripe Apps constraints** — it is not a general web app. See "Stripe
Apps constraints" below before adding dependencies, network calls, or DOM/browser APIs.

## The problem this app solves

Support agents need to find schedules by first-phase `AccountNumber` and/or
`ConfirmationNumber` metadata. Stripe has no schedule metadata search endpoint.
The app lists only schedules that have not started (`scheduled: true`), then filters
first-phase metadata locally with case-insensitive prefix matching (AND when both fields
are set). Active, completed, released, and canceled schedules are not eligible.

The parallel scanner lives in `ui/src/views/scheduleSearchEngine.ts`
(`PAGE_SIZE = 100`, `MAX_PAGES_PER_BATCH = 1000`, `SCAN_CONCURRENCY = 8`);
`ScheduleSearch.tsx` renders the form and `useScheduleSearch.ts` manages its lifecycle
and storage. The first request is unfiltered. When a page has more data, the remainder of
its `created` range is split (`splitRange`) into disjoint, geometrically widening windows
so up to `SCAN_CONCURRENCY` ranges load in parallel; schedules sharing one `created`
second are followed by cursor. Rate-limited pages back off and halve the concurrency.
It retains up to 50 compact rows, shown newest first, and stops at the 51st match.
Searches normally run against an in-memory **schedule index** (`scheduleIndex.ts`): one
compact entry per future schedule, built by the same scanner the first time a user types
or searches, then reused for the session. A search that waits for the first build uses
that fresh data as-is and settles as soon as 51 matches prove overflow (the build keeps
going). A search on an existing index lists only schedules created since its newest
entry, then re-reads each displayed match (`VERIFY_CONCURRENCY = 5`) so started,
canceled, or edited schedules drop out; Stripe's status, not the local clock, decides
what has started. Index guardrails, all covered by `scheduleIndex.test.ts`:
memory only (never `useStorage`); one index at a time keyed by account/mode, discarded on
switch; built only on typing or search, never on mount; no timers, the
`INDEX_MAX_AGE_SECONDS` (15 min) age check runs at search time and rebuilds in the
background; compact entries with lowercased keys; above `MAX_INDEXED_SCHEDULES` (100,000)
the index is dropped and each search scans instead. Cancel and unmount stop index
loading; it resumes from its unfinished ranges. Measured on 15,020 sandbox schedules the
index is about 5 MB (~360 bytes per entry) and local matching takes under 1 ms.

The one-off scan pauses only as a safety stop after 1,000 pages and can be continued; failures
retain partial matches and retry the unfinished ranges. A newer run supersedes an older
one, whose late responses are discarded unapplied. Never present an incomplete
zero-match scan as a completed search.

The earlier customer `account_id` lookup is no longer the current metadata contract.
Do not replace the phase-metadata workflow with it or invent a schedule metadata
search endpoint. Always use the Subscription Schedule list API's `scheduled: true`
parameter. `created` ranges only partition that filtered list for parallel loading; do
not replace `scheduled: true` with a created-date scan. List requests share the account's
per-endpoint rate limit (25/s) with other Dashboard users and the account's own integration, so do
not raise `SCAN_CONCURRENCY` casually. The form stays visible and keeps edited criteria
separate from submitted results.

Schedule Ends comes from the **final** phase's `end_date`, already calculated by Stripe.
Do not infer a total subscription term from price billing frequency or fetch prices for
this display. Releasing a schedule does not cancel its subscription, but released and
other non-future schedules are outside this app's search scope.

## Repository layout

pnpm workspace (`pnpm-workspace.yaml`). Packages: `ui`, `custom-objects`, `extensions/*`
(the `extensions/` directory does not exist yet).

- `stripe-app.yaml` — the app manifest (schema v2.0.0). Declares the app id/name/version,
  `stripe_api_access` permissions, and `ui_extension.views` (viewport → component).
  **Edit this via the Stripe CLI, not by hand, where possible** (see commands below).
  The manifest `version` is what Stripe uses for uploads; the `package.json` versions
  are not kept in sync with it.
- `ui/` — the UI extension (the only substantive package today). It has no `build`
  script; `pnpm build` only reaches the custom-objects scaffold.
  - `src/views/` — view components plus search modules:
    - `scheduleSearchEngine.ts` — parallel range scanner (`createRangeScanner`), the
      one-off search scan (`createScheduleSearch`), and first-phase metadata matching.
    - `scheduleIndex.ts` — the in-memory schedule index and `runIndexedSearch`.
    - `useScheduleSearch.ts` — draft/submitted criteria, search lifecycle, Stripe client,
      index wiring, `useStorage` result cache.
    - `scheduleSearchData.ts` — `SearchResult`/`CachedSearch` types, `MAX_RESULTS`,
      `SEARCH_STORAGE_KEY` (currently `:v13`), cache validation (`parseCachedSearch`),
      date/ID formatting, and `getDashboardUrl`.
    - `scheduleSearchDates.ts` — despite the name, holds `SearchCriteria` and its
      normalize/equality helpers (no date logic; start/end dates are derived in the engine).
    - `ScheduleSearchResults.tsx` — result rows, status badges, and end-behavior notes.
  - The four views registered in the manifest
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
- `extensions/*` — script extensions (none present; directory absent). Uses **vitest**.
- `src/views/` (repo root) — empty leftover scaffolding directory; UI code lives in `ui/src/views/`.
- `tools/test.mts` — orchestrates the split test runners (vitest for extensions/custom-objects,
  jest for `ui/`). Failures from either runner fail the command.
- `tools/create-bulk-subscription-schedules.mts` — `pnpm bulk:subs` fixture generator. Uses
  the logged-in `stripe` CLI to create one "Auto lease" product, a pool of customers with the
  test ACH payment method (`pm_usBankAccount`, so test mode only), and per schedule a new
  $300–$800/month `auto lease` price and a 12-month `end_behavior: cancel` schedule starting
  in a `--from`/`--until` window. First-phase metadata is a unique 11-digit `AccountNumber`
  starting `11` and a 15-character `ConfirmationNumber` starting `S`. Everything is tagged
  `metadata[fixture_batch]` for cleanup; requests carry idempotency keys and retry 429s.

## Commands

Run from the repo root unless noted. Package manager is **pnpm 10.x**; Node **>= 20**
(the root `engines`; `ui/package.json` still carries a stale scaffold `>=14`).

| Task                                         | Command                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Install                                      | `pnpm install`                                                                                                                     |
| Start dev server / live preview in Dashboard | `stripe apps start`                                                                                                                |
| Build all packages                           | `pnpm build`                                                                                                                       |
| Lint (types + eslint + prettier)             | `pnpm lint`                                                                                                                        |
| Auto-fix lint + format                       | `pnpm fix:lint` / `pnpm fix:format`                                                                                                |
| Run all tests                                | `pnpm test`                                                                                                                        |
| Watch extension/custom-object tests (vitest) | `pnpm test:watch`                                                                                                                  |
| Watch UI tests (jest)                        | `pnpm --filter ./ui exec jest --watch`                                                                                             |
| Full gate (build + lint + test)              | `pnpm check`                                                                                                                       |
| Package image for upload                     | `pnpm image`                                                                                                                       |
| Create test-mode fixture schedules           | `pnpm bulk:subs -- <count> --from YYYY-MM-DD --until YYYY-MM-DD [--customers <n>] [--concurrency <n>] [--batch <tag>] [--dry-run]` |
| Regenerate Stripe workspace files            | `pnpm stripe:regen`                                                                                                                |

Stripe CLI operations that edit the manifest:

```bash
stripe apps add view                       # scaffold a new view + test, register in manifest
stripe apps remove view VIEW_NAME
stripe apps grant permission "customer_read" "why the app needs it"
stripe apps grant url "https://api.example.com/path/" "why"   # adds connect-src CSP entry
stripe apps revoke connect-src "https://api.example.com/path/"
```

The Stripe CLI rewrites `stripe-app.yaml` with 4-space indentation and double quotes,
which fails `prettier --check`. Run `pnpm fix:format` after any CLI manifest edit
(including version bumps) or `pnpm lint`/`pnpm check` will fail.

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
  Only the small settled result cache goes in `useStorage`; the schedule index stays in
  module memory (`getScheduleIndex`) because storage values are strings synced to every
  viewport. Tests that render the search must call `discardScheduleIndex()` in `beforeEach`.
- **React is v17** (`@types/react` pinned to `^17`). Don't use React 18+ APIs.
- **Object context**: viewport components receive `environment` (mode, `objectContext`) and
  `userContext` via `ExtensionContextValue`. Use `environment.mode` to build `/test`-prefixed
  Dashboard links (see `getDashboardUrl` in `scheduleSearchData.ts`).

## Conventions

- **Adding a view**: prefer `stripe apps add view` so the manifest, component, and test are
  created consistently. If a new viewport should reuse existing search behavior, mirror the
  thin-wrapper pattern (`ScheduleSearchCustomerDetail.tsx` etc.).
- **UI tests** (Jest): render with `getMockContextProps()`, then assert on toolkit components
  via the wrapper (`wrapper.find(TextField)`, `.toContainText(...)`, `.toHaveProps(...)`).
- **Pagination/limits**: preserve `MAX_PAGES_PER_BATCH`, `SCAN_CONCURRENCY`, and `MAX_RESULTS`.
  Keep overflow, pause, cancellation, failure, and completion distinct. Resuming uses the
  existing search's criteria, matches, and unfinished `created` ranges (with their cursors). Only settled scans (complete
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
