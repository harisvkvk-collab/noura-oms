// Generic, courier-agnostic credential lookup for Edge Functions. Reads
// courier_api_credentials via a service_role client (the only role that can
// — see policies.sql), so this only ever runs server-side, never in the
// frontend. Every adapter's config gets built from the same shape here,
// rather than each courier reading its own Deno.env var.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type CourierCredentials = {
  apiToken: string;
  baseUrl: string | null;
  pickupLocation: string | null;
  extraConfig: Record<string, unknown>;
};

// environment defaults to 'production' — the Settings screen (admin UI)
// only ever writes that one row per courier; pass 'staging' explicitly if
// you're testing against a courier's sandbox credentials entered by hand.
export async function getCourierCredentials(
  supabase: SupabaseClient,
  courierName: string,
  environment: string = 'production',
): Promise<CourierCredentials | null> {
  const { data: courier, error: courierError } = await supabase
    .from('couriers')
    .select('id')
    .eq('name', courierName)
    .maybeSingle();
  if (courierError) throw courierError;
  if (!courier) return null;

  const { data: cred, error: credError } = await supabase
    .from('courier_api_credentials')
    .select('api_token, base_url, pickup_location, extra_config, active')
    .eq('courier_id', courier.id)
    .eq('environment', environment)
    .maybeSingle();
  if (credError) throw credError;
  if (!cred || !cred.active || !cred.api_token) return null;

  return {
    apiToken: cred.api_token,
    baseUrl: cred.base_url,
    pickupLocation: cred.pickup_location,
    extraConfig: (cred.extra_config as Record<string, unknown> | null) ?? {},
  };
}
