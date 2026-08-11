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
