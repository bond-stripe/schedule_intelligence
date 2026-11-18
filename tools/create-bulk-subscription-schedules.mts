#!/usr/bin/env tsx
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_CONCURRENCY = 20;
const DEFAULT_CUSTOMER_POOL_SIZE = 500;
const MAX_COUNT = 20_000;
const MAX_REQUEST_ATTEMPTS = 6;
const LEASE_TERM_MONTHS = 12;
const PRICE_NICKNAME = 'auto lease';
const MIN_PRICE_CENTS = 30_000;
const MAX_PRICE_CENTS = 80_000;
// Start times fall between 14:00 and 22:00 UTC so the calendar date is the same
// in UTC and every US time zone.
const START_HOUR_UTC = 14;
const START_WINDOW_SECONDS = 8 * 60 * 60;
const TEST_ACH_PAYMENT_METHOD = 'pm_usBankAccount';
const STRIPE_API_VERSION = '2023-08-16';
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

type StripeObject = {
  id: string;
  [key: string]: unknown;
};

type PoolCustomer = { customerId: string; paymentMethodId: string };

type CreatedSchedule = {
  accountNumber: string;
  amountCents: number;
  confirmationNumber: string;
  customerId: string;
  priceId: string;
  scheduleId: string;
  startDate: number;
};

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function randomInteger(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

const usedAccountNumbers = new Set<string>();
const usedConfirmationNumbers = new Set<string>();

function uniqueValue(used: Set<string>, generate: () => string): string {
  let value = generate();
  while (used.has(value)) value = generate();
  used.add(value);
  return value;
}

// 11 digits starting with "11".
const createAccountNumber = () =>
  uniqueValue(
    usedAccountNumbers,
    () => '11' + String(randomInteger(0, 999_999_999)).padStart(9, '0')
  );

// 15 uppercase alphanumeric characters starting with "S".
const createConfirmationNumber = () =>
  uniqueValue(
    usedConfirmationNumbers,
    () => 'S' + Array.from({ length: 14 }, () => randomItem([...ALPHANUMERIC])).join('')
  );

function createCustomerIdentity() {
  const firstNames = [
    'Tubence',
    'Jimothy',
    'Yodan',
    'T.S.',
    'Babb',
    'Cakeums',
    'Fribeev',
    'DeeDee',
  ] as const;
  const lastNames = [
    'Babbage',
    'Poldler',
    'Freebeer',
    'Drovens',
    'Bigups',
    'Pinkums',
    'Slaloms',
    'Wells',
  ] as const;
  const name = `${randomItem(firstNames)} ${randomItem(lastNames)}`;
  return { name, email: `${name.replace(/\W+/g, '').toLowerCase()}@example.com` };
}

function parseStripeResponse(stdout: string): StripeObject {
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(`Stripe CLI returned an unexpected response: ${stdout}`);
  }

  const response = JSON.parse(stdout.slice(firstBrace, lastBrace + 1)) as {
    error?: { message?: string; type?: string; code?: string };
    id?: unknown;
  };

  if (response.error) {
    const error = new Error(response.error.message ?? 'Stripe API request failed');
    (error as Error & { code?: string }).code = response.error.code;
    throw error;
  }

  if (typeof response.id !== 'string') {
    throw new Error('Stripe API response did not include an object ID');
  }

  return response as StripeObject;
}

async function stripePost(
  path: string,
  parameters: ReadonlyArray<readonly [string, string | number]>
): Promise<StripeObject> {
  // One key per logical request, so a retry after a timeout cannot create a duplicate.
  const args = [
    'post',
    path,
    '--confirm',
    '--color',
    'off',
    '--stripe-version',
    STRIPE_API_VERSION,
    '--idempotency',
    randomUUID(),
  ];

  for (const [key, value] of parameters) {
    args.push('-d', `${key}=${value}`);
  }

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('stripe', args, {
        maxBuffer: 10 * 1024 * 1024,
      });
      return parseStripeResponse(stdout);
    } catch (error: unknown) {
      const commandError = error as Error & { code?: string; stderr?: string };
      const message = commandError.stderr?.trim() || commandError.message;
      const transientFailure =
        commandError.code === 'rate_limit' ||
        commandError.code === 'lock_timeout' ||
        /no such host|connection|rate.?limit|too many requests|timeout|timed out|unexpected eof/i.test(
          message
        );

      if (!transientFailure || attempt === MAX_REQUEST_ATTEMPTS) {
        throw new Error(message);
      }

      const backoff = 500 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * 250));
    }
  }

  throw new Error('Stripe request failed without an error response');
}

async function runPool<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
  onSettled: (index: number, outcome: { value?: T; error?: string }) => void
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < count) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        onSettled(index, { value: await task(index) });
      } catch (error: unknown) {
        onSettled(index, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
}

async function createPoolCustomer(batch: string): Promise<PoolCustomer> {
  const identity = createCustomerIdentity();
  const customer = await stripePost('/v1/customers', [
    ['name', identity.name],
    ['email', identity.email],
    ['description', 'Bulk fixture for Future Dated Subscriptions'],
    ['metadata[fixture_batch]', batch],
  ]);
  const paymentMethod = await stripePost(
    `/v1/payment_methods/${TEST_ACH_PAYMENT_METHOD}/attach`,
    [['customer', customer.id]]
  );
  return { customerId: customer.id, paymentMethodId: paymentMethod.id };
}

async function createLeaseSchedule(
  customer: PoolCustomer,
  productId: string,
  window: { start: number; days: number },
  batch: string
): Promise<CreatedSchedule> {
  const amountCents = randomInteger(MIN_PRICE_CENTS, MAX_PRICE_CENTS);
  const startDate =
    window.start +
    randomInteger(0, window.days - 1) * 86_400 +
    START_HOUR_UTC * 3600 +
    randomInteger(0, START_WINDOW_SECONDS - 1);
  const accountNumber = createAccountNumber();
  const confirmationNumber = createConfirmationNumber();

  const price = await stripePost('/v1/prices', [
    ['currency', 'usd'],
    ['product', productId],
    ['nickname', PRICE_NICKNAME],
    ['unit_amount', amountCents],
    ['recurring[interval]', 'month'],
    ['recurring[interval_count]', 1],
    ['metadata[fixture_batch]', batch],
  ]);

  const schedule = await stripePost('/v1/subscription_schedules', [
    ['customer', customer.customerId],
    ['start_date', startDate],
    ['end_behavior', 'cancel'],
    ['default_settings[collection_method]', 'charge_automatically'],
    ['default_settings[default_payment_method]', customer.paymentMethodId],
    ['metadata[fixture_batch]', batch],
    ['phases[0][iterations]', LEASE_TERM_MONTHS],
    ['phases[0][items][0][price]', price.id],
    ['phases[0][items][0][quantity]', 1],
    ['phases[0][metadata][AccountNumber]', accountNumber],
    ['phases[0][metadata][ConfirmationNumber]', confirmationNumber],
  ]);

  return {
    accountNumber,
    amountCents,
    confirmationNumber,
    customerId: customer.customerId,
    priceId: price.id,
    scheduleId: schedule.id,
    startDate,
  };
}

function readPositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function readDate(value: string | undefined, label: string): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be a YYYY-MM-DD date`);
  }
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);
}

function parseArguments() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const optionValues = new Set(
    ['--concurrency', '--customers', '--from', '--until', '--batch']
      .map((name) => args.indexOf(name) + 1)
      .filter((index) => index > 0)
  );
  const countArgument = args.find(
    (arg, index) => !arg.startsWith('--') && !optionValues.has(index)
  );
  const count = readPositiveInteger(countArgument, 'count');
  const concurrency = readPositiveInteger(
    option('--concurrency') ?? String(DEFAULT_CONCURRENCY),
    'concurrency'
  );
  const customers = Math.min(
    count,
    readPositiveInteger(
      option('--customers') ?? String(DEFAULT_CUSTOMER_POOL_SIZE),
      'customers'
    )
  );
  const start = readDate(option('--from'), '--from');
  const end = readDate(option('--until'), '--until');
  const days = Math.round((end - start) / 86_400);

  if (count > MAX_COUNT) {
    throw new Error(`count must not exceed ${MAX_COUNT}`);
  }
  if (days < 1) {
    throw new Error('--until must be after --from');
  }
  if (start + START_HOUR_UTC * 3600 <= Date.now() / 1000) {
    throw new Error('--from must be a future date');
  }

  return {
    batch:
      option('--batch') ??
      `bulk-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    concurrency,
    count,
    customers,
    dryRun: args.includes('--dry-run'),
    window: { start, days },
  };
}

async function main(): Promise<void> {
  const { batch, concurrency, count, customers, dryRun, window } = parseArguments();

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          batch,
          count,
          customers,
          firstStartDay: new Date(window.start * 1000).toISOString().slice(0, 10),
          lastStartDay: new Date((window.start + (window.days - 1) * 86_400) * 1000)
            .toISOString()
            .slice(0, 10),
          sampleAccountNumber: createAccountNumber(),
          sampleConfirmationNumber: createConfirmationNumber(),
          sampleAmountUsd: (
            randomInteger(MIN_PRICE_CENTS, MAX_PRICE_CENTS) / 100
          ).toFixed(2),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const logPath = join(tmpdir(), `${batch}.jsonl`);
  writeFileSync(logPath, '');
  process.stdout.write(`Batch ${batch}; writing results to ${logPath}\n`);

  const product = await stripePost('/v1/products', [
    ['name', 'Auto lease'],
    ['description', 'Monthly auto lease payment'],
    ['metadata[fixture_batch]', batch],
  ]);
  process.stdout.write(`Created product ${product.id}\n`);

  const pool: PoolCustomer[] = [];
  let customerFailures = 0;
  await runPool(
    customers,
    concurrency,
    () => createPoolCustomer(batch),
    (_index, outcome) => {
      if (outcome.value) pool.push(outcome.value);
      else customerFailures += 1;
      const done = pool.length + customerFailures;
      if (done % 50 === 0 || done === customers) {
        process.stdout.write(
          `Customers ${done}/${customers}; failed ${customerFailures}\n`
        );
      }
    }
  );
  if (pool.length === 0) throw new Error('No customers could be created');

  const startedAt = Date.now();
  let succeeded = 0;
  const failures: Array<{ index: number; message: string }> = [];
  await runPool(
    count,
    concurrency,
    (index) => createLeaseSchedule(pool[index % pool.length], product.id, window, batch),
    (index, outcome) => {
      if (outcome.value) {
        succeeded += 1;
        appendFileSync(logPath, `${JSON.stringify(outcome.value)}\n`);
      } else {
        failures.push({ index: index + 1, message: outcome.error ?? 'Unknown error' });
      }
      const done = succeeded + failures.length;
      if (done % 100 === 0 || done === count) {
        const perSecond = done / ((Date.now() - startedAt) / 1000);
        process.stdout.write(
          `Schedules ${done}/${count}; succeeded ${succeeded}; failed ${failures.length}; ${perSecond.toFixed(1)}/s\n`
        );
      }
    }
  );

  process.stdout.write(
    `${JSON.stringify({ batch, logPath, succeeded, failures: failures.slice(0, 20), failureCount: failures.length }, null, 2)}\n`
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n\n` +
      'Usage: pnpm bulk:subs -- <count> --from YYYY-MM-DD --until YYYY-MM-DD ' +
      '[--customers <n>] [--concurrency <n>] [--batch <tag>] [--dry-run]\n' +
      '  --until is exclusive: start dates fall on --from through the day before --until.\n'
  );
  process.exitCode = 1;
});
