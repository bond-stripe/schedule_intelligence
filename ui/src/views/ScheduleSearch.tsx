import { useMemo, useState } from 'react';
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
  type SearchResult,
} from './scheduleSearchData';
import ScheduleSearchResults from './ScheduleSearchResults';

const PAGE_SIZE = 100;
const MAX_RESULTS = 100;
const SEARCH_WINDOW_SECONDS = 31 * 24 * 60 * 60;
const ACCOUNT_NUMBER_METADATA_KEY = 'AccountNumber';
const CONFIRMATION_NUMBER_METADATA_KEY = 'ConfirmationNumber';

const stripe = new Stripe(STRIPE_API_KEY, {
  apiVersion: '2023-08-16',
  httpClient: createHttpClient(),
});

const getResourceId = <T extends { id: string }>(resource: string | T | null) =>
  typeof resource === 'string' ? resource : (resource?.id ?? '');

const getCustomerEmail = (customer: unknown) =>
  typeof customer === 'object' &&
  customer !== null &&
  'email' in customer &&
  typeof customer.email === 'string'
    ? customer.email
    : null;

const getScheduleStartDate = (schedule: Stripe.SubscriptionSchedule) =>
  schedule.phases[0]?.start_date ??
  schedule.current_phase?.start_date ??
  schedule.created;

export const matchesPrefix = (value: string, searchTerm: string) =>
  value.toLowerCase().startsWith(searchTerm.trim().toLowerCase());

export const getScheduleCreatedCutoff = (nowMilliseconds = Date.now()) =>
  Math.floor(nowMilliseconds / 1000) - SEARCH_WINDOW_SECONDS;

export const getFirstPhaseSearchMetadata = (
  schedule: Pick<Stripe.SubscriptionSchedule, 'phases'>
) => ({
  accountNumber:
    schedule.phases[0]?.metadata?.[ACCOUNT_NUMBER_METADATA_KEY] ?? '',
  confirmationNumber:
    schedule.phases[0]?.metadata?.[CONFIRMATION_NUMBER_METADATA_KEY] ?? '',
});

const ScheduleSearch = ({ environment }: ExtensionContextValue) => {
  const [storedSearch, setStoredSearch] = useStorage(SEARCH_STORAGE_KEY);
  const cachedSearch = useMemo(() => parseCachedSearch(storedSearch), [storedSearch]);
  const [accountNumber, setAccountNumber] = useState(cachedSearch?.accountNumber ?? '');
  const [confirmationNumber, setConfirmationNumber] = useState(
    cachedSearch?.confirmationNumber ?? ''
  );
  const [results, setResults] = useState<SearchResult[]>(cachedSearch?.results ?? []);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(cachedSearch?.searched ?? false);
  const [error, setError] = useState<string | null>(null);
  const [scannedScheduleCount, setScannedScheduleCount] = useState(
    cachedSearch?.scannedScheduleCount ?? 0
  );
  const [stoppedEarly, setStoppedEarly] = useState(
    cachedSearch?.stoppedEarly ?? false
  );

  const trimmedAccountNumber = accountNumber.trim();
  const trimmedConfirmationNumber = confirmationNumber.trim();
  const hasAccountNumber = trimmedAccountNumber.length > 0;
  const hasConfirmationNumber = trimmedConfirmationNumber.length > 0;
  const canSearch = !loading && (hasAccountNumber || hasConfirmationNumber);

  const searchSchedules = async () => {
    if (!canSearch) return;

    setLoading(true);
    setSearched(true);
    setError(null);
    setResults([]);
    setScannedScheduleCount(0);
    setStoppedEarly(false);

    try {
      const allSchedules: Stripe.SubscriptionSchedule[] = [];
      const createdCutoff = getScheduleCreatedCutoff();
      let startingAfter: string | undefined;

      do {
        const page = await stripe.subscriptionSchedules.list({
          created: { gte: createdCutoff },
          expand: ['data.customer'],
          limit: PAGE_SIZE,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        allSchedules.push(...page.data);
        startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;

        if (page.has_more && !startingAfter) {
          throw new Error('Unable to continue loading subscription schedules.');
        }
      } while (startingAfter);

      const allMatches = allSchedules.filter((schedule) => {
        const metadata = getFirstPhaseSearchMetadata(schedule);
        const accountNumberMatches =
          !hasAccountNumber ||
          matchesPrefix(metadata.accountNumber, trimmedAccountNumber);
        const confirmationNumberMatches =
          !hasConfirmationNumber ||
          matchesPrefix(metadata.confirmationNumber, trimmedConfirmationNumber);

        return accountNumberMatches && confirmationNumberMatches;
      });

      const matches = allMatches.slice(0, MAX_RESULTS).map((schedule) => {
        const metadata = getFirstPhaseSearchMetadata(schedule);

        return {
          scheduleId: schedule.id,
          customerId: getResourceId(schedule.customer),
          customerEmail: getCustomerEmail(schedule.customer),
          accountNumber: metadata.accountNumber,
          confirmationNumber: metadata.confirmationNumber,
          startDate: getScheduleStartDate(schedule),
          status: schedule.status,
        };
      });
      const reachedResultLimit = allMatches.length > MAX_RESULTS;

      setResults(matches);
      setScannedScheduleCount(allSchedules.length);
      setStoppedEarly(reachedResultLimit);

      const cachedSearchToStore: CachedSearch = {
        accountNumber: trimmedAccountNumber,
        confirmationNumber: trimmedConfirmationNumber,
        scannedScheduleCount: allSchedules.length,
        results: matches,
        searched: true,
        stoppedEarly: reachedResultLimit,
      };
      setStoredSearch(JSON.stringify(cachedSearchToStore));
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Unable to search subscription schedules.'
      );
    } finally {
      setLoading(false);
    }
  };

  const startNewSearch = () => {
    setAccountNumber('');
    setConfirmationNumber('');
    setResults([]);
    setSearched(false);
    setError(null);
    setScannedScheduleCount(0);
    setStoppedEarly(false);
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
            <Box>Loading and searching the last 31 days of schedules...</Box>
          </Box>
        )}

        {error && <Banner type="critical" title="Search failed" description={error} />}

        {searched && !loading && !error && results.length === 0 && (
          <Banner
            type="caution"
            title="No matching schedules"
            description={`Scanned ${scannedScheduleCount} subscription schedule${
              scannedScheduleCount === 1 ? '' : 's'
            }.`}
          />
        )}

        {stoppedEarly && results.length > 0 && (
          <Banner
            type="caution"
            title="Showing the first 100 matches"
            description={`All ${scannedScheduleCount} subscription schedules were searched.`}
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
