// Home base for shipping direction/domestic-vs-international logic —
// shared by NewOrder.tsx (outbound leg) and OrderReturns.tsx (inbound
// return leg / outbound exchange replacement leg).
export const HOME_COUNTRY = 'AE';

// NextDrop's fixed "Domestic Cities" list (their API doc), used as a
// dropdown for UAE addresses instead of free text — a typo'd or
// differently-cased city name (e.g. "sharjah" vs "Sharjah") was a real,
// hard-to-diagnose cause of courier booking failures (see Customers.tsx's
// city field). Not meaningful outside the UAE, so only offered when
// country_code === HOME_COUNTRY; other countries stay free text.
export const UAE_CITIES = [
  'Abu Dhabi',
  'Al Ain',
  'Dubai',
  'Sharjah',
  'Ajman',
  'Umm Al Quwain',
  'Fujairah',
  'Ras Al Khaimah',
  'Hatta',
  'Western Region',
];

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cod: 'Cash on delivery',
  upi: 'UPI',
};

// Date <input> gives a date-only string; created_at is a timestamptz, so a
// "to" date filter needs to mean "through the end of that day," not "at
// midnight starting it" — one day past dateStr, used with a `<` (not `<=`)
// filter. Shared by Orders.tsx and Reports.tsx's date-range filters.
export function dayAfter(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
