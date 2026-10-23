// Single rule for when an order's courier leg is booked automatically
// through its API. Mirrored in frontend/src/lib/courier.ts — keep both in sync.
//
// - Integrated couriers (couriers.integration_status = 'integrated') book
//   in whichever environment couriers.api_environment points at.
// - Delhivery is special-cased for testing: while it is set to 'staging',
//   bookings go to Delhivery's sandbox even though its integration_status
//   stays 'manual' (so production orders keep using the manual flow until
//   the staging test is confirmed and the status is flipped by hand).
//
// No imports on purpose: functions/_shared/courierBooking.test.ts loads this
// file directly in Node.

export type BookableCourier = {
  name?: string;
  api_provider: string | null;
  integration_status: string;
  api_environment?: string | null;
};

export function isAutoBookingEnabled(courier: BookableCourier): boolean {
  if (courier.integration_status === 'integrated') return true;
  return courier.api_provider === 'delhivery' && courier.api_environment === 'staging';
}

// The server-side guard used by create-shipment. Returns the message to show
// when booking must not happen, or null when it may proceed. create-shipment
// calls this before any adapter is built, so a blocked booking never reaches
// a courier API.
export function bookingBlockedReason(courier: BookableCourier): string | null {
  if (isAutoBookingEnabled(courier)) return null;
  const name = courier.name ?? 'This courier';
  return `${name} is not an integrated courier, so bookings stay manual.`;
}
