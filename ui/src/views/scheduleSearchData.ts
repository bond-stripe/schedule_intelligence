import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import { getCreatedRange, type SearchCriteria } from './scheduleSearchDates';

// Increment when cached result semantics or validation rules change.
export const SEARCH_STORAGE_KEY = 'scheduled-subscription-search:last-search:v12';
export const MAX_RESULTS = 50;
export type SearchScope = {
  accountId: string;
  mode: ExtensionContextValue['environment']['mode'];
};
export const getSearchStorageKey = (scope: SearchScope) =>
  SEARCH_STORAGE_KEY + ':' + scope.accountId + ':' + scope.mode;

export type ScheduleStatus =
  'active' | 'canceled' | 'completed' | 'not_started' | 'released';
export type SearchResult = {
  scheduleId: string;
  customerId: string;
  customerEmail: string | null;
  accountNumber: string;
  confirmationNumber: string;
  startDate: number | null;
  endDate: number | null;
  endedAt: number | null;
  endBehavior: 'cancel' | 'release' | 'other';
  status: ScheduleStatus;
};
export type CachedSearch = {
  scope: SearchScope;
  criteria: SearchCriteria;
  searchedAt: number;
  scannedScheduleCount: number;
  results: SearchResult[];
  status: 'complete' | 'limit_reached';
};

export const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  Number.isFinite(new Date(value * 1000).getTime());

export const formatDate = (timestamp: number | null) =>
  timestamp === null
    ? 'Unknown'
    : new Date(timestamp * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

/** Absolute links prevent the app host from treating navigation as another drawer. */
export const getDashboardUrl = (
  mode: ExtensionContextValue['environment']['mode'],
  path: string
) => 'https://dashboard.stripe.com' + (mode === 'test' ? '/test' : '') + path;
export const formatScheduleId = (scheduleId: string) =>
  'sub_sched_...' + scheduleId.slice(-4);
export const formatCustomerId = (customerId: string) =>
  customerId.length > 10 ? 'cus_...' + customerId.slice(-6) : customerId;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNullableTimestamp = (value: unknown) => value === null || isTimestamp(value);
const isCriteria = (value: unknown): value is SearchCriteria =>
  isRecord(value) &&
  typeof value.accountNumber === 'string' &&
  typeof value.confirmationNumber === 'string' &&
  Boolean(value.accountNumber.trim() || value.confirmationNumber.trim()) &&
  typeof value.createdAfter === 'string' &&
  typeof value.createdBefore === 'string' &&
  getCreatedRange(value.createdAfter, value.createdBefore).range !== null;
const isResult = (value: unknown): value is SearchResult =>
  isRecord(value) &&
  typeof value.scheduleId === 'string' &&
  value.scheduleId.length > 0 &&
  typeof value.customerId === 'string' &&
  (typeof value.customerEmail === 'string' || value.customerEmail === null) &&
  typeof value.accountNumber === 'string' &&
  typeof value.confirmationNumber === 'string' &&
  isNullableTimestamp(value.startDate) &&
  isNullableTimestamp(value.endDate) &&
  isNullableTimestamp(value.endedAt) &&
  ['cancel', 'release', 'other'].includes(value.endBehavior as string) &&
  ['active', 'canceled', 'completed', 'not_started', 'released'].includes(
    value.status as string
  );

export const parseCachedSearch = (
  value: string | null,
  scope: SearchScope
): CachedSearch | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.scope) ||
      parsed.scope.accountId !== scope.accountId ||
      parsed.scope.mode !== scope.mode ||
      !isCriteria(parsed.criteria) ||
      !isTimestamp(parsed.searchedAt) ||
      typeof parsed.scannedScheduleCount !== 'number' ||
      !Number.isSafeInteger(parsed.scannedScheduleCount) ||
      parsed.scannedScheduleCount < 0 ||
      (parsed.status !== 'complete' && parsed.status !== 'limit_reached') ||
      !Array.isArray(parsed.results) ||
      parsed.results.length > MAX_RESULTS ||
      !parsed.results.every(isResult)
    )
      return null;
    const results = parsed.results;
    const criteria = parsed.criteria;
    if (
      parsed.scannedScheduleCount < results.length ||
      (parsed.status === 'limit_reached' &&
        (results.length !== MAX_RESULTS || parsed.scannedScheduleCount <= MAX_RESULTS))
    )
      return null;
    return {
      scope,
      criteria,
      searchedAt: parsed.searchedAt,
      scannedScheduleCount: parsed.scannedScheduleCount,
      results,
      status: parsed.status,
    };
  } catch {
    return null;
  }
};
