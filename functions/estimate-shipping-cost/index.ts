// Supabase Edge Function: estimated shipping charge for the new-order screen.
// Read-only: asks the courier's rate API what a prepaid parcel to the
// customer's pincode would cost, so staff can see it before booking. The
// courier token stays server-side (functions/_shared/getCourierCredentials.ts).
// Origin pincode is the warehouse pincode stored in the credential's
// extra_config.origin_pincode. Keeps JWT verification on, like create-shipment.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdapterForCourier } from '../_shared/getAdapterForCourier.ts';
import { getCourierCredentials } from '../_shared/getCourierCredentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Used when the caller doesn't pass a weight: the same default the booking uses.
const DEFAULT_WEIGHT_KG = 0.5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { courierId, destinationPincode, weightKg, shippingMode } = await req.json();
    if (!courierId) return json({ ok: false, error: 'courierId is required.' });
    if (!/^\d{6}$/.test(destinationPincode ?? '')) {
      return json({ ok: false, error: 'A 6-digit destination pincode is required.' });
    }
    const weight = Number(weightKg ?? DEFAULT_WEIGHT_KG);
    if (!Number.isFinite(weight) || weight <= 0) {
      return json({ ok: false, error: 'Weight must be a positive number of kilograms.' });
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
    if (!adapter?.estimateCost) {
      return json({ ok: false, error: `${courier.name} doesn't offer a shipping cost estimate.` });
    }

    const credentials = await getCourierCredentials(supabase, courier.name, environment);
    const originPincode = credentials?.extraConfig?.origin_pincode;
    if (typeof originPincode !== 'string' || !/^\d{6}$/.test(originPincode)) {
      return json({ ok: false, error: `Set the ${courier.name} warehouse pincode before showing estimates.` });
    }

    const estimate = await adapter.estimateCost({
      originPincode,
      destinationPincode,
      weightKg: weight,
      shippingMode: shippingMode === 'Express' ? 'Express' : 'Surface',
    });
    return json({ ok: true, ...estimate });
  } catch (err) {
    console.error('estimate-shipping-cost failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
