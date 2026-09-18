# Future Dated Subscriptions

A Stripe App for finding future subscription schedules by an account number or
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
2. The app asks Stripe for only schedules that have not started (`scheduled: true`).
   Active, completed, released, and canceled schedules are excluded by the API before
   the app scans first-phase metadata.
3. Stripe returns future schedules in pages of 100. The app filters each page as it
   arrives, displays matches progressively, and retains at most 50 compact result rows.
4. The app reads `AccountNumber` and `ConfirmationNumber` from the first phase and
   performs case-insensitive prefix matching.
5. If both identifiers are entered, a schedule must match both prefixes.
6. As soon as a 51st match is found, the app stops scanning and displays "More than
   50 matches" with a prompt to refine the search. Exactly 50 matches does not prove
   overflow: the app continues looking until it finds another match or exhausts the
   remaining schedules.
7. Each batch loads at most 50 pages. A longer search pauses with a "Continue
   searching" button that resumes from the saved page cursor. A paused scan is
   explicitly incomplete, including when it has found no matches yet.

For example, searching for confirmation number `SAX` matches
`ConfirmationNumber: "SAXEZT34ZA"`. Searching for `EZT` does not match because the
value does not begin with `EZT`.

The form remains visible above results. Changing filters marks the results as belonging
to the previous submitted criteria. Select Search to issue a fresh scan, even if the
criteria are unchanged. Refinement never filters only the cached 50 rows. Continue/Retry
is available only while the draft still matches the original scan's criteria.

Results include a Not started status badge. Cancel stops further pagination and
discards any response still in flight. Partial matches remain visible after an API
failure, and retry resumes at the failed page.

Completed searches and searches stopped at the result limit are cached locally for
navigation between supported Dashboard views. Partial scans are not cached as complete
results; they can be continued while the view remains open. Starting a new search
clears the previous cache and reloads schedules from Stripe. The reset link clears
both identifiers.

The v13 cache key and stored body are scoped to the Stripe account and test/live mode.
Older caches that used different schedule eligibility rules are not restored.
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

- Not-started schedules show Starts and Ends together. The routine cancellation
  explanation is omitted for leases configured to cancel (`cancel`) at the end. A note
  remains for schedules configured to continue (`release`) or with unknown end behavior.
- Active and historical schedules aren't eligible for search results. In particular,
  releasing a schedule does not cancel its subscription, but the released schedule is
  no longer future-dated and therefore isn't returned by this app.

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
`MAX_PAGES_PER_BATCH` defaults to 50. `ScheduleSearch.tsx` renders the form;
`useScheduleSearch.ts` manages draft/submitted criteria, scan lifecycle, and storage.
`scheduleSearchDates.ts` handles identifier criteria. Shared result/cache types and
validation are in `scheduleSearchData.ts`, and result presentation is in
`ScheduleSearchResults.tsx`.

`pnpm check` includes UI TypeScript, ESLint, formatting, and Jest checks. UI test
failures fail the root command. `pnpm build` currently only visits the custom-object
scaffold; validate the rendered UI through `stripe apps start`.

## Local verification of the first increment

Run `stripe apps start`, then open the app from the Dashboard Subscriptions page:

1. Search for a known account/confirmation prefix. With multiple API pages, results
   and the checked count should update before the scan finishes.
2. Use a broad prefix that matches at least 51 schedules. Expect 50 visible rows,
   the overflow banner, and no subsequent page requests.
3. Try a specific prefix with no matches. If the account has more than 5,000 future
   schedules, expect a pause and Continue, not an assertion that no matches exist.
4. Cancel a scan, then continue or start a new search. Old responses must not replace
   newer results. API failures should retain partial results and offer Retry.
5. Open a schedule result and confirm the search remains available in the original
   tab. Reopen the app after a settled search to check result restoration.

The automated tests cover pagination and overflow boundaries, pause/resume, retry,
cancellation, unmount, progressive results, and cache behavior without Stripe API calls.

## Local verification of the default drawer

After updating the manifest, restart `stripe apps start` and reload the Dashboard:

1. Open `/subscription_schedules` in your test account and open Future Dated
   Subscriptions from the app drawer. Confirm that both identifier fields are available.
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

## Local verification of schedule eligibility and end dates

1. Start a new search and confirm there are no creation-date or status controls. Search
   must stay disabled until at least one identifier is entered.
2. Search for identifiers belonging to active, released, and canceled schedules and
   confirm they do not appear. Confirm a not-started schedule does appear.
3. Edit an identifier after a completed search. Confirm the "Filters changed" warning
   appears until Search applies it. Results should not have a separate search summary.
4. Compare Ends to the last phase in Stripe for single-phase and multi-phase schedules,
   including a trial, monthly intervals, and an early cancellation. The displayed end
   must not be confused with the next invoice or a subscription cancellation date.
5. Reopen the drawer to check saved criteria and end dates. Switch Stripe
   accounts and test/live modes; results from the previous scope must not appear.

Unit/integration tests cover future-only API filtering, stable pagination on resume,
overflow boundaries, end-date semantics,
refinement with fresh API calls, cache validation, and account/mode invalidation.
