import {
  createRangeScanner,
  toSearchResult,
  type ListSchedulePage,
  type ScanOutcome,
  type SearchableSchedule,
  type SearchProgress,
} from './scheduleSearchEngine';
import {
  isTimestamp,
  MAX_RESULTS,
  type SearchResult,
  type SearchScope,
} from './scheduleSearchData';
import type { SearchCriteria } from './scheduleSearchDates';

/**
 * An in-memory index of every future schedule in one account and mode, so repeat
 * searches in a session avoid a full scan. Guardrails:
 * - Memory only. Never put it in `useStorage` (multi-MB strings synced across views).
 * - One index at a time, keyed by scope; switching account or mode discards the old one.
 * - Built only when a user types or searches, never on mount.
 * - No timers: age is checked when a search runs, then rebuilt in the background.
 * - Compact entries with identifiers lowercased once.
 * - Above MAX_INDEXED_SCHEDULES the index is dropped and searches scan instead.
 */
export const INDEX_MAX_AGE_SECONDS = 15 * 60;
export const MAX_INDEXED_SCHEDULES = 100_000;
export const VERIFY_CONCURRENCY = 5;

export type IndexedSchedule = Omit<SearchResult, 'customerEmail'> & {
  created: number;
  accountKey: string;
  confirmationKey: string;
};

export type RetrieveSchedule = (scheduleId: string) => Promise<SearchableSchedule>;

type IndexDependencies = {
  listSchedules: ListSchedulePage;
  retrieveSchedule: RetrieveSchedule;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  maxIndexedSchedules?: number;
};

export type BuildOutcome =
  | { status: 'ready' | 'paused' | 'canceled' | 'too_large' }
  | { status: 'error'; error: string };

// Reuse the original string when lowercasing does not change it.
const toKey = (value: string) => {
  const lower = value.toLowerCase();
  return lower === value ? value : lower;
};

export const toIndexedSchedule = (
  schedule: SearchableSchedule
): IndexedSchedule | null => {
  // `scheduled: true` should only return not-started schedules; keep the guard.
  if (schedule.status !== 'not_started') return null;
  const result = toSearchResult(schedule);
  return {
    scheduleId: result.scheduleId,
    customerId: result.customerId,
    accountNumber: result.accountNumber,
    confirmationNumber: result.confirmationNumber,
    startDate: result.startDate,
    endDate: result.endDate,
    endedAt: result.endedAt,
    endBehavior: result.endBehavior,
    status: result.status,
    created: isTimestamp(schedule.created) ? schedule.created : 0,
    accountKey: toKey(result.accountNumber),
    confirmationKey: toKey(result.confirmationNumber),
  };
};

const toPrefixes = (criteria: SearchCriteria) => ({
  account: criteria.accountNumber.trim().toLowerCase(),
  confirmation: criteria.confirmationNumber.trim().toLowerCase(),
});

const matchesPrefixes = (
  entry: IndexedSchedule,
  prefixes: ReturnType<typeof toPrefixes>
) =>
  entry.accountKey.startsWith(prefixes.account) &&
  entry.confirmationKey.startsWith(prefixes.confirmation);

export const toResult = (entry: IndexedSchedule): SearchResult => ({
  scheduleId: entry.scheduleId,
  customerId: entry.customerId,
  customerEmail: null,
  accountNumber: entry.accountNumber,
  confirmationNumber: entry.confirmationNumber,
  startDate: entry.startDate,
  endDate: entry.endDate,
  endedAt: entry.endedAt,
  endBehavior: entry.endBehavior,
  status: entry.status,
});

export const createScheduleIndex = ({
  listSchedules,
  retrieveSchedule,
  now = () => Math.floor(Date.now() / 1000),
  sleep,
  concurrency,
  maxIndexedSchedules = MAX_INDEXED_SCHEDULES,
}: IndexDependencies) => {
  // The usable index; null until the first full build completes.
  let entries: Map<string, IndexedSchedule> | null = null;
  let builtAt = 0;
  let tooLarge = false;
  let disposed = false;
  // A first build or background rebuild. It fills its own map and swaps in on success.
  let build: {
    entries: Map<string, IndexedSchedule>;
    startedAt: number;
    scanner: ReturnType<typeof createRangeScanner>;
  } | null = null;
  let buildRun: Promise<BuildOutcome> | null = null;
  let buildGeneration = 0;
  const listeners = new Set<() => void>();

  const scannerOptions = { listSchedules, sleep, concurrency };

  const startBuild = () => {
    const target = new Map<string, IndexedSchedule>();
    build = {
      entries: target,
      startedAt: now(),
      scanner: createRangeScanner({
        ...scannerOptions,
        visit: (schedule) => {
          const entry = toIndexedSchedule(schedule);
          if (entry) target.set(entry.scheduleId, entry);
          if (target.size > maxIndexedSchedules) return 'stop';
        },
      }),
    };
  };

  const dropIndex = () => {
    tooLarge = true;
    entries = null;
    build = null;
  };

  /** Runs (or joins) the current build until it settles or is stopped. */
  const runBuild = (): Promise<BuildOutcome> => {
    if (tooLarge) return Promise.resolve({ status: 'too_large' });
    if (buildRun) return buildRun;
    if (!build) startBuild();
    const current = build;
    if (!current) return Promise.resolve({ status: 'canceled' });
    const runGeneration = buildGeneration;
    const isStopped = () => disposed || runGeneration !== buildGeneration;
    const run = current.scanner
      .runBatch({
        onPage: () => listeners.forEach((listener) => listener()),
        isCanceled: isStopped,
      })
      .then((outcome): BuildOutcome => {
        if (isStopped() || build !== current) return { status: 'canceled' };
        if (outcome.status === 'complete') {
          entries = current.entries;
          builtAt = current.startedAt;
          build = null;
          return { status: 'ready' };
        }
        if (outcome.status === 'stopped') {
          dropIndex();
          return { status: 'too_large' };
        }
        if (outcome.status === 'error') {
          return { status: 'error', error: outcome.error ?? 'Unable to load schedules.' };
        }
        return { status: outcome.status };
      })
      .catch((error: unknown): BuildOutcome => ({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to load schedules.',
      }))
      .finally(() => {
        if (buildRun === run) buildRun = null;
        listeners.forEach((listener) => listener());
      });
    buildRun = run;
    return run;
  };

  /** Searchable entries: the usable index, or the first build's partial map. */
  const searchable = () => entries ?? build?.entries ?? new Map();

  const match = (criteria: SearchCriteria): IndexedSchedule[] => {
    const prefixes = toPrefixes(criteria);
    const found: IndexedSchedule[] = [];
    searchable().forEach((entry) => {
      if (matchesPrefixes(entry, prefixes)) found.push(entry);
    });
    return found.sort((left, right) => right.created - left.created);
  };

  /**
   * Adds schedules created since the newest indexed one. Stripe's status, not the
   * local clock, decides what has started: displayed matches are re-read by `verify`,
   * and the age-based rebuild clears the rest.
   */
  const refresh = async (isCanceled: () => boolean): Promise<BuildOutcome> => {
    const current = entries;
    if (!current) return { status: 'canceled' };
    let newest = 0;
    current.forEach((entry) => {
      newest = Math.max(newest, entry.created);
    });
    const delta = createRangeScanner({
      ...scannerOptions,
      initialRange: { gte: newest },
      visit: (schedule) => {
        const entry = toIndexedSchedule(schedule);
        if (entry) current.set(entry.scheduleId, entry);
        if (current.size > maxIndexedSchedules) return 'stop';
      },
    });
    const outcome = await delta.runBatch({ isCanceled: () => disposed || isCanceled() });
    if (outcome.status === 'stopped') {
      dropIndex();
      return { status: 'too_large' };
    }
    if (outcome.status === 'error') {
      return { status: 'error', error: outcome.error ?? 'Unable to load schedules.' };
    }
    if (outcome.status !== 'complete') return { status: outcome.status };
    return { status: 'ready' };
  };

  /** Re-reads one schedule. Returns the fresh entry if it still matches. */
  const verify = async (
    entry: IndexedSchedule,
    criteria: SearchCriteria
  ): Promise<IndexedSchedule | null> => {
    let fresh: IndexedSchedule | null;
    try {
      fresh = toIndexedSchedule(await retrieveSchedule(entry.scheduleId));
    } catch {
      // Keep the indexed row if the check itself fails; it was valid when indexed.
      return entry;
    }
    if (!fresh) {
      entries?.delete(entry.scheduleId);
      return null;
    }
    entries?.set(fresh.scheduleId, fresh);
    return matchesPrefixes(fresh, toPrefixes(criteria)) ? fresh : null;
  };

  return {
    hasUsableIndex: () => entries !== null,
    isTooLarge: () => tooLarge,
    isStale: () => entries !== null && now() - builtAt > INDEX_MAX_AGE_SECONDS,
    isBuilding: () => buildRun !== null,
    /** Count of future schedules checked so far (partial during the first build). */
    size: () => searchable().size,
    /** Starts or resumes a build without waiting, e.g. when a user starts typing. */
    prepare: () => {
      if (!disposed && !tooLarge && entries === null) void runBuild();
    },
    /** Starts a background rebuild; searches keep using the current index meanwhile. */
    rebuildInBackground: () => {
      if (disposed || tooLarge || buildRun) return;
      startBuild();
      void runBuild();
    },
    /**
     * Waits for the first build. `onPage` runs after each page; returning true stops
     * waiting (for example once a search knows it has more than 50 matches) while the
     * build continues.
     */
    waitForBuild: (onPage: () => boolean) =>
      new Promise<BuildOutcome | { status: 'waiting_stopped' }>((resolve) => {
        if (entries !== null) {
          resolve({ status: 'ready' });
          return;
        }
        let settled = false;
        const listener = () => {
          if (!settled && buildRun !== null && onPage()) {
            settled = true;
            listeners.delete(listener);
            resolve({ status: 'waiting_stopped' });
          }
        };
        listeners.add(listener);
        void runBuild().then((outcome) => {
          listeners.delete(listener);
          if (!settled) resolve(outcome);
        });
      }),
    /** Stops any build in progress. Its unfinished ranges resume on the next build. */
    stopBuild: () => {
      buildGeneration += 1;
      buildRun = null;
    },
    dispose: () => {
      disposed = true;
      buildGeneration += 1;
      buildRun = null;
      entries = null;
      build = null;
      listeners.clear();
    },
    match,
    refresh,
    verify,
  };
};

export type ScheduleIndex = ReturnType<typeof createScheduleIndex>;

let active: { key: string; index: ScheduleIndex } | null = null;
const scopeKey = (scope: SearchScope) => scope.accountId + ':' + scope.mode;

/** Returns the index for this scope, discarding any index for another scope. */
export const getScheduleIndex = (
  scope: SearchScope,
  createDependencies: () => IndexDependencies
): ScheduleIndex => {
  const key = scopeKey(scope);
  if (active?.key !== key) {
    active?.index.dispose();
    active = { key, index: createScheduleIndex(createDependencies()) };
  }
  return active.index;
};

/** The index for this scope if one exists, without creating it. */
export const peekScheduleIndex = (scope: SearchScope) =>
  active?.key === scopeKey(scope) ? active.index : null;

export const discardScheduleIndex = () => {
  active?.index.dispose();
  active = null;
};

export type IndexedSearchOutcome = ScanOutcome | { status: 'too_large' };

const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index]);
      }
    })
  );
  return results;
};

/**
 * Answers a search from the index. A search that waits for the first build uses
 * fresh data as-is. A search on an existing index first loads new schedules, then
 * re-reads each displayed match so canceled, started, or edited schedules drop out.
 */
export const runIndexedSearch = async (
  index: ScheduleIndex,
  criteria: SearchCriteria,
  {
    onProgress = () => undefined,
    isCanceled = () => false,
  }: {
    onProgress?: (progress: SearchProgress) => void;
    isCanceled?: () => boolean;
  } = {}
): Promise<IndexedSearchOutcome> => {
  const partial = (): SearchProgress => ({
    results: index.match(criteria).slice(0, MAX_RESULTS).map(toResult),
    scannedScheduleCount: index.size(),
  });
  const settle = (found: IndexedSchedule[]): ScanOutcome => ({
    results: found.slice(0, MAX_RESULTS).map(toResult),
    scannedScheduleCount: index.size(),
    status: found.length > MAX_RESULTS ? 'limit_reached' : 'complete',
  });

  if (index.isTooLarge()) return { status: 'too_large' };
  if (!index.hasUsableIndex()) {
    const built = await index.waitForBuild(() => {
      if (isCanceled()) return true;
      const found = index.match(criteria);
      // A 51st match proves overflow; the build continues for later searches.
      if (found.length > MAX_RESULTS) return true;
      onProgress({
        results: found.map(toResult),
        scannedScheduleCount: index.size(),
      });
      return false;
    });
    if (isCanceled()) return { ...partial(), status: 'canceled' };
    if (built.status === 'waiting_stopped') return settle(index.match(criteria));
    if (built.status === 'too_large') return { status: 'too_large' };
    if (built.status === 'error') return { ...partial(), ...built };
    if (built.status !== 'ready') return { ...partial(), status: built.status };
    return settle(index.match(criteria));
  }

  if (index.isStale()) index.rebuildInBackground();
  const refreshed = await index.refresh(isCanceled);
  if (isCanceled())
    return { results: [], scannedScheduleCount: index.size(), status: 'canceled' };
  if (refreshed.status === 'too_large') return { status: 'too_large' };
  if (refreshed.status === 'error') {
    return { results: [], scannedScheduleCount: index.size(), ...refreshed };
  }
  if (refreshed.status !== 'ready') {
    return { results: [], scannedScheduleCount: index.size(), status: refreshed.status };
  }

  const candidates = index.match(criteria);
  const confirmed: IndexedSchedule[] = [];
  let checked = 0;
  while (confirmed.length < MAX_RESULTS && checked < candidates.length) {
    const batch = candidates.slice(checked, checked + MAX_RESULTS - confirmed.length);
    checked += batch.length;
    const fresh = await runWithConcurrency(batch, VERIFY_CONCURRENCY, (entry) =>
      index.verify(entry, criteria)
    );
    if (isCanceled()) {
      return { results: [], scannedScheduleCount: index.size(), status: 'canceled' };
    }
    confirmed.push(...fresh.filter((entry): entry is IndexedSchedule => entry !== null));
    onProgress({
      results: confirmed.map(toResult),
      scannedScheduleCount: index.size(),
    });
  }
  // Unchecked candidates beyond 50 confirmed rows mean overflow, as with a scan.
  return {
    results: confirmed.map(toResult),
    scannedScheduleCount: index.size(),
    status:
      confirmed.length === MAX_RESULTS && checked < candidates.length
        ? 'limit_reached'
        : 'complete',
  };
};
