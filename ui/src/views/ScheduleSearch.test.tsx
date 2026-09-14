import { render, getMockContextProps } from '@stripe/ui-extension-sdk/testing';
import { ContextView, TextField, Tooltip } from '@stripe/ui-extension-sdk/ui';

import ScheduleSearch, {
  getFirstPhaseSearchMetadata,
  getScheduleCreatedCutoff,
  matchesPrefix,
} from './ScheduleSearch';

describe('ScheduleSearchView', () => {
  it('renders the subscription schedule search workflow', () => {
    const { wrapper } = render(<ScheduleSearch {...getMockContextProps()} />);

    expect(wrapper.find(TextField)).toHaveProps({ label: 'Account number' });
    expect(wrapper.find(Tooltip)).toContainText(
      'Search schedules created in the last 31 days'
    );
    expect(wrapper.find(ContextView)).toContainText('Search');
  });

  it('matches the beginning of a value without regard to case', () => {
    expect(matchesPrefix('SAXEZT34ZA', 'SAX')).toBe(true);
    expect(matchesPrefix('SAXEZT34ZA', 'sax')).toBe(true);
    expect(matchesPrefix('SAXEZT34ZA', 'EZT')).toBe(false);
  });

  it('reads search values from the first phase metadata', () => {
    const schedule = {
      phases: [
        {
          metadata: {
            AccountNumber: '111056117407',
            ConfirmationNumber: 'SAXEZT34ZA',
          },
        },
      ],
    };

    expect(getFirstPhaseSearchMetadata(schedule as never)).toEqual({
      accountNumber: '111056117407',
      confirmationNumber: 'SAXEZT34ZA',
    });
  });

  it('calculates a cutoff exactly 31 days before the search', () => {
    const nowMilliseconds = Date.UTC(2026, 8, 14, 12, 0, 0);

    expect(getScheduleCreatedCutoff(nowMilliseconds)).toBe(
      Math.floor(nowMilliseconds / 1000) - 31 * 24 * 60 * 60
    );
  });
});
