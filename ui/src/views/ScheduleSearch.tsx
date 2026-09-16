import { useEffect, useMemo, useRef, useState } from 'react';
import Stripe from 'stripe';

import {
  Banner,
  Box,
  Button,
  ContextView,
  Icon,
  Link,
  Spinner,
  TextField,
  Tooltip,
} from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import { useStorage } from '@stripe/ui-extension-sdk/data';
import { createHttpClient, STRIPE_API_KEY } from '@stripe/ui-extension-sdk/http_client';

import BrandIcon from './brand_icon.svg';
import {
  parseCachedSearch,
  SEARCH_STORAGE_KEY,
  type CachedSearch,
} from './scheduleSearchData';
import ScheduleSearchResults from './ScheduleSearchResults';
import {
  createScheduleSearch,
  getScheduleCreatedCutoff,
  type ScanOutcome,
  type SearchProgress,
} from './scheduleSearchEngine';

const stripe = new Stripe(STRIPE_API_KEY, {
  apiVersion: '2023-08-16',
  httpClient: createHttpClient(),
});

type SearchState = SearchProgress & {
  status: 'idle' | 'loading' | ScanOutcome['status'];
  error?: string;
};

const emptySearch: SearchState = {
  results: [],
  scannedScheduleCount: 0,
  status: 'idle',
};

const ScheduleSearch = ({ environment }: ExtensionContextValue) => {
  const [storedSearch, setStoredSearch] = useStorage(SEARCH_STORAGE_KEY);
  const cachedSearch = useMemo(() => parseCachedSearch(storedSearch), [storedSearch]);
  const [accountNumber, setAccountNumber] = useState(cachedSearch?.accountNumber ?? '');
  const [confirmationNumber, setConfirmationNumber] = useState(
    cachedSearch?.confirmationNumber ?? ''
  );
  const [search, setSearch] = useState<SearchState>(() =>
    cachedSearch?.searched
      ? {
          results: cachedSearch.results,
          scannedScheduleCount: cachedSearch.scannedScheduleCount,
          status: cachedSearch.stoppedEarly ? 'limit_reached' : 'complete',
        }
      : emptySearch
  );
  const session = useRef<{
    scanner: ReturnType<typeof createScheduleSearch>;
    accountNumber: string;
    confirmationNumber: string;
  } | null>(null);
  const currentRun = useRef(0);
  const running = useRef(false);

  useEffect(
    () => () => {
      currentRun.current += 1;
    },
    []
  );

  const { results, scannedScheduleCount } = search;
  const loading = search.status === 'loading';
  const canResume = ['paused', 'canceled', 'error'].includes(search.status);

  const trimmedAccountNumber = accountNumber.trim();
  const trimmedConfirmationNumber = confirmationNumber.trim();
  const hasAccountNumber = trimmedAccountNumber.length > 0;
  const hasConfirmationNumber = trimmedConfirmationNumber.length > 0;
  const canSearch = !loading && !canResume && (hasAccountNumber || hasConfirmationNumber);

  const runSearchBatch = async () => {
    const activeSession = session.current;
    if (!activeSession || running.current) return;
    running.current = true;
    const runId = ++currentRun.current;
    setSearch((previous) => ({ ...previous, status: 'loading', error: undefined }));
    const outcome = await activeSession.scanner.runBatch({
      isCanceled: () => currentRun.current !== runId,
      onProgress: (progress) => {
        if (currentRun.current === runId) setSearch({ ...progress, status: 'loading' });
      },
    });
    if (currentRun.current !== runId) return;
    running.current = false;
    setSearch(outcome);

    // Only settled searches are cached; partial scans must not look complete on remount.
    if (outcome.status === 'complete' || outcome.status === 'limit_reached') {
      const cachedSearchToStore: CachedSearch = {
        accountNumber: activeSession.accountNumber,
        confirmationNumber: activeSession.confirmationNumber,
        scannedScheduleCount: outcome.scannedScheduleCount,
        results: outcome.results,
        searched: true,
        stoppedEarly: outcome.status === 'limit_reached',
      };
      setStoredSearch(JSON.stringify(cachedSearchToStore));
    }
  };

  const searchSchedules = () => {
    if (!canSearch || running.current) return;
    session.current = {
      scanner: createScheduleSearch({
        listSchedules: (params) => stripe.subscriptionSchedules.list(params),
        accountNumber: trimmedAccountNumber,
        confirmationNumber: trimmedConfirmationNumber,
        createdAfter: getScheduleCreatedCutoff(),
      }),
      accountNumber: trimmedAccountNumber,
      confirmationNumber: trimmedConfirmationNumber,
    };
    setStoredSearch('');
    setSearch(emptySearch);
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
    setAccountNumber('');
    setConfirmationNumber('');
    setSearch(emptySearch);
    setStoredSearch('');
  };

  return (
    <ContextView title="" brandColor="#F6F8FA" brandIcon={BrandIcon}>
      <Box css={{ stack: 'y', rowGap: 'large' }}>
        {results.length === 0 ? (
          <Box css={{ stack: 'y', rowGap: 'medium' }}>
            <Box css={{ stack: 'x', columnGap: 'xsmall', alignY: 'center' }}>
              <Box css={{ font: 'bodyEmphasized' }}>Subscription schedule search</Box>
              <Tooltip
                type="description"
                placement="top"
                trigger={<Icon name="info" size="small" css={{ fill: 'secondary' }} />}
              >
                Search schedules created in the last 31 days by account number,
                confirmation number, or both. Values must begin with the entered
                characters.
              </Tooltip>
            </Box>
            <TextField
              label="Account number"
              placeholder="111056"
              type="search"
              value={accountNumber}
              disabled={loading || canResume}
              onChange={(event) => setAccountNumber(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void searchSchedules();
              }}
            />
            <TextField
              label="Confirmation number"
              placeholder="SAX"
              type="search"
              value={confirmationNumber}
              disabled={loading || canResume}
              onChange={(event) => setConfirmationNumber(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void searchSchedules();
              }}
            />
            <Button
              type="primary"
              disabled={!canSearch}
              pending={loading}
              onPress={() => void searchSchedules()}
            >
              Search
            </Button>
          </Box>
        ) : (
          <Box css={{ stack: 'y', rowGap: 'xxsmall' }}>
            <Box css={{ stack: 'x', distribute: 'space-between', alignY: 'center' }}>
              <Box css={{ font: 'bodyEmphasized' }}>Search results</Box>
              <Link onPress={startNewSearch}>Start a new search</Link>
            </Box>
            <Box css={{ color: 'secondary', font: 'caption', textAlign: 'right' }}>
              {results.length} result{results.length === 1 ? '' : 's'}
            </Box>
          </Box>
        )}

        {loading && (
          <Box css={{ stack: 'x', columnGap: 'small', alignY: 'center' }}>
            <Spinner size="small" />
            <Box>Searching schedules. Checked {scannedScheduleCount} so far.</Box>
            <Button onPress={cancelSearch}>Cancel</Button>
          </Box>
        )}

        {search.status === 'error' && (
          <Banner type="critical" title="Search incomplete" description={search.error} />
        )}

        {(search.status === 'paused' || search.status === 'canceled') && (
          <Banner
            type="caution"
            title={search.status === 'paused' ? 'Search paused' : 'Search canceled'}
            description={`Checked ${scannedScheduleCount} schedules. Search results are incomplete.`}
          />
        )}

        {canResume && (
          <Box css={{ stack: 'x', columnGap: 'small' }}>
            <Button onPress={() => void runSearchBatch()}>
              {search.status === 'error'
                ? 'Retry remaining schedules'
                : 'Continue searching'}
            </Button>
            {results.length === 0 && (
              <Link onPress={startNewSearch}>Start a new search</Link>
            )}
          </Box>
        )}

        {search.status === 'complete' && results.length === 0 && (
          <Banner
            type="caution"
            title="No matching schedules"
            description={`Scanned ${scannedScheduleCount} subscription schedule${
              scannedScheduleCount === 1 ? '' : 's'
            }.`}
          />
        )}

        {search.status === 'limit_reached' && (
          <Banner
            type="caution"
            title="More than 100 matches"
            description="Showing the first 100. Refine your search to find the schedule you need."
          />
        )}

        {results.length > 0 && (
          <ScheduleSearchResults mode={environment.mode} results={results} />
        )}
      </Box>
    </ContextView>
  );
};

export default ScheduleSearch;
