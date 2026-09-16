import type Stripe from 'stripe';

import type { SearchResult } from './scheduleSearchData';

export const PAGE_SIZE = 100;
export const MAX_RESULTS = 100;
export const MAX_PAGES_PER_BATCH = 20;
const SEARCH_WINDOW_SECONDS = 31 * 24 * 60 * 60;

// Only the fields the scanner reads; a Stripe schedule is assignable to this type.
export type SearchableSchedule = Pick<
  Stripe.SubscriptionSchedule,
  'id' | 'customer' | 'created' | 'current_phase' | 'status'
> & {
  phases: Pick<Stripe.SubscriptionSchedule.Phase, 'metadata' | 'start_date'>[];
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

export const getScheduleCreatedCutoff = (nowMilliseconds = Date.now()) =>
  Math.floor(nowMilliseconds / 1000) - SEARCH_WINDOW_SECONDS;

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
  createdAfter,
  maxPagesPerBatch = MAX_PAGES_PER_BATCH,
}: {
  listSchedules: ListSchedulePage;
  accountNumber: string;
  confirmationNumber: string;
  createdAfter: number;
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
          created: { gte: createdAfter },
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
          startDate:
            schedule.phases[0]?.start_date ??
            schedule.current_phase?.start_date ??
            schedule.created,
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
