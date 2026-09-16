# Scheduled Subscription Search

A Stripe App for finding recent subscription schedules by an account number or
confirmation number stored in first-phase metadata. Search results show the customer,
schedule, account and confirmation numbers, start/end dates, and current schedule status.

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
2. New searches default to one calendar month ago through today to limit the initial
   scan. Both dates are included, and users can widen the range by editing either date.
   Month ends are clamped to the previous month's last day (for example, March 31 uses
   February 28, or February 29 in a leap year). These filters concern creation time, not the
   schedule's start or end date.
3. Stripe returns schedules in pages of 100. The app filters each page as it arrives,
   displays matches progressively, and retains at most 100 compact result rows.
4. The app reads `AccountNumber` and `ConfirmationNumber` from the first phase and
   performs case-insensitive prefix matching.
5. If both identifiers are entered, a schedule must match both prefixes. All statuses,
   including released schedules, are always eligible and count toward the match limit.
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

The form remains visible above results. Changing filters marks the results as belonging
to the previous submitted criteria. Select Search to issue a fresh scan, even if the
criteria are unchanged. Refinement never filters only the cached 100 rows. Continue/Retry
is available only while the draft still matches the original scan's criteria.

Date inputs use Stripe's supported `DateField` component. Dates and timestamps are
displayed in the user's local timezone. The API receives
`created.gte` at local midnight on the first date and `created.lt` at local midnight on
the day after the final date. Calendar-day arithmetic handles daylight-saving changes.
Both valid dates and at least one identifier are required; reversed ranges cannot run.

Results include a status badge for Stripe's subscription schedule states: Active,
Canceled, Completed, Not started, and Released. Cancel stops further pagination and
discards any response still in flight. Partial matches remain visible after an API
failure, and retry resumes at the failed page.

Completed searches and searches stopped at the result limit are cached locally for
navigation between supported Dashboard views. Partial scans are not cached as complete
results; they can be continued while the view remains open. Starting a new search
clears the previous cache and reloads schedules from Stripe. The reset link clears
identifiers and restores the one-month default dates. Restored searches keep their
saved date range, including wider ranges.

The v11 cache key and stored body are scoped to the Stripe account and test/live mode.
Older caches that may have excluded released schedules are not restored.
Cached data includes the submitted filters, end dates, completion/overflow state, and
search time. The UI omits the summary heading, repeated criteria, result count, and
search timestamp; select Search again to refresh. Legacy
cache entries and malformed data are ignored. Changing account or mode remounts the
view and invalidates any in-flight work from the previous scope.

## Schedule end dates

"Starts" uses the first phase's start date (or current-phase start if necessary).
"Ends" uses the final phase's `end_date`, which Stripe has already calculated from the
phase configuration. It is not the current phase's end or the subscription's next bill.
Missing or invalid dates display "Unknown"; creation time is not substituted for start.

For a simple phase, the duration is the recurring interval multiplied by
`price.recurring.interval_count` and the number of phase iterations. Iterations are a
create/update parameter; the returned schedule provides the resulting `end_date`.
Using that date avoids extra price calls and reproducing calendar/trial/multi-phase
calculations. A separate business term cannot be inferred from billing frequency alone.

- Active/not-started schedules show Starts and Ends together. The routine cancellation
  explanation is omitted for leases configured to cancel (`cancel`) at the end. A note
  remains for schedules configured to continue (`release`) or with unknown end behavior.
- Historical schedules show "Scheduled end" separately from their actual completed or
  released timestamp. Canceled schedules retain their status badge but omit the actual
  cancellation date. An early release/cancellation does not rewrite the original planned
  endpoint in the display.
- Release does not itself cancel the subscription. The app does not claim that a
  released subscription is still running today or infer a subscription cancellation date.

These dates and status details come from the schedule list response. No new API
permissions or price retrievals are needed.

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
Settled searches are restored when the view mounts; "Start a new search" resets the
form and results in place without navigating to another Dashboard page.

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
`MAX_PAGES_PER_BATCH` defaults to 20. `ScheduleSearch.tsx` renders the form;
`useScheduleSearch.ts` manages draft/submitted criteria, scan lifecycle, and storage.
`scheduleSearchDates.ts` handles calendar-date bounds. Shared result/cache types and
validation are in `scheduleSearchData.ts`, and result presentation is in
`ScheduleSearchResults.tsx`.

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

## Local verification of date filters, statuses, and end dates

1. Start a new search and confirm the two DateFields default to the past month through
   today, with no released-status checkbox. Try empty and reversed dates; Search must
   stay disabled. Compare a known schedule's creation date against each boundary.
2. Search for an identifier belonging to a schedule older than 31 days. Narrow the
   range and keep the form open. Confirm the "Filters changed" warning appears until
   Search applies the edited range. Results should not have a separate search summary.
3. Find an identifier with a released schedule. Verify it appears on the first search
   without any additional option. Confirm its release timestamp and note.
4. Compare Ends to the last phase in Stripe for single-phase and multi-phase schedules,
   including a trial, monthly intervals, and an early cancellation. The displayed end
   must not be confused with the next invoice or a subscription cancellation date.
5. Reopen the drawer to check saved criteria and end dates. Switch Stripe
   accounts and test/live modes; results from the previous scope must not appear.

Unit/integration tests cover date validation, leap years and offset transitions,
released matches counting toward overflow, stable bounds on resume, end-date semantics,
refinement with fresh API calls, cache validation, and account/mode invalidation.
