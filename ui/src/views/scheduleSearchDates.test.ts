import {
  getCreatedRange,
  getDefaultSearchCriteria,
  parseCalendarDate,
} from './scheduleSearchDates';

describe('search creation dates', () => {
  it('defaults to one calendar year through today', () => {
    expect(getDefaultSearchCriteria(new Date(2026, 8, 16, 12))).toEqual({
      accountNumber: '',
      confirmationNumber: '',
      createdAfter: '2025-09-16',
      createdBefore: '2026-09-16',
    });
  });
  it('clamps a leap-day anniversary to the last day of February', () => {
    expect(getDefaultSearchCriteria(new Date(2024, 1, 29)).createdAfter).toBe(
      '2023-02-28'
    );
  });
  it.each([
    '',
    '2026-02-30',
    '2026-13-01',
    '2026-01-00',
    '2026-1-1',
    'not a date',
    '1969-12-31',
  ])('rejects invalid calendar input %s', (value) => {
    expect(parseCalendarDate(value)).toBeNull();
    expect(getCreatedRange(value, '2026-12-31')).toMatchObject({
      range: null,
      afterError: expect.any(String),
    });
  });
  it('rejects missing and reversed upper dates', () => {
    expect(getCreatedRange('2026-01-01', '').range).toBeNull();
    expect(getCreatedRange('2026-01-02', '2026-01-01')).toMatchObject({
      range: null,
      beforeError: expect.any(String),
    });
  });
  it('keeps the earliest permitted date valid in timezones east of UTC', () => {
    const { range } = getCreatedRange('1970-01-01', '1970-01-01');
    expect(range?.gte).toBe(Math.max(0, new Date(1970, 0, 1).getTime() / 1000));
    expect(range?.lt).toBe(new Date(1970, 0, 2).getTime() / 1000);
  });
  it('includes the entire selected last day with an exclusive next-day boundary', () => {
    const { range } = getCreatedRange('2026-09-16', '2026-09-16');
    expect(range).toEqual({
      gte: new Date(2026, 8, 16).getTime() / 1000,
      lt: new Date(2026, 8, 17).getTime() / 1000,
    });
    expect(range && new Date(2026, 8, 16, 23, 59, 59).getTime() / 1000 < range.lt).toBe(
      true
    );
  });
  it.each([
    [2026, 2, 8],
    [2026, 10, 1],
    [2024, 1, 29],
  ])(
    'uses local midnight across offset and month changes (%i/%i/%i)',
    (year, month, day) => {
      const from = new Date(year, month, day);
      const to = new Date(year, month, day + 1);
      const value = [
        year,
        String(month + 1).padStart(2, '0'),
        String(day).padStart(2, '0'),
      ].join('-');
      const { range } = getCreatedRange(value, value);
      expect(range).toEqual({ gte: from.getTime() / 1000, lt: to.getTime() / 1000 });
      expect(range && range.lt - range.gte).toBe(
        86400 + (to.getTimezoneOffset() - from.getTimezoneOffset()) * 60
      );
    }
  );
});
