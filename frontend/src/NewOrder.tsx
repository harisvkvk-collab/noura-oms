// NewOrder.tsx — the New Order tab. Creates an order plus everything that
// goes with it: line items, stock decrement, a payment record (or nothing,
// for COD — money isn't collected until the courier delivers), and for
// online orders a single-leg shipment. In-store orders skip all of that
// shipping machinery and complete immediately.
//
// Known gaps, flagged rather than silently papered over:
// - Reference photos upload to the private 'order-photos' Storage bucket —
//   run scripts/setup-order-photos-storage.sql once first (creates the
//   bucket + a staff-only RLS policy, same pattern as policies.sql). If a
//   photo fails to upload, order creation still succeeds; that photo is
//   just dropped with a warning rather than blocking the whole order.
// - Not wrapped in a DB transaction (no RPC function for this exists yet) —
//   a failure partway through can leave a partially-created order. Good
//   enough for single-till low-volume usage today; worth revisiting before
//   this sees real concurrent traffic.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { supabase } from './supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PAYMENT_METHOD_LABELS, HOME_COUNTRY } from '@/lib/orderConstants';
import { isGenericCourierName } from '@/lib/courier';
import { callEdgeFunction } from '@/lib/edgeFunctions';
import { tryNormalizePhoneForSearch } from '@/lib/phoneUtils';

const ORDER_SOURCES = ['Instagram', 'WhatsApp', 'Facebook', 'TikTok', 'In-store'] as const;
type OrderSource = (typeof ORDER_SOURCES)[number];

type Currency = { code: string; name: string; symbol: string | null };
type ExchangeRate = { currency_code: string; rate_to_aed: number };
type Customer = { id: string; name: string; phone: string | null };
type Product = { id: string; name: string; selling_price: number; stock_qty: number; cost_price: number };
type Courier = { id: string; name: string; default_cod_fee: number | null; integration_status: string };
type CountryPaymentMethod = { country_code: string; payment_method: string; is_default: boolean };
type PickupLocation = { id: string; name: string; is_default: boolean };

type LineItem = {
  key: string;
  productId: string | null;
  name: string;
  qty: number;
  unitPrice: number;
};

type PendingPhoto = { key: string; file: File; previewUrl: string };

function newKey() {
  return Math.random().toString(36).slice(2);
}

async function generateOrderNumber(): Promise<string> {
  const { data, error } = await supabase
    .from('orders')
    .select('order_number')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const last = data?.[0]?.order_number as string | undefined;
  const lastNum = last ? parseInt(last.replace(/\D/g, ''), 10) : NaN;
  const next = (Number.isFinite(lastNum) ? lastNum : 1000) + 1;
  return `#${next}`;
}

export function NewOrder({ staffId, onCreated }: { staffId: string; onCreated?: () => void }) {
  // ---- reference data ----
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [countryPaymentMethods, setCountryPaymentMethods] = useState<CountryPaymentMethod[]>([]);
  const [pickupLocations, setPickupLocations] = useState<PickupLocation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [curRes, rateRes, custRes, prodRes, courierRes, cpmRes, pickupRes] = await Promise.all([
        supabase.from('currencies').select('code, name, symbol').order('code'),
        supabase.from('exchange_rates').select('currency_code, rate_to_aed'),
        supabase.from('customers').select('id, name, phone').order('name'),
        supabase.from('products').select('id, name, selling_price, stock_qty, cost_price').eq('active', true).order('name'),
        supabase
          .from('couriers')
          .select('id, name, default_cod_fee, integration_status')
          .eq('active', true)
          .order('name'),
        supabase.from('country_payment_methods').select('country_code, payment_method, is_default'),
        supabase.from('pickup_locations').select('id, name, is_default').eq('active', true).order('name'),
      ]);
      if (cancelled) return;
      const firstError = [curRes, rateRes, custRes, prodRes, courierRes, cpmRes, pickupRes].find((r) => r.error)?.error;
      if (firstError) {
        setLoadError(firstError.message);
        return;
      }
      setCurrencies(curRes.data ?? []);
      setExchangeRates(rateRes.data ?? []);
      setCustomers(custRes.data ?? []);
      setProducts(prodRes.data ?? []);
      setCouriers(courierRes.data ?? []);
      setCountryPaymentMethods(cpmRes.data ?? []);
      setPickupLocations(pickupRes.data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- form state ----
  const [orderSource, setOrderSource] = useState<OrderSource>('Instagram');
  const [currencyCode, setCurrencyCode] = useState('AED');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerCountry, setCustomerCountry] = useState<string | null>(null);
  const [deliveryArea, setDeliveryArea] = useState<string | null>(null);
  const [items, setItems] = useState<LineItem[]>([{ key: newKey(), productId: null, name: '', qty: 1, unitPrice: 0 }]);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string | null>(null);
  const [courierId, setCourierId] = useState<string | null>(null);
  const [deliveryFee, setDeliveryFee] = useState<number>(0);
  const [manualCourierName, setManualCourierName] = useState('');
  const [pickupLocationId, setPickupLocationId] = useState<string | null>(null);

  // Defaults to whichever pickup location has is_default = true once the
  // list loads — guarded so it only sets it the first time, not every
  // re-render, in case staff have already changed it.
  useEffect(() => {
    setPickupLocationId((prev) => prev ?? pickupLocations.find((p) => p.is_default)?.id ?? null);
  }, [pickupLocations]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successOrderNumber, setSuccessOrderNumber] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isInStore = orderSource === 'In-store';
  const fulfillmentType = isInStore ? 'instore' : 'shipped';

  // Delivery country drives which payment methods show. In-store sales
  // happen in the shop itself, so that's always home-country regardless of
  // the customer's own address.
  const effectiveCountry = isInStore ? HOME_COUNTRY : customerCountry ?? HOME_COUNTRY;

  const availablePaymentMethods = useMemo(() => {
    const methods = countryPaymentMethods.filter((m) => m.country_code === effectiveCountry);
    return isInStore ? methods.filter((m) => m.payment_method !== 'cod') : methods;
  }, [countryPaymentMethods, effectiveCountry, isInStore]);

  // Reset a payment method that's no longer valid when the country/source changes.
  useEffect(() => {
    if (paymentMethod && !availablePaymentMethods.some((m) => m.payment_method === paymentMethod)) {
      setPaymentMethod(null);
    }
  }, [availablePaymentMethods, paymentMethod]);

  useEffect(() => {
    if (isInStore) {
      setCourierId(null);
    }
  }, [isInStore]);

  // AED is the schema's base currency (see schema.sql: cost/selling price are
  // always stored in AED) — it's always rate 1 and never needs a DB lookup,
  // so orders in AED work even before exchange_rates has been seeded.
  const rate =
    currencyCode === 'AED' ? 1 : exchangeRates.find((r) => r.currency_code === currencyCode)?.rate_to_aed;
  const subtotal = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  const totalInAed = rate != null ? Math.round(subtotal * rate * 100) / 100 : null;

  const selectedCourier = couriers.find((c) => c.id === courierId);
  const isGenericCourier = isGenericCourierName(selectedCourier?.name);

  async function resolveCustomerCountry(id: string) {
    const { data } = await supabase
      .from('customer_addresses')
      .select('country_code, area')
      .eq('customer_id', id)
      .eq('is_default', true)
      .maybeSingle();
    setCustomerCountry(data?.country_code ?? null);
    setDeliveryArea(data?.area ?? null);
  }

  function selectCustomer(c: Customer) {
    setCustomerId(c.id);
    setCustomerQuery(c.name);
    resolveCustomerCountry(c.id);
  }

  async function addCustomer(name: string) {
    const { data, error } = await supabase.from('customers').insert({ name }).select('id, name, phone').single();
    if (error) {
      setError(error.message);
      return;
    }
    setCustomers((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    selectCustomer(data);
  }

  function addItem() {
    setItems((prev) => [...prev, { key: newKey(), productId: null, name: '', qty: 1, unitPrice: 0 }]);
  }

  function updateItem(key: string, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }

  function selectProductForItem(key: string, product: Product) {
    updateItem(key, { productId: product.id, name: product.name, unitPrice: product.selling_price });
  }

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setPhotos((prev) => [...prev, ...files.map((file) => ({ key: newKey(), file, previewUrl: URL.createObjectURL(file) }))]);
    e.target.value = '';
  }

  function removePhoto(key: string) {
    setPhotos((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  useEffect(() => {
    return () => {
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
  }, []);

  function resetForm() {
    setOrderSource('Instagram');
    setCurrencyCode('AED');
    setCustomerId(null);
    setCustomerQuery('');
    setCustomerCountry(null);
    setItems([{ key: newKey(), productId: null, name: '', qty: 1, unitPrice: 0 }]);
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPhotos([]);
    setNotes('');
    setPaymentMethod(null);
    setCourierId(null);
    setDeliveryFee(0);
    setManualCourierName('');
    setDeliveryArea(null);
    setPickupLocationId(pickupLocations.find((p) => p.is_default)?.id ?? null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validItems = items.filter((i) => i.name.trim() && i.qty > 0);
    if (!customerId) return setError('Pick or add a customer first.');
    if (validItems.length === 0) return setError('Add at least one line item.');
    if (!paymentMethod) return setError('Pick a payment method.');
    if (!isInStore && !courierId) return setError('Pick a courier for shipped orders.');
    if (rate == null) {
      return setError(
        `No exchange rate on file for ${currencyCode} — run scripts/seed-exchange-rates.sql (or add one) before using this currency.`,
      );
    }

    setSubmitting(true);
    try {
      const orderNumber = await generateOrderNumber();
      const subtotalNow = validItems.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
      const totalNow = subtotalNow;
      const totalInAedNow = Math.round(totalNow * rate * 100) / 100;
      const paidNow = paymentMethod !== 'cod';

      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          order_number: orderNumber,
          customer_id: customerId,
          order_source: orderSource,
          fulfillment_type: fulfillmentType,
          currency_code: currencyCode,
          exchange_rate_snapshot: rate,
          subtotal: subtotalNow,
          discount: 0,
          total: totalNow,
          total_in_aed: totalInAedNow,
          payment_method: paymentMethod,
          payment_status: paidNow ? 'paid' : 'unpaid',
          status: isInStore ? 'completed' : 'draft',
          delivery_country_code: isInStore ? null : effectiveCountry,
          delivery_area: isInStore ? null : deliveryArea,
          notes: notes || null,
          created_by: staffId,
        })
        .select('id, order_number')
        .single();
      if (orderError) throw orderError;

      const { error: itemsError } = await supabase.from('order_items').insert(
        validItems.map((i) => ({
          order_id: order.id,
          product_id: i.productId,
          item_name: i.name,
          qty: i.qty,
          unit_price: i.unitPrice,
          subtotal: i.qty * i.unitPrice,
          unit_cost_aed: i.productId ? products.find((p) => p.id === i.productId)?.cost_price ?? null : null,
        })),
      );
      if (itemsError) throw itemsError;

      // Decrement stock for items tied to a real catalog product. Reads the
      // stock level captured at page load rather than re-fetching — fine for
      // this shop's single-till volume, worth revisiting if usage grows.
      for (const item of validItems) {
        if (!item.productId) continue;
        const product = products.find((p) => p.id === item.productId);
        if (!product) continue;
        const newStock = product.stock_qty - item.qty;
        const { error: stockError } = await supabase
          .from('products')
          .update({ stock_qty: newStock })
          .eq('id', item.productId);
        if (stockError) throw stockError;
        const { error: ledgerError } = await supabase.from('inventory_ledger').insert({
          product_id: item.productId,
          change_qty: -item.qty,
          reason: 'sale',
          reference_type: 'order',
          reference_id: order.id,
          created_by: staffId,
        });
        if (ledgerError) throw ledgerError;
      }

      if (paidNow) {
        const { error: paymentError } = await supabase.from('payments').insert({
          order_id: order.id,
          method: paymentMethod,
          amount: totalNow,
          currency_code: currencyCode,
          paid_at: new Date().toISOString(),
          recorded_by: staffId,
        });
        if (paymentError) throw paymentError;
      }

      let shipmentBookingWarning = '';
      if (!isInStore) {
        const { data: shipment, error: shipmentError } = await supabase
          .from('shipments')
          .insert({
            order_id: order.id,
            direction: 'outbound',
            origin_country_code: HOME_COUNTRY,
            destination_country_code: effectiveCountry,
            status: 'pending',
          })
          .select('id')
          .single();
        if (shipmentError) throw shipmentError;

        const { data: shipmentLeg, error: legError } = await supabase
          .from('shipment_legs')
          .insert({
            shipment_id: shipment.id,
            leg_order: 1,
            leg_type: effectiveCountry === HOME_COUNTRY ? 'domestic' : 'international',
            courier_id: courierId,
            cost: deliveryFee,
            manual_courier_name: isGenericCourier ? manualCourierName.trim() || null : null,
            pickup_location_id: pickupLocationId,
            currency_code: currencyCode,
            status: 'pending',
            is_manual: true,
          })
          .select('id')
          .single();
        if (legError) throw legError;

        // Integrated couriers (couriers.integration_status = 'integrated')
        // get booked automatically via their adapter, right here — see
        // functions/create-shipment. Failure is non-fatal (same "warn,
        // don't block" precedent as the photo-upload handling below): the
        // leg just stays is_manual with no tracking number, same as any
        // manual courier, and staff can chase it up by hand.
        if (selectedCourier?.integration_status === 'integrated') {
          try {
            const result = await callEdgeFunction<{ ok: boolean; trackingNumber?: string; error?: string }>(
              'create-shipment',
              { shipmentLegId: shipmentLeg.id },
            );
            if (!result.ok) {
              shipmentBookingWarning = ` (courier booking failed: ${result.error ?? 'unknown error'} — enter tracking manually later)`;
            }
          } catch {
            shipmentBookingWarning = ' (courier booking failed — enter tracking manually later)';
          }
        }

        // Non-COD orders never generate a courier_cod_receivable (no cash
        // was collected by the courier to net the fee out of), so the
        // delivery fee owed to the courier is tracked here instead. COD
        // orders skip this — their fee is deducted from the cash collected
        // when the order is marked delivered (see OrderDetail.tsx).
        if (paymentMethod !== 'cod') {
          const { error: payableError } = await supabase.from('courier_payables').insert({
            order_id: order.id,
            shipment_leg_id: shipmentLeg.id,
            courier_id: courierId,
            amount: deliveryFee,
            reason: 'delivery',
            status: 'unpaid',
          });
          if (payableError) throw payableError;
        }

        const { error: timelineError } = await supabase.from('order_timeline').insert({
          order_id: order.id,
          step: 'created',
          staff_user_id: staffId,
        });
        if (timelineError) throw timelineError;
      }

      // order-photos is a private bucket (see scripts/setup-order-photos-storage.sql)
      // — no public URL works against it. We store the storage *path* in
      // image_url, not a URL; whatever screen displays these later needs to
      // call supabase.storage.from('order-photos').createSignedUrl(path, ...)
      // to actually view one. A signed/public URL stored directly would either
      // go stale (signed URLs expire) or bypass the staff-only access policy
      // (public URLs skip RLS entirely).
      let photoWarning = '';
      if (photos.length > 0) {
        let uploadFailures = 0;
        for (const photo of photos) {
          const path = `${order.id}/${photo.key}-${photo.file.name}`;
          const { error: uploadError } = await supabase.storage.from('order-photos').upload(path, photo.file);
          if (uploadError) {
            uploadFailures += 1;
            continue;
          }
          await supabase.from('order_photos').insert({ order_id: order.id, image_url: path });
        }
        if (uploadFailures > 0) {
          photoWarning = ` (${uploadFailures} photo(s) couldn't be saved — run scripts/setup-order-photos-storage.sql first)`;
        }
      }

      setSuccessOrderNumber(order.order_number + shipmentBookingWarning + photoWarning);
      resetForm();
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create order.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {successOrderNumber && (
        <Card className="border-success bg-success/10">
          <CardContent className="p-3 text-sm text-success-foreground">
            Order {successOrderNumber} created.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid grid-cols-1 gap-2 p-2 sm:gap-4 sm:p-4 sm:grid-cols-3">
          <div className="relative flex flex-col gap-1">
            <Label className="text-sm">Customer</Label>
            <Input
              value={customerQuery}
              onChange={(e) => {
                setCustomerQuery(e.target.value);
                setCustomerId(null);
                setCustomerCountry(null);
              }}
              placeholder="Search or add customer"
              autoComplete="off"
            />
            {customerQuery.trim() && !customerId && (
              <div className="absolute top-full z-10 mt-1 w-full rounded-md border border-border bg-card shadow-md">
                {customers
                  .filter((c) => {
                    const query = customerQuery.toLowerCase();
                    const nameMatch = c.name.toLowerCase().includes(query);
                    const phoneMatch = c.phone ? tryNormalizePhoneForSearch(customerQuery)?.includes(c.phone) || c.phone.includes(query) : false;
                    return nameMatch || phoneMatch;
                  })
                  .slice(0, 6)
                  .map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => selectCustomer(c)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
                    >
                      {c.name}
                      {c.phone ? <span className="text-muted-foreground"> · {c.phone}</span> : null}
                    </button>
                  ))}
                <button
                  type="button"
                  onClick={() => addCustomer(customerQuery.trim())}
                  className="block w-full border-t border-border px-3 py-2 text-left text-sm text-primary hover:bg-secondary"
                >
                  + Add "{customerQuery.trim()}" as new customer
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Order source</Label>
            <Select value={orderSource} onValueChange={(v) => setOrderSource(v as OrderSource)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORDER_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Currency</Label>
            <Select value={currencyCode} onValueChange={setCurrencyCode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currencies.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {rate == null && (
              <p className="text-xs text-destructive">No exchange rate on file for {currencyCode}.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-2 p-3">
          <Label className="text-sm">Line items</Label>
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_40px_50px_40px_24px] gap-1 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_56px_76px_76px_28px]">
              <span>Item</span>
              <span className="text-center">Qty</span>
              <span className="text-right">Price</span>
              <span className="text-right">Subtotal</span>
              <span />
            </div>
            {items.map((item) => (
              <LineItemRow
                key={item.key}
                item={item}
                products={products}
                onChange={(patch) => updateItem(item.key, patch)}
                onSelectProduct={(p) => selectProductForItem(item.key, p)}
                onRemove={() => removeItem(item.key)}
              />
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addItem}>
            <Plus className="size-4" /> Add item
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <Label>Reference photo</Label>
          <div className="flex flex-wrap gap-3">
            {photos.map((p) => (
              <div key={p.key} className="relative size-20 overflow-hidden rounded-md border border-border">
                <img src={p.previewUrl} alt="" className="size-full object-cover" />
                <button
                  type="button"
                  onClick={() => removePhoto(p.key)}
                  className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                  aria-label="Remove photo"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-input text-muted-foreground hover:bg-secondary"
            >
              <Plus className="size-4" />
              <span className="text-xs">Add photo</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFilesSelected}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-1.5 p-4">
          <Label htmlFor="order-notes">Order notes</Label>
          <Textarea
            id="order-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. customer wants sleeve length adjusted, matches the photo above, deliver after 6pm…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-1 items-end gap-2 p-2 sm:gap-4 sm:p-4 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label>Payment method</Label>
            <Select value={paymentMethod ?? undefined} onValueChange={setPaymentMethod} disabled={!customerId}>
              <SelectTrigger>
                <SelectValue placeholder={customerId ? 'Select' : 'Pick a customer first'} />
              </SelectTrigger>
              <SelectContent>
                {availablePaymentMethods.map((m) => (
                  <SelectItem key={m.payment_method} value={m.payment_method}>
                    {PAYMENT_METHOD_LABELS[m.payment_method] ?? m.payment_method}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isInStore && (
            <div className="flex flex-col gap-1.5">
              <Label>Courier</Label>
              <Select
                value={courierId ?? undefined}
                onValueChange={(id) => {
                  setCourierId(id);
                  const courier = couriers.find((c) => c.id === id);
                  if (courier?.default_cod_fee != null) setDeliveryFee(courier.default_cod_fee);
                  if (!isGenericCourierName(courier?.name)) setManualCourierName('');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {couriers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isGenericCourier && (
                <Input
                  value={manualCourierName}
                  onChange={(e) => setManualCourierName(e.target.value)}
                  placeholder="Courier company name"
                  className="mt-1.5"
                />
              )}
            </div>
          )}

          {!isInStore && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delivery-fee">Delivery fee</Label>
              <Input
                id="delivery-fee"
                type="number"
                min={0}
                step="0.01"
                value={deliveryFee}
                onChange={(e) => setDeliveryFee(Number(e.target.value))}
              />
            </div>
          )}

          {!isInStore && (
            <div className="flex flex-col gap-1.5">
              <Label>Pickup location</Label>
              <Select value={pickupLocationId ?? undefined} onValueChange={setPickupLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {pickupLocations.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.is_default ? ' (default)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5 sm:col-start-4">
            <Label>Order total</Label>
            <div className="text-2xl font-bold tracking-tight">
              {currencyCode} {subtotal.toFixed(2)}
            </div>
            {totalInAed != null && currencyCode !== 'AED' && (
              <p className="text-xs text-muted-foreground">≈ AED {totalInAed.toFixed(2)}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : isInStore ? 'Complete sale' : 'Create order'}
        </Button>
      </div>
    </form>
  );
}

function LineItemRow({
  item,
  products,
  onChange,
  onSelectProduct,
  onRemove,
}: {
  item: LineItem;
  products: Product[];
  onChange: (patch: Partial<LineItem>) => void;
  onSelectProduct: (p: Product) => void;
  onRemove: () => void;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const matches = products.filter((p) => p.name.toLowerCase().includes(item.name.toLowerCase())).slice(0, 6);
  const overStock =
    item.productId != null &&
    (() => {
      const p = products.find((pr) => pr.id === item.productId);
      return p != null && item.qty > p.stock_qty;
    })();

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_40px_50px_40px_24px] items-start gap-1 sm:grid-cols-[minmax(0,1fr)_56px_76px_76px_28px] sm:gap-2">
      <div className="relative min-w-0">
        <Input
          value={item.name}
          onChange={(e) => {
            onChange({ name: e.target.value, productId: null });
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          className="h-8 text-xs"
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          placeholder="Item name"
          autoComplete="off"
        />
        {showDropdown && item.name.trim() && matches.length > 0 && (
          <div className="absolute top-full z-10 mt-1 w-full rounded-md border border-border bg-card shadow-md">
            {matches.map((p) => (
              <button
                type="button"
                key={p.id}
                onMouseDown={() => onSelectProduct(p)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
              >
                {p.name} <span className="text-muted-foreground">· {p.stock_qty} in stock</span>
              </button>
            ))}
          </div>
        )}
        {overStock && <p className="mt-0.5 text-xs text-destructive">Only limited stock left</p>}
      </div>
      <Input
        type="number"
        min={1}
        value={item.qty}
        onChange={(e) => onChange({ qty: Number(e.target.value) })}
        className="h-8 text-xs text-center"
      />
      <Input
        type="number"
        min={0}
        step="0.01"
        value={item.unitPrice}
        onChange={(e) => onChange({ unitPrice: Number(e.target.value) })}
        className="h-8 text-xs text-right"
      />
      <div className="flex h-8 items-center text-xs text-right">{(item.qty * item.unitPrice).toFixed(2)}</div>
      <button
        type="button"
        onClick={onRemove}
        className="flex h-9 items-center justify-center text-muted-foreground hover:text-destructive"
        aria-label="Remove item"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
