// Purchases.tsx — PO list on top, a creation form below it (mirrors
// NewOrder.tsx's structure: supplier instead of customer, cost instead of
// price). Stock isn't touched at creation — only "Mark received" moves
// inventory, mirroring how NewOrder decrements stock at order creation.

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { supabase } from './supabaseClient';
import { cn } from '@/lib/utils';
import { firstEmbedded } from '@/lib/supabaseRelations';
import { PAYMENT_METHOD_LABELS } from '@/lib/orderConstants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Supplier = { id: string; name: string };
type Product = { id: string; name: string; cost_price: number };

type POListItem = {
  id: string;
  po_number: string;
  supplier_name: string | null;
  expected_delivery_date: string | null;
  status: string;
  paymentStatus: string;
  currency_code: string;
  total: number;
  paidTotal: number;
  itemCount: number;
};

type LineItem = { key: string; productId: string | null; name: string; qty: number; unitCost: number };

const PO_STATUS_META: Record<string, { label: string; variant: 'neutral' | 'info' | 'warning' | 'success' }> = {
  draft: { label: 'Draft', variant: 'neutral' },
  ordered: { label: 'Ordered', variant: 'info' },
  receiving: { label: 'Receiving', variant: 'warning' },
  received: { label: 'Received', variant: 'success' },
};

const PAYMENT_STATUS_META: Record<string, { label: string; variant: 'neutral' | 'warning' | 'success' }> = {
  unpaid: { label: 'Unpaid', variant: 'neutral' },
  partial: { label: 'Partial', variant: 'warning' },
  paid: { label: 'Paid', variant: 'success' },
};

const SUPPLIER_PAYMENT_METHODS = ['cash', 'card', 'bank_transfer'] as const;
const PAYMENT_TYPES = ['advance', 'balance', 'full', 'partial'] as const;

function newKey() {
  return Math.random().toString(36).slice(2);
}

async function generatePoNumber(): Promise<string> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('po_number')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const last = data?.[0]?.po_number as string | undefined;
  const lastNum = last ? parseInt(last.replace(/\D/g, ''), 10) : NaN;
  const next = (Number.isFinite(lastNum) ? lastNum : 0) + 1;
  return `PO-${String(next).padStart(4, '0')}`;
}

export function Purchases({ staffId }: { staffId: string }) {
  const [purchaseOrders, setPurchaseOrders] = useState<POListItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [paymentDialogPoId, setPaymentDialogPoId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function load() {
    setLoading(true);
    const [poRes, supplierRes, productRes] = await Promise.all([
      supabase
        .from('purchase_orders')
        .select(
          'id, po_number, expected_delivery_date, status, payment_status, currency_code, total, suppliers(name), purchase_order_items(id), supplier_payments(amount)',
        )
        .order('created_at', { ascending: false }),
      supabase.from('suppliers').select('id, name').order('name'),
      supabase.from('products').select('id, name, cost_price').eq('active', true).order('name'),
    ]);
    const firstError = [poRes, supplierRes, productRes].find((r) => r.error)?.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }
    setPurchaseOrders(
      (poRes.data ?? []).map((po) => ({
        id: po.id,
        po_number: po.po_number,
        supplier_name: firstEmbedded(po.suppliers)?.name ?? null,
        expected_delivery_date: po.expected_delivery_date,
        status: po.status,
        paymentStatus: po.payment_status,
        currency_code: po.currency_code,
        total: Number(po.total),
        paidTotal: (po.supplier_payments ?? []).reduce((sum, p) => sum + Number(p.amount), 0),
        itemCount: Array.isArray(po.purchase_order_items) ? po.purchase_order_items.length : 0,
      })),
    );
    setSuppliers(supplierRes.data ?? []);
    setProducts(productRes.data ?? []);
    setError(null);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function markReceived(poId: string) {
    setProcessingId(poId);
    setError(null);
    try {
      const { data: items, error: itemsError } = await supabase
        .from('purchase_order_items')
        .select('id, product_id, qty, qty_received')
        .eq('purchase_order_id', poId);
      if (itemsError) throw itemsError;

      for (const item of items ?? []) {
        const remaining = item.qty - item.qty_received;
        if (remaining > 0 && item.product_id) {
          const { data: product, error: productError } = await supabase
            .from('products')
            .select('stock_qty')
            .eq('id', item.product_id)
            .single();
          if (productError) throw productError;

          const { error: stockError } = await supabase
            .from('products')
            .update({ stock_qty: product.stock_qty + remaining })
            .eq('id', item.product_id);
          if (stockError) throw stockError;

          const { error: ledgerError } = await supabase.from('inventory_ledger').insert({
            product_id: item.product_id,
            change_qty: remaining,
            reason: 'purchase',
            reference_type: 'purchase_order',
            reference_id: poId,
            created_by: staffId,
          });
          if (ledgerError) throw ledgerError;
        }

        const { error: itemError } = await supabase
          .from('purchase_order_items')
          .update({ qty_received: item.qty })
          .eq('id', item.id);
        if (itemError) throw itemError;
      }

      const { error: poError } = await supabase.from('purchase_orders').update({ status: 'received' }).eq('id', poId);
      if (poError) throw poError;

      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark purchase order received.');
    } finally {
      setProcessingId(null);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error && purchaseOrders.length === 0) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Purchases</h1>
      </div>

      <Card className="min-w-0">
        <CardContent className="p-0">
          {purchaseOrders.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No purchase orders yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">PO #</th>
                    <th className="px-4 py-2 font-medium">Supplier</th>
                    <th className="px-4 py-2 font-medium">Expected</th>
                    <th className="px-4 py-2 font-medium">Items</th>
                    <th className="px-4 py-2 font-medium">Total</th>
                    <th className="px-4 py-2 font-medium">Fulfillment</th>
                    <th className="px-4 py-2 font-medium">Payment</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {purchaseOrders.map((po) => {
                    const status = PO_STATUS_META[po.status] ?? { label: po.status, variant: 'neutral' as const };
                    const paymentStatus =
                      PAYMENT_STATUS_META[po.paymentStatus] ?? { label: po.paymentStatus, variant: 'neutral' as const };
                    const canReceive = po.status === 'ordered' || po.status === 'receiving';
                    const canPay = po.paymentStatus !== 'paid';
                    return (
                      <tr key={po.id}>
                        <td className="px-4 py-2.5 font-medium">{po.po_number}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{po.supplier_name ?? '—'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {po.expected_delivery_date ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{po.itemCount}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {po.currency_code} {po.total.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5">
                          {status.variant === 'neutral' ? (
                            <span className="text-xs text-muted-foreground">{status.label}</span>
                          ) : (
                            <Badge variant={status.variant}>{status.label}</Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                              {po.currency_code} {po.paidTotal.toFixed(0)} / {po.total.toFixed(0)}
                            </span>
                            {paymentStatus.variant === 'neutral' ? (
                              <span className="text-xs text-muted-foreground">{paymentStatus.label}</span>
                            ) : (
                              <Badge variant={paymentStatus.variant}>{paymentStatus.label}</Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex justify-end gap-2">
                            {canReceive && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={processingId === po.id}
                                onClick={() => markReceived(po.id)}
                              >
                                {processingId === po.id ? 'Saving…' : 'Mark received'}
                              </Button>
                            )}
                            {canPay && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setPaymentDialogPoId(po.id)}
                              >
                                Record payment
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {paymentDialogPoId && (
        <RecordPaymentDialog
          po={purchaseOrders.find((p) => p.id === paymentDialogPoId)!}
          staffId={staffId}
          open={paymentDialogPoId !== null}
          onOpenChange={(open) => {
            if (!open) setPaymentDialogPoId(null);
          }}
          onRecorded={() => {
            setPaymentDialogPoId(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <NewPurchaseOrderForm
        staffId={staffId}
        suppliers={suppliers}
        products={products}
        onSupplierAdded={(s) => setSuppliers((prev) => [...prev, s].sort((a, b) => a.name.localeCompare(b.name)))}
        onCreated={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

function NewPurchaseOrderForm({
  staffId,
  suppliers,
  products,
  onSupplierAdded,
  onCreated,
}: {
  staffId: string;
  suppliers: Supplier[];
  products: Product[];
  onSupplierAdded: (s: Supplier) => void;
  onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [supplierQuery, setSupplierQuery] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('Due on receipt');
  const [items, setItems] = useState<LineItem[]>([{ key: newKey(), productId: null, name: '', qty: 1, unitCost: 0 }]);
  const [submitting, setSubmitting] = useState<'draft' | 'ordered' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function addItem() {
    setItems((prev) => [...prev, { key: newKey(), productId: null, name: '', qty: 1, unitCost: 0 }]);
  }
  function updateItem(key: string, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }
  function removeItem(key: string) {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }
  function selectProductForItem(key: string, product: Product) {
    updateItem(key, { productId: product.id, name: product.name, unitCost: product.cost_price });
  }

  async function addSupplier(name: string) {
    const { data, error: insertError } = await supabase.from('suppliers').insert({ name }).select('id, name').single();
    if (insertError) {
      setError(insertError.message);
      return;
    }
    onSupplierAdded(data);
    setSupplierId(data.id);
    setSupplierQuery(data.name);
  }

  function resetForm() {
    setSupplierId(null);
    setSupplierQuery('');
    setExpectedDelivery('');
    setPaymentTerms('Due on receipt');
    setItems([{ key: newKey(), productId: null, name: '', qty: 1, unitCost: 0 }]);
  }

  async function handleSubmit(status: 'draft' | 'ordered') {
    setError(null);
    const validItems = items.filter((i) => i.name.trim() && i.qty > 0);
    if (!supplierId) return setError('Pick or add a supplier first.');
    if (validItems.length === 0) return setError('Add at least one line item.');

    setSubmitting(status);
    try {
      const poNumber = await generatePoNumber();
      const subtotal = validItems.reduce((sum, i) => sum + i.qty * i.unitCost, 0);

      const { data: po, error: poError } = await supabase
        .from('purchase_orders')
        .insert({
          po_number: poNumber,
          supplier_id: supplierId,
          expected_delivery_date: expectedDelivery || null,
          payment_terms: paymentTerms || null,
          status,
          currency_code: 'AED',
          subtotal,
          total: subtotal,
          created_by: staffId,
        })
        .select('id, po_number')
        .single();
      if (poError) throw poError;

      const { error: itemsError } = await supabase.from('purchase_order_items').insert(
        validItems.map((i) => ({
          purchase_order_id: po.id,
          product_id: i.productId,
          item_name: i.name,
          qty: i.qty,
          unit_cost: i.unitCost,
          subtotal: i.qty * i.unitCost,
        })),
      );
      if (itemsError) throw itemsError;

      setSuccess(`${po.po_number} ${status === 'draft' ? 'saved as draft' : 'created'}.`);
      resetForm();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save purchase order.');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">New purchase order</h2>

      {success && (
        <Card className="border-success bg-success/10">
          <CardContent className="p-3 text-sm text-success-foreground">{success}</CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <div className="relative flex flex-col gap-1.5">
            <Label>Supplier</Label>
            <Input
              value={supplierQuery}
              onChange={(e) => {
                setSupplierQuery(e.target.value);
                setSupplierId(null);
              }}
              placeholder="Search or add supplier"
              autoComplete="off"
            />
            {supplierQuery.trim() && !supplierId && (
              <div className="absolute top-full z-10 mt-1 w-full rounded-md border border-border bg-card shadow-md">
                {suppliers
                  .filter((s) => s.name.toLowerCase().includes(supplierQuery.toLowerCase()))
                  .slice(0, 6)
                  .map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => {
                        setSupplierId(s.id);
                        setSupplierQuery(s.name);
                      }}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
                    >
                      {s.name}
                    </button>
                  ))}
                <button
                  type="button"
                  onClick={() => addSupplier(supplierQuery.trim())}
                  className="block w-full border-t border-border px-3 py-2 text-left text-sm text-primary hover:bg-secondary"
                >
                  + Add "{supplierQuery.trim()}" as new supplier
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="po-expected">Expected delivery</Label>
            <Input
              id="po-expected"
              type="date"
              value={expectedDelivery}
              onChange={(e) => setExpectedDelivery(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="po-terms">Payment terms</Label>
            <Input id="po-terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <Label>Line items</Label>
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[minmax(0,1fr)_56px_76px_76px_28px] gap-2 text-xs text-muted-foreground">
              <span>Item</span>
              <span>Qty</span>
              <span>Cost</span>
              <span>Subtotal</span>
              <span />
            </div>
            {items.map((item) => (
              <PurchaseLineItemRow
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

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={submitting !== null} onClick={() => handleSubmit('draft')}>
          {submitting === 'draft' ? 'Saving…' : 'Save as draft'}
        </Button>
        <Button type="button" disabled={submitting !== null} onClick={() => handleSubmit('ordered')}>
          {submitting === 'ordered' ? 'Saving…' : 'Create purchase order'}
        </Button>
      </div>
    </div>
  );
}

function PurchaseLineItemRow({
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

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_56px_76px_76px_28px] items-start gap-2">
      <div className="relative min-w-0">
        <Input
          value={item.name}
          onChange={(e) => {
            onChange({ name: e.target.value, productId: null });
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
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
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <Input type="number" min={1} value={item.qty} onChange={(e) => onChange({ qty: Number(e.target.value) })} />
      <Input
        type="number"
        min={0}
        step="0.01"
        value={item.unitCost}
        onChange={(e) => onChange({ unitCost: Number(e.target.value) })}
      />
      <div className="flex h-9 items-center text-sm">{(item.qty * item.unitCost).toFixed(2)}</div>
      <button
        type="button"
        onClick={onRemove}
        className={cn('flex h-9 items-center justify-center text-muted-foreground hover:text-destructive')}
        aria-label="Remove item"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function RecordPaymentDialog({
  po,
  staffId,
  open,
  onOpenChange,
  onRecorded,
}: {
  po: POListItem;
  staffId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded: () => void;
}) {
  const due = po.total - po.paidTotal;
  const [amount, setAmount] = useState(Math.max(due, 0));
  const [method, setMethod] = useState<string>('cash');
  const [paymentType, setPaymentType] = useState<string>('partial');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (amount <= 0) return setError('Enter an amount greater than zero.');

    setSubmitting(true);
    setError(null);

    const { error: insertError } = await supabase.from('supplier_payments').insert({
      purchase_order_id: po.id,
      amount,
      method,
      payment_type: paymentType,
      note: note.trim() || null,
      recorded_by: staffId,
    });
    if (insertError) {
      setError(insertError.message);
      setSubmitting(false);
      return;
    }

    // Recompute from the actual sum of payments rather than trusting the
    // client's running total — this insert may not be the only one that's
    // happened since the list last loaded.
    const { data: payments, error: sumError } = await supabase
      .from('supplier_payments')
      .select('amount')
      .eq('purchase_order_id', po.id);
    if (sumError) {
      setError(sumError.message);
      setSubmitting(false);
      return;
    }
    const totalPaid = (payments ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
    const newStatus = totalPaid <= 0 ? 'unpaid' : totalPaid >= po.total ? 'paid' : 'partial';

    const { error: statusError } = await supabase
      .from('purchase_orders')
      .update({ payment_status: newStatus })
      .eq('id', po.id);
    if (statusError) {
      setError(statusError.message);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    onRecorded();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Record payment — {po.po_number}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {po.currency_code} {po.paidTotal.toFixed(2)} paid of {po.currency_code} {po.total.toFixed(2)} total
            {due > 0 && (
              <>
                {' '}
                ({po.currency_code} {due.toFixed(2)} due)
              </>
            )}
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-amount">Amount ({po.currency_code})</Label>
            <Input
              id="pay-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPLIER_PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m] ?? m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Payment type</Label>
              <Select value={paymentType} onValueChange={setPaymentType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-note">Note (optional)</Label>
            <Input id="pay-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Saving…' : 'Record payment'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
