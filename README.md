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
3. Stripe returns schedules in pages of 100. The app paginates through all matching
   pages and holds those schedules in memory for the current search.
4. The app reads `AccountNumber` and `ConfirmationNumber` from the first phase and
   performs case-insensitive prefix matching.
5. If both fields are entered, a schedule must match both fields.
6. The first 100 matching schedules are displayed. If more than 100 match, the app
   indicates that the displayed list was limited after all recent schedules were
   searched.

For example, searching for confirmation number `SAX` matches
`ConfirmationNumber: "SAXEZT34ZA"`. Searching for `EZT` does not match because the
value does not begin with `EZT`.

Results include a status badge for Stripe's subscription schedule states: Active,
Canceled, Completed, Not started, and Released. Search results are cached locally so
they remain available while navigating between supported Dashboard views. Starting a
new search reloads recent schedules from Stripe.

## Dashboard locations

The app is available in these Dashboard viewports:

- Subscription list
- Customer detail
- Subscription detail

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

The primary search implementation is in
`ui/src/views/ScheduleSearch.tsx`. Shared result and cache types are in
`ui/src/views/scheduleSearchData.ts`, and result presentation is in
`ui/src/views/ScheduleSearchResults.tsx`.
