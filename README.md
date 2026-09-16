# Scheduled Subscription Search

A Stripe App for finding recent subscription schedules by an account number or
confirmation number stored in first-phase metadata. Search results show the customer,
schedule, account and confirmation numbers, start date, and current schedule status.

## Required metadata contract

This app is intentionally built around a specific metadata convention. A schedule is
searchable only when its values use these exact, case-sensitive paths and key names:

```text
subscription_schedule.phases[0].metadata.AccountNumber
subscription_schedule.phases[0].metadata.ConfirmationNumber
```

In a subscription schedule create request, that structure looks like:

```js
{
  customer: 'cus_VBfy6gzOXM3SCo',
  phases: [
    {
      metadata: {
        AccountNumber: '111056117407',
        ConfirmationNumber: 'SAXEZT34ZA',
      },
      // Other phase configuration...
    },
  ],
  // Other schedule configuration...
}
```

Important constraints:

- Metadata must be on the **first schedule phase** (`phases[0].metadata`).
- Metadata on the customer, subscription, top-level subscription schedule, or a later
  phase is not searched.
- The keys must be spelled and capitalized exactly as `AccountNumber` and
  `ConfirmationNumber`.
- Stripe metadata values are strings.

## How search works

1. The user enters an account number, a confirmation number, or both.
2. The app requests subscription schedules with a `created` timestamp in the previous
   31 days. This is a rolling 31×24-hour window based on schedule creation time, not its
   start date.
3. Stripe returns schedules in pages of 100. The app filters each page as it arrives,
   displays matches progressively, and retains at most 100 compact result rows.
4. The app reads `AccountNumber` and `ConfirmationNumber` from the first phase and
   performs case-insensitive prefix matching.
5. If both fields are entered, a schedule must match both fields.
6. As soon as a 101st match is found, the app stops scanning and displays "More than
   100 matches" with a prompt to refine the search. Exactly 100 matches does not prove
   overflow: the app continues looking until it finds another match or exhausts the
   remaining schedules.
7. Each batch loads at most 20 pages. A longer search pauses with a "Continue
   searching" button that resumes from the saved page cursor. A paused scan is
   explicitly incomplete, including when it has found no matches yet.

For example, searching for confirmation number `SAX` matches
`ConfirmationNumber: "SAXEZT34ZA"`. Searching for `EZT` does not match because the
value does not begin with `EZT`.

Results include a status badge for Stripe's subscription schedule states: Active,
Canceled, Completed, Not started, and Released. Cancel stops further pagination and
discards any response still in flight. Partial matches remain visible after an API
failure, and retry resumes at the failed page.

Completed searches and searches stopped at the result limit are cached locally for
navigation between supported Dashboard views. Partial scans are not cached as complete
results; they can be continued while the view remains open. Starting a new search
clears the previous cache and reloads schedules from Stripe.

This first refactor retains the 31-day window and all statuses. The one-year default,
creation-date/status controls, and end-date display are planned in later increments.

## Dashboard locations

The app is available throughout the Dashboard when opened from the app drawer. It has
page-specific views for:

- Subscription list
- Customer detail
- Subscription detail

The default drawer (`stripe.dashboard.drawer.default`) provides the same search form
and results on all other pages, including `/subscription_schedules` and schedule detail
pages. It works with account-prefixed and test-mode Dashboard URLs. This is the app's
drawer UI, not an embedded search field in Stripe's native schedules table.

The default view does not receive a current Stripe object, so it searches by the
entered identifiers and does not provide object-based previous/next navigation.
Settled searches are restored when the view mounts; "Start a new search" clears the
results and shows the form in place without navigating to another Dashboard page.

The app requires `subscription_read` to load schedules and `customer_read` to show
customer details with results.

## Development

Requirements:

- Node.js 20 or later
- pnpm 10

Install dependencies and run all checks:

```sh
pnpm install
pnpm check
```

The scanner is in `ui/src/views/scheduleSearchEngine.ts`; its configurable
`MAX_PAGES_PER_BATCH` defaults to 20. `ScheduleSearch.tsx` manages the form, scan
lifecycle, and storage. Shared result/cache types are in `scheduleSearchData.ts`,
and result presentation is in `ScheduleSearchResults.tsx`.

`pnpm check` includes UI TypeScript, ESLint, formatting, and Jest checks. UI test
failures fail the root command. `pnpm build` currently only visits the custom-object
scaffold; validate the rendered UI through `stripe apps start`.

## Local verification of the first increment

Run `stripe apps start`, then open the app from the Dashboard Subscriptions page:

1. Search for a known account/confirmation prefix. With multiple API pages, results
   and the checked count should update before the scan finishes.
2. Use a broad prefix that matches at least 101 schedules. Expect 100 visible rows,
   the overflow banner, and no subsequent page requests.
3. Try a specific prefix with no matches. If the account has more than 2,000 schedules
   in the window, expect a pause and Continue, not an assertion that no matches exist.
4. Cancel a scan, then continue or start a new search. Old responses must not replace
   newer results. API failures should retain partial results and offer Retry.
5. Open a schedule result and confirm the search remains available in the original
   tab. Reopen the app after a settled search to check result restoration.

The automated tests cover pagination and overflow boundaries, pause/resume, retry,
cancellation, unmount, progressive results, and cache behavior without Stripe API calls.

## Local verification of the default drawer

After updating the manifest, restart `stripe apps start` and reload the Dashboard:

1. Open `/subscription_schedules` in your test account and open Scheduled Subscription
   Search from the app drawer. Confirm that both identifier fields are available.
2. Run a search there. Confirm that matches render, schedule links open a new tab,
   and "Start a new search" returns to the form on the same page.
3. Complete a search on the Subscriptions page, then navigate to the schedules page
   and reopen the app. Confirm that the settled results are restored.
4. Open a schedule detail page and another Dashboard page. Confirm the same default
   search view is available. Repeat opening/closing the drawer and starting searches
   to check for the historical re-render crash in the actual Dashboard host.

Automated drawer tests exercise missing object context, searching with reactive
storage, starting over, restoring results from another viewport, invalid cached data,
and test/live schedule links. Actual Dashboard host behavior still needs this smoke test.
