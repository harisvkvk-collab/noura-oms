// Couriers named 'Other UAE courier' / 'Other local courier' are generic
// placeholders — the real company name is captured per-shipment-leg in
// manual_courier_name instead. Anywhere a courier name is shown, prefer
// that over the generic row name.
export const GENERIC_COURIER_NAMES = ['Other UAE courier', 'Other local courier'];

export function isGenericCourierName(name: string | null | undefined): boolean {
  return !!name && GENERIC_COURIER_NAMES.includes(name);
}

export function displayCourierName(
  courierName: string | null | undefined,
  manualCourierName: string | null | undefined,
): string | null {
  const manual = manualCourierName?.trim();
  return manual || courierName || null;
}

// Mirror of functions/_shared/courierBooking.ts — keep the two in sync.
// Whether an order's courier leg is booked automatically through its API.
export function isAutoBookingEnabled(courier: {
  api_provider: string | null;
  integration_status: string;
  api_environment?: string | null;
}): boolean {
  if (courier.integration_status === 'integrated') return true;
  return courier.api_provider === 'delhivery' && courier.api_environment === 'staging';
}
