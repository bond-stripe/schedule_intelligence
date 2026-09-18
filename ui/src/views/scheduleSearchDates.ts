export type SearchCriteria = {
  accountNumber: string;
  confirmationNumber: string;
};

export const getDefaultSearchCriteria = (): SearchCriteria => ({
  accountNumber: '',
  confirmationNumber: '',
});

export const normalizeCriteria = (criteria: SearchCriteria): SearchCriteria => ({
  ...criteria,
  accountNumber: criteria.accountNumber.trim(),
  confirmationNumber: criteria.confirmationNumber.trim(),
});

export const criteriaEqual = (a: SearchCriteria, b: SearchCriteria) =>
  a.accountNumber.trim().toLowerCase() === b.accountNumber.trim().toLowerCase() &&
  a.confirmationNumber.trim().toLowerCase() === b.confirmationNumber.trim().toLowerCase();
