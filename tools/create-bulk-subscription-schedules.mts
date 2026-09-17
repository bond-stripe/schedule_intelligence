#!/usr/bin/env tsx
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_CONCURRENCY = 5;
const MAX_COUNT = 10_000;
const MAX_REQUEST_ATTEMPTS = 3;
const LEASE_TERM_MONTHS = 12;
const TEST_ACH_PAYMENT_METHOD = 'pm_usBankAccount';
const STRIPE_API_VERSION = '2023-08-16';

type StripeObject = {
  id: string;
  [key: string]: unknown;
};

type Fixture = {
  accountNumber: string;
  amount: number;
  confirmationNumber: string;
  customerEmail: string;
  customerName: string;
  startDate: number;
  suffix: string;
};

type CreatedFixture = Fixture & {
  customerId: string;
  paymentMethodId: string;
  productId: string;
  scheduleId: string;
};

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function randomInteger(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function createFixture(): Fixture {
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
  const suffix = `${Date.now()}-${randomInteger(100_000, 999_999)}`;
  const customerName = `${randomItem(firstNames)} ${randomItem(lastNames)}`;

  return {
    accountNumber: `ACCT-${randomInteger(10_000_000, 99_999_999)}`,
    amount: randomInteger(30_000, 100_000),
    confirmationNumber: `CONF-${randomInteger(10_000_000, 99_999_999)}`,
    customerEmail: `${customerName.replace(/\s+/g, '').toLowerCase()}+@example.com`,
    customerName,
    startDate: Math.floor(Date.now() / 1000) + randomInteger(1, 30) * 24 * 60 * 60,
    suffix,
  };
}

function parseStripeResponse(stdout: string): StripeObject {
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(`Stripe CLI returned an unexpected response: ${stdout}`);
  }

  const response = JSON.parse(stdout.slice(firstBrace, lastBrace + 1)) as {
    error?: { message?: string };
    id?: unknown;
  };

  if (response.error) {
    throw new Error(response.error.message ?? 'Stripe API request failed');
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
  const args = [
    'post',
    path,
    '--confirm',
    '--color',
    'off',
    '--stripe-version',
    STRIPE_API_VERSION,
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
      const commandError = error as Error & { stderr?: string };
      const message = commandError.stderr?.trim() || commandError.message;
      const transientFailure =
        /no such host|connection|rate.?limit|timeout|timed out|unexpected eof/i.test(
          message
        );

      if (!transientFailure || attempt === MAX_REQUEST_ATTEMPTS) {
        throw new Error(message);
      }

      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }

  throw new Error('Stripe request failed without an error response');
}

async function createLeaseSchedule(): Promise<CreatedFixture> {
  const fixture = createFixture();
  const [customer, product] = await Promise.all([
    stripePost('/v1/customers', [
      ['name', fixture.customerName],
      ['email', fixture.customerEmail],
      ['description', 'Bulk fixture for Scheduled Subscription Search'],
    ]),
    stripePost('/v1/products', [
      ['name', `Lease payment ${fixture.suffix}`],
      ['description', 'Monthly residential lease payment'],
      ['metadata[fixture_type]', 'scheduled_subscription_search'],
    ]),
  ]);

  const paymentMethod = await stripePost(
    `/v1/payment_methods/${TEST_ACH_PAYMENT_METHOD}/attach`,
    [['customer', customer.id]]
  );

  await stripePost(`/v1/customers/${customer.id}`, [
    ['invoice_settings[default_payment_method]', paymentMethod.id],
  ]);

  const schedule = await stripePost('/v1/subscription_schedules', [
    ['customer', customer.id],
    ['start_date', fixture.startDate],
    ['end_behavior', 'cancel'],
    ['default_settings[collection_method]', 'charge_automatically'],
    ['default_settings[default_payment_method]', paymentMethod.id],
    ['phases[0][iterations]', LEASE_TERM_MONTHS],
    ['phases[0][items][0][price_data][currency]', 'usd'],
    ['phases[0][items][0][price_data][product]', product.id],
    ['phases[0][items][0][price_data][recurring][interval]', 'month'],
    ['phases[0][items][0][price_data][recurring][interval_count]', 1],
    ['phases[0][items][0][price_data][unit_amount]', fixture.amount],
    ['phases[0][items][0][quantity]', 1],
    ['phases[0][metadata][AccountNumber]', fixture.accountNumber],
    ['phases[0][metadata][ConfirmationNumber]', fixture.confirmationNumber],
  ]);

  return {
    ...fixture,
    customerId: customer.id,
    paymentMethodId: paymentMethod.id,
    productId: product.id,
    scheduleId: schedule.id,
  };
}

function readPositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function parseArguments(): {
  concurrency: number;
  count: number;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const concurrencyIndex = args.indexOf('--concurrency');
  const countArgument = args.find((arg) => !arg.startsWith('--'));
  const count = readPositiveInteger(countArgument, 'count');
  const concurrency =
    concurrencyIndex === -1
      ? DEFAULT_CONCURRENCY
      : readPositiveInteger(args[concurrencyIndex + 1], 'concurrency');

  if (count > MAX_COUNT) {
    throw new Error(`count must not exceed ${MAX_COUNT}`);
  }

  if (concurrency > count) {
    return { concurrency: count, count, dryRun };
  }

  return { concurrency, count, dryRun };
}

async function main(): Promise<void> {
  const { concurrency, count, dryRun } = parseArguments();

  if (dryRun) {
    const fixture = createFixture();
    process.stdout.write(
      `${JSON.stringify(
        {
          ...fixture,
          amountUsd: (fixture.amount / 100).toFixed(2),
          leaseTermMonths: LEASE_TERM_MONTHS,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(
    `Creating ${count} lease schedules with concurrency ${concurrency}...\n`
  );

  let nextIndex = 0;
  let completed = 0;
  const created: CreatedFixture[] = [];
  const failures: Array<{ index: number; message: string }> = [];

  async function worker(): Promise<void> {
    while (nextIndex < count) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        created.push(await createLeaseSchedule());
      } catch (error: unknown) {
        failures.push({
          index: index + 1,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      completed += 1;
      if (completed % 10 === 0 || completed === count) {
        process.stdout.write(
          `Completed ${completed}/${count}; succeeded ${created.length}; failed ${failures.length}\n`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  process.stdout.write(
    `${JSON.stringify(
      {
        created: created.map((fixture) => ({
          accountNumber: fixture.accountNumber,
          amountUsd: (fixture.amount / 100).toFixed(2),
          confirmationNumber: fixture.confirmationNumber,
          customerId: fixture.customerId,
          scheduleId: fixture.scheduleId,
          startDate: fixture.startDate,
        })),
        failures,
      },
      null,
      2
    )}\n`
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n\n` +
      'Usage: pnpm bulk:subs -- <count> [--concurrency <count>] [--dry-run]\n'
  );
  process.exitCode = 1;
});
