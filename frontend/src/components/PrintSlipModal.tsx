import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { firstEmbedded, embeddedName } from '@/lib/supabaseRelations';
import { displayCourierName } from '@/lib/courier';
import { PAYMENT_METHOD_LABELS } from '@/lib/orderConstants';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import QRCode from 'qrcode';

type PrintSlipModalProps = {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

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

export function PrintSlipModal({ orderId, open, onOpenChange }: PrintSlipModalProps) {
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!open) return;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [companyRes, orderRes, itemsRes, shipmentRes] = await Promise.all([
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

        const slipHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Shipping slip — ${escapeHtml(order.order_number)}</title>
<style id="page-size-style">@page { size: A5; margin: 5mm; }</style>
<style>
  * { box-sizing: border-box; }
  html { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 3mm; font-size: 11px; line-height: 1.2; }
  @media print {
    html { margin: 0; padding: 0; }
    body { margin: 0 !important; padding: 3mm !important; }
    .controls { display: none !important; }
  }
  .controls { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .controls button { font-size: 11px; padding: 3px 8px; border: 1px solid #999; background: #f5f5f5; cursor: pointer; border-radius: 3px; }
  .controls button.active { background: #333; color: #fff; border-color: #333; }
  .controls .separator { width: 1px; background: #999; margin: 0 4px; }
  @media print { .controls { display: none; } }
  .header { border-bottom: 1.5px solid #111; padding-bottom: 4px; margin-bottom: 6px; }
  .header .business-name { font-size: 16px; font-weight: 700; margin: 0; }
  .header .slip-title { font-size: 9px; letter-spacing: 0.5px; color: #555; margin: 1px 0 0 0; }
  .courier-banner { font-size: 18px; font-weight: 800; text-transform: uppercase; text-align: center; border: 2px solid #111; padding: 4px 2px; margin-bottom: 6px; letter-spacing: 0.5px; }
  .meta-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 11px; }
  .section { margin-bottom: 6px; }
  .section .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; color: #555; margin-bottom: 1px; font-weight: 600; }
  .section { font-size: 12px; line-height: 1.3; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  th, td { text-align: left; padding: 2px 0; border-bottom: 1px solid #ddd; font-size: 11px; }
  th:last-child, td:last-child { text-align: right; }
  .qr-section { margin: 2px 0 4px 0; text-align: center; }
  .qr-section img { display: block; margin: 0 auto; }
  .qr-section .qr-label { font-size: 9px; color: #666; margin-top: 1px; }
  .payment { border: 1px solid #111; padding: 6px 4px; margin: 6px 0; }
  .payment .big { font-size: 15px; font-weight: 700; margin-top: 2px; }
  .payment.cod .big { color: #b00020; }

  body.compact { font-size: 9px; padding: 2.5mm; line-height: 1.1; }
  body.compact .header { padding-bottom: 2px; margin-bottom: 4px; }
  body.compact .header .business-name { font-size: 13px; margin: 0; }
  body.compact .header .slip-title { font-size: 8px; margin: 0.5px 0 0 0; }
  body.compact .courier-banner { font-size: 15px; padding: 2px 1px; margin-bottom: 4px; }
  body.compact .meta-row { margin-bottom: 4px; font-size: 9px; }
  body.compact .section { margin-bottom: 4px; font-size: 10px; line-height: 1.2; }
  body.compact .section .label { font-size: 8px; margin-bottom: 0.5px; }
  body.compact table { margin-bottom: 4px; font-size: 9px; }
  body.compact th, body.compact td { padding: 1px 0; }
  body.compact .qr-section { margin: 1px 0 3px 0; text-align: center; }
  body.compact .qr-section img { width: 45px; height: 45px; margin: 1px auto; }
  body.compact .qr-section .qr-label { font-size: 7px; margin-top: 0.5px; }
  body.compact .payment { padding: 4px 3px; margin: 4px 0; }
  body.compact .payment .big { font-size: 13px; margin-top: 1px; }
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

        setHtml(slipHtml);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load shipping slip.');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, orderId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-4xl max-h-96 p-0 flex flex-col">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>Shipping Slip Preview</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <p>Loading shipping slip…</p>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-destructive">
            <p>{error}</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-auto bg-slate-50">
              <iframe
                ref={iframeRef}
                srcDoc={html}
                className="w-full h-full border-0"
                title="Shipping slip preview"
              />
            </div>
            <div className="px-6 py-4 border-t flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (iframeRef.current?.contentWindow) {
                    iframeRef.current.contentWindow.print();
                  }
                }}
              >
                Print
              </Button>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
