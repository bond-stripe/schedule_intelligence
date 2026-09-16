import {
  createScheduleSearch,
  getScheduleCreatedCutoff,
  MAX_PAGES_PER_BATCH,
  type ListSchedulePage,
  type SearchableSchedule,
} from './scheduleSearchEngine';

const schedule = (
  id: number,
  account = '111056',
  confirmation = 'SAXEZT'
): SearchableSchedule => ({
  id: `sub_sched_${id}`,
  customer: 'cus_123',
  created: 1704067200,
  current_phase: null,
  status: 'not_started',
  phases: [
    {
      start_date: 1735689600,
      metadata: { AccountNumber: account, ConfirmationNumber: confirmation },
    },
  ],
});
const page = (data: SearchableSchedule[], has_more = false) => ({ data, has_more });

describe('schedule search engine', () => {
  const listSchedules = jest.fn<
    ReturnType<ListSchedulePage>,
    Parameters<ListSchedulePage>
  >();
  const newSearch = (
    overrides: Partial<Parameters<typeof createScheduleSearch>[0]> = {}
  ) =>
    createScheduleSearch({
      listSchedules,
      accountNumber: '111',
      confirmationNumber: '',
      createdAfter: 123456,
      ...overrides,
    });

  beforeEach(() => listSchedules.mockReset());

  it('matches trimmed, case-insensitive prefixes with AND semantics', async () => {
    listSchedules.mockResolvedValue(
      page([
        schedule(1),
        schedule(2, 'other'),
        schedule(3, '111', 'other'),
        schedule(4, '111', 'XSAX'),
      ])
    );
    const result = await newSearch({
      accountNumber: ' 111 ',
      confirmationNumber: ' sax ',
    }).runBatch();
    expect(result.status).toBe('complete');
    expect(result.results.map((row) => row.scheduleId)).toEqual(['sub_sched_1']);
    expect(result.scannedScheduleCount).toBe(4);
  });

  it('allows searching by confirmation alone', async () => {
    listSchedules.mockResolvedValue(page([schedule(1, ''), schedule(2, '', 'other')]));
    expect(
      (await newSearch({ accountNumber: '', confirmationNumber: 'sax' }).runBatch())
        .results
    ).toHaveLength(1);
  });

  it('ignores later-phase metadata and tolerates missing first-phase metadata', async () => {
    const laterPhase = schedule(1, 'other');
    laterPhase.phases.push(schedule(2).phases[0]);
    const noMetadata = schedule(3);
    noMetadata.phases[0].metadata = null;
    listSchedules.mockResolvedValue(
      page([laterPhase, noMetadata, { ...schedule(4), phases: [] }])
    );
    expect((await newSearch().runBatch()).results).toEqual([]);
  });

  it('preserves every schedule status in this increment', async () => {
    const statuses: SearchableSchedule['status'][] = [
      'active',
      'canceled',
      'completed',
      'not_started',
      'released',
    ];
    listSchedules.mockResolvedValue(
      page(statuses.map((status, i) => ({ ...schedule(i), status })))
    );
    expect((await newSearch().runBatch()).results.map((row) => row.status)).toEqual(
      statuses
    );
  });

  it('rejects empty criteria and invalid budgets before making requests', () => {
    expect(() => newSearch({ accountNumber: ' ' })).toThrow('Enter an account number');
    expect(() => newSearch({ maxPagesPerBatch: 0 })).toThrow('page budget');
    expect(listSchedules).not.toHaveBeenCalled();
  });

  it('uses a fixed cutoff and correct cursor, publishing compact immutable snapshots', async () => {
    listSchedules
      .mockResolvedValueOnce(page([schedule(1), schedule(2, 'other')], true))
      .mockResolvedValueOnce(page([schedule(3)]));
    const onProgress = jest.fn();
    const result = await newSearch().runBatch({ onProgress });
    expect(listSchedules.mock.calls.map(([params]) => params)).toEqual([
      { created: { gte: 123456 }, limit: 100, expand: ['data.customer'] },
      {
        created: { gte: 123456 },
        limit: 100,
        expand: ['data.customer'],
        starting_after: 'sub_sched_2',
      },
    ]);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0].results).toHaveLength(1);
    expect(onProgress.mock.calls[0][0].results[0]).not.toHaveProperty('phases');
    expect(result.results.map((row) => row.scheduleId)).toEqual([
      'sub_sched_1',
      'sub_sched_3',
    ]);
    expect(result.scannedScheduleCount).toBe(3);
  });

  it('stops on match 101 without retaining it or requesting page three', async () => {
    listSchedules
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => schedule(i)),
          true
        )
      )
      .mockResolvedValueOnce(
        page([schedule(100, 'other'), schedule(101), schedule(102)], true)
      );
    const search = newSearch();
    const result = await search.runBatch();
    expect(result.status).toBe('limit_reached');
    expect(result.results).toHaveLength(100);
    expect(result.results[99].scheduleId).toBe('sub_sched_99');
    expect(result.scannedScheduleCount).toBe(102);
    expect(listSchedules).toHaveBeenCalledTimes(2);
    expect(await search.runBatch()).toEqual(result);
    expect(listSchedules).toHaveBeenCalledTimes(2);
  });

  it('does not claim overflow for exactly 100 matches with more nonmatching pages', async () => {
    listSchedules
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => schedule(i)),
          true
        )
      )
      .mockResolvedValueOnce(page([schedule(101, 'other')], true))
      .mockResolvedValueOnce(page([schedule(102, 'other')]));
    const result = await newSearch().runBatch();
    expect(result.status).toBe('complete');
    expect(result.results).toHaveLength(100);
    expect(listSchedules).toHaveBeenCalledTimes(3);
  });

  it('completes an empty result only after exhausting the pages', async () => {
    listSchedules
      .mockResolvedValueOnce(page([schedule(1, 'other')], true))
      .mockResolvedValueOnce(page([]));
    expect(await newSearch().runBatch()).toEqual({
      status: 'complete',
      results: [],
      scannedScheduleCount: 1,
    });
  });

  it('pauses at the page budget and continues from the saved cursor and matches', async () => {
    listSchedules
      .mockResolvedValueOnce(page([schedule(1)], true))
      .mockResolvedValueOnce(page([schedule(2)]));
    const search = newSearch({ maxPagesPerBatch: 1 });
    expect((await search.runBatch()).status).toBe('paused');
    expect(listSchedules).toHaveBeenCalledTimes(1);
    const result = await search.runBatch();
    expect(result.status).toBe('complete');
    expect(result.results).toHaveLength(2);
    expect(listSchedules.mock.calls[1][0].starting_after).toBe('sub_sched_1');
  });

  it('bounds no-match scans with the default budget', async () => {
    listSchedules.mockImplementation(async () =>
      page([schedule(listSchedules.mock.calls.length, 'other')], true)
    );
    expect((await newSearch().runBatch()).status).toBe('paused');
    expect(listSchedules).toHaveBeenCalledTimes(MAX_PAGES_PER_BATCH);
  });

  it('retains partial results on failure and retries the failed page', async () => {
    listSchedules
      .mockResolvedValueOnce(page([schedule(1)], true))
      .mockRejectedValueOnce(new Error('Temporarily unavailable'))
      .mockResolvedValueOnce(page([schedule(2)]));
    const search = newSearch();
    const failed = await search.runBatch();
    expect(failed).toMatchObject({
      status: 'error',
      error: 'Temporarily unavailable',
      scannedScheduleCount: 1,
    });
    expect(failed.results).toHaveLength(1);
    const result = await search.runBatch();
    expect(result.status).toBe('complete');
    expect(result.results).toHaveLength(2);
    expect(listSchedules.mock.calls[2][0]).toEqual(listSchedules.mock.calls[1][0]);
  });

  it('does not request pages after cancellation', async () => {
    let canceled = false;
    listSchedules.mockResolvedValue(page([schedule(1)], true));
    const result = await newSearch().runBatch({
      onProgress: () => {
        canceled = true;
      },
      isCanceled: () => canceled,
    });
    expect(result.status).toBe('canceled');
    expect(result.results).toHaveLength(1);
    expect(listSchedules).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight response after cancellation and can retry it', async () => {
    let canceled = false;
    listSchedules
      .mockImplementationOnce(async () => {
        canceled = true;
        return page([schedule(1)], true);
      })
      .mockResolvedValueOnce(page([schedule(1)]));
    const search = newSearch();
    const onProgress = jest.fn();
    expect(await search.runBatch({ isCanceled: () => canceled, onProgress })).toEqual({
      status: 'canceled',
      results: [],
      scannedScheduleCount: 0,
    });
    expect(onProgress).not.toHaveBeenCalled();
    expect((await search.runBatch()).results).toHaveLength(1);
    expect(listSchedules.mock.calls[1][0]).toEqual(listSchedules.mock.calls[0][0]);
  });

  it('makes no request if already canceled', async () => {
    expect((await newSearch().runBatch({ isCanceled: () => true })).status).toBe(
      'canceled'
    );
    expect(listSchedules).not.toHaveBeenCalled();
  });

  it('fails safely on an empty page that claims more data', async () => {
    listSchedules.mockResolvedValue(page([], true));
    expect((await newSearch().runBatch()).status).toBe('error');
    expect(listSchedules).toHaveBeenCalledTimes(1);
  });

  it('fails safely on a repeated cursor without duplicating matches', async () => {
    listSchedules.mockResolvedValue(page([schedule(1)], true));
    const result = await newSearch().runBatch();
    expect(result.status).toBe('error');
    expect(result.results).toHaveLength(1);
    expect(listSchedules).toHaveBeenCalledTimes(2);
  });

  it('keeps the existing rolling 31-day cutoff', () => {
    const now = Date.UTC(2026, 8, 14, 12);
    expect(getScheduleCreatedCutoff(now)).toBe(now / 1000 - 31 * 24 * 60 * 60);
  });
});
