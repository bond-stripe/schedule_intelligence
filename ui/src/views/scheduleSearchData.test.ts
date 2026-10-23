import {
  getDashboardUrl,
  getSearchStorageKey,
  parseCachedSearch,
  type CachedSearch,
} from './scheduleSearchData';

describe('getDashboardUrl', () => {
  it('creates an absolute live-mode Dashboard URL scoped to the account', () => {
    expect(
      getDashboardUrl(
        { accountId: 'acct_1234', mode: 'live' },
        '/subscription_schedules/sub_sched_123'
      )
    ).toBe('https://dashboard.stripe.com/acct_1234/subscription_schedules/sub_sched_123');
  });

  it('creates an absolute test-mode Dashboard URL scoped to the account', () => {
    expect(
      getDashboardUrl(
        { accountId: 'acct_1234', mode: 'test' },
        '/subscription_schedules/sub_sched_123'
      )
    ).toBe(
      'https://dashboard.stripe.com/acct_1234/test/subscription_schedules/sub_sched_123'
    );
  });
});

describe('scoped search cache', () => {
  const scope = { accountId: 'acct_1234', mode: 'test' as const };
  const valid: CachedSearch = {
    scope,
    criteria: {
      accountNumber: '111',
      confirmationNumber: '',
    },
    searchedAt: 1767225600,
    scannedScheduleCount: 1,
    status: 'complete',
    results: [
      {
        scheduleId: 'sub_sched_1234',
        customerId: 'cus_123',
        customerEmail: null,
        accountNumber: '111',
        confirmationNumber: '',
        startDate: 1735689600,
        endDate: 1767225600,
        endedAt: null,
        endBehavior: 'cancel',
        status: 'not_started',
      },
    ],
  };
  it('round-trips filters, end dates, and freshness', () => {
    expect(parseCachedSearch(JSON.stringify(valid), scope)).toEqual(valid);
  });
  it('rejects cached results that are no longer future schedules', () => {
    const cache = {
      ...valid,
      results: [{ ...valid.results[0], status: 'released', endedAt: 1767225600 }],
    };
    expect(parseCachedSearch(JSON.stringify(cache), scope)).toBeNull();
  });
  it('uses the current cache schema key', () => {
    expect(getSearchStorageKey(scope)).toBe(
      'scheduled-subscription-search:last-search:v13:acct_1234:test'
    );
  });
  it('isolates accounts and modes in both key and body validation', () => {
    const live = { ...scope, mode: 'live' as const };
    const other = { ...scope, accountId: 'acct_other' };
    expect(new Set([scope, live, other].map(getSearchStorageKey)).size).toBe(3);
    expect(parseCachedSearch(JSON.stringify(valid), live)).toBeNull();
    expect(parseCachedSearch(JSON.stringify(valid), other)).toBeNull();
  });
  it.each([
    null,
    '',
    '{bad',
    'null',
    '[]',
    '{}',
    JSON.stringify({ accountNumber: '111', searched: true, results: [] }),
  ])('ignores absent, invalid, and legacy data (%s)', (value) => {
    expect(parseCachedSearch(value, scope)).toBeNull();
  });
  it.each([
    { status: 'paused' },
    { searchedAt: -1 },
    { scannedScheduleCount: -1 },
    { scannedScheduleCount: 0.5 },
    { status: 'limit_reached' },
    { criteria: { accountNumber: '', confirmationNumber: '' } },
    { results: Array(51).fill(valid.results[0]) },
    { results: [{ ...valid.results[0], endDate: 'tomorrow' }] },
    { results: [{ ...valid.results[0], status: 'invalid' }] },
  ])('rejects invalid or incomplete cache state %#', (change) => {
    expect(parseCachedSearch(JSON.stringify({ ...valid, ...change }), scope)).toBeNull();
  });
  it('accepts unknown dates without inventing a value', () => {
    const cache = {
      ...valid,
      results: [{ ...valid.results[0], startDate: null, endDate: null, endedAt: null }],
    };
    expect(
      parseCachedSearch(JSON.stringify(cache), scope)?.results[0].endDate
    ).toBeNull();
  });
});
