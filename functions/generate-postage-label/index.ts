// Supabase Edge Function: generates the postage label PDF for a shipment
// leg that already has a tracking_number (i.e. createShipment succeeded —
// see functions/create-shipment). Called from OrderDetail.tsx's "Postage
// printed" step for integrated couriers. Keeps JWT verification on (the
// default) — only our own authenticated frontend calls this.

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
    const { shipmentLegId } = await req.json();
    if (!shipmentLegId) return json({ ok: false, error: 'shipmentLegId is required.' });

    const { data: leg, error: legError } = await supabase
      .from('shipment_legs')
      .select('id, tracking_number, couriers(name, api_provider, integration_status)')
      .eq('id', shipmentLegId)
      .maybeSingle();
    if (legError) throw legError;
    if (!leg) return json({ ok: false, error: 'Shipment leg not found.' });
    if (!leg.tracking_number) {
      return json({ ok: false, error: 'No tracking number on file — the booking may not have been created automatically.' });
    }

    const courier = Array.isArray(leg.couriers) ? leg.couriers[0] : leg.couriers;
    if (!courier) return json({ ok: false, error: 'Courier not found for this leg.' });

    const adapter = await getAdapterForCourier(supabase, courier);
    if (!adapter?.generatePostageLabel) {
      return json({ ok: false, error: `${courier.name} doesn't support postage label generation.` });
    }

    const result = await adapter.generatePostageLabel(leg.tracking_number);
    return json({ ok: true, fileName: result.fileName, contentType: result.contentType, base64Data: result.base64Data });
  } catch (err) {
    console.error('generate-postage-label failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
