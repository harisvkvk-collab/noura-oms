// shippingSlip.ts — builds and opens the printable internal shipping slip
// from OrderDetail.tsx's "Print shipping slip" button. Unlike the courier's
// own postage label (OrderDetail's "Postage printed" step, which calls
// functions/generate-postage-label and only exists for integrated
// couriers), this is our own document: available for every shipped order
// regardless of courier integration status, built entirely client-side —
// no PDF, no Edge Function. Same "open it, let the browser's native print
// dialog handle printer/size" approach as the postage label.
//
// The window is opened synchronously as the very first thing this function
// does, before any await — popup blockers key off a window.open() call
// still being on the same call stack as the user gesture that triggered it,
// not off it being literally the first statement in the click handler, so
// this still counts even though the actual content is written in later,
// after the fetches below resolve.

import QRCode from 'qrcode';
import { supabase } from '../supabaseClient';
import { firstEmbedded, embeddedName } from './supabaseRelations';
import { displayCourierName } from './courier';
import { PAYMENT_METHOD_LABELS } from './orderConstants';

function escapeHtml(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export async function openShippingSlip(orderId: string): Promise<void> {
  const win = window.open('', '_blank');
  if (!win) throw new Error('Popup blocked — allow popups for this site to print the shipping slip.');
  win.document.write('<p style="font-family: sans-serif; padding: 16px;">Loading shipping slip…</p>');

  try {
    const [companyRes, orderRes, itemsRes, shipmentRes] = await Promise.all([
      // Singleton table with no fixed id (see schema.sql) — just take
      // whichever one row exists.
      supabase.from('company_settings').select('business_name').limit(1).maybeSingle(),
      supabase
        .from('orders')
        .select(
          'order_number, created_at, payment_method, total_in_aed, notes, customer_id, customers(name, phone)',
        )
        .eq('id', orderId)
        .single(),
      supabase.from('order_items').select('item_name, qty').eq('order_id', orderId),
      supabase
        .from('shipments')
        .select(
          'shipment_legs(courier_id, manual_courier_name, couriers(name), pickup_locations(name, address, city, contact_person, contact_phone))',
        )
        .eq('order_id', orderId)
        .is('return_id', null)
        .maybeSingle(),
    ]);

    if (companyRes.error) throw companyRes.error;
    if (orderRes.error) throw orderRes.error;
    if (itemsRes.error) throw itemsRes.error;
    if (shipmentRes.error) throw shipmentRes.error;

    const order = orderRes.data;
    const customer = firstEmbedded(order.customers);

    let addressLines: string[] = [];
    let googleLocationLink: string | null = null;
    if (order.customer_id) {
      const { data: addr, error: addrError } = await supabase
        .from('customer_addresses')
        .select('full_address, area, city, google_location_link, countries(name)')
        .eq('customer_id', order.customer_id)
        .eq('is_default', true)
        .maybeSingle();
      if (addrError) throw addrError;
      if (addr) {
        addressLines = [addr.full_address, [addr.area, addr.city].filter(Boolean).join(', '), embeddedName(addr.countries)].filter(
          (l): l is string => !!l,
        );
        googleLocationLink = addr.google_location_link;
      }
    }

    let qrCodeDataUrl = '';
    if (googleLocationLink) {
      try {
        qrCodeDataUrl = await QRCode.toDataURL(googleLocationLink, { width: 100 });
      } catch (err) {
        console.error('Failed to generate QR code:', err);
      }
    }

    const legs = shipmentRes.data?.shipment_legs;
    const leg = firstEmbedded(legs);
    const legCourier = leg ? firstEmbedded(leg.couriers) : null;
    const courierName = leg ? displayCourierName(legCourier?.name ?? null, leg.manual_courier_name) : null;
    const pickup = leg ? firstEmbedded(leg.pickup_locations) : null;

    const items = itemsRes.data ?? [];
    const isCod = order.payment_method === 'cod';
    const paymentLabel = PAYMENT_METHOD_LABELS[order.payment_method] ?? order.payment_method;

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Shipping slip — ${escapeHtml(order.order_number)}</title>
<style id="page-size-style">@page { size: A5; margin: 5mm; }</style>
<style>
  * { box-sizing: border-box; }
  html { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 5mm; font-size: 12px; }
  @media print {
    html { margin: 0; padding: 0; }
    body { margin: 0 !important; padding: 5mm !important; }
    .controls { display: none !important; }
  }
  .controls { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .controls button { font-size: 12px; padding: 4px 10px; border: 1px solid #999; background: #f5f5f5; cursor: pointer; border-radius: 4px; }
  .controls button.active { background: #333; color: #fff; border-color: #333; }
  .controls .separator { width: 1px; background: #999; margin: 0 4px; }
  @media print { .controls { display: none; } }
  .header { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
  .header .business-name { font-size: 18px; font-weight: 700; }
  .header .slip-title { font-size: 11px; letter-spacing: 1px; color: #555; margin-top: 2px; }
  .courier-banner { font-size: 20px; font-weight: 800; text-transform: uppercase; text-align: center; border: 2px solid #111; padding: 6px; margin-bottom: 12px; letter-spacing: 0.5px; }
  .meta-row { display: flex; justify-content: space-between; margin-bottom: 12px; }
  .section { margin-bottom: 12px; }
  .section .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th, td { text-align: left; padding: 4px 0; border-bottom: 1px solid #ddd; }
  th:last-child, td:last-child { text-align: right; }
  .qr-section { margin: 8px 0; }
  .qr-section img { display: block; margin: 0 auto; }
  .payment { border: 1px solid #111; padding: 8px; margin-top: 8px; margin-bottom: 8px; }
  .payment .big { font-size: 16px; font-weight: 700; margin-top: 4px; }
  .payment.cod .big { color: #b00020; }

  /* Compact layout (for 4x6 thermal labels) */
  body.compact { font-size: 10px; padding: 3mm; }
  body.compact .header { padding-bottom: 4px; margin-bottom: 6px; }
  body.compact .header .business-name { font-size: 14px; }
  body.compact .header .slip-title { font-size: 9px; }
  body.compact .courier-banner { font-size: 16px; padding: 3px; margin-bottom: 6px; }
  body.compact .meta-row { margin-bottom: 6px; font-size: 10px; }
  body.compact .section { margin-bottom: 6px; }
  body.compact .section .label { font-size: 9px; margin-bottom: 1px; }
  body.compact table { margin-bottom: 6px; font-size: 10px; }
  body.compact th, body.compact td { padding: 2px 0; }
  body.compact .qr-section { margin: 4px 0; text-align: center; }
  body.compact .qr-section img { width: 50px; height: 50px; margin: 2px auto; }
  body.compact .qr-section .qr-label { font-size: 8px; margin-top: 2px; }
  body.compact .payment { padding: 5px; margin: 6px 0; }
  body.compact .payment .big { font-size: 14px; margin-top: 2px; }
  body.compact .remarks { display: none; }
</style>
</head>
<body>
  <div class="controls">
    <strong style="font-size: 12px; align-self: center;">Paper size:</strong>
    <button type="button" class="active" data-size="A5" onclick="setSlipSize('A5', this)">A5</button>
    <button type="button" data-size="A6" onclick="setSlipSize('A6', this)">A6</button>
    <button type="button" data-size="compact" onclick="setSlipSize('compact', this)">Compact (4×6″)</button>
    <div class="separator"></div>
    <button type="button" onclick="window.print()" style="background: #007bff; color: white; border-color: #007bff;">Print</button>
  </div>

  <div class="header">
    <div class="business-name">From: ${escapeHtml(companyRes.data?.business_name || 'Noura OMS')}</div>
    <div class="slip-title">SHIPPING SLIP</div>
  </div>

  <div class="courier-banner">${escapeHtml(courierName || 'COURIER NOT SET')}</div>

  <div class="meta-row">
    <div><strong>Order:</strong> ${escapeHtml(order.order_number)}</div>
    <div><strong>Date:</strong> ${escapeHtml(formatDate(order.created_at))}</div>
  </div>

  <div class="section">
    <div class="label">From address</div>
    ${
      pickup
        ? `<div>${escapeHtml(pickup.name)}</div>
    ${pickup.address ? `<div>${escapeHtml(pickup.address)}</div>` : ''}
    ${pickup.city ? `<div>${escapeHtml(pickup.city)}</div>` : ''}
    ${
      pickup.contact_person || pickup.contact_phone
        ? `<div>${escapeHtml([pickup.contact_person, pickup.contact_phone].filter(Boolean).join(' · '))}</div>`
        : ''
    }`
        : '<div>No pickup location on file</div>'
    }
  </div>

  <div class="section">
    <div class="label">To</div>
    <div>${escapeHtml(customer?.name || '—')}</div>
    ${customer?.phone ? `<div>${escapeHtml(customer.phone)}</div>` : ''}
    ${addressLines.length ? addressLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') : '<div>No address on file</div>'}
  </div>

  ${
    qrCodeDataUrl
      ? `<div class="section qr-section" style="text-align: center;">
    <img src="${qrCodeDataUrl}" alt="Customer location QR code" style="width: 100px; height: 100px; margin: 8px auto;" />
    <div class="qr-label" style="font-size: 10px; color: #666; margin-top: 4px;">Scan for customer location</div>
  </div>`
      : ''
  }

  <table>
    <thead><tr><th>Item</th><th>Qty</th></tr></thead>
    <tbody>
      ${items.map((i) => `<tr><td>${escapeHtml(i.item_name)}</td><td>${i.qty}</td></tr>`).join('')}
    </tbody>
  </table>

  <div class="payment ${isCod ? 'cod' : ''}">
    <div>${escapeHtml(paymentLabel)}</div>
    <div class="big">${isCod ? `COLLECT AED ${Number(order.total_in_aed).toFixed(2)}` : 'PREPAID — PAID'}</div>
  </div>

  ${order.notes ? `<div class="section remarks"><div class="label">Remarks</div><div>${escapeHtml(order.notes)}</div></div>` : ''}

  <script>
    function setSlipSize(size, btn) {
      var sizeMap = {
        'A5': 'A5',
        'A6': 'A6',
        'compact': '101.6mm 152.4mm'
      };
      var pageSize = sizeMap[size] || 'A5';
      document.getElementById('page-size-style').textContent = '@page { size: ' + pageSize + '; margin: 10mm; }';
      document.querySelectorAll('.controls button[data-size]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.body.classList.toggle('compact', size === 'compact');
    }
  </script>
</body>
</html>`;

    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    win.close();
    throw err;
  }
}

// openReturnSlip — the return-pickup counterpart to openShippingSlip above.
// A courier's own generated label (NextDrop's generate_label, or any future
// integrated courier's equivalent) can't carry custom text — it's their
// fixed document — and in any case return pickups here are always manual
// (see OrderReturns.tsx's MarkReceivedDialog, is_manual: true), so this is
// the only place return item details ever reach the courier physically
// picking them up. Printable as soon as a return is started — the pickup
// often happens before "Mark received" is ever clicked (that step is when
// stock/courier-cost get recorded, typically once the item is already back
// in hand), so this deliberately doesn't require a courier leg to exist yet.
export async function openReturnSlip(returnId: string): Promise<void> {
  const win = window.open('', '_blank');
  if (!win) throw new Error('Popup blocked — allow popups for this site to print the return slip.');
  win.document.write('<p style="font-family: sans-serif; padding: 16px;">Loading return slip…</p>');

  try {
    const [companyRes, returnRes, itemsRes, shipmentRes] = await Promise.all([
      supabase.from('company_settings').select('business_name').limit(1).maybeSingle(),
      supabase
        .from('order_returns')
        .select('id, type, created_at, order_id, orders(order_number, customer_id, customers(name, phone))')
        .eq('id', returnId)
        .single(),
      supabase.from('return_items').select('item_name, qty, reason').eq('return_id', returnId),
      supabase
        .from('shipments')
        .select('shipment_legs(courier_id, manual_courier_name, couriers(name))')
        .eq('return_id', returnId)
        .eq('direction', 'inbound')
        .maybeSingle(),
    ]);

    if (companyRes.error) throw companyRes.error;
    if (returnRes.error) throw returnRes.error;
    if (itemsRes.error) throw itemsRes.error;
    if (shipmentRes.error) throw shipmentRes.error;

    const orderReturn = returnRes.data;
    const order = firstEmbedded(orderReturn.orders);
    if (!order) throw new Error('No order found for this return.');
    const customer = firstEmbedded(order.customers);

    let addressLines: string[] = [];
    if (order.customer_id) {
      const { data: addr, error: addrError } = await supabase
        .from('customer_addresses')
        .select('full_address, area, city, countries(name)')
        .eq('customer_id', order.customer_id)
        .eq('is_default', true)
        .maybeSingle();
      if (addrError) throw addrError;
      if (addr) {
        addressLines = [addr.full_address, [addr.area, addr.city].filter(Boolean).join(', '), embeddedName(addr.countries)].filter(
          (l): l is string => !!l,
        );
      }
    }

    const leg = firstEmbedded(shipmentRes.data?.shipment_legs);
    const legCourier = leg ? firstEmbedded(leg.couriers) : null;
    const courierName = leg ? displayCourierName(legCourier?.name ?? null, leg.manual_courier_name) : null;

    const items = itemsRes.data ?? [];
    const isExchange = orderReturn.type === 'exchange';
    const remarksText = items
      .map((i) => `${i.qty}x ${i.item_name}${i.reason ? ` (${i.reason})` : ''}`)
      .join('; ');

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Return slip — ${escapeHtml(order.order_number)}</title>
<style id="page-size-style">@page { size: A5; margin: 10mm; }</style>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 16px; font-size: 12px; }
  .controls { display: flex; gap: 8px; margin-bottom: 16px; }
  .controls button { font-size: 12px; padding: 4px 10px; border: 1px solid #999; background: #f5f5f5; cursor: pointer; border-radius: 4px; }
  .controls button.active { background: #333; color: #fff; border-color: #333; }
  @media print { .controls { display: none; } }
  .header { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
  .header .business-name { font-size: 18px; font-weight: 700; }
  .header .slip-title { font-size: 11px; letter-spacing: 1px; color: #555; margin-top: 2px; }
  .meta-row { display: flex; justify-content: space-between; margin-bottom: 12px; }
  .section { margin-bottom: 12px; }
  .section .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th, td { text-align: left; padding: 4px 0; border-bottom: 1px solid #ddd; }
  th:last-child, td:last-child { text-align: right; }
  .remarks { border: 1px solid #111; padding: 8px; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="controls">
    <button type="button" class="active" data-size="A5" onclick="setSlipSize('A5', this)">A5</button>
    <button type="button" data-size="A6" onclick="setSlipSize('A6', this)">A6</button>
    <button type="button" onclick="window.print()">Print</button>
  </div>

  <div class="header">
    <div class="business-name">${escapeHtml(companyRes.data?.business_name || 'Noura OMS')}</div>
    <div class="slip-title">${isExchange ? 'EXCHANGE — RETURN PICKUP SLIP' : 'RETURN PICKUP SLIP'}</div>
  </div>

  <div class="meta-row">
    <div><strong>Order:</strong> ${escapeHtml(order.order_number)}</div>
    <div><strong>Date:</strong> ${escapeHtml(formatDate(orderReturn.created_at))}</div>
  </div>

  <div class="section">
    <div class="label">Pickup from</div>
    <div>${escapeHtml(customer?.name || '—')}</div>
    ${customer?.phone ? `<div>${escapeHtml(customer.phone)}</div>` : ''}
    ${addressLines.length ? addressLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') : '<div>No address on file</div>'}
  </div>

  <div class="section">
    <div class="label">Courier</div>
    <div>${escapeHtml(courierName || 'Not yet assigned')}</div>
  </div>

  <table>
    <thead><tr><th>Item</th><th>Qty</th></tr></thead>
    <tbody>
      ${items.map((i) => `<tr><td>${escapeHtml(i.item_name)}${i.reason ? ` — ${escapeHtml(i.reason)}` : ''}</td><td>${i.qty}</td></tr>`).join('') || '<tr><td colspan="2">No items recorded</td></tr>'}
    </tbody>
  </table>

  <div class="remarks">
    <div class="section-label" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 2px;">Remarks</div>
    <div>${escapeHtml(remarksText || 'No items recorded')}</div>
  </div>

  <script>
    function setSlipSize(size, btn) {
      document.getElementById('page-size-style').textContent = '@page { size: ' + size + '; margin: 10mm; }';
      document.querySelectorAll('.controls button[data-size]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
    }
  </script>
</body>
</html>`;

    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    win.close();
    throw err;
  }
}
