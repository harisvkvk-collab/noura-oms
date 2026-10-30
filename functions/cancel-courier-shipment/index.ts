// Supabase Edge Function: cancels a booked courier shipment, from the
// "Cancel with courier" button on OrderDetail.tsx. Only allowed while the
// parcel is still open at the courier (see the adapter's cancelShipment).
// The leg's own environment is used, so a staging test is never cancelled
// against production. Keeps JWT verification on, like create-shipment.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdapterForCourier } from '../_shared/getAdapterForCourier.ts';
import { corsHeaders } from '../_shared/cors.ts';
import type { WebhookStatusUpdate } from '../../adapters/types.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// A cancel is only meaningful while the parcel is still open at the courier.
const CANCELLABLE_STATUSES = ['pending', 'in_transit'];

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
      .select('id, shipment_id, tracking_number, status, courier_environment, couriers(name, api_provider, integration_status, api_environment)')
      .eq('id', shipmentLegId)
      .maybeSingle();
    if (legError) throw legError;
    if (!leg) return json({ ok: false, error: 'Shipment leg not found.' });

    const courier = Array.isArray(leg.couriers) ? leg.couriers[0] : leg.couriers;
    if (!courier) return json({ ok: false, error: 'Courier not found for this leg.' });
    if (!leg.tracking_number) return json({ ok: false, error: 'This leg has no courier booking to cancel.' });
    if (!CANCELLABLE_STATUSES.includes(leg.status)) {
      return json({ ok: false, error: `This shipment can't be cancelled now (status: ${leg.status}).` });
    }

    const environment = leg.courier_environment ?? (courier.api_environment === 'staging' ? 'staging' : 'production');
    const adapter = await getAdapterForCourier(supabase, { ...courier, api_environment: environment });
    if (!adapter) return json({ ok: false, error: `No active ${environment} API credentials on file for ${courier.name}.` });
    if (!adapter.cancelShipment) return json({ ok: false, error: `${courier.name} doesn't support cancellation through the app.` });

    const cancelled = await adapter.cancelShipment(leg.tracking_number);

    // Read back what the courier now shows. An in-transit cancel is a return
    // (RT) and stays open until it reaches the origin. If the read-back fails,
    // keep the leg open as pending so the daily refresh corrects it.
    let update: WebhookStatusUpdate | null = null;
    if (adapter.trackShipment) {
      try {
        update = await adapter.trackShipment(leg.tracking_number);
      } catch (err) {
        console.error('cancel-courier-shipment: status read-back failed', err);
      }
    }
    const newStatus = update?.simplifiedStatus ?? 'pending';
    const rawStatus = update?.rawStatus ?? 'Cancel requested';

    const { error: updateError } = await supabase
      .from('shipment_legs')
      .update({ status: newStatus, provider_status_raw: rawStatus, updated_at: new Date().toISOString() })
      .eq('id', leg.id);
    if (updateError) throw updateError;

    const { data: shipment } = await supabase.from('shipments').select('order_id').eq('id', leg.shipment_id).maybeSingle();
    if (shipment?.order_id) {
      const { error: timelineError } = await supabase.from('order_timeline').insert({
        order_id: shipment.order_id,
        step: `courier_update:${newStatus}`,
        note: `${courier.name} cancellation: ${cancelled.detail}`,
      });
      if (timelineError) console.error('cancel-courier-shipment: timeline write failed', timelineError);
    }

    return json({ ok: true, status: newStatus, detail: cancelled.detail });
  } catch (err) {
    console.error('cancel-courier-shipment failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
