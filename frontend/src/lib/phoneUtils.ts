import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';

const DEFAULT_COUNTRY = 'AE';

/**
 * Normalize a phone number to E.164 format (e.g., +971501234567).
 * Returns null if the number is empty or invalid.
 * Throws an error if the format is invalid.
 */
export function normalizePhoneNumber(input: string | null | undefined): string | null {
  if (!input || !input.trim()) return null;

  try {
    const parsed = parsePhoneNumber(input.trim(), DEFAULT_COUNTRY);
    if (!parsed || !isValidPhoneNumber(input.trim(), DEFAULT_COUNTRY)) {
      throw new Error(`Invalid phone number. Please enter a valid ${DEFAULT_COUNTRY} number.`);
    }
    return parsed.format('E.164');
  } catch (err) {
    throw new Error(`Invalid phone number. Please enter a valid ${DEFAULT_COUNTRY} number.`);
  }
}

/**
 * Check if a string looks like it could be a phone number (mostly digits).
 * Used to decide whether to search by phone in customer lookup.
 */
export function looksLikePhoneNumber(input: string): boolean {
  const digits = input.replace(/\D/g, '');
  return digits.length >= 7; // At least 7 digits
}

/**
 * Attempt to normalize a phone search string, or return null if it doesn't look like a phone.
 * Unlike normalizePhoneNumber, this doesn't throw — it's for optional search matching.
 */
export function tryNormalizePhoneForSearch(input: string): string | null {
  if (!looksLikePhoneNumber(input)) return null;

  try {
    const parsed = parsePhoneNumber(input.trim(), DEFAULT_COUNTRY);
    return parsed ? parsed.format('E.164') : null;
  } catch {
    return null;
  }
}
