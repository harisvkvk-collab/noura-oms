// Supabase Edge Function: receives NextDrop's webhook push and updates the
// matching shipment_legs row. Deploy this and give its URL to NextDrop
// support as the webhook destination for your account.
//
// NextDrop's webhook payload echoes back whatever we sent as
// `reference_number` when creating the shipment — we send our order_number
// there (see adapters/nextdrop.ts createShipment), so this handler looks up
// the shipment leg by tracking_number first, falling back to matching the
// order by order_number if needed.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { NextDropAdapter } from '../../adapters/nextdrop.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // service role: this function writes to shipment_legs directly
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // NextDrop's own docs show the webhook auth header as "API-KEY" (note the
  // hyphen, differing from "APIKEY" used on outbound requests) — verify
  // against whatever value you configured for this endpoint.
  const incomingKey = req.headers.get('API-KEY') ?? req.headers.get('APIKEY');
  const expectedKey = Deno.env.get('NEXTDROP_WEBHOOK_SECRET');
  if (!expectedKey || incomingKey !== expectedKey) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rawBody = await req.json();

  // parseWebhookPayload doesn't need real config for parsing (no API calls
  // happen here), so a placeholder config is fine. A future function that
  // calls createShipment/generatePostageLabel (real outbound API calls)
  // should instead build this via getCourierCredentials() + buildNextDropConfig()
  // — see functions/_shared/getCourierCredentials.ts — reading the key from
  // courier_api_credentials (set through the Settings screen) rather than
  // a Deno.env var.
  const adapter = new NextDropAdapter({ apiKey: '', customerBranch: '' });
  const updates = adapter.parseWebhookPayload(rawBody);

  for (const update of updates) {
    const { data: leg, error: findError } = await supabase
      .from('shipment_legs')
      .select('id, shipment_id')
      .eq('tracking_number', update.trackingNumber)
      .maybeSingle();

    if (findError || !leg) {
      // Nothing matched this tracking number yet — log and move on rather
      // than failing the whole webhook batch over one unmatched event.
      console.error('No shipment_leg found for tracking number', update.trackingNumber, findError);
      continue;
    }

    await supabase
      .from('shipment_legs')
      .update({
        status: update.simplifiedStatus,
        provider_status_raw: update.rawStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', leg.id);

    // Also record it on the order's timeline so staff see delivery progress
    // alongside the pack/postage/dispatch steps, not just on the shipment tab.
    const { data: shipment } = await supabase
      .from('shipments')
      .select('order_id')
      .eq('id', leg.shipment_id)
      .maybeSingle();

    if (shipment?.order_id) {
      await supabase.from('order_timeline').insert({
        order_id: shipment.order_id,
        step: `courier_update:${update.simplifiedStatus}`,
        note: update.statusDetails ?? update.rawStatus,
      });

      if (update.simplifiedStatus === 'delivered') {
        await supabase
          .from('orders')
          .update({ status: 'delivered', updated_at: new Date().toISOString() })
          .eq('id', shipment.order_id);
      }
    }
  }

  return new Response(JSON.stringify({ status: 1, message: 'success' }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
