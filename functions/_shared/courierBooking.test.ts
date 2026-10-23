// Proves the production booking guard. Run with:
//   node --test functions/_shared/courierBooking.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingBlockedReason, isAutoBookingEnabled } from './courierBooking.ts';

test('manual Delhivery production booking is blocked', () => {
  const courier = { name: 'Delhivery', api_provider: 'delhivery', integration_status: 'manual', api_environment: 'production' };
  assert.equal(isAutoBookingEnabled(courier), false);
  assert.match(bookingBlockedReason(courier) ?? '', /bookings stay manual/);
});

test('manual courier with default environment is blocked', () => {
  const courier = { name: 'Delhivery', api_provider: 'delhivery', integration_status: 'manual' };
  assert.notEqual(bookingBlockedReason(courier), null);
});

test('Delhivery staging booking is allowed while status stays manual', () => {
  const courier = { name: 'Delhivery', api_provider: 'delhivery', integration_status: 'manual', api_environment: 'staging' };
  assert.equal(bookingBlockedReason(courier), null);
});

test('other manual couriers stay blocked even on staging', () => {
  const courier = { name: 'NextDrop', api_provider: 'nextdrop', integration_status: 'manual', api_environment: 'staging' };
  assert.notEqual(bookingBlockedReason(courier), null);
});

test('integrated couriers are allowed', () => {
  const courier = { name: 'Delhivery', api_provider: 'delhivery', integration_status: 'integrated', api_environment: 'production' };
  assert.equal(bookingBlockedReason(courier), null);
});
