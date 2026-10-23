import { Badge, Box, Divider, Link } from '@stripe/ui-extension-sdk/ui';

import {
  formatCustomerId,
  formatDate,
  formatScheduleId,
  getDashboardUrl,
  type SearchResult,
  type SearchScope,
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
  scope: SearchScope;
  onSelect?: (result: SearchResult) => void;
  results: SearchResult[];
};

const ScheduleSearchResults = ({
  onSelect,
  results,
  scope,
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
                  scope,
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
          <Box
            css={{
              stack: 'x',
              columnGap: 'medium',
              rowGap: 'xxsmall',
              wrap: 'wrap',
              color: 'secondary',
              font: 'caption',
            }}
          >
            <Box>Starts {formatDate(result.startDate)}</Box>
            <Box>
              {result.status === 'active' || result.status === 'not_started'
                ? 'Ends'
                : 'Scheduled end'}{' '}
              {formatDate(result.endDate)}
            </Box>
          </Box>
          {['released', 'completed'].includes(result.status) && (
            <Box css={{ color: 'secondary', font: 'caption' }}>
              {statusPresentation[result.status].label} {formatDate(result.endedAt)}
            </Box>
          )}
          {result.status === 'released' ? (
            <Box css={{ color: 'secondary', font: 'caption' }}>
              Release does not cancel the subscription.
            </Box>
          ) : (
            (result.status === 'active' || result.status === 'not_started') &&
            result.endBehavior !== 'cancel' && (
              <Box css={{ color: 'secondary', font: 'caption' }}>
                {result.endBehavior === 'release'
                  ? 'The subscription continues after the schedule ends.'
                  : 'The schedule end is not a confirmed subscription cancellation date.'}
              </Box>
            )
          )}
        </Box>
        {index < results.length - 1 && <Divider />}
      </Box>
    ))}
  </Box>
);

export default ScheduleSearchResults;
