import { useState } from 'react';
import { render, getMockContextProps } from '@stripe/ui-extension-sdk/testing';
import {
  Banner,
  Checkbox,
  DateField,
  Button,
  ContextView,
  Link,
  TextField,
  Tooltip,
} from '@stripe/ui-extension-sdk/ui';
import { useStorage } from '@stripe/ui-extension-sdk/data';

import ScheduleSearch from './ScheduleSearch';
import { GM_FINANCIAL_BLUE } from './branding';
import { getSearchStorageKey } from './scheduleSearchData';
import { getDefaultSearchCriteria, getCreatedRange } from './scheduleSearchDates';
import { MAX_PAGES_PER_BATCH } from './scheduleSearchEngine';
import type { ListSchedulePage, SearchableSchedule } from './scheduleSearchEngine';

const mockListSchedules = jest.fn<
  ReturnType<ListSchedulePage>,
  Parameters<ListSchedulePage>
>();
const mockRetrieveCustomer = jest.fn<
  Promise<{ id: string; email: string | null }>,
  [string]
>();
jest.mock('stripe', () => ({
  default: jest.fn().mockImplementation(() => ({
    subscriptionSchedules: {
      list: (params: Parameters<ListSchedulePage>[0]) => mockListSchedules(params),
    },
    customers: {
      retrieve: (customerId: string) => mockRetrieveCustomer(customerId),
    },
  })),
}));
jest.mock('@stripe/ui-extension-sdk/data', () => ({ useStorage: jest.fn() }));
const mockUseStorage = useStorage as jest.MockedFunction<typeof useStorage>;
const setStoredSearch = jest.fn();

const schedule = (id: number, accountNumber = '111'): SearchableSchedule => ({
  id: `sub_sched_${id}`,
  customer: 'cus_123',
  created: 1704067200,
  current_phase: null,
  end_behavior: 'release',
  canceled_at: null,
  completed_at: null,
  released_at: null,
  status: 'not_started',
  phases: [
    {
      start_date: 1735689600,
      end_date: 1767225600,
      metadata: { AccountNumber: accountNumber },
    },
  ],
});
const page = (data: SearchableSchedule[], has_more = false) => ({ data, has_more });
const deferredPage = () => {
  let resolve!: (value: Awaited<ReturnType<ListSchedulePage>>) => void;
  const promise = new Promise<Awaited<ReturnType<ListSchedulePage>>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const requireNode = <T,>(node: T | null | undefined): T => {
  if (node == null) throw new Error('Expected the UI control to be present.');
  return node;
};
const startSearch = (wrapper: ReturnType<typeof render>['wrapper']) => {
  requireNode(wrapper.find(TextField, { label: 'Account number' })).trigger('onChange', {
    target: { value: '111' },
  });
  requireNode(wrapper.find(Button, { type: 'primary' })).trigger('onPress');
};

describe('ScheduleSearchView', () => {
  beforeEach(() => {
    mockListSchedules.mockReset();
    mockRetrieveCustomer.mockReset();
    mockRetrieveCustomer.mockResolvedValue({ id: 'cus_123', email: null });
    setStoredSearch.mockReset();
    mockUseStorage.mockReset();
    mockUseStorage.mockReturnValue([null, setStoredSearch]);
  });

  it('renders the search criteria without a redundant heading or info tooltip', () => {
    const { wrapper } = render(<ScheduleSearch {...getMockContextProps()} />);
    expect(wrapper.find(ContextView)).toHaveProps({ brandColor: GM_FINANCIAL_BLUE });
    expect(wrapper.find(TextField, { label: 'Account number' })).toHaveProps({
      placeholder: '111...',
      value: '',
    });
    expect(wrapper.find(TextField, { label: 'Confirmation number' })).toHaveProps({
      placeholder: 'SAA...',
      value: '',
    });
    expect(wrapper.find(ContextView)).toContainText('Created date');
    expect(wrapper.findAll(DateField).map((field) => field.prop('label'))).toEqual([
      'From',
      'To',
    ]);
    expect(wrapper.find(ContextView)).not.toContainText('Both dates are included.');
    expect(wrapper.find(ContextView)).not.toContainText('Dates use your local time');
    expect(wrapper.find(ContextView)).not.toContainText('Subscription schedule search');
    expect(wrapper.find(Tooltip)).toBeNull();
    expect(wrapper.find(Button)).toHaveProps({ disabled: true });
  });

  it('shows matching schedules without the post-search summary', async () => {
    const matching = schedule(1);
    matching.phases[0].metadata = { ConfirmationNumber: 'SAWFVCXZZA' };
    mockListSchedules.mockResolvedValue(page([matching]));
    mockRetrieveCustomer.mockResolvedValue({
      id: 'cus_123',
      email: 'customer@example.com',
    });
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    requireNode(wrapper.find(TextField, { label: 'Confirmation number' })).trigger(
      'onChange',
      { target: { value: 'SAWFVCXZZA' } }
    );
    requireNode(wrapper.find(Button, { type: 'primary' })).trigger('onPress');
    await update();
    expect(mockListSchedules.mock.calls[0][0]).not.toHaveProperty('expand');
    expect(mockRetrieveCustomer).toHaveBeenCalledWith('cus_123');
    expect(wrapper.find(ContextView)).toContainText('customer@example.com');
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_1');
    expect(wrapper.find(ContextView)).toContainText('Confirmation SAWFVCXZZA');
    expect(wrapper.find(ContextView)).not.toContainText('Search results');
    expect(wrapper.find(ContextView)).not.toContainText('Confirmation number SAWFVCXZZA');
    expect(wrapper.find(ContextView)).not.toContainText(
      'Created ' + getDefaultSearchCriteria().createdAfter
    );
    expect(wrapper.find(ContextView)).not.toContainText('1 result');
    expect(wrapper.find(ContextView)).not.toContainText('Searched ');
    expect(wrapper.find(ContextView)).not.toContainText('Search again to refresh');
  });

  it('shows results while later pages are pending and caches only the settled result', async () => {
    const pending = deferredPage();
    mockListSchedules
      .mockResolvedValueOnce(page([schedule(1)], true))
      .mockReturnValueOnce(pending.promise);
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    startSearch(wrapper);
    await update();
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_1');
    expect(wrapper.find(ContextView)).toContainText('Checked 1 so far');
    expect(setStoredSearch.mock.calls).toEqual([['']]);
    pending.resolve(page([schedule(2)]));
    await update();
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_1');
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_2');
    expect(JSON.parse(setStoredSearch.mock.calls[1][0])).toMatchObject({
      scannedScheduleCount: 2,
      status: 'complete',
    });
    expect(wrapper.find(Link, { target: '_blank' })).toHaveProps({ external: true });
  });

  it('uses the default month for new searches and allows an explicitly wider range', async () => {
    mockListSchedules.mockResolvedValue(page([schedule(1)]));
    const defaults = getDefaultSearchCriteria();
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    expect(wrapper.find(DateField, { label: 'From' })).toHaveProps({
      value: defaults.createdAfter,
    });
    expect(wrapper.find(DateField, { label: 'To' })).toHaveProps({
      value: defaults.createdBefore,
    });
    startSearch(wrapper);
    await update();
    const defaultRange = getCreatedRange(
      defaults.createdAfter,
      defaults.createdBefore
    ).range;
    expect(mockListSchedules.mock.calls[0][0].created).toEqual(defaultRange);

    requireNode(wrapper.find(DateField, { label: 'From' })).trigger(
      'onChange',
      '2025-01-01'
    );
    requireNode(wrapper.find(DateField, { label: 'To' })).trigger(
      'onChange',
      '2026-01-01'
    );
    requireNode(wrapper.find(Button, { type: 'primary' })).trigger('onPress');
    await update();
    expect(mockListSchedules.mock.calls[1][0].created).toEqual(
      getCreatedRange('2025-01-01', '2026-01-01').range
    );

    requireNode(
      wrapper.findAll(Link).find((link) => link.text === 'Start a new search')
    ).trigger('onPress');
    expect(wrapper.find(DateField, { label: 'From' })).toHaveProps({
      value: defaults.createdAfter,
    });
    expect(wrapper.find(DateField, { label: 'To' })).toHaveProps({
      value: defaults.createdBefore,
    });
    startSearch(wrapper);
    await update();
    expect(mockListSchedules.mock.calls[2][0].created).toEqual(defaultRange);
  });

  it('reports overflow and makes no request after match 51', async () => {
    mockListSchedules
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 50 }, (_, i) => schedule(i)),
          true
        )
      )
      .mockResolvedValueOnce(page([schedule(51)], true));
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    startSearch(wrapper);
    await update();
    expect(wrapper.find(Banner)).toHaveProps({ title: 'More than 50 matches' });
    expect(wrapper.find(ContextView)).not.toContainText('All 51');
    expect(mockListSchedules).toHaveBeenCalledTimes(2);
    const cached = JSON.parse(setStoredSearch.mock.calls[1][0]);
    expect(cached.status).toBe('limit_reached');
    expect(cached.results).toHaveLength(50);
  });

  it('pauses without showing a no-matches message, then continues', async () => {
    mockListSchedules.mockImplementation(async () =>
      page([schedule(mockListSchedules.mock.calls.length, 'other')], true)
    );
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    startSearch(wrapper);
    await update();
    expect(wrapper.find(Banner)).toHaveProps({ title: 'Search paused' });
    expect(wrapper.find(ContextView)).not.toContainText('No matching schedules');
    expect(mockListSchedules).toHaveBeenCalledTimes(MAX_PAGES_PER_BATCH);
    mockListSchedules.mockResolvedValueOnce(page([]));
    requireNode(
      wrapper.findAll(Button).find((button) => button.text === 'Continue searching')
    ).trigger('onPress');
    await update();
    expect(mockListSchedules.mock.calls[20][0].starting_after).toBe('sub_sched_20');
    expect(wrapper.find(Banner)).toHaveProps({ title: 'No matching schedules' });
  });

  it('retains partial matches on failure and retries without starting over', async () => {
    mockListSchedules
      .mockResolvedValueOnce(page([schedule(1)], true))
      .mockRejectedValueOnce(new Error('Temporary API failure'))
      .mockResolvedValueOnce(page([schedule(2)]));
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    startSearch(wrapper);
    await update();
    expect(wrapper.find(Banner)).toHaveProps({
      title: 'Search incomplete',
      description: 'Temporary API failure',
    });
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_1');
    expect(setStoredSearch.mock.calls).toEqual([['']]);
    requireNode(
      wrapper
        .findAll(Button)
        .find((button) => button.text === 'Retry remaining schedules')
    ).trigger('onPress');
    await update();
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_1');
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_2');
    expect(mockListSchedules.mock.calls[2][0]).toEqual(
      mockListSchedules.mock.calls[1][0]
    );
  });

  it('ignores a late response after canceling and starting a new search', async () => {
    const pending = deferredPage();
    mockListSchedules
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page([schedule(2)]));
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    startSearch(wrapper);
    requireNode(
      wrapper.findAll(Button).find((button) => button.text === 'Cancel')
    ).trigger('onPress');
    expect(wrapper.find(Banner)).toHaveProps({ title: 'Search canceled' });
    requireNode(wrapper.find(Link)).trigger('onPress');
    startSearch(wrapper);
    await update();
    pending.resolve(page([schedule(1)], true));
    await update();
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_2');
    expect(wrapper.find(ContextView)).not.toContainText('Schedule sub_sched_...ed_1');
    expect(mockListSchedules).toHaveBeenCalledTimes(2);
    expect(setStoredSearch).toHaveBeenCalledTimes(4);
  });

  it('stops pagination and cache writes when the view unmounts', async () => {
    const pending = deferredPage();
    mockListSchedules.mockReturnValueOnce(pending.promise);
    // The SDK wrapper unmount only detaches the wrapper. Unmount React itself.
    const Harness = () => {
      const [visible, setVisible] = useState(true);
      return (
        <ContextView title="Test">
          <Button onPress={() => setVisible(false)}>Leave view</Button>
          {visible && <ScheduleSearch {...getMockContextProps()} />}
        </ContextView>
      );
    };
    const { wrapper, update } = render(<Harness />);
    startSearch(wrapper);
    requireNode(wrapper.find(Button)).trigger('onPress');
    await update();
    pending.resolve(page([schedule(1)], true));
    await update();
    expect(mockListSchedules).toHaveBeenCalledTimes(1);
    expect(setStoredSearch.mock.calls).toEqual([['']]);
  });

  it('sends inclusive date bounds and saves the submitted filters', async () => {
    mockListSchedules.mockResolvedValue({ data: [schedule(1)], has_more: false });
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    requireNode(wrapper.find(DateField, { label: 'From' })).trigger(
      'onChange',
      '2026-01-01'
    );
    requireNode(wrapper.find(DateField, { label: 'To' })).trigger(
      'onChange',
      '2026-01-31'
    );
    startSearch(wrapper);
    await update();
    expect(mockListSchedules.mock.calls[0][0].created).toEqual(
      getCreatedRange('2026-01-01', '2026-01-31').range
    );
    expect(JSON.parse(setStoredSearch.mock.calls[1][0])).toMatchObject({
      scope: { accountId: 'acct_1234', mode: 'test' },
      criteria: {
        accountNumber: '111',
        createdAfter: '2026-01-01',
        createdBefore: '2026-01-31',
      },
      searchedAt: expect.any(Number),
    });
  });

  it('prevents empty or reversed date ranges from issuing requests', () => {
    const { wrapper } = render(<ScheduleSearch {...getMockContextProps()} />);
    requireNode(wrapper.find(DateField, { label: 'From' })).trigger('onChange', '');
    startSearch(wrapper);
    expect(wrapper.find(DateField, { label: 'From' })).toHaveProps({
      invalid: true,
    });
    expect(mockListSchedules).not.toHaveBeenCalled();
    requireNode(wrapper.find(DateField, { label: 'From' })).trigger(
      'onChange',
      '2026-12-31'
    );
    requireNode(wrapper.find(DateField, { label: 'To' })).trigger(
      'onChange',
      '2026-01-01'
    );
    requireNode(wrapper.find(Button, { type: 'primary' })).trigger('onPress');
    expect(wrapper.find(DateField, { label: 'To' })).toHaveProps({
      invalid: true,
    });
    expect(mockListSchedules).not.toHaveBeenCalled();
  });

  it('includes released matches without a status checkbox', async () => {
    mockListSchedules.mockResolvedValue({
      data: [{ ...schedule(1), status: 'released', released_at: 1760000000 }],
      has_more: false,
    });
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    expect(wrapper.find(Checkbox)).toBeNull();
    startSearch(wrapper);
    await update();
    expect(wrapper.find(Banner, { title: 'No matching schedules' })).toBeNull();
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_1');
    expect(wrapper.find(Checkbox)).toBeNull();
    expect(mockListSchedules).toHaveBeenCalledTimes(1);
    const cached = JSON.parse(setStoredSearch.mock.calls[1][0]);
    expect(cached.results[0].status).toBe('released');
    expect(cached.criteria).not.toHaveProperty('includeReleased');
  });

  it('warns when criteria change while retaining previous matches until a fresh search', async () => {
    mockListSchedules
      .mockResolvedValueOnce({ data: [schedule(1)], has_more: false })
      .mockResolvedValueOnce({ data: [schedule(2, '222')], has_more: false });
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    startSearch(wrapper);
    await update();
    requireNode(wrapper.find(TextField, { label: 'Account number' })).trigger(
      'onChange',
      { target: { value: '222' } }
    );
    expect(wrapper.find(Banner, { title: 'Filters changed' })).not.toBeNull();
    expect(wrapper.find(ContextView)).toContainText('Account 111');
    expect(wrapper.find(TextField, { label: 'Account number' })).toHaveProps({
      value: '222',
    });
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_1');
    requireNode(wrapper.find(Button, { type: 'primary' })).trigger('onPress');
    await update();
    expect(mockListSchedules).toHaveBeenCalledTimes(2);
    expect(wrapper.find(ContextView)).toContainText('Account 222');
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...ed_2');
    expect(wrapper.find(Banner, { title: 'Filters changed' })).toBeNull();
  });

  it.each(['account', 'mode'] as const)(
    'invalidates an in-flight scan when the %s changes',
    async (change) => {
      const pending = deferredPage();
      mockListSchedules.mockReturnValueOnce(pending.promise);
      const Harness = () => {
        const [alternate, setAlternate] = useState(false);
        return (
          <ContextView title="Scope test">
            <Button onPress={() => setAlternate(true)}>Switch scope</Button>
            <ScheduleSearch
              {...getMockContextProps({
                userContext: {
                  account: {
                    id: alternate && change === 'account' ? 'acct_other' : 'acct_1234',
                  },
                },
                environment: { mode: alternate && change === 'mode' ? 'live' : 'test' },
              })}
            />
          </ContextView>
        );
      };
      const { wrapper, update } = render(<Harness />);
      startSearch(wrapper);
      requireNode(wrapper.find(Button)).trigger('onPress');
      await update();
      pending.resolve({ data: [schedule(1)], has_more: true });
      await update();
      expect(mockListSchedules).toHaveBeenCalledTimes(1);
      expect(setStoredSearch.mock.calls).toEqual([['']]);
      expect(mockUseStorage).toHaveBeenCalledWith(
        getSearchStorageKey({
          accountId: change === 'account' ? 'acct_other' : 'acct_1234',
          mode: change === 'mode' ? 'live' : 'test',
        })
      );
      expect(wrapper.find(TextField, { label: 'Account number' })).toHaveProps({
        value: '',
      });
    }
  );

  it('restores a settled overflow and criteria without a summary or refresh message', () => {
    mockUseStorage.mockReturnValue([
      JSON.stringify({
        scope: { accountId: 'acct_1234', mode: 'test' },
        criteria: { ...getDefaultSearchCriteria(), accountNumber: '111' },
        searchedAt: 1704067200,
        scannedScheduleCount: 51,
        status: 'limit_reached',
        results: Array.from({ length: 50 }, (_, i) => ({
          scheduleId: 'sub_sched_' + i,
          customerId: 'cus_123',
          customerEmail: null,
          accountNumber: '111',
          confirmationNumber: '',
          startDate: 1735689600,
          endDate: 1767225600,
          endedAt: null,
          endBehavior: 'release',
          status: 'not_started',
        })),
      }),
      setStoredSearch,
    ]);
    const { wrapper } = render(<ScheduleSearch {...getMockContextProps()} />);
    expect(wrapper.find(Banner)).toHaveProps({ title: 'More than 50 matches' });
    expect(wrapper.find(DateField, { label: 'From' })).toHaveProps({
      value: getDefaultSearchCriteria().createdAfter,
    });
    expect(wrapper.find(ContextView)).not.toContainText('Search results');
    expect(wrapper.find(ContextView)).not.toContainText('Searched ');
    expect(wrapper.find(ContextView)).not.toContainText('Search again to refresh');
    expect(mockListSchedules).not.toHaveBeenCalled();
  });
});
