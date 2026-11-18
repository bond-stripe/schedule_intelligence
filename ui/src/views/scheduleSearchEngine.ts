import type Stripe from 'stripe';

import { isTimestamp, MAX_RESULTS, type SearchResult } from './scheduleSearchData';

export const PAGE_SIZE = 100;
// A safety stop, not a normal pause: 1,000 pages is 100,000 schedules.
export const MAX_PAGES_PER_BATCH = 1000;
// List requests share the account's per-endpoint rate limit with every other
// Dashboard user and the account's own integration, so keep this modest.
export const SCAN_CONCURRENCY = 8;
const MIN_SCAN_CONCURRENCY = 2;
const MAX_RATE_LIMIT_RETRIES = 4;
export const CUSTOMER_LOOKUP_CONCURRENCY = 5;

// Only the fields the scanner reads; a Stripe schedule is assignable to this type.
// Stripe always sends `created`; without a valid one a range is not split further.
export type SearchableSchedule = Pick<
  Stripe.SubscriptionSchedule,
  | 'id'
  | 'customer'
  | 'current_phase'
  | 'status'
  | 'end_behavior'
  | 'canceled_at'
  | 'completed_at'
  | 'released_at'
> &
  Partial<Pick<Stripe.SubscriptionSchedule, 'created'>> & {
    phases: Pick<
      Stripe.SubscriptionSchedule.Phase,
      'metadata' | 'start_date' | 'end_date'
    >[];
  };

export type ListSchedulePage = (
  params: Stripe.SubscriptionScheduleListParams
) => Promise<{ data: SearchableSchedule[]; has_more: boolean }>;

export type SearchProgress = {
  results: SearchResult[];
  scannedScheduleCount: number;
};

export type RetrieveCustomer = (
  customerId: string
) => Promise<{ email?: string | null; deleted?: boolean | void }>;

/** Enrich only the final retained rows, without failing a search on a customer lookup. */
export const enrichCustomerEmails = async (
  results: SearchResult[],
  retrieveCustomer: RetrieveCustomer,
  isCanceled: () => boolean = () => false
) => {
  const customerIds = Array.from(new Set(results.map((result) => result.customerId)));
  const emails = new Map<string, string | null>();
  let nextIndex = 0;
  const worker = async () => {
    while (!isCanceled()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= customerIds.length) return;
      const customerId = customerIds[index];
      try {
        const customer = await retrieveCustomer(customerId);
        if (!isCanceled() && customer.deleted !== true) {
          emails.set(customerId, customer.email ?? null);
        }
      } catch {
        // Keep the customer ID as the display fallback when enrichment fails.
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(CUSTOMER_LOOKUP_CONCURRENCY, customerIds.length) },
      worker
    )
  );
  return results.map((result) =>
    emails.has(result.customerId)
      ? { ...result, customerEmail: emails.get(result.customerId) ?? null }
      : result
  );
};

export type ScanOutcome = SearchProgress &
  (
    | { status: 'complete' | 'limit_reached' | 'paused' | 'canceled' }
    | { status: 'error'; error: string }
  );

export const getScheduleDates = (schedule: SearchableSchedule) => {
  const start = schedule.phases[0]?.start_date ?? schedule.current_phase?.start_date;
  const end = schedule.phases.at(-1)?.end_date;
  const ended =
    schedule.status === 'canceled'
      ? schedule.canceled_at
      : schedule.status === 'released'
        ? schedule.released_at
        : schedule.status === 'completed'
          ? schedule.completed_at
          : null;
  return {
    startDate: isTimestamp(start) ? start : null,
    endDate: isTimestamp(end) && (!isTimestamp(start) || end >= start) ? end : null,
    endedAt: isTimestamp(ended) ? ended : null,
    endBehavior:
      schedule.end_behavior === 'cancel' || schedule.end_behavior === 'release'
        ? schedule.end_behavior
        : ('other' as const),
  };
};

export const getFirstPhaseSearchMetadata = (
  schedule: Pick<SearchableSchedule, 'phases'>
) => ({
  accountNumber: schedule.phases[0]?.metadata?.AccountNumber ?? '',
  confirmationNumber: schedule.phases[0]?.metadata?.ConfirmationNumber ?? '',
});

/**
 * A half-open `created` window, newest first, with an optional cursor inside it.
 * Absent bounds are open. Disjoint windows never return the same schedule.
 */
export type ScanRange = { gte?: number; lt?: number; startingAfter?: string };

const toListParams = (range: ScanRange): Stripe.SubscriptionScheduleListParams => {
  const created = {
    ...(range.gte !== undefined ? { gte: range.gte } : {}),
    ...(range.lt !== undefined ? { lt: range.lt } : {}),
  };
  return {
    scheduled: true,
    limit: PAGE_SIZE,
    ...(range.gte !== undefined || range.lt !== undefined ? { created } : {}),
    ...(range.startingAfter ? { starting_after: range.startingAfter } : {}),
  };
};

/**
 * Splits the unscanned rest of a range into up to `pieces` windows that widen
 * geometrically into the past, starting at about one page's span. The newest
 * window keeps the cursor, which points at a schedule inside it.
 */
export const splitRange = (
  range: ScanRange & { lt: number },
  pageSpan: number,
  pieces: number
): ScanRange[] => {
  const floor = range.gte ?? 0;
  const windows: ScanRange[] = [];
  let upper = range.lt;
  let width = Math.max(1, Math.floor(pageSpan));
  while (windows.length < pieces - 1 && upper - width > floor) {
    windows.push({ gte: upper - width, lt: upper });
    upper -= width;
    width *= 2;
  }
  windows.push({ ...(range.gte !== undefined ? { gte: range.gte } : {}), lt: upper });
  if (range.startingAfter) windows[0].startingAfter = range.startingAfter;
  return windows;
};

const isRateLimited = (error: unknown) => {
  const details = error as { statusCode?: unknown; type?: unknown } | null;
  return details?.statusCode === 429 || details?.type === 'StripeRateLimitError';
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type PageOutcome = { range: ScanRange; rateLimited: number } & (
  { page: Awaited<ReturnType<ListSchedulePage>> } | { error: unknown }
);

export type ScannerStatus = 'complete' | 'stopped' | 'paused' | 'canceled' | 'error';

/**
 * Walks every future schedule in the given `created` range, newest first. The first
 * request covers the whole range; once a page shows more data, its remainder is split
 * so up to `concurrency` ranges load in parallel. `visit` sees each schedule once and
 * can return 'stop' to end the scan. Reusing runBatch continues a paused, failed, or
 * canceled scan from its unfinished ranges.
 */
export const createRangeScanner = ({
  listSchedules,
  visit,
  initialRange = {},
  maxPagesPerBatch = MAX_PAGES_PER_BATCH,
  concurrency = SCAN_CONCURRENCY,
  sleep = wait,
}: {
  listSchedules: ListSchedulePage;
  visit: (schedule: SearchableSchedule) => 'stop' | void;
  initialRange?: ScanRange;
  maxPagesPerBatch?: number;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
}) => {
  if (!Number.isInteger(maxPagesPerBatch) || maxPagesPerBatch < 1) {
    throw new Error('The page budget must be a positive integer.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('The scan concurrency must be a positive integer.');
  }
  const seen = new Set<string>();
  // Every range not yet exhausted, including ones a run currently has in flight.
  const unfinished: ScanRange[] = [{ ...initialRange }];
  let terminalStatus: 'complete' | 'stopped' | undefined;
  let generation = 0;
  let activeConcurrency = concurrency;

  const fetchPage = async (range: ScanRange): Promise<PageOutcome> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return {
          range,
          rateLimited: attempt,
          page: await listSchedules(toListParams(range)),
        };
      } catch (error) {
        if (!isRateLimited(error) || attempt >= MAX_RATE_LIMIT_RETRIES) {
          return { range, rateLimited: attempt, error };
        }
        await sleep(500 * 2 ** attempt + Math.random() * 250);
      }
    }
  };

  /** Applies one page. Returns a terminal outcome, if any. */
  const applyPage = (
    range: ScanRange,
    page: Awaited<ReturnType<ListSchedulePage>>,
    idleSlots: number
  ): 'stopped' | 'invalid_cursor' | undefined => {
    const last = page.data.at(-1);
    if (page.has_more && (!last?.id || last.id === range.startingAfter)) {
      return 'invalid_cursor';
    }
    unfinished.splice(unfinished.indexOf(range), 1);

    for (const schedule of page.data) {
      if (seen.has(schedule.id)) continue;
      seen.add(schedule.id);
      if (visit(schedule) === 'stop') return 'stopped';
    }

    if (!page.has_more || !last) return undefined;
    const newest = page.data[0]?.created;
    const remaining = { ...range, startingAfter: last.id };
    if (!isTimestamp(last.created) || (range.gte ?? 0) >= last.created) {
      // Nothing left to split by time; keep following the cursor.
      unfinished.push(remaining);
      return undefined;
    }
    const span = isTimestamp(newest) ? newest - last.created : 1;
    unfinished.push(
      ...splitRange({ ...remaining, lt: last.created + 1 }, span, idleSlots + 1)
    );
    return undefined;
  };

  const runBatch = async ({
    onPage = () => undefined,
    isCanceled = () => false,
  }: {
    onPage?: () => void;
    isCanceled?: () => boolean;
  } = {}): Promise<{ status: ScannerStatus; error?: string }> => {
    if (terminalStatus) return { status: terminalStatus };
    // A newer run supersedes this one. Its in-flight responses are then discarded
    // unapplied, so their ranges stay in `unfinished` for the newer run.
    generation += 1;
    const runGeneration = generation;
    const isObsolete = () => generation !== runGeneration || isCanceled();
    const inFlight = new Map<ScanRange, Promise<PageOutcome>>();
    let pagesRequested = 0;

    for (;;) {
      if (isObsolete()) return { status: 'canceled' };
      if (unfinished.length === 0) {
        terminalStatus = 'complete';
        return { status: terminalStatus };
      }
      for (const range of unfinished) {
        if (inFlight.size >= activeConcurrency || pagesRequested >= maxPagesPerBatch) {
          break;
        }
        if (inFlight.has(range)) continue;
        pagesRequested += 1;
        inFlight.set(range, fetchPage(range));
      }
      if (inFlight.size === 0) return { status: 'paused' };

      // The SDK cannot abort an in-flight request. Discard its response if obsolete.
      const outcome = await Promise.race(inFlight.values());
      if (isObsolete()) return { status: 'canceled' };
      inFlight.delete(outcome.range);
      if (outcome.rateLimited > 0) {
        activeConcurrency = Math.max(
          Math.min(MIN_SCAN_CONCURRENCY, concurrency),
          Math.floor(activeConcurrency / 2)
        );
      }
      if ('error' in outcome) {
        const { error } = outcome;
        return {
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to load schedules.',
        };
      }

      const waitingRanges = unfinished.filter(
        (range) => range !== outcome.range && !inFlight.has(range)
      ).length;
      const idleSlots = Math.max(0, activeConcurrency - inFlight.size - waitingRanges);
      const applied = applyPage(outcome.range, outcome.page, idleSlots);
      if (applied === 'invalid_cursor') {
        return {
          status: 'error',
          error: 'Unable to continue loading subscription schedules.',
        };
      }
      if (applied === 'stopped') {
        terminalStatus = 'stopped';
        return { status: terminalStatus };
      }
      if (unfinished.length > 0) onPage();
    }
  };

  return { runBatch };
};

export const toSearchResult = (schedule: SearchableSchedule): SearchResult => {
  const customer = schedule.customer;
  return {
    scheduleId: schedule.id,
    customerId: typeof customer === 'string' ? customer : customer.id,
    customerEmail: null,
    ...getFirstPhaseSearchMetadata(schedule),
    ...getScheduleDates(schedule),
    status: schedule.status,
  };
};

/**
 * A one-off search scan that holds only compact matches. It stops at the 51st match.
 * Reusing runBatch continues a paused/failed/canceled search with the same criteria.
 */
export const createScheduleSearch = ({
  accountNumber,
  confirmationNumber,
  ...scannerOptions
}: {
  listSchedules: ListSchedulePage;
  accountNumber: string;
  confirmationNumber: string;
  maxPagesPerBatch?: number;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
}) => {
  const accountPrefix = accountNumber.trim().toLowerCase();
  const confirmationPrefix = confirmationNumber.trim().toLowerCase();
  if (!accountPrefix && !confirmationPrefix) {
    throw new Error('Enter an account number or confirmation number.');
  }
  const matches: { created: number; result: SearchResult }[] = [];
  let scannedScheduleCount = 0;

  const scanner = createRangeScanner({
    ...scannerOptions,
    visit: (schedule) => {
      scannedScheduleCount += 1;
      // `scheduled: true` should only return not-started schedules. Keep the
      // local guard so an unexpected API response cannot surface a historical one.
      if (schedule.status !== 'not_started') return;
      const metadata = getFirstPhaseSearchMetadata(schedule);
      if (
        !metadata.accountNumber.toLowerCase().startsWith(accountPrefix) ||
        !metadata.confirmationNumber.toLowerCase().startsWith(confirmationPrefix)
      ) {
        return;
      }
      // A 51st matching schedule proves overflow; do not retain it.
      if (matches.length === MAX_RESULTS) return 'stop';
      matches.push({
        created: isTimestamp(schedule.created) ? schedule.created : 0,
        result: toSearchResult(schedule),
      });
    },
  });

  // Parallel ranges finish out of order; show matches newest first.
  const snapshot = (): SearchProgress => ({
    results: [...matches]
      .sort((left, right) => right.created - left.created)
      .map((match) => match.result),
    scannedScheduleCount,
  });

  const runBatch = async ({
    onProgress = () => undefined,
    isCanceled = () => false,
  }: {
    onProgress?: (progress: SearchProgress) => void;
    isCanceled?: () => boolean;
  } = {}): Promise<ScanOutcome> => {
    const outcome = await scanner.runBatch({
      onPage: () => onProgress(snapshot()),
      isCanceled,
    });
    if (outcome.status === 'error') {
      return {
        ...snapshot(),
        status: 'error',
        error: outcome.error ?? 'Unable to load schedules.',
      };
    }
    return {
      ...snapshot(),
      status: outcome.status === 'stopped' ? 'limit_reached' : outcome.status,
    };
  };

  return { runBatch };
};
