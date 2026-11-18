import type Stripe from 'stripe';

import {
  createScheduleIndex,
  discardScheduleIndex,
  getScheduleIndex,
  INDEX_MAX_AGE_SECONDS,
  peekScheduleIndex,
  runIndexedSearch,
  toIndexedSchedule,
} from './scheduleIndex';
import type { ListSchedulePage, SearchableSchedule } from './scheduleSearchEngine';

const NEWEST = 1_794_425_567;
const schedule = (
  id: number,
  account: string,
  created: number,
  confirmation = 'S' + String(id).padStart(14, '0')
): SearchableSchedule => ({
  id: `sub_sched_${id}`,
  customer: `cus_${id % 7}`,
  created,
  current_phase: null,
  end_behavior: 'cancel',
  canceled_at: null,
  completed_at: null,
  released_at: null,
  status: 'not_started',
  phases: [
    {
      start_date: 1795000000,
      end_date: 1826536000,
      metadata: { AccountNumber: account, ConfirmationNumber: confirmation },
    },
  ],
});
const fixtures = (count: number, matchEvery = 100) =>
  Array.from({ length: count }, (_, i) =>
    schedule(i, i % matchEvery === 0 ? '11663' + i : '119' + i, NEWEST - i * 5)
  );

// Filters like Stripe: newest first, `created` bounds, `starting_after` cursor.
const createFakeApi = (initial: SearchableSchedule[]) => {
  let items = [...initial];
  const calls: Stripe.SubscriptionScheduleListParams[] = [];
  const retrieved: string[] = [];
  const overrides = new Map<string, SearchableSchedule | Error>();
  const listSchedules: ListSchedulePage = async (params) => {
    calls.push(params);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sorted = [...items].sort(
      (left, right) =>
        (right.created ?? 0) - (left.created ?? 0) || right.id.localeCompare(left.id)
    );
    const { gte, lt } = (params.created ?? {}) as Stripe.RangeQueryParam;
    const after = params.starting_after
      ? sorted.findIndex((item) => item.id === params.starting_after)
      : -1;
    const candidates = sorted.filter(
      (item, index) =>
        index > after &&
        (gte === undefined || (item.created ?? 0) >= gte) &&
        (lt === undefined || (item.created ?? 0) < lt)
    );
    const data = candidates.slice(0, params.limit ?? 10);
    return { data, has_more: candidates.length > data.length };
  };
  const retrieveSchedule = async (scheduleId: string) => {
    retrieved.push(scheduleId);
    const override = overrides.get(scheduleId);
    if (override instanceof Error) throw override;
    const found = override ?? items.find((item) => item.id === scheduleId);
    if (!found) throw new Error('No such schedule');
    return found;
  };
  return {
    listSchedules,
    retrieveSchedule,
    calls,
    retrieved,
    overrides,
    add: (item: SearchableSchedule) => {
      items = [...items, item];
    },
  };
};

const criteria = (accountNumber: string, confirmationNumber = '') => ({
  accountNumber,
  confirmationNumber,
});

describe('schedule index', () => {
  let clock = NEWEST + 60;
  const now = () => clock;
  const newIndex = (
    fake: ReturnType<typeof createFakeApi>,
    maxIndexedSchedules?: number
  ) =>
    createScheduleIndex({
      listSchedules: fake.listSchedules,
      retrieveSchedule: fake.retrieveSchedule,
      now,
      sleep: async () => undefined,
      ...(maxIndexedSchedules ? { maxIndexedSchedules } : {}),
    });

  beforeEach(() => {
    clock = NEWEST + 60;
    discardScheduleIndex();
  });

  it('stores compact entries and reuses unchanged identifier strings as keys', () => {
    const entry = toIndexedSchedule(
      schedule(1, '11663221259', NEWEST, 'SCTGWP6UIYE8EKZ')
    );
    expect(entry).toMatchObject({
      scheduleId: 'sub_sched_1',
      accountKey: '11663221259',
      confirmationKey: 'sctgwp6uiye8ekz',
      created: NEWEST,
    });
    expect(entry).not.toHaveProperty('phases');
    expect(entry).not.toHaveProperty('customerEmail');
    expect(
      toIndexedSchedule({ ...schedule(2, '1', NEWEST), status: 'active' })
    ).toBeNull();
  });

  it('answers the first search from a fresh build without re-reading matches', async () => {
    const fake = createFakeApi(fixtures(1200));
    const index = newIndex(fake);
    const result = await runIndexedSearch(index, criteria('11663'));
    expect(result).toMatchObject({ status: 'complete', scannedScheduleCount: 1200 });
    expect(result.status !== 'too_large' && result.results).toHaveLength(12);
    expect(fake.retrieved).toHaveLength(0);
    expect(index.hasUsableIndex()).toBe(true);
  });

  it('answers repeat searches from memory with one delta request and match re-reads', async () => {
    const fake = createFakeApi(fixtures(1200));
    const index = newIndex(fake);
    await runIndexedSearch(index, criteria('11663'));
    const buildCalls = fake.calls.length;

    const result = await runIndexedSearch(index, criteria('116630'));
    expect(fake.calls.length - buildCalls).toBe(1);
    expect(fake.calls.at(-1)).toMatchObject({
      scheduled: true,
      created: { gte: NEWEST },
    });
    expect(result).toMatchObject({ status: 'complete' });
    expect(
      result.status !== 'too_large' && result.results.map((row) => row.scheduleId)
    ).toEqual(['sub_sched_0']);
    expect(fake.retrieved).toEqual(['sub_sched_0']);
  });

  it('picks up schedules created after the index was built', async () => {
    const fake = createFakeApi(fixtures(300));
    const index = newIndex(fake);
    await runIndexedSearch(index, criteria('11663'));
    fake.add(schedule(9999, '11663999', NEWEST + 30));
    const result = await runIndexedSearch(index, criteria('11663999'));
    expect(
      result.status !== 'too_large' && result.results.map((row) => row.scheduleId)
    ).toEqual(['sub_sched_9999']);
    expect(index.size()).toBe(301);
  });

  it('drops started or edited matches on re-read and refills from later candidates', async () => {
    const fake = createFakeApi(fixtures(1200, 1));
    const index = newIndex(fake);
    // Overflow settles the first search early; let the build finish in the background.
    expect(await runIndexedSearch(index, criteria('11663'))).toMatchObject({
      status: 'limit_reached',
    });
    expect(index.hasUsableIndex()).toBe(false);
    while (!index.hasUsableIndex())
      await new Promise((resolve) => setTimeout(resolve, 0));
    fake.overrides.set('sub_sched_0', {
      ...schedule(0, '116630', NEWEST),
      status: 'active',
    });
    fake.overrides.set('sub_sched_1', schedule(1, '22222', NEWEST - 5));

    const result = await runIndexedSearch(index, criteria('11663'));
    if (result.status === 'too_large') throw new Error('unexpected');
    expect(result.status).toBe('limit_reached');
    expect(result.results).toHaveLength(50);
    const ids = result.results.map((row) => row.scheduleId);
    expect(ids).not.toContain('sub_sched_0');
    expect(ids).not.toContain('sub_sched_1');
    expect(ids.at(-1)).toBe('sub_sched_51');
    // The started schedule left the index; the edited one now has its new identifier.
    expect(index.match(criteria('116630'))).toHaveLength(0);
    expect(index.match(criteria('22222')).map((entry) => entry.scheduleId)).toEqual([
      'sub_sched_1',
    ]);
  });

  it('keeps an indexed match when its re-read fails', async () => {
    const fake = createFakeApi(fixtures(300));
    const index = newIndex(fake);
    await runIndexedSearch(index, criteria('11663'));
    fake.overrides.set('sub_sched_0', new Error('Network error'));
    const result = await runIndexedSearch(index, criteria('116630'));
    expect(
      result.status !== 'too_large' && result.results.map((row) => row.scheduleId)
    ).toEqual(['sub_sched_0']);
  });

  it('rebuilds a stale index in the background while searches use the current one', async () => {
    const fake = createFakeApi(fixtures(1200));
    const index = newIndex(fake);
    await runIndexedSearch(index, criteria('11663'));
    expect(index.isStale()).toBe(false);
    clock += INDEX_MAX_AGE_SECONDS + 1;
    expect(index.isStale()).toBe(true);

    const result = await runIndexedSearch(index, criteria('116630'));
    expect(result).toMatchObject({ status: 'complete' });
    expect(index.isBuilding()).toBe(true);
    await index.waitForBuild(() => false);
    while (index.isBuilding()) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(index.isStale()).toBe(false);
    expect(index.size()).toBe(1200);
  });

  it('does nothing until asked: no requests on creation, prepare only once', async () => {
    const fake = createFakeApi(fixtures(300));
    const index = newIndex(fake);
    expect(fake.calls).toHaveLength(0);
    index.prepare();
    index.prepare();
    expect(fake.calls).toHaveLength(1);
    await runIndexedSearch(index, criteria('11663'));
    const calls = fake.calls.length;
    index.prepare();
    expect(fake.calls).toHaveLength(calls);
  });

  it('resumes a stopped build without re-fetching finished ranges or duplicating', async () => {
    const fake = createFakeApi(fixtures(2400));
    const index = newIndex(fake);
    let pages = 0;
    const first = await runIndexedSearch(index, criteria('11663'), {
      onProgress: () => {
        pages += 1;
        if (pages === 3) index.stopBuild();
      },
    });
    expect(first.status).toBe('canceled');
    expect(index.hasUsableIndex()).toBe(false);
    const result = await runIndexedSearch(index, criteria('11663'));
    expect(result).toMatchObject({ status: 'complete', scannedScheduleCount: 2400 });
    expect(fake.calls.length).toBeLessThan(40);
  });

  it('drops the index and reports too_large above the entry limit', async () => {
    const fake = createFakeApi(fixtures(500));
    const index = newIndex(fake, 250);
    expect(await runIndexedSearch(index, criteria('11663'))).toEqual({
      status: 'too_large',
    });
    expect(index.isTooLarge()).toBe(true);
    expect(index.hasUsableIndex()).toBe(false);
    expect(index.size()).toBe(0);
    const calls = fake.calls.length;
    index.prepare();
    expect(fake.calls).toHaveLength(calls);
  });

  it('keeps one index per account and mode and discards the old one on switch', async () => {
    const fake = createFakeApi(fixtures(300));
    const dependencies = () => ({
      listSchedules: fake.listSchedules,
      retrieveSchedule: fake.retrieveSchedule,
      sleep: async () => undefined,
    });
    const live = { accountId: 'acct_1', mode: 'live' as const };
    const first = getScheduleIndex(live, dependencies);
    await runIndexedSearch(first, criteria('11663'));
    expect(getScheduleIndex(live, dependencies)).toBe(first);
    expect(peekScheduleIndex({ ...live, mode: 'test' })).toBeNull();

    const other = getScheduleIndex({ accountId: 'acct_2', mode: 'live' }, dependencies);
    expect(other).not.toBe(first);
    expect(first.hasUsableIndex()).toBe(false);
    expect(first.size()).toBe(0);
    expect(peekScheduleIndex(live)).toBeNull();
  });
});
