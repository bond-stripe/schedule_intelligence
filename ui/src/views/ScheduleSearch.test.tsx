import { render, getMockContextProps } from '@stripe/ui-extension-sdk/testing';
import { ContextView, TextField } from '@stripe/ui-extension-sdk/ui';

import ScheduleSearch from './ScheduleSearch';

describe('ScheduleSearchView', () => {
  it('renders the subscription schedule search workflow', () => {
    const { wrapper } = render(<ScheduleSearch {...getMockContextProps()} />);

    expect(wrapper.find(TextField)).toHaveProps({ label: 'enter account_id' });
    expect(wrapper.find(ContextView)).toContainText('Search');
  });
});
