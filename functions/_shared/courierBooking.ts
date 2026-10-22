// Single rule for when an order's courier leg is booked automatically
// through its API. Mirrored in frontend/src/lib/courier.ts — keep both in sync.
//
// - Integrated couriers (couriers.integration_status = 'integrated') book
//   in whichever environment couriers.api_environment points at.
// - Delhivery is special-cased for testing: while it is set to 'staging',
//   bookings go to Delhivery's sandbox even though its integration_status
//   stays 'manual' (so production orders keep using the manual flow until
//   the staging test is confirmed and the status is flipped by hand).

export type BookableCourier = {
  api_provider: string | null;
  integration_status: string;
  api_environment?: string | null;
};

export function isAutoBookingEnabled(courier: BookableCourier): boolean {
  if (courier.integration_status === 'integrated') return true;
  return courier.api_provider === 'delhivery' && courier.api_environment === 'staging';
}
