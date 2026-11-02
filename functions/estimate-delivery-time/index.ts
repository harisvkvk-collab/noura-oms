// Supabase Edge Function: expected delivery time for the new-order screen.
// Read-only: asks the courier how many days a parcel from the pickup location's
// pincode to the customer's pincode should take. Information only; the courier
// token stays server-side. Keeps JWT verification on, like estimate-shipping-cost.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdapterForCourier } from '../_shared/getAdapterForCourier.ts';
import { getCourierCredentials } from '../_shared/getCourierCredentials.ts';
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
    const { courierId, destinationPincode, shippingMode, pickupLocationId } = await req.json();
    if (!courierId) return json({ ok: false, error: 'courierId is required.' });
    if (!/^\d{6}$/.test(destinationPincode ?? '')) {
      return json({ ok: false, error: 'A 6-digit destination pincode is required.' });
    }

    const { data: courier, error: courierError } = await supabase
      .from('couriers')
      .select('name, api_provider, api_environment')
      .eq('id', courierId)
      .maybeSingle();
    if (courierError) throw courierError;
    if (!courier) return json({ ok: false, error: 'Courier not found.' });

    const environment = courier.api_environment === 'staging' ? 'staging' : 'production';
    const adapter = await getAdapterForCourier(supabase, { ...courier, api_environment: environment });
    if (!adapter?.estimateDelivery) {
      return json({ ok: false, error: `${courier.name} doesn't offer a delivery time estimate.` });
    }

    const credentials = await getCourierCredentials(supabase, courier.name, environment);
    // The chosen pickup location's own pincode wins over the courier's default.
    let originPincode = credentials?.extraConfig?.origin_pincode;
    if (pickupLocationId) {
      const { data: pickupLocation, error: pickupError } = await supabase
        .from('pickup_locations')
        .select('delhivery_pincode')
        .eq('id', pickupLocationId)
        .maybeSingle();
      if (pickupError) throw pickupError;
      if (pickupLocation?.delhivery_pincode) originPincode = pickupLocation.delhivery_pincode;
    }
    if (typeof originPincode !== 'string' || !/^\d{6}$/.test(originPincode)) {
      return json({ ok: false, error: `Set the ${courier.name} warehouse pincode before showing delivery times.` });
    }

    const result = await adapter.estimateDelivery({
      originPincode,
      destinationPincode,
      shippingMode: shippingMode === 'Express' ? 'Express' : 'Surface',
    });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error('estimate-delivery-time failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
