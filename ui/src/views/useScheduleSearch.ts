import { useEffect, useMemo, useRef, useState } from 'react';
import Stripe from 'stripe';
import { useStorage } from '@stripe/ui-extension-sdk/data';
import { createHttpClient, STRIPE_API_KEY } from '@stripe/ui-extension-sdk/http_client';
import {
  createScheduleSearch,
  type ScanOutcome,
  type SearchProgress,
} from './scheduleSearchEngine';
import {
  getSearchStorageKey,
  parseCachedSearch,
  type CachedSearch,
  type SearchScope,
} from './scheduleSearchData';
import {
  criteriaEqual,
  getCreatedRange,
  getDefaultSearchCriteria,
  normalizeCriteria,
  type SearchCriteria,
} from './scheduleSearchDates';

const stripe = new Stripe(STRIPE_API_KEY, {
  apiVersion: '2023-08-16',
  httpClient: createHttpClient(),
});

type SearchState = SearchProgress & {
  status: 'idle' | 'loading' | ScanOutcome['status'];
  submitted: SearchCriteria | null;
  searchedAt: number | null;
  error?: string;
};
const emptySearch: SearchState = {
  results: [],
  scannedScheduleCount: 0,
  status: 'idle',
  submitted: null,
  searchedAt: null,
};

export const useScheduleSearch = ({ accountId, mode }: SearchScope) => {
  const [storedSearch, setStoredSearch] = useStorage(
    getSearchStorageKey({ accountId, mode })
  );
  const cached = useMemo(
    () => parseCachedSearch(storedSearch, { accountId, mode }),
    [storedSearch, accountId, mode]
  );
  // Hydrate only on mount. The owning view is keyed by account/mode, so switching
  // scope remounts it without a storage restoration effect or a stale scanner.
  const [draft, setDraft] = useState<SearchCriteria>(
    () => cached?.criteria ?? getDefaultSearchCriteria()
  );
  const [search, setSearch] = useState<SearchState>(() =>
    cached
      ? {
          results: cached.results,
          scannedScheduleCount: cached.scannedScheduleCount,
          status: cached.status,
          submitted: cached.criteria,
          searchedAt: cached.searchedAt,
        }
      : emptySearch
  );
  const [cacheWarning, setCacheWarning] = useState<string | null>(null);
  const session = useRef<{
    scanner: ReturnType<typeof createScheduleSearch>;
    criteria: SearchCriteria;
  } | null>(null);
  const currentRun = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      currentRun.current += 1;
    },
    []
  );

  const loading = search.status === 'loading';
  const dateValidation = getCreatedRange(draft.createdAfter, draft.createdBefore);
  const canSearch =
    !loading &&
    dateValidation.range !== null &&
    Boolean(draft.accountNumber.trim() || draft.confirmationNumber.trim());
  const criteriaChanged =
    search.submitted !== null && !criteriaEqual(draft, search.submitted);
  const canResume =
    !criteriaChanged && ['paused', 'canceled', 'error'].includes(search.status);
  const saveCache = (value: string) => {
    try {
      setStoredSearch(value);
      setCacheWarning(null);
    } catch {
      setCacheWarning('Search results could not be saved for navigation.');
    }
  };

  const runSearchBatch = async () => {
    const active = session.current;
    if (!active || running.current) return;
    running.current = true;
    const runId = ++currentRun.current;
    setSearch((previous) => ({ ...previous, status: 'loading', error: undefined }));
    let outcome: ScanOutcome;
    try {
      outcome = await active.scanner.runBatch({
        isCanceled: () => currentRun.current !== runId,
        onProgress: (progress) => {
          if (currentRun.current === runId)
            setSearch({
              ...progress,
              status: 'loading',
              submitted: active.criteria,
              searchedAt: null,
            });
        },
      });
    } catch (error) {
      if (currentRun.current === runId) {
        setSearch((previous) => ({
          ...previous,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to search schedules.',
        }));
      }
      return;
    } finally {
      if (currentRun.current === runId) running.current = false;
    }
    if (currentRun.current !== runId) return;
    const settled = outcome.status === 'complete' || outcome.status === 'limit_reached';
    const searchedAt = Math.floor(Date.now() / 1000);
    setSearch({
      ...outcome,
      submitted: active.criteria,
      searchedAt: settled ? searchedAt : null,
    });
    if (outcome.status === 'complete' || outcome.status === 'limit_reached') {
      const cache: CachedSearch = {
        scope: { accountId, mode },
        criteria: active.criteria,
        searchedAt,
        results: outcome.results,
        scannedScheduleCount: outcome.scannedScheduleCount,
        status: outcome.status,
      };
      saveCache(JSON.stringify(cache));
    }
  };

  const searchSchedules = () => {
    if (!canSearch || running.current || !dateValidation.range) return;
    const criteria = normalizeCriteria(draft);
    session.current = {
      scanner: createScheduleSearch({
        listSchedules: (params) => stripe.subscriptionSchedules.list(params),
        accountNumber: criteria.accountNumber,
        confirmationNumber: criteria.confirmationNumber,
        created: dateValidation.range,
      }),
      criteria,
    };
    saveCache('');
    setSearch({ ...emptySearch, submitted: criteria });
    void runSearchBatch();
  };
  const cancelSearch = () => {
    currentRun.current += 1;
    running.current = false;
    setSearch((previous) => ({ ...previous, status: 'canceled' }));
  };
  const startNewSearch = () => {
    currentRun.current += 1;
    running.current = false;
    session.current = null;
    setDraft(getDefaultSearchCriteria());
    setSearch(emptySearch);
    saveCache('');
  };
  const updateDraft = (changes: Partial<SearchCriteria>) =>
    setDraft((previous) => ({ ...previous, ...changes }));
  return {
    draft,
    updateDraft,
    search,
    loading,
    canSearch,
    canResume,
    criteriaChanged,
    dateValidation,
    cacheWarning,
    searchSchedules,
    cancelSearch,
    startNewSearch,
    runSearchBatch,
  };
};
