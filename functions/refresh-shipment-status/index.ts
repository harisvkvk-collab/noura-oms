// Supabase Edge Function: pulls the latest tracking status from a courier
// for shipment legs that have a tracking number, and writes it back to
// shipment_legs (+ the order timeline, + orders.status once delivered).
//
// Two modes:
// - { shipmentLegId }  — the "Refresh status" button on OrderDetail.tsx.
// - {} (no id)         — the daily batch: every open leg for couriers whose
//                        adapter supports tracking (currently Delhivery).
//                        Scheduled from frontend/scripts/schedule-delhivery-refresh.sql.
//
// Keeps JWT verification on, so the scheduled call must send the service
// role key as its bearer token.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdapterForCourier } from '../_shared/getAdapterForCourier.ts';
import { corsHeaders } from '../_shared/cors.ts';
import type { WebhookStatusUpdate } from '../../adapters/types.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Legs in these states are finished; the daily batch skips them.
const CLOSED_STATUSES = ['delivered', 'failed_rto'];

type LegRow = {
  id: string;
  shipment_id: string;
  tracking_number: string | null;
  status: string;
  couriers: { name: string; api_provider: string | null; integration_status: string; api_environment: string | null } | { name: string; api_provider: string | null; integration_status: string; api_environment: string | null }[] | null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const shipmentLegId: string | undefined = body.shipmentLegId;

    if (shipmentLegId) {
      const { data: leg, error } = await supabase
        .from('shipment_legs')
        .select('id, shipment_id, tracking_number, status, couriers(name, api_provider, integration_status, api_environment)')
        .eq('id', shipmentLegId)
        .maybeSingle();
      if (error) throw error;
      if (!leg) return json({ ok: false, error: 'Shipment leg not found.' });
      const result = await refreshLeg(leg as LegRow);
      return json(result.ok ? { ok: true, status: result.status, detail: result.detail } : { ok: false, error: result.detail });
    }

    // Batch: only legs that have a tracking number and aren't finished yet.
    const { data: legs, error: legsError } = await supabase
      .from('shipment_legs')
      .select('id, shipment_id, tracking_number, status, couriers(name, api_provider, integration_status, api_environment)')
      .not('tracking_number', 'is', null);
    if (legsError) throw legsError;

    const open = ((legs ?? []) as LegRow[]).filter((leg) => {
      const courier = Array.isArray(leg.couriers) ? leg.couriers[0] : leg.couriers;
      return courier?.api_provider === 'delhivery' && !CLOSED_STATUSES.includes(leg.status);
    });

    let updated = 0;
    const failed: string[] = [];
    // Sequential on purpose: Delhivery allows 750 tracking requests per 5 minutes.
    for (const leg of open) {
      try {
        const result = await refreshLeg(leg);
        if (result.ok) updated += 1;
        else failed.push(`${leg.id}: ${result.detail}`);
      } catch (err) {
        failed.push(`${leg.id}: ${err instanceof Error ? err.message : 'Unknown error.'}`);
      }
    }

    return json({ ok: true, checked: open.length, updated, failed });
  } catch (err) {
    console.error('refresh-shipment-status failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

async function refreshLeg(leg: LegRow): Promise<{ ok: boolean; status?: string; detail: string }> {
  const courier = Array.isArray(leg.couriers) ? leg.couriers[0] : leg.couriers;
  if (!courier) return { ok: false, detail: 'Courier not found for this leg.' };
  if (!leg.tracking_number) return { ok: false, detail: 'No tracking number on this leg yet.' };

  const adapter = await getAdapterForCourier(supabase, courier);
  if (!adapter) return { ok: false, detail: `No active API credentials on file for ${courier.name}.` };
  if (!adapter.trackShipment) return { ok: false, detail: `${courier.name} doesn't support status tracking.` };

  const update = await adapter.trackShipment(leg.tracking_number);
  await applyUpdate(leg, update);
  return { ok: true, status: update.simplifiedStatus, detail: update.rawStatus };
}

async function applyUpdate(leg: LegRow, update: WebhookStatusUpdate) {
  const { error: legError } = await supabase
    .from('shipment_legs')
    .update({
      status: update.simplifiedStatus,
      provider_status_raw: update.rawStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leg.id);
  if (legError) throw legError;

  // Only write to the timeline when the status actually moved, so the daily
  // batch doesn't add a row per order every day.
  if (leg.status === update.simplifiedStatus) return;

  const { data: shipment, error: shipmentError } = await supabase
    .from('shipments')
    .select('order_id')
    .eq('id', leg.shipment_id)
    .maybeSingle();
  if (shipmentError) throw shipmentError;
  if (!shipment?.order_id) return;

  const { error: timelineError } = await supabase.from('order_timeline').insert({
    order_id: shipment.order_id,
    step: `courier_update:${update.simplifiedStatus}`,
    note: update.statusDetails ?? update.rawStatus,
  });
  if (timelineError) throw timelineError;

  // Same rule as nextdrop-webhook: a delivered parcel closes the order.
  if (update.simplifiedStatus === 'delivered') {
    const { error: orderError } = await supabase
      .from('orders')
      .update({ status: 'delivered', updated_at: new Date().toISOString() })
      .eq('id', shipment.order_id);
    if (orderError) throw orderError;
  }
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
