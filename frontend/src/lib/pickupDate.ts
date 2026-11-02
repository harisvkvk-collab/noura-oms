// Delhivery only takes pickup requests for today or the next few days.
// These helpers keep that rule in one place for the order form and the
// Deliveries pickup card.

export const PICKUP_WINDOW_DAYS = 7;

// Local calendar date (YYYY-MM-DD) for a day offset from today.
export function localDateISO(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Plain-language reason a pickup date can't be used, or null if it's fine.
export function pickupDateProblem(dateISO: string): string | null {
  if (!dateISO) return 'Choose a pickup date.';
  if (dateISO < localDateISO(0)) return 'That date has already passed. Choose today or a later date.';
  const lastDay = localDateISO(PICKUP_WINDOW_DAYS);
  if (dateISO > lastDay) {
    const readable = new Date(`${lastDay}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `Delhivery can only collect up to ${PICKUP_WINDOW_DAYS} days ahead. Choose a date up to ${readable}.`;
  }
  return null;
}
