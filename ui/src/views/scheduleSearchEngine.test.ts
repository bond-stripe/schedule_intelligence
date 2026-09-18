import {
  createScheduleSearch,
  enrichCustomerEmails,
  getScheduleDates,
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
  current_phase: null,
  end_behavior: 'release',
  canceled_at: null,
  completed_at: null,
  released_at: null,
  status: 'not_started',
  phases: [
    {
      start_date: 1735689600,
      end_date: 1767225600,
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
      ...overrides,
    });

  beforeEach(() => listSchedules.mockReset());

  it('enriches unique customers only after scanning and tolerates lookup failures', async () => {
    const rows = (
      await (async () => {
        listSchedules.mockResolvedValue(page([schedule(1), schedule(2)]));
        return newSearch().runBatch();
      })()
    ).results;
    const retrieveCustomer = jest.fn(async (customerId: string) => {
      if (customerId === 'cus_missing') throw new Error('Not found');
      return { email: 'customer@example.com' };
    });
    const withMissingCustomer = [
      ...rows,
      { ...rows[0], scheduleId: 'sub_sched_missing', customerId: 'cus_missing' },
    ];

    const enriched = await enrichCustomerEmails(withMissingCustomer, retrieveCustomer);

    expect(retrieveCustomer).toHaveBeenCalledTimes(2);
    expect(enriched.slice(0, 2).map((result) => result.customerEmail)).toEqual([
      'customer@example.com',
      'customer@example.com',
    ]);
    expect(enriched[2].customerEmail).toBeNull();
  });

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

  it('defensively ignores any non-future schedule returned by the API', async () => {
    listSchedules.mockResolvedValue(
      page([
        { ...schedule(1), status: 'active' },
        { ...schedule(2), status: 'canceled' },
        { ...schedule(3), status: 'released' },
        schedule(4),
      ])
    );
    const result = await newSearch().runBatch();
    expect(result.results.map((row) => row.scheduleId)).toEqual(['sub_sched_4']);
    expect(result.scannedScheduleCount).toBe(4);
  });

  it('rejects empty criteria and invalid budgets before making requests', () => {
    expect(() => newSearch({ accountNumber: ' ' })).toThrow('Enter an account number');
    expect(() => newSearch({ maxPagesPerBatch: 0 })).toThrow('page budget');
    expect(listSchedules).not.toHaveBeenCalled();
  });

  it('uses the future-only filter and correct cursor, publishing compact snapshots', async () => {
    listSchedules
      .mockResolvedValueOnce(page([schedule(1), schedule(2, 'other')], true))
      .mockResolvedValueOnce(page([schedule(3)]));
    const onProgress = jest.fn();
    const result = await newSearch().runBatch({ onProgress });
    expect(listSchedules.mock.calls.map(([params]) => params)).toEqual([
      { scheduled: true, limit: 100 },
      {
        scheduled: true,
        limit: 100,
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

  it('stops on match 51 without retaining it or requesting page three', async () => {
    listSchedules
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 50 }, (_, i) => schedule(i)),
          true
        )
      )
      .mockResolvedValueOnce(
        page([schedule(50, 'other'), schedule(51), schedule(52)], true)
      );
    const search = newSearch();
    const result = await search.runBatch();
    expect(result.status).toBe('limit_reached');
    expect(result.results).toHaveLength(50);
    expect(result.results[49].scheduleId).toBe('sub_sched_49');
    expect(result.scannedScheduleCount).toBe(52);
    expect(listSchedules).toHaveBeenCalledTimes(2);
    expect(await search.runBatch()).toEqual(result);
    expect(listSchedules).toHaveBeenCalledTimes(2);
  });

  it('does not claim overflow for exactly 50 matches with more nonmatching pages', async () => {
    listSchedules
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 50 }, (_, i) => schedule(i)),
          true
        )
      )
      .mockResolvedValueOnce(page([schedule(51, 'other')], true))
      .mockResolvedValueOnce(page([schedule(52, 'other')]));
    const result = await newSearch().runBatch();
    expect(result.status).toBe('complete');
    expect(result.results).toHaveLength(50);
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

  it('preserves the future-only filter across continuation', async () => {
    const search = newSearch({ maxPagesPerBatch: 1 });
    listSchedules
      .mockResolvedValueOnce(page([schedule(1)], true))
      .mockResolvedValueOnce(page([]));
    await search.runBatch();
    await search.runBatch();
    expect(listSchedules.mock.calls[1][0]).toMatchObject({ scheduled: true });
  });

  it('uses the last phase end, independent of the current phase', () => {
    const item = schedule(1);
    item.phases.push({ ...item.phases[0], start_date: 1767225600, end_date: 1798761600 });
    item.current_phase = { start_date: 1735689600, end_date: 1767225600 };
    expect(getScheduleDates(item)).toEqual({
      startDate: 1735689600,
      endDate: 1798761600,
      endedAt: null,
      endBehavior: 'release',
    });
  });

  it.each([
    ['canceled', 'canceled_at'],
    ['completed', 'completed_at'],
    ['released', 'released_at'],
  ] as const)(
    'keeps the actual %s date distinct from the scheduled end',
    (status, field) => {
      const item = { ...schedule(1), status, [field]: 1750000000 };
      expect(getScheduleDates(item)).toMatchObject({
        endDate: 1767225600,
        endedAt: 1750000000,
      });
    }
  );

  it('does not invent start/end dates when the schedule has no phases', () => {
    const item = { ...schedule(1), phases: [] };
    expect(getScheduleDates(item)).toMatchObject({ startDate: null, endDate: null });
    item.current_phase = null;
  });

  it('discards invalid dates and preserves cancel end behavior', () => {
    const item = schedule(1);
    item.phases[0].end_date = NaN;
    item.end_behavior = 'cancel';
    expect(getScheduleDates(item)).toMatchObject({
      endDate: null,
      endBehavior: 'cancel',
    });
  });
});
