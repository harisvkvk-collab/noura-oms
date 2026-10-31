// Supabase Edge Function: asks Delhivery to collect booked parcels, from the
// "Request pickup" card on Deliveries.tsx. Staging only for now: a production
// pickup is a real collection, so it stays refused until it has been approved.
// The request uses the courier's own environment. Keeps JWT verification on.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdapterForCourier } from '../_shared/getAdapterForCourier.ts';
import { corsHeaders } from '../_shared/cors.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { courierId, pickupLocationId, pickupDate, pickupTime, packageCount } = await req.json();
    if (!courierId) return json({ ok: false, error: 'courierId is required.' });
    if (!pickupLocationId) return json({ ok: false, error: 'Choose a pickup location first.' });

    const { data: courier, error: courierError } = await supabase
      .from('couriers')
      .select('name, api_provider, api_environment')
      .eq('id', courierId)
      .maybeSingle();
    if (courierError) throw courierError;
    if (!courier) return json({ ok: false, error: 'Courier not found.' });
    if (courier.api_provider !== 'delhivery') {
      return json({ ok: false, error: `${courier.name} doesn't support pickup requests through the app.` });
    }
    if (courier.api_environment !== 'staging') {
      return json({ ok: false, error: 'Pickup requests are only enabled on the Delhivery staging environment for now.' });
    }

    // The pickup is requested for the warehouse named on the chosen location.
    const { data: pickupLocation, error: pickupError } = await supabase
      .from('pickup_locations')
      .select('name, delhivery_warehouse_name')
      .eq('id', pickupLocationId)
      .maybeSingle();
    if (pickupError) throw pickupError;
    if (!pickupLocation?.delhivery_warehouse_name) {
      return json({
        ok: false,
        error: `Pickup location "${pickupLocation?.name ?? 'unknown'}" has no Delhivery warehouse name. Add one in Settings first.`,
      });
    }

    const adapter = await getAdapterForCourier(supabase, { ...courier, api_environment: 'staging' });
    if (!adapter) return json({ ok: false, error: 'No active staging API credentials on file for Delhivery.' });
    if (!adapter.requestPickup) return json({ ok: false, error: `${courier.name} doesn't support pickup requests.` });

    const result = await adapter.requestPickup({
      pickupDate: String(pickupDate ?? ''),
      pickupTime: String(pickupTime ?? ''),
      packageCount: Number(packageCount),
      warehouseName: pickupLocation.delhivery_warehouse_name,
    });
    return json({ ok: true, pickupId: result.pickupId, detail: result.detail });
  } catch (err) {
    console.error('request-pickup failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
