// Supabase Edge Function: books a shipment with an integrated courier
// (currently only NextDrop) right after a shipment_legs row is created for
// it, and saves the returned tracking_number + rawStatus back onto that
// leg. Called from NewOrder.tsx immediately after the leg insert — see
// getAdapterForCourier() (functions/_shared/) for how the courier's
// credentials get resolved.
//
// Failure here is deliberately non-fatal from the caller's side (same
// "warn, don't block" precedent as reference-photo upload failures in
// NewOrder.tsx): the leg just stays is_manual and trackless, exactly like
// any manual courier, and staff can chase it up by hand. Keeps JWT
// verification on (the default) — unlike nextdrop-webhook, this is only
// ever called by our own authenticated frontend, never by NextDrop.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdapterForCourier } from '../_shared/getAdapterForCourier.ts';
import { corsHeaders } from '../_shared/cors.ts';
import type { CreateShipmentInput } from '../../adapters/types.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // service role: reads courier_api_credentials, writes shipment_legs
);

// pickup_locations has no country column (this business only has UAE
// addresses) — mirrors frontend/src/lib/orderConstants.ts's HOME_COUNTRY
// (which stores the ISO code 'AE'), duplicated here as the full name since
// Deno Edge Functions don't share a module graph with the Vite frontend
// and NextDrop wants the full country name, not the ISO code — see the
// receiverCountryName comment below for why.
const HOME_COUNTRY_NAME = 'United Arab Emirates';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { shipmentLegId } = await req.json();
    if (!shipmentLegId) {
      return json({ ok: false, error: 'shipmentLegId is required.' });
    }

    const { data: leg, error: legError } = await supabase
      .from('shipment_legs')
      .select(
        'id, shipment_id, courier_id, currency_code, pickup_location_id, couriers(name, api_provider, integration_status)',
      )
      .eq('id', shipmentLegId)
      .maybeSingle();
    if (legError) throw legError;
    if (!leg) return json({ ok: false, error: 'Shipment leg not found.' });

    // couriers(...) is embedded as an array by the untyped client regardless
    // of the true one-to-one cardinality here (same gotcha as the frontend
    // — see frontend/src/lib/supabaseRelations.ts) — take the first entry.
    const courier = Array.isArray(leg.couriers) ? leg.couriers[0] : leg.couriers;
    if (!courier) return json({ ok: false, error: 'Courier not found for this leg.' });
    if (courier.integration_status !== 'integrated') {
      return json({ ok: false, error: `${courier.name} is not an integrated courier.` });
    }

    const { data: shipment, error: shipmentError } = await supabase
      .from('shipments')
      .select('order_id')
      .eq('id', leg.shipment_id)
      .maybeSingle();
    if (shipmentError) throw shipmentError;
    if (!shipment?.order_id) return json({ ok: false, error: 'No order found for this shipment.' });

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, customer_id, currency_code, payment_method, total, notes, delivery_country_code')
      .eq('id', shipment.order_id)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return json({ ok: false, error: 'Order not found.' });

    const { data: customer, error: customerError } = order.customer_id
      ? await supabase.from('customers').select('name, phone').eq('id', order.customer_id).maybeSingle()
      : { data: null, error: null };
    if (customerError) throw customerError;
    if (!customer) return json({ ok: false, error: 'No customer on this order to ship to.' });

    const { data: address, error: addressError } = order.customer_id
      ? await supabase
          .from('customer_addresses')
          .select('country_code, city, area, full_address, countries(name)')
          .eq('customer_id', order.customer_id)
          .eq('is_default', true)
          .maybeSingle()
      : { data: null, error: null };
    if (addressError) throw addressError;
    if (!address?.full_address || !address.city || !address.country_code) {
      return json({ ok: false, error: 'Customer has no complete default address on file.' });
    }

    // NextDrop's to_country/from_country want the full country name (every
    // sample payload in their docs sends "United Arab Emirates", never
    // "AE") — countries.code is what we store everywhere else, so resolve
    // the human-readable name here rather than leaking that quirk into the
    // adapter or the generic CreateShipmentInput contract other couriers
    // implement too.
    const addressCountry = Array.isArray(address.countries) ? address.countries[0] : address.countries;
    const receiverCountryName = addressCountry?.name ?? address.country_code;

    const { data: items, error: itemsError } = await supabase
      .from('order_items')
      .select('item_name, qty')
      .eq('order_id', order.id);
    if (itemsError) throw itemsError;

    // A non-default pickup location means this leg ships from somewhere
    // other than the courier account's on-file branch — adapters that
    // support it (NextDrop: /Order/thirdparty_order) need the actual
    // pickup address/contact spelled out, via CreateShipmentInput.shipFrom.
    let shipFrom: CreateShipmentInput['shipFrom'];
    if (leg.pickup_location_id) {
      const { data: pickupLocation, error: pickupError } = await supabase
        .from('pickup_locations')
        .select('name, address, city, contact_person, contact_phone, is_default')
        .eq('id', leg.pickup_location_id)
        .maybeSingle();
      if (pickupError) throw pickupError;
      if (pickupLocation && !pickupLocation.is_default) {
        if (!pickupLocation.contact_person || !pickupLocation.contact_phone) {
          return json({
            ok: false,
            error: `Pickup location "${pickupLocation.name}" is missing a contact name/phone — add one in Settings before booking from it.`,
          });
        }
        shipFrom = {
          contactName: pickupLocation.contact_person,
          contactPhone: pickupLocation.contact_phone,
          address: pickupLocation.address,
          city: pickupLocation.city ?? '',
          country: HOME_COUNTRY_NAME,
        };
      }
    }

    const adapter = await getAdapterForCourier(supabase, courier);
    if (!adapter) {
      return json({ ok: false, error: `No active API credentials on file for ${courier.name}.` });
    }

    const input: CreateShipmentInput = {
      orderId: order.id,
      orderNumber: order.order_number,
      receiverName: customer.name,
      receiverAddress: address.full_address,
      receiverCity: address.city,
      receiverArea: address.area ?? undefined,
      receiverCountry: receiverCountryName,
      receiverPhone: customer.phone ?? '',
      pieces: (items ?? []).reduce((sum, i) => sum + i.qty, 0) || 1,
      itemDescription: (items ?? []).map((i) => `${i.qty}x ${i.item_name}`).join(', '),
      specialInstruction: order.notes ?? undefined,
      currencyCode: order.currency_code,
      codAmount: order.payment_method === 'cod' ? Number(order.total) : undefined,
      shipFrom,
    };

    const result = await adapter.createShipment(input);

    const { error: updateError } = await supabase
      .from('shipment_legs')
      .update({
        tracking_number: result.trackingNumber,
        provider_status_raw: result.rawStatus,
        is_manual: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', shipmentLegId);
    if (updateError) throw updateError;

    return json({ ok: true, trackingNumber: result.trackingNumber });
  } catch (err) {
    console.error('create-shipment failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
