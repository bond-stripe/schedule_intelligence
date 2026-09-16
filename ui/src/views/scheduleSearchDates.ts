export type SearchCriteria = {
  accountNumber: string;
  confirmationNumber: string;
  createdAfter: string;
  createdBefore: string;
};

export type CreatedRange = { gte: number; lt: number };

// DateField values are calendar dates, not UTC instants. Construct local midnight
// explicitly so both filtering and displayed dates use the user's local timezone.
export const parseCalendarDate = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return year >= 1970 &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
};

export const calendarDateValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const getDefaultSearchCriteria = (now = new Date()): SearchCriteria => {
  const year = now.getFullYear();
  const month = now.getMonth() - 1;
  // Clamp month ends instead of letting dates such as March 31 roll into March.
  const lastDay = new Date(year, month + 1, 0).getDate();
  return {
    accountNumber: '',
    confirmationNumber: '',
    createdAfter: calendarDateValue(
      new Date(year, month, Math.min(now.getDate(), lastDay))
    ),
    createdBefore: calendarDateValue(now),
  };
};

export const getCreatedRange = (
  after: string,
  before: string
): {
  range: CreatedRange | null;
  afterError?: string;
  beforeError?: string;
} => {
  const first = parseCalendarDate(after);
  const last = parseCalendarDate(before);
  if (!first || !last)
    return {
      range: null,
      ...(!first ? { afterError: 'Enter a valid start date.' } : {}),
      ...(!last ? { beforeError: 'Enter a valid end date.' } : {}),
    };
  if (first > last)
    return { range: null, beforeError: 'Choose a date on or after the start date.' };
  // Advance the calendar day, not 24 hours: a local day can be 23 or 25 hours.
  const nextDay = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  // Local midnight on 1970-01-01 can precede the Unix epoch east of UTC.
  // Stripe schedules cannot predate the epoch; keep the lower API bound valid.
  return {
    range: { gte: Math.max(0, first.getTime() / 1000), lt: nextDay.getTime() / 1000 },
  };
};

export const normalizeCriteria = (criteria: SearchCriteria): SearchCriteria => ({
  ...criteria,
  accountNumber: criteria.accountNumber.trim(),
  confirmationNumber: criteria.confirmationNumber.trim(),
});

export const criteriaEqual = (a: SearchCriteria, b: SearchCriteria) =>
  a.accountNumber.trim().toLowerCase() === b.accountNumber.trim().toLowerCase() &&
  a.confirmationNumber.trim().toLowerCase() ===
    b.confirmationNumber.trim().toLowerCase() &&
  a.createdAfter === b.createdAfter &&
  a.createdBefore === b.createdBefore;
