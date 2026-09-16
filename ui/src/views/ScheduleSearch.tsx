import {
  Banner,
  Box,
  Button,
  ContextView,
  DateField,
  Link,
  Spinner,
  TextField,
} from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

import BrandIcon from './brand_icon.svg';
import { getSearchStorageKey, type SearchScope } from './scheduleSearchData';
import ScheduleSearchResults from './ScheduleSearchResults';
import { useScheduleSearch } from './useScheduleSearch';

const ScheduleSearchView = ({ scope }: { scope: SearchScope }) => {
  const {
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
  } = useScheduleSearch(scope);
  const { results, scannedScheduleCount } = search;

  return (
    <ContextView title="" brandColor="#F6F8FA" brandIcon={BrandIcon}>
      <Box css={{ stack: 'y', rowGap: 'large' }}>
        <Box css={{ stack: 'y', rowGap: 'medium' }}>
          <TextField
            label="Account number"
            placeholder="111..."
            type="search"
            value={draft.accountNumber}
            disabled={loading}
            onChange={(event) => updateDraft({ accountNumber: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') searchSchedules();
            }}
          />
          <TextField
            label="Confirmation number"
            placeholder="SAA..."
            type="search"
            value={draft.confirmationNumber}
            disabled={loading}
            onChange={(event) => updateDraft({ confirmationNumber: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') searchSchedules();
            }}
          />
          <Box css={{ stack: 'y', rowGap: 'small' }}>
            <Box css={{ font: 'bodyEmphasized' }}>Created date</Box>
            <Box css={{ stack: 'x', columnGap: 'medium', rowGap: 'small', wrap: 'wrap' }}>
              <DateField
                label="From"
                value={draft.createdAfter}
                disabled={loading}
                onChange={(value) => updateDraft({ createdAfter: value })}
                invalid={Boolean(dateValidation.afterError)}
                error={dateValidation.afterError}
              />
              <DateField
                label="To"
                value={draft.createdBefore}
                disabled={loading}
                onChange={(value) => updateDraft({ createdBefore: value })}
                invalid={Boolean(dateValidation.beforeError)}
                error={dateValidation.beforeError}
              />
            </Box>
          </Box>
          <Box css={{ stack: 'x', columnGap: 'medium', alignY: 'center' }}>
            <Button
              type="primary"
              disabled={!canSearch}
              pending={loading}
              onPress={searchSchedules}
            >
              Search
            </Button>
            {search.status !== 'idle' && (
              <Link onPress={startNewSearch}>Start a new search</Link>
            )}
          </Box>
        </Box>

        {criteriaChanged && (
          <Banner
            type="default"
            title="Filters changed"
            description="These results are from your previous search. Select Search to apply your changes."
          />
        )}
        {loading && (
          <Box css={{ stack: 'x', columnGap: 'small', alignY: 'center', wrap: 'wrap' }}>
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
            description={
              'Checked ' +
              scannedScheduleCount +
              ' schedules. Search results are incomplete.'
            }
          />
        )}
        {canResume && (
          <Button onPress={() => void runSearchBatch()}>
            {search.status === 'error'
              ? 'Retry remaining schedules'
              : 'Continue searching'}
          </Button>
        )}
        {search.status === 'complete' && results.length === 0 && (
          <Banner
            type="caution"
            title="No matching schedules"
            description={
              'Checked ' + scannedScheduleCount + ' schedules in the searched date range.'
            }
          />
        )}
        {search.status === 'limit_reached' && (
          <Banner
            type="caution"
            title="More than 100 matches"
            description="Showing the first 100. Refine your identifiers or date range, then search again."
          />
        )}
        {cacheWarning && (
          <Banner type="caution" title="Results not saved" description={cacheWarning} />
        )}
        {results.length > 0 && (
          <ScheduleSearchResults mode={scope.mode} results={results} />
        )}
      </Box>
    </ContextView>
  );
};

const ScheduleSearch = ({ environment, userContext }: ExtensionContextValue) => {
  const scope = { accountId: userContext.account.id, mode: environment.mode };
  return <ScheduleSearchView key={getSearchStorageKey(scope)} scope={scope} />;
};

export default ScheduleSearch;
