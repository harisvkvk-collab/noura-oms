// Tests the credential resolver with an in-memory fake of the Supabase client.
// Proves staging never reads or uses production credentials or warehouses.
// Run with:  node --test functions/_shared/getAdapterForCourier.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapterForCourier } from './getAdapterForCourier.ts';
import { DelhiveryAdapter } from '../../adapters/delhivery.ts';

type Row = Record<string, unknown>;

// Records every .eq() filter, so a test can prove which environment was read.
function fakeSupabase(tables: Record<string, Row[]>) {
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  const client = {
    from(table: string) {
      const active: Record<string, unknown> = {};
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          active[column] = value;
          filters.push({ table, column, value });
          return builder;
        },
        async maybeSingle() {
          const row = (tables[table] ?? []).find((r) => Object.entries(active).every(([k, v]) => r[k] === v));
          return { data: row ?? null, error: null };
        },
      };
      return builder;
    },
  };
  return { client: client as never, filters };
}

function readsEnvironment(filters: Array<{ table: string; column: string; value: unknown }>, env: string) {
  return filters.some((f) => f.table === 'courier_api_credentials' && f.column === 'environment' && f.value === env);
}

const courierRow = { id: 'c1', name: 'Delhivery' };

test('staging with no warehouse fails clearly and never reads production', async () => {
  const { client, filters } = fakeSupabase({
    couriers: [courierRow],
    courier_api_credentials: [
      { courier_id: 'c1', environment: 'staging', api_token: 'STAGING-TOKEN', base_url: null, pickup_location: null, extra_config: null, active: true },
      { courier_id: 'c1', environment: 'production', api_token: 'LIVE-TOKEN', base_url: null, pickup_location: 'WHITEWAY WOOD B2C', extra_config: null, active: true },
    ],
  });
  await assert.rejects(
    getAdapterForCourier(client, { name: 'Delhivery', api_provider: 'delhivery', api_environment: 'staging' }),
    /Delhivery staging: registered warehouse name is not set/,
  );
  assert.equal(readsEnvironment(filters, 'production'), false, 'production credentials must not be read for staging');
});

test('staging with its own warehouse builds a staging adapter only', async () => {
  const { client, filters } = fakeSupabase({
    couriers: [courierRow],
    courier_api_credentials: [
      { courier_id: 'c1', environment: 'staging', api_token: 'STAGING-TOKEN', base_url: null, pickup_location: 'Staging Warehouse', extra_config: null, active: true },
      { courier_id: 'c1', environment: 'production', api_token: 'LIVE-TOKEN', base_url: null, pickup_location: 'WHITEWAY WOOD B2C', extra_config: null, active: true },
    ],
  });
  const adapter = await getAdapterForCourier(client, { name: 'Delhivery', api_provider: 'delhivery', api_environment: 'staging' });
  assert.ok(adapter instanceof DelhiveryAdapter);
  assert.equal(readsEnvironment(filters, 'production'), false);
});

test('missing staging token returns null, with no production fallback', async () => {
  const { client, filters } = fakeSupabase({
    couriers: [courierRow],
    courier_api_credentials: [
      { courier_id: 'c1', environment: 'production', api_token: 'LIVE-TOKEN', base_url: null, pickup_location: 'WHITEWAY WOOD B2C', extra_config: null, active: true },
    ],
  });
  const adapter = await getAdapterForCourier(client, { name: 'Delhivery', api_provider: 'delhivery', api_environment: 'staging' });
  assert.equal(adapter, null);
  assert.equal(readsEnvironment(filters, 'production'), false);
});

test('production uses the production warehouse and token', async () => {
  const { client, filters } = fakeSupabase({
    couriers: [courierRow],
    courier_api_credentials: [
      { courier_id: 'c1', environment: 'production', api_token: 'LIVE-TOKEN', base_url: null, pickup_location: 'WHITEWAY WOOD B2C', extra_config: null, active: true },
    ],
  });
  const adapter = await getAdapterForCourier(client, { name: 'Delhivery', api_provider: 'delhivery', api_environment: 'production' });
  assert.ok(adapter instanceof DelhiveryAdapter);
  assert.equal(readsEnvironment(filters, 'staging'), false);
});
