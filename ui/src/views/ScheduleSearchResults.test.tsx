import { render } from '@stripe/ui-extension-sdk/testing';
import { Badge, Box } from '@stripe/ui-extension-sdk/ui';
import ScheduleSearchResults from './ScheduleSearchResults';
import { formatDate, type SearchResult } from './scheduleSearchData';

const result: SearchResult = {
  scheduleId: 'sub_sched_1234',
  customerId: 'cus_1234',
  customerEmail: null,
  accountNumber: '111',
  confirmationNumber: 'ABC',
  status: 'not_started',
  startDate: 1735689600,
  endDate: 1767225600,
  endedAt: null,
  endBehavior: 'release',
};
describe('schedule end presentation', () => {
  it('shows Starts and Ends together, explaining a continuing subscription', () => {
    const { wrapper } = render(<ScheduleSearchResults mode="test" results={[result]} />);
    expect(wrapper.find(Box)).toContainText('Starts ' + formatDate(result.startDate));
    expect(wrapper.find(Box)).toContainText('Ends ' + formatDate(result.endDate));
    expect(wrapper.find(Box)).toContainText(
      'subscription continues after the schedule ends'
    );
  });
  it.each(['active', 'not_started'] as const)(
    'shows %s lease end dates without a cancellation explanation',
    (status) => {
      const { wrapper } = render(
        <ScheduleSearchResults
          mode="test"
          results={[{ ...result, status, endBehavior: 'cancel' }]}
        />
      );
      expect(wrapper.find(Box)).toContainText('Starts ' + formatDate(result.startDate));
      expect(wrapper.find(Box)).toContainText('Ends ' + formatDate(result.endDate));
      expect(wrapper.find(Box)).not.toContainText('subscription is scheduled to cancel');
      expect(wrapper.find(Box)).not.toContainText('subscription continues');
    }
  );
  it.each([1750000000, null])(
    'keeps canceled status and planned dates without the cancellation timestamp (%s)',
    (endedAt) => {
      const { wrapper } = render(
        <ScheduleSearchResults
          mode="test"
          results={[{ ...result, status: 'canceled', endBehavior: 'cancel', endedAt }]}
        />
      );
      expect(wrapper.find(Badge)).toContainText('Canceled');
      expect(wrapper.find(Box)).toContainText('Starts ' + formatDate(result.startDate));
      expect(wrapper.find(Box)).toContainText(
        'Scheduled end ' + formatDate(result.endDate)
      );
      expect(wrapper.find(Box)).not.toContainText('Canceled ' + formatDate(endedAt));
      if (endedAt !== null)
        expect(wrapper.find(Box)).not.toContainText(formatDate(endedAt));
    }
  );
  it.each(['completed', 'released'] as const)(
    'separates the planned end from the actual %s date',
    (status) => {
      const { wrapper } = render(
        <ScheduleSearchResults
          mode="test"
          results={[{ ...result, status, endedAt: 1750000000 }]}
        />
      );
      expect(wrapper.find(Box)).toContainText(
        'Scheduled end ' + formatDate(result.endDate)
      );
      expect(wrapper.find(Box)).toContainText(formatDate(1750000000));
      if (status === 'released')
        expect(wrapper.find(Box)).toContainText(
          'Release does not cancel the subscription.'
        );
    }
  );
  it('shows Unknown for absent end dates', () => {
    const { wrapper } = render(
      <ScheduleSearchResults mode="test" results={[{ ...result, endDate: null }]} />
    );
    expect(wrapper.find(Box)).toContainText('Ends Unknown');
  });
});
