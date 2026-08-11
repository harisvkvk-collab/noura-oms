// OrderReturns.tsx — Returns & Exchanges section on OrderDetail.tsx, shown
// only for delivered orders. Two-step, same "record it, don't wait on
// integration" philosophy as the rest of fulfillment:
//
// 1. Start return/exchange — just records what's coming back (order_returns
//    + return_items), status 'pending'. No courier/cost yet: at this point
//    the pickup often hasn't even been arranged.
// 2. Mark received — staff enters the return-pickup courier + cost (and,
//    for an exchange, a second courier + cost for the replacement leg going
//    back out). This is when stock actually moves: +qty for the returned
//    product(s) (inventory_ledger reason 'return'), and for exchanges
//    -qty for the replacement going out (reason 'exchange'). Each leg gets
//    its own shipments/shipment_legs row (return_id set) and, like any
//    other leg, its own courier_payables row — the business owes the
//    courier for both directions regardless of how the original order was
//    paid for.
//
// Not wrapped in a DB transaction (same known limitation as NewOrder.tsx) —
// form-input validation happens before any write, but a failure mid-sequence
// (e.g. network drop) can still leave partial state.

import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { firstEmbedded, embeddedName } from '@/lib/supabaseRelations';
import { displayCourierName, isGenericCourierName } from '@/lib/courier';
import { HOME_COUNTRY } from '@/lib/orderConstants';
import { openReturnSlip } from '@/lib/shippingSlip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type OrderItemRow = { id: string; product_id: string | null; item_name: string; qty: number };

type ReturnItem = {
  id: string;
  order_item_id: string | null;
  product_id: string | null;
  item_name: string;
  qty: number;
  reason: string | null;
};

type ReplacementItem = {
  id: string;
  product_id: string;
  item_name: string;
  qty: number;
};

type OrderReturn = {
  id: string;
  type: 'return' | 'exchange';
  status: string;
  created_at: string;
  items: ReturnItem[];
  replacementItems: ReplacementItem[];
  legs: { direction: string; courierName: string | null }[];
};

type Courier = { id: string; name: string; default_cod_fee: number | null };
type ReplacementProduct = { id: string; name: string; stock_qty: number };

async function loadReturns(orderId: string): Promise<OrderReturn[]> {
  const { data, error } = await supabase
    .from('order_returns')
    .select(
      'id, type, status, created_at, return_items(id, order_item_id, product_id, item_name, qty, reason), exchange_replacement_items(id, product_id, item_name, qty), shipments(direction, shipment_legs(courier_id, cost, manual_courier_name, couriers(name)))',
    )
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    created_at: r.created_at,
    items: r.return_items ?? [],
    replacementItems: r.exchange_replacement_items ?? [],
    legs: (r.shipments ?? []).map((s) => {
      const leg = firstEmbedded(s.shipment_legs);
      const courierName = leg ? displayCourierName(embeddedName(leg.couriers), leg.manual_courier_name) : null;
      return { direction: s.direction, courierName };
    }),
  }));
}

export function OrderReturns({
  orderId,
  staffId,
  items,
  currencyCode,
  deliveryCountryCode,
}: {
  orderId: string;
  staffId: string;
  items: OrderItemRow[];
  currencyCode: string;
  deliveryCountryCode: string | null;
}) {
  const [returns, setReturns] = useState<OrderReturn[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [products, setProducts] = useState<ReplacementProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  const [receivingReturn, setReceivingReturn] = useState<OrderReturn | null>(null);
  const [printingReturnId, setPrintingReturnId] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);

  async function handlePrintReturnSlip(returnId: string) {
    setPrintingReturnId(returnId);
    setPrintError(null);
    try {
      await openReturnSlip(returnId);
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : 'Failed to build return slip.');
    } finally {
      setPrintingReturnId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [returnsData, courierRes, productRes] = await Promise.all([
          loadReturns(orderId),
          supabase.from('couriers').select('id, name, default_cod_fee').eq('active', true).order('name'),
          supabase.from('products').select('id, name, stock_qty').eq('active', true).order('name'),
        ]);
        if (cancelled) return;
        if (courierRes.error) throw courierRes.error;
        if (productRes.error) throw productRes.error;
        setReturns(returnsData);
        setCouriers(courierRes.data ?? []);
        setProducts(productRes.data ?? []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load returns.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, refreshKey]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Returns & exchanges</h2>
          <Button type="button" size="sm" variant="outline" onClick={() => setStartOpen(true)}>
            Start return/exchange
          </Button>
        </div>

        {printError && <p className="text-sm text-destructive">{printError}</p>}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : returns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No returns or exchanges for this order.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {returns.map((r) => (
              <li key={r.id} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium capitalize">{r.type}</span>
                  <Badge variant={r.status === 'received' ? 'success' : 'warning'}>{r.status}</Badge>
                </div>
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {r.items.map((it) => (
                    <li key={it.id} className="text-xs text-muted-foreground">
                      {it.qty}x {it.item_name}
                      {it.reason ? ` — ${it.reason}` : ''}
                    </li>
                  ))}
                </ul>
                {r.replacementItems.length > 0 && (
                  <ul className="mt-1.5 flex flex-col gap-0.5">
                    {r.replacementItems.map((it) => (
                      <li key={it.id} className="text-xs text-muted-foreground">
                        Replacement: {it.qty}x {it.item_name}
                      </li>
                    ))}
                  </ul>
                )}
                {r.legs.length > 0 && (
                  <ul className="mt-1.5 flex flex-col gap-0.5">
                    {r.legs.map((leg, idx) => (
                      <li key={idx} className="text-xs text-muted-foreground">
                        {leg.direction === 'inbound' ? 'Return pickup' : 'Replacement'} via{' '}
                        {leg.courierName ?? 'unknown courier'}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={printingReturnId === r.id}
                    onClick={() => handlePrintReturnSlip(r.id)}
                  >
                    {printingReturnId === r.id ? 'Building…' : 'Print return slip'}
                  </Button>
                  {r.status === 'pending' && (
                    <Button type="button" size="sm" onClick={() => setReceivingReturn(r)}>
                      Mark received
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {startOpen && (
        <StartReturnDialog
          orderId={orderId}
          staffId={staffId}
          items={items}
          products={products}
          open={startOpen}
          onOpenChange={setStartOpen}
          onCreated={() => {
            setStartOpen(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {receivingReturn && (
        <MarkReceivedDialog
          orderId={orderId}
          staffId={staffId}
          orderReturn={receivingReturn}
          couriers={couriers}
          currencyCode={currencyCode}
          deliveryCountryCode={deliveryCountryCode}
          open={receivingReturn !== null}
          onOpenChange={(open) => {
            if (!open) setReceivingReturn(null);
          }}
          onReceived={() => {
            setReceivingReturn(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </Card>
  );
}

type ReplacementRow = { key: string; productId: string | null; name: string; qty: number };

let replacementKeyCounter = 0;
function newReplacementKey() {
  replacementKeyCounter += 1;
  return `replacement-${replacementKeyCounter}`;
}

function StartReturnDialog({
  orderId,
  staffId,
  items,
  products,
  open,
  onOpenChange,
  onCreated,
}: {
  orderId: string;
  staffId: string;
  items: OrderItemRow[];
  products: ReplacementProduct[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<'return' | 'exchange'>('return');
  const [selection, setSelection] = useState<Record<string, { checked: boolean; qty: number; reason: string }>>(
    () => Object.fromEntries(items.map((i) => [i.id, { checked: false, qty: i.qty, reason: '' }])),
  );
  const [replacementItems, setReplacementItems] = useState<ReplacementRow[]>([
    { key: newReplacementKey(), productId: null, name: '', qty: 1 },
  ]);
  // Extra return items beyond what's on the original order — e.g. the
  // customer sent back something that wasn't actually part of this order,
  // or staff just want to log a free-text note as its own line. Reuses
  // ReplacementItemRow's search-or-type-a-name pattern (already built for
  // exchange replacements) rather than a second, separate widget.
  const [extraItems, setExtraItems] = useState<ReplacementRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateSelection(itemId: string, patch: Partial<{ checked: boolean; qty: number; reason: string }>) {
    setSelection((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }));
  }

  function updateReplacementItem(key: string, patch: Partial<ReplacementRow>) {
    setReplacementItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addReplacementItem() {
    setReplacementItems((prev) => [...prev, { key: newReplacementKey(), productId: null, name: '', qty: 1 }]);
  }

  function removeReplacementItem(key: string) {
    setReplacementItems((prev) => prev.filter((r) => r.key !== key));
  }

  function updateExtraItem(key: string, patch: Partial<ReplacementRow>) {
    setExtraItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addExtraItem() {
    setExtraItems((prev) => [...prev, { key: newReplacementKey(), productId: null, name: '', qty: 1 }]);
  }

  function removeExtraItem(key: string) {
    setExtraItems((prev) => prev.filter((r) => r.key !== key));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const chosen = items
      .map((i) => ({ item: i, sel: selection[i.id] }))
      .filter(({ sel }) => sel.checked);

    // Unlike the exchange-replacement rows below (which only count a row
    // once it resolves to a real product), an extra return item is valid
    // as soon as it has a name typed — that's the whole point of "manual
    // entry": something the customer sent back that isn't in the catalog,
    // or just a free-text note, shouldn't require a product match to log.
    const extraToInsert = extraItems.filter((r) => r.name.trim());

    if (chosen.length === 0 && extraToInsert.length === 0) return setError('Select or add at least one item.');
    for (const { sel } of chosen) {
      if (!(sel.qty > 0)) return setError('Quantity must be greater than zero for every selected item.');
    }
    const overQty = chosen.find(({ item, sel }) => sel.qty > item.qty);
    if (overQty) return setError(`Quantity for "${overQty.item.item_name}" can't exceed the ordered quantity.`);
    const badExtraQty = extraToInsert.find((r) => !(r.qty > 0));
    if (badExtraQty) return setError('Quantity must be greater than zero for every extra item.');

    const chosenReplacements = type === 'exchange' ? replacementItems.filter((r) => r.productId != null) : [];
    if (type === 'exchange') {
      if (chosenReplacements.length === 0) return setError('Pick at least one replacement item.');
      const badQty = chosenReplacements.find((r) => !(r.qty > 0));
      if (badQty) return setError('Quantity must be greater than zero for every replacement item.');
    }

    setSubmitting(true);
    try {
      const { data: orderReturn, error: returnError } = await supabase
        .from('order_returns')
        .insert({ order_id: orderId, type, status: 'pending', created_by: staffId })
        .select('id')
        .single();
      if (returnError) throw returnError;

      const { error: itemsError } = await supabase.from('return_items').insert([
        ...chosen.map(({ item, sel }) => ({
          return_id: orderReturn.id,
          order_item_id: item.id,
          product_id: item.product_id,
          item_name: item.item_name,
          qty: sel.qty,
          reason: sel.reason.trim() || null,
        })),
        ...extraToInsert.map((r) => ({
          return_id: orderReturn.id,
          order_item_id: null,
          product_id: r.productId,
          item_name: r.name.trim(),
          qty: r.qty,
          reason: null,
        })),
      ]);
      if (itemsError) throw itemsError;

      if (chosenReplacements.length > 0) {
        const { error: replacementError } = await supabase.from('exchange_replacement_items').insert(
          chosenReplacements.map((r) => ({
            return_id: orderReturn.id,
            product_id: r.productId,
            item_name: r.name,
            qty: r.qty,
          })),
        );
        if (replacementError) throw replacementError;
      }

      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start return.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Start return/exchange</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as 'return' | 'exchange')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="return">Return</SelectItem>
                <SelectItem value="exchange">Exchange</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Items</Label>
            {items.map((item) => {
              const sel = selection[item.id];
              return (
                <div key={item.id} className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sel.checked}
                      onChange={(e) => updateSelection(item.id, { checked: e.target.checked })}
                      className="size-4 rounded border-input"
                    />
                    {item.item_name} <span className="text-muted-foreground">(ordered {item.qty})</span>
                  </label>
                  {sel.checked && (
                    <div className="grid grid-cols-2 gap-2 pl-6">
                      <div className="flex flex-col gap-1">
                        <Label className="text-xs">Qty</Label>
                        <Input
                          type="number"
                          min={1}
                          max={item.qty}
                          value={sel.qty}
                          onChange={(e) => updateSelection(item.id, { qty: Number(e.target.value) })}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-xs">Reason</Label>
                        <Input
                          value={sel.reason}
                          onChange={(e) => updateSelection(item.id, { reason: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Extra items (not on this order)</Label>
            {extraItems.map((row) => (
              <ReplacementItemRow
                key={row.key}
                row={row}
                products={products}
                onChange={(patch) => updateExtraItem(row.key, patch)}
                onRemove={() => removeExtraItem(row.key)}
              />
            ))}
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addExtraItem}>
              Add item
            </Button>
          </div>

          {type === 'exchange' && (
            <div className="flex flex-col gap-2">
              <Label>Replacement items</Label>
              {replacementItems.map((row) => (
                <ReplacementItemRow
                  key={row.key}
                  row={row}
                  products={products}
                  onChange={(patch) => updateReplacementItem(row.key, patch)}
                  onRemove={() => removeReplacementItem(row.key)}
                />
              ))}
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addReplacementItem}>
                Add replacement item
              </Button>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Saving…' : type === 'exchange' ? 'Create exchange' : 'Create return'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReplacementItemRow({
  row,
  products,
  onChange,
  onRemove,
}: {
  row: ReplacementRow;
  products: ReplacementProduct[];
  onChange: (patch: Partial<ReplacementRow>) => void;
  onRemove: () => void;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const matches = products.filter((p) => p.name.toLowerCase().includes(row.name.toLowerCase())).slice(0, 6);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_64px_28px] items-start gap-2">
      <div className="relative min-w-0">
        <Input
          value={row.name}
          onChange={(e) => {
            onChange({ name: e.target.value, productId: null });
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          placeholder="Search product"
          autoComplete="off"
        />
        {showDropdown && row.name.trim() && matches.length > 0 && (
          <div className="absolute top-full z-10 mt-1 w-full rounded-md border border-border bg-card shadow-md">
            {matches.map((p) => (
              <button
                type="button"
                key={p.id}
                onMouseDown={() => onChange({ productId: p.id, name: p.name })}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
              >
                {p.name} <span className="text-muted-foreground">· {p.stock_qty} in stock</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <Input
        type="number"
        min={1}
        value={row.qty}
        onChange={(e) => onChange({ qty: Number(e.target.value) })}
      />
      <button
        type="button"
        onClick={onRemove}
        className="flex h-9 items-center justify-center text-muted-foreground hover:text-destructive"
        aria-label="Remove replacement item"
      >
        ×
      </button>
    </div>
  );
}

function CourierPicker({
  label,
  couriers,
  courierId,
  onCourierChange,
  fee,
  onFeeChange,
  manualName,
  onManualNameChange,
}: {
  label: string;
  couriers: Courier[];
  courierId: string | null;
  onCourierChange: (id: string) => void;
  fee: number;
  onFeeChange: (fee: number) => void;
  manualName: string;
  onManualNameChange: (name: string) => void;
}) {
  const courier = couriers.find((c) => c.id === courierId);
  const isGeneric = isGenericCourierName(courier?.name);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Courier</Label>
          <Select
            value={courierId ?? undefined}
            onValueChange={(id) => {
              onCourierChange(id);
              const c = couriers.find((x) => x.id === id);
              if (c?.default_cod_fee != null) onFeeChange(c.default_cod_fee);
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
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Cost</Label>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={fee}
            onChange={(e) => onFeeChange(Number(e.target.value))}
          />
        </div>
      </div>
      {isGeneric && (
        <Input
          value={manualName}
          onChange={(e) => onManualNameChange(e.target.value)}
          placeholder="Courier company name"
        />
      )}
    </div>
  );
}

function MarkReceivedDialog({
  orderId,
  staffId,
  orderReturn,
  couriers,
  currencyCode,
  deliveryCountryCode,
  open,
  onOpenChange,
  onReceived,
}: {
  orderId: string;
  staffId: string;
  orderReturn: OrderReturn;
  couriers: Courier[];
  currencyCode: string;
  deliveryCountryCode: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReceived: () => void;
}) {
  const isExchange = orderReturn.type === 'exchange';
  const [pickupCourierId, setPickupCourierId] = useState<string | null>(null);
  const [pickupFee, setPickupFee] = useState(0);
  const [pickupManualName, setPickupManualName] = useState('');
  const [replacementCourierId, setReplacementCourierId] = useState<string | null>(null);
  const [replacementFee, setReplacementFee] = useState(0);
  const [replacementManualName, setReplacementManualName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickupCourier = couriers.find((c) => c.id === pickupCourierId);
  const replacementCourier = couriers.find((c) => c.id === replacementCourierId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pickupCourierId) return setError('Pick a courier for the return pickup.');
    if (isExchange && !replacementCourierId) return setError('Pick a courier for the replacement shipment.');

    setSubmitting(true);
    try {
      // The return travels from the customer's country back to home base —
      // the mirror image of the outbound leg's origin/destination.
      const returnOrigin = deliveryCountryCode ?? HOME_COUNTRY;
      const legType = returnOrigin === HOME_COUNTRY ? 'domestic' : 'international';

      const { data: pickupShipment, error: pickupShipmentError } = await supabase
        .from('shipments')
        .insert({
          order_id: orderId,
          return_id: orderReturn.id,
          direction: 'inbound',
          origin_country_code: returnOrigin,
          destination_country_code: HOME_COUNTRY,
          status: 'delivered',
        })
        .select('id')
        .single();
      if (pickupShipmentError) throw pickupShipmentError;

      const { data: pickupLeg, error: pickupLegError } = await supabase
        .from('shipment_legs')
        .insert({
          shipment_id: pickupShipment.id,
          leg_order: 1,
          leg_type: legType,
          courier_id: pickupCourierId,
          cost: pickupFee,
          manual_courier_name: isGenericCourierName(pickupCourier?.name) ? pickupManualName.trim() || null : null,
          currency_code: currencyCode,
          status: 'delivered',
          is_manual: true,
        })
        .select('id')
        .single();
      if (pickupLegError) throw pickupLegError;

      const { error: pickupPayableError } = await supabase.from('courier_payables').insert({
        order_id: orderId,
        shipment_leg_id: pickupLeg.id,
        courier_id: pickupCourierId,
        amount: pickupFee,
        reason: 'return_pickup',
        status: 'unpaid',
      });
      if (pickupPayableError) throw pickupPayableError;

      // Stock for returned product(s): +qty back onto the shelf.
      const returnedQtyByProduct = new Map<string, number>();
      for (const item of orderReturn.items) {
        if (!item.product_id) continue;
        returnedQtyByProduct.set(item.product_id, (returnedQtyByProduct.get(item.product_id) ?? 0) + item.qty);
      }
      const productIds = [...returnedQtyByProduct.keys()];
      let stockByProduct = new Map<string, number>();
      if (productIds.length > 0) {
        const { data: productsData, error: productsError } = await supabase
          .from('products')
          .select('id, stock_qty')
          .in('id', productIds);
        if (productsError) throw productsError;
        stockByProduct = new Map((productsData ?? []).map((p) => [p.id, p.stock_qty]));
      }

      for (const productId of productIds) {
        const qty = returnedQtyByProduct.get(productId)!;
        const current = stockByProduct.get(productId) ?? 0;
        const increased = current + qty;
        const { error: stockError } = await supabase
          .from('products')
          .update({ stock_qty: increased })
          .eq('id', productId);
        if (stockError) throw stockError;
        const { error: ledgerError } = await supabase.from('inventory_ledger').insert({
          product_id: productId,
          change_qty: qty,
          reason: 'return',
          reference_type: 'order_return',
          reference_id: orderReturn.id,
          created_by: staffId,
        });
        if (ledgerError) throw ledgerError;
        stockByProduct.set(productId, increased);
      }

      if (isExchange) {
        const { data: replacementShipment, error: replacementShipmentError } = await supabase
          .from('shipments')
          .insert({
            order_id: orderId,
            return_id: orderReturn.id,
            direction: 'outbound',
            origin_country_code: HOME_COUNTRY,
            destination_country_code: returnOrigin,
            status: 'pending',
          })
          .select('id')
          .single();
        if (replacementShipmentError) throw replacementShipmentError;

        const { data: replacementLeg, error: replacementLegError } = await supabase
          .from('shipment_legs')
          .insert({
            shipment_id: replacementShipment.id,
            leg_order: 1,
            leg_type: legType,
            courier_id: replacementCourierId,
            cost: replacementFee,
            manual_courier_name: isGenericCourierName(replacementCourier?.name)
              ? replacementManualName.trim() || null
              : null,
            currency_code: currencyCode,
            status: 'pending',
            is_manual: true,
          })
          .select('id')
          .single();
        if (replacementLegError) throw replacementLegError;

        const { error: replacementPayableError } = await supabase.from('courier_payables').insert({
          order_id: orderId,
          shipment_leg_id: replacementLeg.id,
          courier_id: replacementCourierId,
          amount: replacementFee,
          reason: 'exchange_replacement',
          status: 'unpaid',
        });
        if (replacementPayableError) throw replacementPayableError;

        // Replacement product(s)/qty going out — chosen independently of
        // what came back, so this is its own stock lookup, not a reuse of
        // the returned items' stock map above.
        const replacementQtyByProduct = new Map<string, number>();
        for (const item of orderReturn.replacementItems) {
          replacementQtyByProduct.set(
            item.product_id,
            (replacementQtyByProduct.get(item.product_id) ?? 0) + item.qty,
          );
        }
        const replacementProductIds = [...replacementQtyByProduct.keys()];
        let replacementStockByProduct = new Map<string, number>();
        if (replacementProductIds.length > 0) {
          const { data: replacementProductsData, error: replacementProductsError } = await supabase
            .from('products')
            .select('id, stock_qty')
            .in('id', replacementProductIds);
          if (replacementProductsError) throw replacementProductsError;
          replacementStockByProduct = new Map((replacementProductsData ?? []).map((p) => [p.id, p.stock_qty]));
        }

        for (const productId of replacementProductIds) {
          const qty = replacementQtyByProduct.get(productId)!;
          const current = replacementStockByProduct.get(productId) ?? 0;
          const decreased = current - qty;
          const { error: stockError } = await supabase
            .from('products')
            .update({ stock_qty: decreased })
            .eq('id', productId);
          if (stockError) throw stockError;
          const { error: ledgerError } = await supabase.from('inventory_ledger').insert({
            product_id: productId,
            change_qty: -qty,
            reason: 'exchange',
            reference_type: 'order_return',
            reference_id: orderReturn.id,
            created_by: staffId,
          });
          if (ledgerError) throw ledgerError;
        }
      }

      const { error: statusError } = await supabase
        .from('order_returns')
        .update({ status: 'received' })
        .eq('id', orderReturn.id);
      if (statusError) throw statusError;

      onReceived();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark received.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Mark received — {isExchange ? 'exchange' : 'return'}</DialogTitle>
          </DialogHeader>

          <CourierPicker
            label="Return pickup"
            couriers={couriers}
            courierId={pickupCourierId}
            onCourierChange={setPickupCourierId}
            fee={pickupFee}
            onFeeChange={setPickupFee}
            manualName={pickupManualName}
            onManualNameChange={setPickupManualName}
          />

          {isExchange && (
            <CourierPicker
              label="Replacement shipment"
              couriers={couriers}
              courierId={replacementCourierId}
              onCourierChange={setReplacementCourierId}
              fee={replacementFee}
              onFeeChange={setReplacementFee}
              manualName={replacementManualName}
              onManualNameChange={setReplacementManualName}
            />
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Saving…' : 'Mark received'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
