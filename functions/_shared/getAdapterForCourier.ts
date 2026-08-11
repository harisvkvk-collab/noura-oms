// Resolves a courier row to a ready DeliveryAdapter instance, reading its
// credentials via getCourierCredentials() (service_role only). Adding a new
// integrated courier later means writing its adapter file (implementing
// DeliveryAdapter, adapters/types.ts) plus one new case below — nothing else
// in create-shipment/index.ts or generate-postage-label/index.ts changes.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { DeliveryAdapter } from '../../adapters/types.ts';
import { NextDropAdapter, buildNextDropConfig } from '../../adapters/nextdrop.ts';
import { getCourierCredentials } from './getCourierCredentials.ts';

export async function getAdapterForCourier(
  supabase: SupabaseClient,
  courier: { name: string; api_provider: string | null },
): Promise<DeliveryAdapter | null> {
  const credentials = await getCourierCredentials(supabase, courier.name);
  if (!credentials) return null;

  switch (courier.api_provider) {
    case 'nextdrop':
      return new NextDropAdapter(buildNextDropConfig(credentials));
    default:
      return null;
  }
}
