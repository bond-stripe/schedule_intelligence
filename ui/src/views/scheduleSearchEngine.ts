import type Stripe from 'stripe';

import { isTimestamp, MAX_RESULTS, type SearchResult } from './scheduleSearchData';
import type { CreatedRange } from './scheduleSearchDates';

export const PAGE_SIZE = 100;
export const MAX_PAGES_PER_BATCH = 20;

// Only the fields the scanner reads; a Stripe schedule is assignable to this type.
export type SearchableSchedule = Pick<
  Stripe.SubscriptionSchedule,
  | 'id'
  | 'customer'
  | 'created'
  | 'current_phase'
  | 'status'
  | 'end_behavior'
  | 'canceled_at'
  | 'completed_at'
  | 'released_at'
> & {
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
 * A search session holds only compact matches and its next page cursor. Reusing
 * runBatch continues a paused/failed search with the same criteria and cutoff.
 */
export const createScheduleSearch = ({
  listSchedules,
  accountNumber,
  confirmationNumber,
  created,
  maxPagesPerBatch = MAX_PAGES_PER_BATCH,
}: {
  listSchedules: ListSchedulePage;
  accountNumber: string;
  confirmationNumber: string;
  created: CreatedRange;
  maxPagesPerBatch?: number;
}) => {
  const accountPrefix = accountNumber.trim().toLowerCase();
  const confirmationPrefix = confirmationNumber.trim().toLowerCase();
  if (!accountPrefix && !confirmationPrefix) {
    throw new Error('Enter an account number or confirmation number.');
  }
  if (!Number.isInteger(maxPagesPerBatch) || maxPagesPerBatch < 1) {
    throw new Error('The page budget must be a positive integer.');
  }
  if (
    !isTimestamp(created.gte) ||
    !isTimestamp(created.lt) ||
    created.gte >= created.lt
  ) {
    throw new Error('Choose a valid creation date range.');
  }
  // Snapshot the bounds so editing criteria cannot change a resumed search.
  const createdRange = { ...created };

  const results: SearchResult[] = [];
  let scannedScheduleCount = 0;
  let startingAfter: string | undefined;
  let terminalStatus: 'complete' | 'limit_reached' | undefined;

  const snapshot = (): SearchProgress => ({
    results: [...results],
    scannedScheduleCount,
  });

  const runBatch = async ({
    onProgress = () => undefined,
    isCanceled = () => false,
  }: {
    onProgress?: (progress: SearchProgress) => void;
    isCanceled?: () => boolean;
  } = {}): Promise<ScanOutcome> => {
    if (terminalStatus) return { ...snapshot(), status: terminalStatus };
    const cursors = new Set(startingAfter ? [startingAfter] : []);

    for (let pageNumber = 0; pageNumber < maxPagesPerBatch; pageNumber += 1) {
      if (isCanceled()) return { ...snapshot(), status: 'canceled' };

      let page: Awaited<ReturnType<ListSchedulePage>>;
      try {
        page = await listSchedules({
          created: { ...createdRange },
          expand: ['data.customer'],
          limit: PAGE_SIZE,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
      } catch (error) {
        return {
          ...snapshot(),
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to load schedules.',
        };
      }

      // The SDK cannot abort an in-flight request. Discard its response if obsolete.
      if (isCanceled()) return { ...snapshot(), status: 'canceled' };
      const nextCursor = page.data.at(-1)?.id;
      if (page.has_more && (!nextCursor || cursors.has(nextCursor))) {
        return {
          ...snapshot(),
          status: 'error',
          error: 'Unable to continue loading subscription schedules.',
        };
      }

      for (const schedule of page.data) {
        scannedScheduleCount += 1;
        const metadata = getFirstPhaseSearchMetadata(schedule);
        if (
          !metadata.accountNumber.toLowerCase().startsWith(accountPrefix) ||
          !metadata.confirmationNumber.toLowerCase().startsWith(confirmationPrefix)
        ) {
          continue;
        }

        // A 101st matching schedule proves overflow; do not retain or enrich it.
        if (results.length === MAX_RESULTS) {
          terminalStatus = 'limit_reached';
          return { ...snapshot(), status: terminalStatus };
        }

        const customer = schedule.customer;
        results.push({
          scheduleId: schedule.id,
          customerId: typeof customer === 'string' ? customer : customer.id,
          customerEmail:
            typeof customer !== 'string' && 'email' in customer ? customer.email : null,
          ...metadata,
          ...getScheduleDates(schedule),
          status: schedule.status,
        });
      }

      if (!page.has_more) {
        terminalStatus = 'complete';
        return { ...snapshot(), status: terminalStatus };
      }
      startingAfter = nextCursor;
      if (nextCursor) cursors.add(nextCursor);
      onProgress(snapshot());
    }

    return { ...snapshot(), status: 'paused' };
  };

  return { runBatch };
};
