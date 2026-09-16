import { useState } from 'react';
import { render, getMockContextProps } from '@stripe/ui-extension-sdk/testing';
import {
  Banner,
  Button,
  ContextView,
  Link,
  TextField,
  Tooltip,
} from '@stripe/ui-extension-sdk/ui';
import { useStorage } from '@stripe/ui-extension-sdk/data';

import ScheduleSearch from './ScheduleSearch';
import type { ListSchedulePage, SearchableSchedule } from './scheduleSearchEngine';

const mockListSchedules = jest.fn<
  ReturnType<ListSchedulePage>,
  Parameters<ListSchedulePage>
>();
jest.mock('stripe', () => ({
  default: jest.fn().mockImplementation(() => ({
    subscriptionSchedules: {
      list: (params: Parameters<ListSchedulePage>[0]) => mockListSchedules(params),
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
  status: 'not_started',
  phases: [{ start_date: 1735689600, metadata: { AccountNumber: accountNumber } }],
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
    setStoredSearch.mockReset();
    mockUseStorage.mockReset();
    mockUseStorage.mockReturnValue([null, setStoredSearch]);
  });

  it('renders the existing search criteria', () => {
    const { wrapper } = render(<ScheduleSearch {...getMockContextProps()} />);
    expect(wrapper.find(TextField)).toHaveProps({ label: 'Account number' });
    expect(wrapper.find(Tooltip)).toContainText(
      'Search schedules created in the last 31 days'
    );
    expect(wrapper.find(Button)).toHaveProps({ disabled: true });
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
    expect(wrapper.find(ContextView)).toContainText('2 results');
    expect(JSON.parse(setStoredSearch.mock.calls[1][0])).toMatchObject({
      scannedScheduleCount: 2,
      stoppedEarly: false,
    });
    expect(wrapper.find(Link, { target: '_blank' })).toHaveProps({ external: true });
  });

  it('reports overflow and makes no request after match 101', async () => {
    mockListSchedules
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => schedule(i)),
          true
        )
      )
      .mockResolvedValueOnce(page([schedule(101)], true));
    const { wrapper, update } = render(<ScheduleSearch {...getMockContextProps()} />);
    startSearch(wrapper);
    await update();
    expect(wrapper.find(Banner)).toHaveProps({ title: 'More than 100 matches' });
    expect(wrapper.find(ContextView)).not.toContainText('All 101');
    expect(mockListSchedules).toHaveBeenCalledTimes(2);
    const cached = JSON.parse(setStoredSearch.mock.calls[1][0]);
    expect(cached.stoppedEarly).toBe(true);
    expect(cached.results).toHaveLength(100);
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
    expect(mockListSchedules).toHaveBeenCalledTimes(20);
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
    requireNode(wrapper.find(Button)).trigger('onPress');
    await update();
    expect(wrapper.find(ContextView)).toContainText('2 results');
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

  it('restores a settled overflow result without making another API request', () => {
    mockUseStorage.mockReturnValue([
      JSON.stringify({
        accountNumber: '111',
        confirmationNumber: '',
        scannedScheduleCount: 101,
        searched: true,
        stoppedEarly: true,
        results: [
          {
            scheduleId: 'sub_sched_1',
            customerId: 'cus_123',
            customerEmail: null,
            accountNumber: '111',
            confirmationNumber: '',
            startDate: 1735689600,
            status: 'not_started',
          },
        ],
      }),
      setStoredSearch,
    ]);
    const { wrapper } = render(<ScheduleSearch {...getMockContextProps()} />);
    expect(wrapper.find(Banner)).toHaveProps({ title: 'More than 100 matches' });
    expect(mockListSchedules).not.toHaveBeenCalled();
  });
});
