// Per-courier credential field schema for the Settings screen. Keyed by
// couriers.api_provider (not name — provider is the stable adapter-key
// identifier; a courier's display name could change without its API
// integration changing). Adding a genuinely new courier later means: one
// new row in `couriers`, one new entry here if it needs non-generic fields
// (skip it entirely to just get the generic single-API-key fallback), and
// eventually its own adapter file — this screen itself doesn't change.

export type CredentialFieldKey = 'api_token' | 'pickup_location' | 'base_url';

// Documented host for each Delhivery environment (adapters/delhivery.ts uses
// the same values when no base URL is saved). Shown as the field's
// placeholder — a blank save leaves the stored value unchanged.
export const DELHIVERY_DEFAULT_BASE_URLS = {
  staging: 'https://staging-express.delhivery.com',
  production: 'https://track.delhivery.com',
} as const;

// Fields not covered by a real courier_api_credentials column land in
// extra_config instead (a jsonb column meant for exactly this — "wallet
// threshold, webhook doc status, customer_branch for NextDrop, etc.", per
// schema.sql). customer_branch is NextDrop's registered branch name
// (portal → account settings) — mandatory on every booking call; there was
// no field for it here before, so it was always sent as an empty string,
// which is why bookings failed with "Incomplete request parameters" even
// with a valid API key on file.
export type ExtraConfigFieldKey = 'customer_branch';

// kind: 'url' fields are plain text (not masked) — a base URL isn't a
// secret. defaultValue is shown as the placeholder only.
export type CredentialFieldDef =
  | { key: CredentialFieldKey; label: string; environment: 'staging' | 'production' | false; kind?: 'url'; defaultValue?: string }
  | { key: ExtraConfigFieldKey; label: string; environment: 'staging' | 'production' | false; extraConfig: true };

export const GENERIC_FALLBACK_FIELDS: CredentialFieldDef[] = [
  { key: 'api_token', label: 'API Key', environment: false },
];

export const courierCredentialFields: Record<string, CredentialFieldDef[]> = {
  nextdrop: [
    { key: 'api_token', label: 'API Key', environment: false },
    { key: 'customer_branch', label: 'Customer Branch (from NextDrop portal)', environment: false, extraConfig: true },
  ],
  delhivery: [
    { key: 'api_token', label: 'Staging Token', environment: 'staging' },
    { key: 'base_url', label: 'Staging Base URL', environment: 'staging', kind: 'url', defaultValue: DELHIVERY_DEFAULT_BASE_URLS.staging },
    { key: 'api_token', label: 'Production Token', environment: 'production' },
    { key: 'base_url', label: 'Production Base URL', environment: 'production', kind: 'url', defaultValue: DELHIVERY_DEFAULT_BASE_URLS.production },
    // Must exactly match the warehouse name registered in Delhivery.
    { key: 'pickup_location', label: 'Registered Warehouse Name', environment: false },
  ],
};

export function fieldsForProvider(apiProvider: string | null): CredentialFieldDef[] {
  if (apiProvider && courierCredentialFields[apiProvider]) return courierCredentialFields[apiProvider];
  return GENERIC_FALLBACK_FIELDS;
}

export function resolveEnvironment(field: CredentialFieldDef): 'staging' | 'production' {
  return field.environment || 'production';
}
