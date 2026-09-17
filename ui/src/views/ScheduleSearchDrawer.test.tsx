import { useState } from 'react';
import { getMockContextProps, render } from '@stripe/ui-extension-sdk/testing';
import { Button, ContextView, Link, TextField } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import { useStorage } from '@stripe/ui-extension-sdk/data';

import ScheduleSearch from './ScheduleSearch';
import ScheduleSearchDrawer from './ScheduleSearchDrawer';
import type { CachedSearch } from './scheduleSearchData';
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
let storedSearch: string | null;
const storageWrites = jest.fn();

// Exercise actual React updates and a changing setter identity, as in the old
// re-render regression, while sharing the saved string between viewport mounts.
function useTestStorage(key: string): ReturnType<typeof useStorage> {
  expect(key).toMatch(
    /^scheduled-subscription-search:last-search:v12:acct_1234:(test|live)$/
  );
  const [value, setValue] = useState(storedSearch);
  return [
    value,
    (next) => {
      storedSearch = next;
      storageWrites(next);
      setValue(next);
    },
  ];
}

const drawerContext = (mode: 'live' | 'test' = 'test'): ExtensionContextValue => {
  const props = getMockContextProps();
  return {
    ...props,
    environment: {
      ...props.environment,
      mode,
      viewportID: 'stripe.dashboard.drawer.default',
      objectContext: null,
    },
  };
};

const savedSearch: CachedSearch = {
  scope: { accountId: 'acct_1234', mode: 'test' },
  criteria: {
    accountNumber: '123456',
    confirmationNumber: 'ABC123',
    createdAfter: '2023-01-01',
    createdBefore: '2024-01-01',
  },
  searchedAt: 1704067200,
  scannedScheduleCount: 1,
  status: 'complete',
  results: [
    {
      scheduleId: 'sub_sched_1234',
      customerId: 'cus_1234',
      customerEmail: 'customer@example.com',
      accountNumber: '123456',
      confirmationNumber: 'ABC123',
      startDate: 1704067200,
      endDate: 1735689600,
      endedAt: null,
      endBehavior: 'release',
      status: 'not_started',
    },
  ],
};
const matchingSchedule: SearchableSchedule = {
  id: 'sub_sched_1234',
  customer: 'cus_1234',
  created: 1704067200,
  current_phase: null,
  end_behavior: 'release',
  canceled_at: null,
  completed_at: null,
  released_at: null,
  status: 'not_started',
  phases: [
    {
      start_date: 1704067200,
      end_date: 1735689600,
      metadata: { AccountNumber: '123456', ConfirmationNumber: 'ABC123' },
    },
  ],
};
const requireNode = <T,>(node: T | null | undefined): T => {
  if (node == null) throw new Error('Expected the UI control to be present.');
  return node;
};
const search = (wrapper: ReturnType<typeof render>['wrapper']) => {
  requireNode(wrapper.find(TextField, { label: 'Account number' })).trigger('onChange', {
    target: { value: '123' },
  });
  requireNode(wrapper.find(Button, { type: 'primary' })).trigger('onPress');
};

describe('ScheduleSearchDrawerView', () => {
  beforeEach(() => {
    storedSearch = null;
    storageWrites.mockReset();
    mockListSchedules.mockReset();
    mockListSchedules.mockResolvedValue({ data: [matchingSchedule], has_more: false });
    mockUseStorage.mockReset();
    mockUseStorage.mockImplementation(useTestStorage);
  });

  it('offers the full search without any object context', () => {
    const { wrapper } = render(<ScheduleSearchDrawer {...drawerContext()} />);
    expect(wrapper.findAll(ContextView)).toHaveLength(1);
    expect(wrapper.findAll(TextField).map((field) => field.prop('label'))).toEqual([
      'Account number',
      'Confirmation number',
    ]);
    expect(wrapper.find(Button)).toHaveProps({ disabled: true });
    expect(mockListSchedules).not.toHaveBeenCalled();
    expect(storageWrites).not.toHaveBeenCalled();
  });

  it.each(['live', 'test'] as const)(
    'restores results with %s links and no restore writes',
    async (mode) => {
      storedSearch = JSON.stringify({
        ...savedSearch,
        scope: { ...savedSearch.scope, mode },
      });
      const { wrapper, update } = render(
        <ScheduleSearchDrawer {...drawerContext(mode)} />
      );
      await update();
      expect(wrapper.find(ContextView)).not.toContainText('Search results');
      expect(wrapper.find(ContextView)).not.toContainText('Search again to refresh');
      expect(wrapper.find(ContextView)).toContainText('customer@example.com');
      expect(wrapper.find(Link, { target: '_blank' })).toHaveProps({
        external: true,
        href:
          'https://dashboard.stripe.com' +
          (mode === 'test' ? '/test' : '') +
          '/subscription_schedules/sub_sched_1234',
      });
      expect(mockListSchedules).not.toHaveBeenCalled();
      expect(storageWrites).not.toHaveBeenCalled();
    }
  );

  it('searches and starts a new search in place without a storage render loop', async () => {
    const { wrapper, update } = render(<ScheduleSearchDrawer {...drawerContext()} />);
    search(wrapper);
    await update();
    expect(wrapper.find(ContextView)).toContainText('Schedule sub_sched_...1234');
    expect(mockListSchedules).toHaveBeenCalledTimes(1);
    expect(storageWrites).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storedSearch ?? '{}').results).toHaveLength(1);
    const newSearch = requireNode(
      wrapper.findAll(Link).find((link) => link.text === 'Start a new search')
    );
    expect(newSearch.prop('href')).toBeUndefined();
    newSearch.trigger('onPress');
    await update();
    expect(wrapper.find(TextField, { label: 'Account number' })).toHaveProps({
      value: '',
    });
    expect(storedSearch).toBe('');
    search(wrapper);
    await update();
    expect(mockListSchedules).toHaveBeenCalledTimes(2);
    expect(storageWrites).toHaveBeenCalledTimes(5);
  });

  it('restores a search from the subscription list when the default drawer mounts', async () => {
    const original = render(
      <ScheduleSearch
        {...getMockContextProps({
          environment: { viewportID: 'stripe.dashboard.subscription.list' },
        })}
      />
    );
    search(original.wrapper);
    await original.update();
    const drawer = render(<ScheduleSearchDrawer {...drawerContext()} />);
    await drawer.update();
    expect(drawer.wrapper.find(ContextView)).toContainText('Schedule sub_sched_...1234');
    expect(mockListSchedules).toHaveBeenCalledTimes(1);
    expect(storageWrites).toHaveBeenCalledTimes(2);
  });

  it('falls back to search when cached data is invalid', () => {
    storedSearch = '{invalid json';
    const { wrapper } = render(<ScheduleSearchDrawer {...drawerContext()} />);
    expect(wrapper.find(TextField)).toHaveProps({ label: 'Account number', value: '' });
    expect(storageWrites).not.toHaveBeenCalled();
  });
});
