import { Badge, Box, Divider, Link } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

import {
  formatCustomerId,
  formatDate,
  formatScheduleId,
  getDashboardUrl,
  type SearchResult,
  type ScheduleStatus,
} from './scheduleSearchData';

const statusPresentation: Record<
  ScheduleStatus,
  { label: string; type: 'info' | 'negative' | 'neutral' | 'positive' | 'warning' }
> = {
  active: { label: 'Active', type: 'positive' },
  canceled: { label: 'Canceled', type: 'negative' },
  completed: { label: 'Completed', type: 'neutral' },
  not_started: { label: 'Not started', type: 'info' },
  released: { label: 'Released', type: 'warning' },
};

type ScheduleSearchResultsProps = {
  mode: ExtensionContextValue['environment']['mode'];
  onSelect?: (result: SearchResult) => void;
  results: SearchResult[];
};

const ScheduleSearchResults = ({
  mode,
  onSelect,
  results,
}: ScheduleSearchResultsProps) => (
  <Box css={{ stack: 'y', rowGap: 'medium' }}>
    {results.map((result, index) => (
      <Box key={result.scheduleId} css={{ stack: 'y', rowGap: 'medium' }}>
        <Box css={{ stack: 'y', rowGap: 'xxsmall' }}>
          <Box css={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {result.customerEmail ?? formatCustomerId(result.customerId)}
          </Box>
          <Box css={{ stack: 'x', columnGap: 'small', alignY: 'center', wrap: 'wrap' }}>
            {onSelect ? (
              <Link onPress={() => onSelect(result)}>
                Schedule {formatScheduleId(result.scheduleId)}
              </Link>
            ) : (
              <Link
                external
                href={getDashboardUrl(
                  mode,
                  `/subscription_schedules/${result.scheduleId}`
                )}
                target="_blank"
              >
                Schedule {formatScheduleId(result.scheduleId)}
              </Link>
            )}
            <Badge type={statusPresentation[result.status].type}>
              {statusPresentation[result.status].label}
            </Badge>
          </Box>
          <Box css={{ color: 'secondary', font: 'caption' }}>
            Account {result.accountNumber || '—'} · Confirmation{' '}
            {result.confirmationNumber || '—'}
          </Box>
          <Box css={{ color: 'secondary', font: 'caption' }}>
            Starts {formatDate(result.startDate)}
          </Box>
        </Box>
        {index < results.length - 1 && <Divider />}
      </Box>
    ))}
  </Box>
);

export default ScheduleSearchResults;
