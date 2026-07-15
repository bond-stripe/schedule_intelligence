import { useEffect, useMemo, useState } from 'react';
import Stripe from 'stripe';

import {
  Banner,
  Box,
  Button,
  ContextView,
  Link,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextField,
} from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import { useStorage } from '@stripe/ui-extension-sdk/data';
import { createHttpClient, STRIPE_API_KEY } from '@stripe/ui-extension-sdk/http_client';

import BrandIcon from './brand_icon.svg';

const MAX_CUSTOMER_PAGES = 10;
const MAX_SCHEDULE_PAGES_PER_CUSTOMER = 10;
const PAGE_SIZE = 100;
const MAX_RESULTS = 100;
const ACCOUNT_ID_METADATA_KEY = 'account_id';
const SEARCH_STORAGE_KEY = 'scheduled-subscription-search:last-search';

const stripe = new Stripe(STRIPE_API_KEY, {
  apiVersion: '2023-08-16',
  httpClient: createHttpClient(),
});

type SearchResult = {
  scheduleId: string;
  startDate: number;
  customerId: string;
  accountId: string;
};

type CachedSearch = {
  accountId: string;
  matchedCustomerCount: number;
  results: SearchResult[];
  searched: boolean;
  stoppedEarly: boolean;
};

const formatDate = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

const getDashboardPath = (
  mode: ExtensionContextValue['environment']['mode'],
  path: string
) => `${mode === 'test' ? '/test' : ''}${path}`;

const escapeSearchQueryValue = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const formatCustomerId = (customerId: string) =>
  customerId.length > 10 ? `cus_...${customerId.slice(-6)}` : customerId;

const formatScheduleId = (scheduleId: string) => `sub_...${scheduleId.slice(-4)}`;

const getScheduleStartDate = (schedule: Stripe.SubscriptionSchedule) =>
  schedule.phases[0]?.start_date ??
  schedule.current_phase?.start_date ??
  schedule.created;

const parseCachedSearch = (value: string | null): CachedSearch | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<CachedSearch>;

    if (
      typeof parsed.accountId !== 'string' ||
      typeof parsed.matchedCustomerCount !== 'number' ||
      typeof parsed.searched !== 'boolean' ||
      typeof parsed.stoppedEarly !== 'boolean' ||
      !Array.isArray(parsed.results)
    ) {
      return null;
    }

    return {
      accountId: parsed.accountId,
      matchedCustomerCount: parsed.matchedCustomerCount,
      results: parsed.results.filter(
        (result): result is SearchResult =>
          typeof result === 'object' &&
          result !== null &&
          typeof result.scheduleId === 'string' &&
          typeof result.startDate === 'number' &&
          typeof result.customerId === 'string' &&
          typeof result.accountId === 'string'
      ),
      searched: parsed.searched,
      stoppedEarly: parsed.stoppedEarly,
    };
  } catch {
    return null;
  }
};

const ScheduleSearch = ({ environment }: ExtensionContextValue) => {
  const [storedSearch, setStoredSearch] = useStorage(SEARCH_STORAGE_KEY);
  const cachedSearch = useMemo(() => parseCachedSearch(storedSearch), [storedSearch]);
  const [accountId, setAccountId] = useState(cachedSearch?.accountId ?? '');
  const [results, setResults] = useState<SearchResult[]>(cachedSearch?.results ?? []);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(cachedSearch?.searched ?? false);
  const [error, setError] = useState<string | null>(null);
  const [matchedCustomerCount, setMatchedCustomerCount] = useState(
    cachedSearch?.matchedCustomerCount ?? 0
  );
  const [stoppedEarly, setStoppedEarly] = useState(cachedSearch?.stoppedEarly ?? false);

  const trimmedAccountId = accountId.trim();
  const canSearch = trimmedAccountId.length > 0 && !loading;

  useEffect(() => {
    if (!cachedSearch || loading) {
      return;
    }

    setAccountId(cachedSearch.accountId);
    setResults(cachedSearch.results);
    setMatchedCustomerCount(cachedSearch.matchedCustomerCount);
    setSearched(cachedSearch.searched);
    setStoppedEarly(cachedSearch.stoppedEarly);
    setError(null);
  }, [cachedSearch, loading]);

  const resultSummary = useMemo(() => {
    if (!searched || loading || error) {
      return null;
    }

    if (results.length === 0) {
      return `Found ${matchedCustomerCount} matching customer${
        matchedCustomerCount === 1 ? '' : 's'
      }, but no subscription schedules.`;
    }

    return `Found ${results.length} subscription schedule${
      results.length === 1 ? '' : 's'
    } for ${matchedCustomerCount} matching customer${
      matchedCustomerCount === 1 ? '' : 's'
    }.`;
  }, [error, loading, matchedCustomerCount, results.length, searched]);

  const searchSchedules = async () => {
    if (!canSearch) {
      return;
    }

    setLoading(true);
    setSearched(true);
    setError(null);
    setResults([]);
    setMatchedCustomerCount(0);
    setStoppedEarly(false);

    try {
      const customers: Stripe.Customer[] = [];
      const matches: SearchResult[] = [];
      let customerPageCount = 0;
      let customerPage: string | undefined;
      let reachedLimit = false;
      const query = `metadata['${ACCOUNT_ID_METADATA_KEY}']:'${escapeSearchQueryValue(
        trimmedAccountId
      )}'`;

      while (customerPageCount < MAX_CUSTOMER_PAGES) {
        const page = await stripe.customers.search({
          query,
          limit: PAGE_SIZE,
          ...(customerPage ? { page: customerPage } : {}),
        });

        customers.push(...page.data);
        customerPageCount += 1;

        if (!page.has_more || !page.next_page) {
          break;
        }

        customerPage = page.next_page;

        if (customerPageCount >= MAX_CUSTOMER_PAGES) {
          reachedLimit = true;
        }
      }

      for (const customer of customers) {
        let schedulePageCount = 0;
        let startingAfter: string | undefined;

        while (
          schedulePageCount < MAX_SCHEDULE_PAGES_PER_CUSTOMER &&
          matches.length < MAX_RESULTS
        ) {
          const page = await stripe.subscriptionSchedules.list({
            customer: customer.id,
            limit: PAGE_SIZE,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });

          schedulePageCount += 1;

          for (const schedule of page.data) {
            matches.push({
              scheduleId: schedule.id,
              startDate: getScheduleStartDate(schedule),
              customerId: customer.id,
              accountId: customer.metadata?.[ACCOUNT_ID_METADATA_KEY] ?? '',
            });

            if (matches.length >= MAX_RESULTS) {
              reachedLimit = true;
              break;
            }
          }

          if (!page.has_more || matches.length >= MAX_RESULTS) {
            break;
          }

          startingAfter = page.data.at(-1)?.id;

          if (!startingAfter) {
            break;
          }

          if (schedulePageCount >= MAX_SCHEDULE_PAGES_PER_CUSTOMER) {
            reachedLimit = true;
          }
        }
      }

      setResults(matches);
      setMatchedCustomerCount(customers.length);
      setStoppedEarly(reachedLimit);
      const cachedSearchToStore: CachedSearch = {
        accountId: trimmedAccountId,
        matchedCustomerCount: customers.length,
        results: matches,
        searched: true,
        stoppedEarly: reachedLimit,
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

  return (
    <ContextView
      title="Scheduled Subscription Search"
      description="Find subscription schedules by customer account_id metadata."
      brandColor="#F6F8FA"
      brandIcon={BrandIcon}
      externalLink={{
        label: 'Customer search API',
        href: 'https://docs.stripe.com/api/customers/search',
      }}
    >
      <Box css={{ stack: 'y', rowGap: 'large' }}>
        <Box css={{ stack: 'y', rowGap: 'medium' }}>
          <TextField
            label="enter account_id"
            placeholder="abc123"
            type="search"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void searchSchedules();
              }
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

        {loading && (
          <Box css={{ stack: 'x', columnGap: 'small' }}>
            <Spinner size="small" />
            <Box>Searching customers and subscription schedules...</Box>
          </Box>
        )}

        {error && <Banner type="critical" title="Search failed" description={error} />}

        {resultSummary && (
          <Banner
            type={results.length > 0 ? 'default' : 'caution'}
            title={results.length > 0 ? 'Search complete' : 'No matching schedules'}
            description={
              stoppedEarly
                ? `${resultSummary} The scan stopped at the first limit.`
                : resultSummary
            }
          />
        )}

        {results.length > 0 && (
          <Box css={{ stack: 'y', rowGap: 'medium' }}>
            <Box css={{ font: 'heading' }}>Results</Box>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Customer</TableHeaderCell>
                  <TableHeaderCell>Account ID</TableHeaderCell>
                  <TableHeaderCell>Subscription schedule</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {results.map((schedule) => (
                  <TableRow key={schedule.scheduleId}>
                    <TableCell wrap width="minimized">
                      <Box
                        css={{
                          font: 'caption',
                          overflowWrap: 'break-word',
                          wordBreak: 'break-word',
                        }}
                      >
                        <Link
                          href={getDashboardPath(
                            environment.mode,
                            `/customers/${schedule.customerId}`
                          )}
                        >
                          {formatCustomerId(schedule.customerId)}
                        </Link>
                      </Box>
                    </TableCell>
                    <TableCell wrap width="minimized">
                      <Box
                        css={{
                          font: 'caption',
                          overflowWrap: 'break-word',
                          wordBreak: 'break-word',
                        }}
                      >
                        {schedule.accountId}
                      </Box>
                    </TableCell>
                    <TableCell wrap>
                      <Box
                        css={{
                          font: 'caption',
                          overflowWrap: 'break-word',
                          rowGap: 'xxsmall',
                          stack: 'y',
                          wordBreak: 'break-word',
                        }}
                      >
                        <Link
                          href={getDashboardPath(
                            environment.mode,
                            `/subscription_schedules/${schedule.scheduleId}`
                          )}
                        >
                          {formatScheduleId(schedule.scheduleId)}
                        </Link>
                        <Box css={{ color: 'secondary', font: 'caption' }}>
                          Start date: {formatDate(schedule.startDate)}
                        </Box>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Box>
    </ContextView>
  );
};

export default ScheduleSearch;
