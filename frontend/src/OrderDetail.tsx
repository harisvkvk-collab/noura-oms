// OrderDetail.tsx — the Order Fulfillment Timeline. Online orders only; the
// Recent Orders list on the dashboard never links here for in-store sales
// (see Dashboard.tsx) since those complete immediately with no pipeline to
// walk through. Each action button both updates orders.status and logs a
// timestamped order_timeline row for the logged-in staff member.

import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, FileText, Eye, X } from 'lucide-react';
import { supabase } from './supabaseClient';
import { embeddedName, firstEmbedded } from '@/lib/supabaseRelations';
import { PAYMENT_METHOD_LABELS } from '@/lib/orderConstants';
import { displayCourierName } from '@/lib/courier';
import { callEdgeFunction } from '@/lib/edgeFunctions';
import { openShippingSlip } from '@/lib/shippingSlip';
import { OrderStatusBadge } from '@/components/OrderStatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { OrderReturns } from './OrderReturns';

// 'Delivered' still has a manual button even for integrated couriers whose
// webhook (functions/nextdrop-webhook) can advance orders.status to
// 'delivered' itself — that just means the button below may already be
// moot by the time staff go looking for it, not that it's unsafe to click.
// 'Postage printed' is the one step that actively branches on
// integration_status — see the 'postage_printed' case below and
// functions/generate-postage-label.
const STATUS_ORDER = ['draft', 'confirmed', 'packed', 'postage_printed', 'dispatched', 'delivered'];

const STEPS = [
  { key: 'confirmed', label: 'Confirm order', actionLabel: 'Confirm order' },
  { key: 'packed', label: 'Packed', actionLabel: 'Mark packed' },
  { key: 'postage_printed', label: 'Postage printed', actionLabel: 'Print postage' },
  { key: 'dispatched', label: 'Dispatched', actionLabel: 'Mark dispatched' },
  { key: 'delivered', label: 'Delivered', actionLabel: 'Mark delivered' },
] as const;

type Order = {
  id: string;
  order_number: string;
  status: string;
  total: number;
  total_in_aed: number;
  currency_code: string;
  order_source: string;
  payment_method: string;
  fulfillment_type: string;
  delivery_country_code: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_area: string | null;
  notes: string | null;
  deliveryAddress: {
    full_address: string | null;
    city: string | null;
    area: string | null;
    zip_code: string | null;
    google_location_link: string | null;
  } | null;
};

type OrderPhoto = {
  id: string;
  image_url: string;
  uploaded_at: string;
  signedUrl?: string;
};

type ShipmentLeg = {
  id: string;
  courier_id: string;
  cost: number | null;
  tracking_number: string | null;
  courierIntegrated: boolean;
  courierWhatsappNumber: string | null;
  pickup_location_id: string | null;
  pickupLocationName: string | null;
  pickupLocationAddress: {
    name: string | null;
    address: string | null;
    city: string | null;
    contact_person: string | null;
    contact_phone: string | null;
  } | null;
};

type OrderItemRow = { id: string; product_id: string | null; item_name: string; qty: number; unit_price?: number };

type TimelineEntry = { step: string; created_at: string; staff_name: string | null };

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function fetchOrderDetail(orderId: string) {
  const [orderRes, itemsRes, timelineRes, shipmentRes, photosRes] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, order_number, status, total, total_in_aed, currency_code, order_source, payment_method, fulfillment_type, delivery_country_code, delivery_area, notes, customer_id, customers(name, phone)',
      )
      .eq('id', orderId)
      .single(),
    supabase.from('order_items').select('id, product_id, item_name, qty, unit_price').eq('order_id', orderId),
    supabase
      .from('order_timeline')
      .select('step, created_at, staff_users(name)')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true }),
    supabase
      .from('shipments')
      .select('shipment_legs(id, courier_id, cost, tracking_number, manual_courier_name, pickup_location_id, couriers(name, integration_status, whatsapp_number))')
      .eq('order_id', orderId)
      .is('return_id', null)
      .maybeSingle(),
    supabase.from('order_photos').select('id, image_url, uploaded_at').eq('order_id', orderId).order('uploaded_at', { ascending: false }),
  ]);

  // Fetch full pickup location and delivery address details
  let pickupLocationData: any = null;
  let deliveryAddressData: any = null;

  if (shipmentRes.data?.shipment_legs) {
    const firstLeg = Array.isArray(shipmentRes.data.shipment_legs)
      ? shipmentRes.data.shipment_legs[0]
      : shipmentRes.data.shipment_legs;
    if (firstLeg?.pickup_location_id) {
      const { data: locData } = await supabase
        .from('pickup_locations')
        .select('name, address, city, contact_person, contact_phone')
        .eq('id', firstLeg.pickup_location_id)
        .single();
      pickupLocationData = locData;
    }
  }

  if (orderRes.data?.customer_id) {
    const { data: addrData } = await supabase
      .from('customer_addresses')
      .select('full_address, city, area, country_code, zip_code, google_location_link')
      .eq('customer_id', orderRes.data.customer_id)
      .eq('is_default', true)
      .maybeSingle();
    deliveryAddressData = addrData;
  }

  if (orderRes.error) throw orderRes.error;
  if (itemsRes.error) throw itemsRes.error;
  if (timelineRes.error) throw timelineRes.error;
  if (photosRes.error) throw photosRes.error;

  const o = orderRes.data;
  const customer = firstEmbedded(o.customers);
  const order: Order = {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    total: Number(o.total),
    total_in_aed: Number(o.total_in_aed),
    currency_code: o.currency_code,
    order_source: o.order_source,
    payment_method: o.payment_method,
    fulfillment_type: o.fulfillment_type,
    delivery_country_code: o.delivery_country_code,
    customer_name: customer?.name ?? null,
    customer_phone: customer?.phone ?? null,
    delivery_area: o.delivery_area,
    notes: o.notes,
    deliveryAddress: deliveryAddressData ? {
      full_address: deliveryAddressData.full_address,
      city: deliveryAddressData.city,
      area: deliveryAddressData.area,
      zip_code: deliveryAddressData.zip_code,
      google_location_link: deliveryAddressData.google_location_link,
    } : null,
  };

  const items: OrderItemRow[] = (itemsRes.data ?? []).map((i) => ({
    id: i.id,
    product_id: i.product_id,
    item_name: i.item_name,
    qty: i.qty,
    unit_price: i.unit_price ? Number(i.unit_price) : undefined,
  }));

  const photos: OrderPhoto[] = (photosRes.data ?? []).map((p) => ({
    id: p.id,
    image_url: p.image_url,
    uploaded_at: p.uploaded_at,
  }));

  const timeline: TimelineEntry[] = (timelineRes.data ?? []).map((t) => ({
    step: t.step,
    created_at: t.created_at,
    staff_name: embeddedName(t.staff_users),
  }));

  const legs = shipmentRes.data?.shipment_legs;
  const firstLeg = firstEmbedded(legs);
  const legCourier = firstLeg ? firstEmbedded(firstLeg.couriers) : null;
  const courierName = firstLeg ? displayCourierName(legCourier?.name ?? null, firstLeg.manual_courier_name) : null;
  const shipmentLeg: ShipmentLeg | null = firstLeg
    ? {
        id: firstLeg.id,
        courier_id: firstLeg.courier_id,
        cost: firstLeg.cost == null ? null : Number(firstLeg.cost),
        tracking_number: firstLeg.tracking_number,
        courierIntegrated: legCourier?.integration_status === 'integrated',
        courierWhatsappNumber: legCourier?.whatsapp_number ?? null,
        pickup_location_id: firstLeg.pickup_location_id,
        pickupLocationName: pickupLocationData?.name ?? null,
        pickupLocationAddress: pickupLocationData ? {
          name: pickupLocationData.name,
          address: pickupLocationData.address,
          city: pickupLocationData.city,
          contact_person: pickupLocationData.contact_person,
          contact_phone: pickupLocationData.contact_phone,
        } : null,
      }
    : null;

  return { order, items, timeline, courierName, shipmentLeg, photos };
}

function openPdfFromBase64(base64Data: string, contentType?: string) {
  // Strip whitespace defensively — some backends wrap base64 output at a
  // fixed line length, and atob() is stricter about embedded newlines than
  // the spec's "ignore ASCII whitespace" wording suggests in practice.
  const cleaned = base64Data.replace(/\s/g, '');
  let byteChars: string;
  try {
    byteChars = atob(cleaned);
  } catch {
    // The bare browser error ("not correctly encoded") gives no way to
    // tell what was actually wrong — surface enough of the raw string to
    // diagnose it (e.g. an unexpected data: URI prefix, truncated data,
    // or an error payload where PDF bytes were expected) without needing
    // another deploy-and-reproduce cycle.
    throw new Error(
      `Received data isn't valid base64 (length ${base64Data.length}, starts with "${base64Data.slice(0, 40)}").`,
    );
  }
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: contentType || 'application/pdf' });
  window.open(URL.createObjectURL(blob), '_blank');
}

function buildConfirmationMessage(order: Order, items: OrderItemRow[], template?: string) {
  const itemLines = items.map((i) => `${i.qty}x ${i.item_name}`).join('\n');
  const paymentLabel = PAYMENT_METHOD_LABELS[order.payment_method] ?? order.payment_method;

  const defaultTemplate =
    `Hi {CUSTOMER_NAME}, thank you for your order {ORDER_NUMBER}!\n\n{ITEMS}\nTotal: {CURRENCY} {TOTAL} ({PAYMENT_METHOD})\n\nWe'll notify you once it's packed and on its way.`;
  const tmpl = template || defaultTemplate;

  return tmpl
    .replace('{CUSTOMER_NAME}', order.customer_name ?? 'there')
    .replace('{ORDER_NUMBER}', order.order_number)
    .replace('{ITEMS}', itemLines)
    .replace('{CURRENCY}', order.currency_code)
    .replace('{TOTAL}', order.total.toFixed(2))
    .replace('{PAYMENT_METHOD}', paymentLabel);
}

function buildCourierWhatsAppMessage(
  order: Order,
  items: OrderItemRow[],
  shipmentLeg: ShipmentLeg,
  template?: string,
) {
  // Build pickup address from all available fields
  const pickupParts = [];
  if (shipmentLeg.pickupLocationAddress?.name) pickupParts.push(shipmentLeg.pickupLocationAddress.name);
  if (shipmentLeg.pickupLocationAddress?.address) pickupParts.push(shipmentLeg.pickupLocationAddress.address);
  if (shipmentLeg.pickupLocationAddress?.city) pickupParts.push(shipmentLeg.pickupLocationAddress.city);
  if (shipmentLeg.pickupLocationAddress?.contact_person || shipmentLeg.pickupLocationAddress?.contact_phone) {
    const contact = [shipmentLeg.pickupLocationAddress.contact_person, shipmentLeg.pickupLocationAddress.contact_phone]
      .filter(Boolean)
      .join(' · ');
    if (contact) pickupParts.push(contact);
  }
  const pickupAddr = pickupParts.length > 0 ? pickupParts.join('\n') : 'Pickup location not set';

  // Build delivery address from all available fields
  const deliveryParts = [];
  if (order.deliveryAddress?.full_address) deliveryParts.push(order.deliveryAddress.full_address);
  if (order.deliveryAddress?.area) deliveryParts.push(order.deliveryAddress.area);
  if (order.deliveryAddress?.city) deliveryParts.push(order.deliveryAddress.city);
  const deliveryAddr = deliveryParts.length > 0 ? deliveryParts.join('\n') : '⚠️ Customer delivery address not entered';
  const deliveryLocationLine = order.deliveryAddress?.google_location_link ? `\n${order.deliveryAddress.google_location_link}` : '';

  const itemLines = items.map((i) => `• ${i.qty}x ${i.item_name}`).join('\n');
  const paymentType =
    order.payment_method === 'cod'
      ? `COD: collect AED ${order.total_in_aed.toFixed(2)}`
      : 'PREPAID';

  const defaultTemplate =
    `Order: {ORDER_NUMBER}\n\nFrom\n{PICKUP_ADDRESS}\n\nTo\n{CUSTOMER_NAME}\n{CUSTOMER_PHONE}\n{DELIVERY_ADDRESS}\n\nPayment\n{PAYMENT_TYPE}\n\nItems\n{ITEMS}`;
  const tmpl = template || defaultTemplate;

  return tmpl
    .replaceAll('{ORDER_NUMBER}', order.order_number)
    .replaceAll('{PICKUP_ADDRESS}', pickupAddr)
    .replaceAll('{DELIVERY_ADDRESS}', deliveryAddr + deliveryLocationLine)
    .replaceAll('{CUSTOMER_NAME}', order.customer_name ?? 'N/A')
    .replaceAll('{CUSTOMER_PHONE}', order.customer_phone ?? 'N/A')
    .replaceAll('{PAYMENT_TYPE}', paymentType)
    .replaceAll('{ITEMS}', itemLines);
}

export function OrderDetail({
  orderId,
  staffId,
  onBack,
  backLabel = 'Back to dashboard',
}: {
  orderId: string;
  staffId: string;
  onBack: () => void;
  backLabel?: string;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [courierName, setCourierName] = useState<string | null>(null);
  const [shipmentLeg, setShipmentLeg] = useState<ShipmentLeg | null>(null);
  const [photos, setPhotos] = useState<OrderPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submittingStep, setSubmittingStep] = useState<string | null>(null);
  const [sendWhatsApp, setSendWhatsApp] = useState(true);
  const [postageTrackingInput, setPostageTrackingInput] = useState('');
  const [printingSlip, setPrintingSlip] = useState(false);
  const [retryingBooking, setRetryingBooking] = useState(false);
  const [reprintingLabel, setReprintingLabel] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [sendingCourierWhatsApp, setSendingCourierWhatsApp] = useState(false);
  const [sendingCustomerWhatsApp, setSendingCustomerWhatsApp] = useState(false);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [viewingPhotoUrl, setViewingPhotoUrl] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await fetchOrderDetail(orderId);
      setOrder(result.order);
      setItems(result.items);
      setTimeline(result.timeline);
      setCourierName(result.courierName);
      setShipmentLeg(result.shipmentLeg);

      // Generate signed URLs for photos in the private storage bucket
      const photosWithSignedUrls = await Promise.all(
        result.photos.map(async (photo) => {
          try {
            // Check if image_url is already a full URL (contains http/https)
            if (photo.image_url.startsWith('http')) {
              console.log('Photo URL is already a full URL:', photo.image_url);
              return { ...photo, signedUrl: photo.image_url };
            }

            // image_url is a path like "order-id/key-filename.jpg"
            // createSignedUrl returns { data: { signedUrl: string }, error: null }
            console.log('Generating signed URL for path:', photo.image_url);
            const { data, error } = await supabase.storage
              .from('order-photos')
              .createSignedUrl(photo.image_url, 3600);

            if (error || !data) {
              console.warn(`Failed to generate signed URL for ${photo.image_url}:`, error);
              return { ...photo, signedUrl: photo.image_url };
            }

            console.log('Generated signed URL for:', photo.image_url);
            return {
              ...photo,
              signedUrl: data.signedUrl,
            };
          } catch (err) {
            console.warn(`Error generating signed URL for ${photo.image_url}:`, err);
            return { ...photo, signedUrl: photo.image_url };
          }
        })
      );

      setPhotos(photosWithSignedUrls);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  async function advanceTo(stepKey: string) {
    if (!order) return;
    setSubmittingStep(stepKey);
    setError(null);
    try {
      // Validate and build the COD receivable payload *before* touching the
      // order — a missing shipment leg needs to block the whole action, not
      // surface after the order's already been marked delivered with
      // nothing to show for the money that's supposedly out with a courier.
      let receivableToInsert: {
        order_id: string;
        shipment_leg_id: string;
        courier_id: string;
        amount_collected: number;
        delivery_fee_deducted: number;
        net_due: number;
        status: string;
      } | null = null;
      if (stepKey === 'delivered' && order.payment_method === 'cod') {
        if (!shipmentLeg) {
          throw new Error('No shipment leg found for this order — cannot record a COD receivable without one.');
        }
        const amountCollected = order.total_in_aed;
        const deliveryFeeDeducted = shipmentLeg.cost ?? 0;
        receivableToInsert = {
          order_id: order.id,
          shipment_leg_id: shipmentLeg.id,
          courier_id: shipmentLeg.courier_id,
          amount_collected: amountCollected,
          delivery_fee_deducted: deliveryFeeDeducted,
          net_due: amountCollected - deliveryFeeDeducted,
          status: 'pending',
        };
      }

      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: stepKey, updated_at: new Date().toISOString() })
        .eq('id', order.id);
      if (updateError) throw updateError;

      const { error: timelineError } = await supabase
        .from('order_timeline')
        .insert({ order_id: order.id, step: stepKey, staff_user_id: staffId });
      if (timelineError) throw timelineError;

      if (receivableToInsert) {
        const { error: receivableError } = await supabase.from('courier_cod_receivables').insert(receivableToInsert);
        if (receivableError) throw receivableError;
      }

      if (stepKey === 'confirmed' && sendWhatsApp) {
        const message = buildConfirmationMessage(order, items);
        if (order.customer_phone) {
          window.open(`https://wa.me/${order.customer_phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
        }
        await supabase.from('order_messages').insert({
          order_id: order.id,
          type: 'confirmation',
          channel: 'whatsapp',
          content: message,
          status: 'sent',
          sent_at: new Date().toISOString(),
        });
      }

      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update order.');
    } finally {
      setSubmittingStep(null);
    }
  }

  // 'Postage printed' branches on the leg's courier: an integrated courier
  // with a tracking number on file (the automatic booking succeeded) gets
  // its label generated and opened via the API (functions/
  // generate-postage-label) — the step only advances if that actually
  // succeeds, since there'd be nothing to show for it otherwise. An
  // integrated courier whose automatic booking FAILED (no tracking_number
  // yet — see the NewOrder.tsx "enter tracking manually later" comment)
  // falls back to the same hand-typed path as a manual courier: there's no
  // real AWB to call the label API with, so all we can do is let staff
  // record one by hand and move on.
  async function handlePostagePrint() {
    if (!order || !shipmentLeg) return;
    setSubmittingStep('postage_printed');
    setError(null);
    try {
      if (shipmentLeg.courierIntegrated && shipmentLeg.tracking_number) {
        const result = await callEdgeFunction<{
          ok: boolean;
          fileName?: string;
          contentType?: string;
          base64Data?: string;
          error?: string;
        }>('generate-postage-label', { shipmentLegId: shipmentLeg.id });
        if (!result.ok || !result.base64Data) {
          throw new Error(result.error ?? 'Failed to generate postage label.');
        }
        openPdfFromBase64(result.base64Data, result.contentType);
      } else if (postageTrackingInput.trim()) {
        const { error: trackingError } = await supabase
          .from('shipment_legs')
          .update({ tracking_number: postageTrackingInput.trim(), updated_at: new Date().toISOString() })
          .eq('id', shipmentLeg.id);
        if (trackingError) throw trackingError;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to print postage.');
      setSubmittingStep(null);
      return;
    }
    await advanceTo('postage_printed');
  }

  async function handlePrintSlip() {
    setPrintingSlip(true);
    setError(null);
    try {
      await openShippingSlip(orderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build shipping slip.');
    } finally {
      setPrintingSlip(false);
    }
  }

  // The 'Generate & print postage' button inside the timeline (below) only
  // shows up while 'postage_printed' is the current step — once staff move
  // past it, or if the browser closed the print dialog/lost the download
  // before anyone saw it, there was no way back to the courier's own label
  // short of literally undoing the order status. This is the same call
  // (generate-postage-label re-fetches from NextDrop by tracking_number
  // every time, not a cached copy), just reachable at any point after
  // booking rather than gated to one moment in the pipeline.
  async function handleReprintCourierLabel() {
    if (!shipmentLeg?.tracking_number) return;
    setReprintingLabel(true);
    setError(null);
    try {
      const result = await callEdgeFunction<{
        ok: boolean;
        fileName?: string;
        contentType?: string;
        base64Data?: string;
        error?: string;
      }>('generate-postage-label', { shipmentLegId: shipmentLeg.id });
      if (!result.ok || !result.base64Data) {
        throw new Error(result.error ?? 'Failed to generate postage label.');
      }
      openPdfFromBase64(result.base64Data, result.contentType);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to print courier label.');
    } finally {
      setReprintingLabel(false);
    }
  }

  // Available at any step, not just while 'postage_printed' is current —
  // the failed automatic booking that left this leg trackless could've
  // happened days ago, and fixing the customer's address (Customers.tsx)
  // only helps retroactively if there's a way to re-trigger the booking
  // after the fact. functions/create-shipment re-derives everything itself
  // from shipmentLegId (order, customer, address, items) rather than
  // reusing anything cached here, so it always sees the current address.
  async function handleRetryBooking() {
    if (!shipmentLeg) return;
    setRetryingBooking(true);
    setError(null);
    try {
      const result = await callEdgeFunction<{ ok: boolean; trackingNumber?: string; error?: string }>(
        'create-shipment',
        { shipmentLegId: shipmentLeg.id },
      );
      if (!result.ok) throw new Error(result.error ?? 'Courier booking failed.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry courier booking.');
    } finally {
      setRetryingBooking(false);
    }
  }

  // Open WhatsApp with a pre-filled message for the courier — purely
  // optional convenience, not required to progress the order.
  async function handleSendCourierWhatsApp() {
    if (!order || !shipmentLeg || !shipmentLeg.courierWhatsappNumber) return;
    setSendingCourierWhatsApp(true);
    try {
      const { data: settings } = await supabase
        .from('company_settings')
        .select('whatsapp_courier_template')
        .maybeSingle();
      const template = settings?.whatsapp_courier_template;
      const message = buildCourierWhatsAppMessage(order, items, shipmentLeg, template);
      const whatsappNum = shipmentLeg.courierWhatsappNumber.replace(/\D/g, '');
      window.open(`https://wa.me/${whatsappNum}?text=${encodeURIComponent(message)}`, '_blank');
    } finally {
      setSendingCourierWhatsApp(false);
    }
  }

  // Send WhatsApp confirmation to customer
  async function handleSendCustomerWhatsApp() {
    if (!order) return;
    setSendingCustomerWhatsApp(true);
    try {
      const { data: settings } = await supabase
        .from('company_settings')
        .select('whatsapp_customer_template')
        .maybeSingle();
      const template = settings?.whatsapp_customer_template;
      const message = buildConfirmationMessage(order, items, template);
      const customerPhone = order.customer_phone?.replace(/\D/g, '');
      if (customerPhone) {
        window.open(`https://wa.me/${customerPhone}?text=${encodeURIComponent(message)}`, '_blank');
      }
    } finally {
      setSendingCustomerWhatsApp(false);
    }
  }

  // Internal record-keeping only — NextDrop's API (and, in practice, most
  // courier APIs) has no cancel/void endpoint, only booking creation and
  // label/AWB generation. This marks the order (and its shipment leg, if
  // any) cancelled in our own system so it stops showing as active/pending
  // in Deliveries etc.; it does NOT reach out to the courier. The dialog
  // says so explicitly whenever a tracking number already exists, since
  // that's the case staff most need reminding to also handle manually.
  async function handleCancelOrder() {
    if (!order) return;
    setCancelling(true);
    setError(null);
    try {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', order.id);
      if (updateError) throw updateError;

      const { error: timelineError } = await supabase
        .from('order_timeline')
        .insert({ order_id: order.id, step: 'cancelled', staff_user_id: staffId });
      if (timelineError) throw timelineError;

      if (shipmentLeg) {
        const { error: legError } = await supabase
          .from('shipment_legs')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', shipmentLeg.id);
        if (legError) throw legError;
      }

      setCancelDialogOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel order.');
    } finally {
      setCancelling(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error && !order) return <p className="text-sm text-destructive">{error}</p>;
  if (!order) return null;

  if (order.fulfillment_type === 'instore') {
    return (
      <div className="flex flex-col gap-4">
        <BackButton onBack={onBack} label={backLabel} />
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            {order.order_number} was completed in-store — there's no fulfillment timeline for it.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (order.status === 'cancelled') {
    return (
      <div className="flex flex-col gap-4">
        <BackButton onBack={onBack} label={backLabel} />
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between">
              <h1 className="text-base font-semibold">
                {order.order_number} · {order.customer_name ?? 'Unknown customer'}
              </h1>
              <OrderStatusBadge status={order.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              This order was cancelled — an internal record only.
              {shipmentLeg?.tracking_number
                ? ` It had a courier booking on file (${shipmentLeg.tracking_number}${courierName ? ` via ${courierName}` : ''}) — if that hasn't been cancelled with the courier directly yet, do that separately in their portal.`
                : ''}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const statusIndex = STATUS_ORDER.indexOf(order.status);
  const timelineByStep = new Map(timeline.map((t) => [t.step, t]));
  const created = timelineByStep.get('created');

  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} label={backLabel} />

      <Card>
        <CardContent className="flex flex-col gap-1 p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-semibold">
              {order.order_number} · {order.customer_name ?? 'Unknown customer'}
            </h1>
            <OrderStatusBadge status={order.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            {items.length} item{items.length === 1 ? '' : 's'} · {order.currency_code} {order.total.toFixed(2)} ·{' '}
            {order.order_source}
            {order.payment_method === 'cod' && (
              <>
                {' '}
                · COD{courierName ? ` via ${courierName}` : ''}
              </>
            )}
          </p>
          <div className="mt-2 flex flex-nowrap gap-2 overflow-x-auto pb-2 -mb-2 sm:flex-wrap sm:overflow-x-visible">
            <Button type="button" size="sm" variant="outline" onClick={() => setDetailsModalOpen(true)}>
              <FileText className="mr-1 size-4" />
              Order details
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={printingSlip} onClick={handlePrintSlip}>
              {printingSlip ? 'Building…' : 'Print shipping slip'}
            </Button>
            {shipmentLeg?.courierIntegrated && !shipmentLeg?.tracking_number && (
              <Button type="button" size="sm" variant="outline" disabled={retryingBooking} onClick={handleRetryBooking}>
                {retryingBooking ? 'Retrying…' : 'Retry courier booking'}
              </Button>
            )}
            {shipmentLeg?.courierIntegrated && shipmentLeg?.tracking_number && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reprintingLabel}
                onClick={handleReprintCourierLabel}
              >
                {reprintingLabel ? 'Building…' : `Print ${courierName ?? 'courier'} label`}
              </Button>
            )}
            {statusIndex >= STATUS_ORDER.indexOf('postage_printed') && shipmentLeg?.courierIntegrated && shipmentLeg?.tracking_number && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={submittingStep !== null}
                onClick={handlePostagePrint}
              >
                {submittingStep === 'postage_printed' ? 'Saving…' : 'Generate & print postage'}
              </Button>
            )}
            {statusIndex >= STATUS_ORDER.indexOf('confirmed') && (
              <Button
                type="button"
                size="sm"
                variant={statusIndex >= STATUS_ORDER.indexOf('confirmed') ? 'secondary' : 'outline'}
                className={statusIndex >= STATUS_ORDER.indexOf('confirmed') ? 'bg-blue-500 hover:bg-blue-600 text-white' : ''}
                disabled={sendingCustomerWhatsApp || !order.customer_phone}
                onClick={handleSendCustomerWhatsApp}
              >
                {sendingCustomerWhatsApp ? 'Opening…' : '📱 Customer WhatsApp'}
              </Button>
            )}
            {shipmentLeg?.courierWhatsappNumber && statusIndex >= STATUS_ORDER.indexOf('postage_printed') && (
              <Button
                type="button"
                size="sm"
                variant={statusIndex >= STATUS_ORDER.indexOf('postage_printed') ? 'secondary' : 'outline'}
                className={statusIndex >= STATUS_ORDER.indexOf('postage_printed') ? 'bg-green-500 hover:bg-green-600' : ''}
                disabled={sendingCourierWhatsApp}
                onClick={handleSendCourierWhatsApp}
              >
                {sendingCourierWhatsApp ? 'Opening…' : '📱 Book via WhatsApp'}
              </Button>
            )}
            {order.status !== 'delivered' && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setCancelDialogOpen(true)}
              >
                Cancel order
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {order.order_number}?</DialogTitle>
            <DialogDescription>
              This only marks the order cancelled in our own system — it does not contact the courier.
              {shipmentLeg?.tracking_number
                ? ` This order already has a courier booking (${shipmentLeg.tracking_number}${courierName ? ` via ${courierName}` : ''}) — you'll still need to cancel that separately in the courier's own portal.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCancelDialogOpen(false)} disabled={cancelling}>
              Never mind
            </Button>
            <Button type="button" variant="destructive" onClick={handleCancelOrder} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel order'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detailsModalOpen} onOpenChange={setDetailsModalOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto max-w-2xl w-full">
          <DialogHeader className="sticky top-0 bg-background z-10">
            <DialogTitle>Order Details — {order.order_number}</DialogTitle>
            <button
              onClick={() => setDetailsModalOpen(false)}
              className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-5" />
            </button>
          </DialogHeader>

          <div className="flex flex-col gap-6 pr-4">
            <div className="flex flex-col gap-3">
              <h3 className="font-semibold text-sm">Customer</h3>
              <div className="space-y-1 text-sm">
                <p><span className="text-muted-foreground">Name:</span> {order.customer_name || 'N/A'}</p>
                <p><span className="text-muted-foreground">Phone:</span> {order.customer_phone || 'N/A'}</p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="font-semibold text-sm">Delivery Address</h3>
              <div className="space-y-1 text-sm">
                {order.deliveryAddress?.full_address && (
                  <p>{order.deliveryAddress.full_address}</p>
                )}
                {order.deliveryAddress?.area && (
                  <p>{order.deliveryAddress.area}</p>
                )}
                {order.deliveryAddress?.city && (
                  <p>{order.deliveryAddress.city}</p>
                )}
                {order.deliveryAddress?.zip_code && (
                  <p>{order.deliveryAddress.zip_code}</p>
                )}
                {order.deliveryAddress?.google_location_link && (
                  <p>
                    <a
                      href={order.deliveryAddress.google_location_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:underline text-xs"
                    >
                      📍 Open in Google Maps
                    </a>
                  </p>
                )}
                {!order.deliveryAddress && <p className="text-muted-foreground">No delivery address set</p>}
              </div>
            </div>

            {shipmentLeg && (
              <div className="flex flex-col gap-3">
                <h3 className="font-semibold text-sm">Courier Information</h3>
                <div className="space-y-1 text-sm">
                  <p><span className="text-muted-foreground">Courier:</span> {courierName || 'N/A'}</p>
                  {shipmentLeg.tracking_number && (
                    <p><span className="text-muted-foreground">Tracking:</span> {shipmentLeg.tracking_number}</p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <h3 className="font-semibold text-sm">Line Items</h3>
              <div className="space-y-2 text-sm">
                {items.length === 0 ? (
                  <p className="text-muted-foreground">No items</p>
                ) : (
                  items.map((item) => (
                    <div key={item.id} className="flex justify-between gap-2 border-b pb-2 last:border-b-0">
                      <div>
                        <p className="font-medium">{item.item_name}</p>
                        <p className="text-xs text-muted-foreground">Qty: {item.qty}</p>
                      </div>
                      {item.unit_price && (
                        <p className="text-right whitespace-nowrap">
                          {order.currency_code} {item.unit_price.toFixed(2)}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {photos.length > 0 && (
              <div className="flex flex-col gap-3">
                <h3 className="font-semibold text-sm">Reference Photos</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {photos.map((photo) => (
                    <button
                      key={photo.id}
                      onClick={() => setViewingPhotoUrl(photo.signedUrl || photo.image_url)}
                      className="relative aspect-square overflow-hidden rounded border border-border hover:border-primary transition-colors bg-secondary"
                      aria-label="View photo"
                    >
                      <img
                        src={photo.signedUrl || photo.image_url}
                        alt="Order reference"
                        className="size-full object-cover"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/30 transition-colors">
                        <Eye className="size-4 text-white opacity-0 hover:opacity-100" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {order.notes && (
              <div className="flex flex-col gap-3">
                <h3 className="font-semibold text-sm">Order Notes</h3>
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{order.notes}</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {viewingPhotoUrl && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
          onClick={() => setViewingPhotoUrl(null)}
        >
          <div className="relative max-h-[90vh] max-w-4xl">
            <button
              onClick={() => setViewingPhotoUrl(null)}
              className="absolute -top-8 right-0 text-white hover:text-gray-300"
              aria-label="Close"
            >
              <X className="size-6" />
            </button>
            <img
              src={viewingPhotoUrl}
              alt="Full size photo"
              className="max-h-[90vh] max-w-4xl object-contain"
            />
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col">
            <TimelineStep
              icon="done"
              label="Order created"
              subtitle={created ? `${formatTimestamp(created.created_at)}${created.staff_name ? ` · by ${created.staff_name}` : ''}` : undefined}
              isLast={false}
            />
            {STEPS.map((step, idx) => {
              const stepIndex = STATUS_ORDER.indexOf(step.key);
              const done = statusIndex >= stepIndex;
              const current = statusIndex === stepIndex - 1;
              const entry = timelineByStep.get(step.key);
              const previousLabel = idx === 0 ? 'order confirmation' : STEPS[idx - 1].label.toLowerCase();

              return (
                <TimelineStep
                  key={step.key}
                  icon={done ? 'done' : current ? 'current' : 'pending'}
                  label={step.label}
                  subtitle={
                    done
                      ? entry
                        ? `${formatTimestamp(entry.created_at)}${entry.staff_name ? ` · by ${entry.staff_name}` : ''}`
                        : undefined
                      : current
                        ? 'Ready to go'
                        : `Waiting on ${previousLabel}`
                  }
                  isLast={idx === STEPS.length - 1}
                >
                  {current && (
                    <div className="mt-2 flex flex-col gap-2">
                      {step.key === 'confirmed' && (
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={sendWhatsApp}
                            onChange={(e) => setSendWhatsApp(e.target.checked)}
                            className="size-4 rounded border-input"
                          />
                          Also send WhatsApp confirmation to customer
                        </label>
                      )}
                      {step.key === 'postage_printed' && shipmentLeg?.courierIntegrated && !shipmentLeg?.tracking_number && (
                        <p className="text-xs text-warning-foreground">
                          The automatic courier booking wasn't completed for this order, so there's no tracking
                          number to generate a label from. Enter one by hand below if you have it, or leave it
                          blank to mark this step done and chase it up later.
                        </p>
                      )}
                      {step.key === 'postage_printed' && (!shipmentLeg?.courierIntegrated || !shipmentLeg?.tracking_number) && (
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="postage-tracking" className="text-xs">
                            Tracking number (optional)
                          </Label>
                          <Input
                            id="postage-tracking"
                            value={postageTrackingInput}
                            onChange={(e) => setPostageTrackingInput(e.target.value)}
                            placeholder="Enter if the courier gave you one"
                            className="w-56"
                          />
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="w-fit"
                          disabled={submittingStep !== null}
                          onClick={() => (step.key === 'postage_printed' ? handlePostagePrint() : advanceTo(step.key))}
                        >
                          {submittingStep === step.key
                            ? 'Saving…'
                            : step.key === 'postage_printed' && shipmentLeg?.courierIntegrated && shipmentLeg?.tracking_number
                              ? 'Generate & print postage'
                              : step.actionLabel}
                        </Button>
                      </div>
                    </div>
                  )}
                </TimelineStep>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {order.status === 'delivered' && (
        <OrderReturns
          orderId={order.id}
          staffId={staffId}
          items={items}
          currencyCode={order.currency_code}
          deliveryCountryCode={order.delivery_country_code}
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function BackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> {label}
    </button>
  );
}

function TimelineStep({
  icon,
  label,
  subtitle,
  isLast,
  children,
}: {
  icon: 'done' | 'current' | 'pending';
  label: string;
  subtitle?: string;
  isLast: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        {icon === 'done' ? (
          <CheckCircle2 className="size-5 text-success-foreground" fill="var(--success)" />
        ) : icon === 'current' ? (
          <Circle className="size-5 text-primary" fill="var(--accent)" />
        ) : (
          <Circle className="size-5 text-muted-foreground" />
        )}
        {!isLast && <div className="w-px flex-1 bg-border" />}
      </div>
      <div className={isLast ? 'pb-0' : 'pb-6'}>
        <div className={`text-sm font-medium ${icon === 'pending' ? 'text-muted-foreground' : ''}`}>{label}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}
