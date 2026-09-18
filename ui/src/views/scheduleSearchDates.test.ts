import {
  criteriaEqual,
  getDefaultSearchCriteria,
  normalizeCriteria,
} from './scheduleSearchDates';

describe('search criteria', () => {
  it('defaults to empty identifiers', () => {
    expect(getDefaultSearchCriteria()).toEqual({
      accountNumber: '',
      confirmationNumber: '',
    });
  });

  it('normalizes whitespace and compares case-insensitively', () => {
    const criteria = normalizeCriteria({
      accountNumber: ' 111 ',
      confirmationNumber: ' AbC ',
    });
    expect(criteria).toEqual({ accountNumber: '111', confirmationNumber: 'AbC' });
    expect(
      criteriaEqual(criteria, { accountNumber: '111', confirmationNumber: 'abc' })
    ).toBe(true);
  });
});
