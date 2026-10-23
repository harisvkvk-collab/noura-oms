// Resolves a courier row to a ready DeliveryAdapter instance, reading its
// credentials via getCourierCredentials() (service_role only). Adding a new
// integrated courier later means writing its adapter file (implementing
// DeliveryAdapter, adapters/types.ts) plus one new case below — nothing else
// in create-shipment/index.ts or generate-postage-label/index.ts changes.
//
// environment comes from couriers.api_environment ('staging' while we test
// against a courier's sandbox, 'production' otherwise), so a courier can be
// tested without its production credentials being used for real bookings.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { DeliveryAdapter } from '../../adapters/types.ts';
import { NextDropAdapter, buildNextDropConfig } from '../../adapters/nextdrop.ts';
import { DelhiveryAdapter, buildDelhiveryConfig } from '../../adapters/delhivery.ts';
import { getCourierCredentials } from './getCourierCredentials.ts';

export type CourierEnvironment = 'staging' | 'production';

export async function getAdapterForCourier(
  supabase: SupabaseClient,
  courier: { name: string; api_provider: string | null; api_environment?: string | null },
): Promise<DeliveryAdapter | null> {
  const environment: CourierEnvironment = courier.api_environment === 'staging' ? 'staging' : 'production';
  const credentials = await getCourierCredentials(supabase, courier.name, environment);
  if (!credentials) return null;

  switch (courier.api_provider) {
    case 'nextdrop':
      return new NextDropAdapter(buildNextDropConfig(credentials));
    case 'delhivery':
      // Each environment has its own warehouse name. A staging booking never
      // falls back to the production warehouse, since Delhivery's sandbox
      // only knows the warehouses registered there.
      return new DelhiveryAdapter(buildDelhiveryConfig(credentials, environment));
    default:
      return null;
  }
}
