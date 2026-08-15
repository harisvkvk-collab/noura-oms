// Deliveries.tsx — two courier-money screens, opposite directions:
//
// - COD receivables: cash couriers collect on our behalf for COD orders,
//   net of their delivery fee, owed TO us. Created from OrderDetail.tsx's
//   "Mark delivered" step. Settled via courier_settlements.
// - Courier payables: delivery fees WE owe the courier on non-COD orders
//   (there's no cash collection to net the fee out of, so it's tracked
//   separately). Created at order creation time in NewOrder.tsx. Paid via
//   courier_payments.
//
// Both group by courier_id *plus* manual_courier_name, not courier_id
// alone: 'Other UAE courier' / 'Other local courier' are shared generic
// placeholders, so two orders both using that row could really be two
// different real-world companies (see lib/courier.ts). Grouping by
// courier_id only would silently merge their money together.

import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { firstEmbedded } from '@/lib/supabaseRelations';
import { displayCourierName } from '@/lib/courier';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Receivable = {
  id: string;
  courier_id: string;
  manual_courier_name: string | null;
  display_name: string;
  amount_collected: number;
  delivery_fee_deducted: number;
  net_due: number;   // original amount, never changes
  remaining: number; // net_due minus everything already applied via courier_settlement_items — what's actually still owed
};

type CourierSummary = {
  courierId: string;
  manualCourierName: string | null;
  courierName: string;
  orderCount: number;
  collected: number;
  feesDeducted: number;
  netDue: number;
};

type Payable = {
  id: string;
  courier_id: string;
  manual_courier_name: string | null;
  display_name: string;
  amount: number;     // original amount, never changes
  remaining: number;  // amount minus everything already applied via courier_payment_items
};

type PayableSummary = {
  courierId: string;
  manualCourierName: string | null;
  courierName: string;
  count: number;
  totalOwed: number;
};

function groupKey(courierId: string, manualCourierName: string | null) {
  return manualCourierName ? `${courierId}::${manualCourierName}` : courierId;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// A settlement/payment is a lump sum that can cover several outstanding
// receivables/payables at once (see file header) — courier_settlement_items
// / courier_payment_items.amount_applied is how much of a given lump sum
// went toward one specific row, so the real remaining balance for that row
// is its original amount minus the sum of amount_applied across every
// settlement/payment ever linked to it (there can be more than one, across
// partial rounds over time). These two helpers compute that sum, keyed by
// receivable_id / payable_id, for a given set of ids.
async function fetchAppliedToReceivables(ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase
    .from('courier_settlement_items')
    .select('receivable_id, amount_applied')
    .in('receivable_id', ids);
  if (error) throw error;
  for (const row of data ?? []) {
    map.set(row.receivable_id, (map.get(row.receivable_id) ?? 0) + Number(row.amount_applied));
  }
  return map;
}

async function fetchAppliedToPayables(ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase
    .from('courier_payment_items')
    .select('payable_id, amount_applied')
    .in('payable_id', ids);
  if (error) throw error;
  for (const row of data ?? []) {
    map.set(row.payable_id, (map.get(row.payable_id) ?? 0) + Number(row.amount_applied));
  }
  return map;
}

// Splits `amount` across `rows` (already sorted oldest-first) by paying
// each row's remaining balance off in full before moving to the next —
// the natural "settle the oldest debts first" allocation, and the one that
// leaves at most a single row partially paid rather than spreading a small
// remainder thinly across all of them. Returns applied-per-row (rows that
// got nothing this round are simply absent from the map).
function allocateAcrossRows<T extends { id: string; remaining: number }>(rows: T[], amount: number): Map<string, number> {
  const applied = new Map<string, number>();
  let left = amount;
  for (const row of rows) {
    if (left <= 0) break;
    const take = Math.min(row.remaining, left);
    if (take > 0) {
      applied.set(row.id, take);
      left -= take;
    }
  }
  return applied;
}

export function Deliveries() {
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settlingCourier, setSettlingCourier] = useState<CourierSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function load() {
    setLoading(true);
    try {
      const { data, error: fetchError } = await supabase
        .from('courier_cod_receivables')
        .select(
          'id, courier_id, amount_collected, delivery_fee_deducted, net_due, couriers(name), shipment_legs(manual_courier_name)',
        )
        .neq('status', 'remitted');
      if (fetchError) throw fetchError;
      const rows = data ?? [];
      const appliedMap = await fetchAppliedToReceivables(rows.map((r) => r.id));
      setReceivables(
        rows.map((r) => {
          const manualCourierName = firstEmbedded(r.shipment_legs)?.manual_courier_name ?? null;
          const courierName = firstEmbedded(r.couriers)?.name ?? null;
          const netDue = Number(r.net_due);
          return {
            id: r.id,
            courier_id: r.courier_id,
            manual_courier_name: manualCourierName,
            display_name: displayCourierName(courierName, manualCourierName) ?? 'Unknown courier',
            amount_collected: Number(r.amount_collected),
            delivery_fee_deducted: Number(r.delivery_fee_deducted),
            net_due: netDue,
            remaining: Math.max(0, netDue - (appliedMap.get(r.id) ?? 0)),
          };
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load receivables.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;

  const byCourier = new Map<string, CourierSummary>();
  for (const r of receivables) {
    const key = groupKey(r.courier_id, r.manual_courier_name);
    const entry = byCourier.get(key) ?? {
      courierId: r.courier_id,
      manualCourierName: r.manual_courier_name,
      courierName: r.display_name,
      orderCount: 0,
      collected: 0,
      feesDeducted: 0,
      netDue: 0,
    };
    entry.orderCount += 1;
    entry.collected += r.amount_collected;
    entry.feesDeducted += r.delivery_fee_deducted;
    entry.netDue += r.remaining;
    byCourier.set(key, entry);
  }
  const summaries = [...byCourier.values()].sort((a, b) => b.netDue - a.netDue);
  const totalOutstanding = summaries.reduce((sum, s) => sum + s.netDue, 0);
  const pendingOrders = summaries.reduce((sum, s) => sum + s.orderCount, 0);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">Deliveries</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total outstanding</div>
            <div className="mt-0.5 text-3xl font-bold tracking-tight">AED {totalOutstanding.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">COD orders pending</div>
            <div className="mt-0.5 text-3xl font-bold tracking-tight">{pendingOrders}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardContent className="p-0">
          <div className="p-4 pb-0">
            <h2 className="text-sm font-semibold">COD receivables by courier</h2>
            <p className="text-xs text-muted-foreground">
              Cash collected by couriers, net of their delivery fees, awaiting settlement.
            </p>
          </div>
          {summaries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No outstanding COD receivables.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="border-y border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Courier</th>
                    <th className="px-4 py-2 font-medium">Orders</th>
                    <th className="px-4 py-2 font-medium">Collected</th>
                    <th className="px-4 py-2 font-medium">Fees deducted</th>
                    <th className="px-4 py-2 font-medium">Net due</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summaries.map((s) => (
                    <tr key={groupKey(s.courierId, s.manualCourierName)}>
                      <td className="px-4 py-2.5 font-medium">{s.courierName}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{s.orderCount}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{s.collected.toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{s.feesDeducted.toFixed(2)}</td>
                      <td className="px-4 py-2.5 font-medium">{s.netDue.toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button type="button" size="sm" variant="outline" onClick={() => setSettlingCourier(s)}>
                          Record settlement
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td className="px-4 py-2.5 text-sm font-semibold" colSpan={4}>
                      Total net due from all couriers
                    </td>
                    <td className="px-4 py-2.5 text-sm font-semibold" colSpan={2}>
                      AED {totalOutstanding.toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {settlingCourier && (
        <RecordSettlementDialog
          courier={settlingCourier}
          open={settlingCourier !== null}
          onOpenChange={(open) => {
            if (!open) setSettlingCourier(null);
          }}
          onRecorded={() => {
            setSettlingCourier(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      <CourierPayablesSection />
    </div>
  );
}

function CourierPayablesSection() {
  const [payables, setPayables] = useState<Payable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payingCourier, setPayingCourier] = useState<PayableSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function load() {
    setLoading(true);
    try {
      const { data, error: fetchError } = await supabase
        .from('courier_payables')
        .select('id, courier_id, amount, couriers(name), shipment_legs(manual_courier_name), orders(status)')
        .neq('status', 'paid');
      if (fetchError) throw fetchError;
      const rows = data ?? [];
      const deliveredRows = rows.filter((p) => firstEmbedded(p.orders)?.status === 'delivered');
      const appliedMap = await fetchAppliedToPayables(deliveredRows.map((p) => p.id));
      setPayables(
        deliveredRows.map((p) => {
          const manualCourierName = firstEmbedded(p.shipment_legs)?.manual_courier_name ?? null;
          const courierName = firstEmbedded(p.couriers)?.name ?? null;
          const amount = Number(p.amount);
          return {
            id: p.id,
            courier_id: p.courier_id,
            manual_courier_name: manualCourierName,
            display_name: displayCourierName(courierName, manualCourierName) ?? 'Unknown courier',
            amount,
            remaining: Math.max(0, amount - (appliedMap.get(p.id) ?? 0)),
          };
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payables.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;

  const byCourier = new Map<string, PayableSummary>();
  for (const p of payables) {
    const key = groupKey(p.courier_id, p.manual_courier_name);
    const entry = byCourier.get(key) ?? {
      courierId: p.courier_id,
      manualCourierName: p.manual_courier_name,
      courierName: p.display_name,
      count: 0,
      totalOwed: 0,
    };
    entry.count += 1;
    entry.totalOwed += p.remaining;
    byCourier.set(key, entry);
  }
  const summaries = [...byCourier.values()].sort((a, b) => b.totalOwed - a.totalOwed);
  const totalOwed = summaries.reduce((sum, s) => sum + s.totalOwed, 0);

  return (
    <Card className="min-w-0">
      <CardContent className="p-0">
        <div className="p-4 pb-0">
          <h2 className="text-sm font-semibold">Courier payables</h2>
          <p className="text-xs text-muted-foreground">
            Delivery fees owed to couriers on prepaid (non-COD) orders.
          </p>
        </div>
        {summaries.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No outstanding courier payables.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-y border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Courier</th>
                  <th className="px-4 py-2 font-medium">Orders</th>
                  <th className="px-4 py-2 font-medium">Total owed</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summaries.map((s) => (
                  <tr key={groupKey(s.courierId, s.manualCourierName)}>
                    <td className="px-4 py-2.5 font-medium">{s.courierName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{s.count}</td>
                    <td className="px-4 py-2.5 font-medium">{s.totalOwed.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Button type="button" size="sm" variant="outline" onClick={() => setPayingCourier(s)}>
                        Record payment
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className="px-4 py-2.5 text-sm font-semibold" colSpan={2}>
                    Total owed to all couriers
                  </td>
                  <td className="px-4 py-2.5 text-sm font-semibold" colSpan={2}>
                    AED {totalOwed.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>

      {payingCourier && (
        <RecordPaymentDialog
          courier={payingCourier}
          open={payingCourier !== null}
          onOpenChange={(open) => {
            if (!open) setPayingCourier(null);
          }}
          onRecorded={() => {
            setPayingCourier(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </Card>
  );
}

function RecordPaymentDialog({
  courier,
  open,
  onOpenChange,
  onRecorded,
}: {
  courier: PayableSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(courier.totalOwed);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (amount <= 0) return setError('Enter an amount greater than zero.');

    setSubmitting(true);
    setError(null);
    try {
      // Fresh fetch rather than trusting the summary that opened this dialog
      // — another staff member could have recorded a payment since. Filtered
      // client-side by manual_courier_name too, same reasoning as the
      // settlement dialog above. created_at drives the payoff order below.
      const { data: outstandingForCourierId, error: fetchError } = await supabase
        .from('courier_payables')
        .select('id, amount, created_at, shipment_legs(manual_courier_name)')
        .eq('courier_id', courier.courierId)
        .neq('status', 'paid');
      if (fetchError) throw fetchError;
      const matchingCourier = (outstandingForCourierId ?? []).filter(
        (p) => (firstEmbedded(p.shipment_legs)?.manual_courier_name ?? null) === courier.manualCourierName,
      );
      if (matchingCourier.length === 0) {
        throw new Error('Nothing outstanding for this courier anymore — someone may have just paid it.');
      }

      // Each payable's TRUE remaining balance, net of any prior partial
      // rounds already applied to it — not its original `amount`, which is
      // what left this screen showing the full amount forever even after a
      // partial payment. Oldest first: a payment gets applied to the
      // longest-outstanding payables before newer ones.
      const appliedMap = await fetchAppliedToPayables(matchingCourier.map((p) => p.id));
      const outstanding = matchingCourier
        .map((p) => ({
          id: p.id,
          created_at: p.created_at,
          remaining: Math.max(0, Number(p.amount) - (appliedMap.get(p.id) ?? 0)),
        }))
        .filter((p) => p.remaining > 0)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const totalRemaining = outstanding.reduce((sum, p) => sum + p.remaining, 0);
      if (totalRemaining <= 0) {
        throw new Error('Nothing outstanding for this courier anymore — someone may have just paid it.');
      }

      // Computed before any write — same "fail before mutating" reasoning
      // as elsewhere in this file: an allocation that touches nothing
      // outstanding should block before a courier_payments row exists to
      // orphan.
      const allocated = allocateAcrossRows(outstanding, amount);
      const touched = [...allocated.keys()];
      if (touched.length === 0) {
        throw new Error('Amount did not cover any outstanding payable — nothing to apply it to.');
      }

      const { data: payment, error: paymentError } = await supabase
        .from('courier_payments')
        .insert({
          courier_id: courier.courierId,
          payment_reference: reference.trim() || null,
          paid_at: paymentDate,
          amount,
        })
        .select('id')
        .single();
      if (paymentError) throw paymentError;

      const { error: itemsError } = await supabase.from('courier_payment_items').insert(
        touched.map((payableId) => ({ payment_id: payment.id, payable_id: payableId, amount_applied: allocated.get(payableId) })),
      );
      if (itemsError) throw itemsError;

      // Status per row, not per batch: a lump payment can fully clear some
      // payables and only partially cover the one it runs out on, so each
      // row's own remaining-after-this-payment decides its own status.
      const paidOffIds = touched.filter((id) => {
        const row = outstanding.find((o) => o.id === id)!;
        return row.remaining - allocated.get(id)! <= 0.005;
      });
      const stillPartialIds = touched.filter((id) => !paidOffIds.includes(id));

      if (paidOffIds.length > 0) {
        const { error } = await supabase.from('courier_payables').update({ status: 'paid' }).in('id', paidOffIds);
        if (error) throw error;
      }
      if (stillPartialIds.length > 0) {
        const { error } = await supabase.from('courier_payables').update({ status: 'partial' }).in('id', stillPartialIds);
        if (error) throw error;
      }

      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Record payment — {courier.courierName}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {courier.count} order{courier.count === 1 ? '' : 's'} outstanding · AED{' '}
            {courier.totalOwed.toFixed(2)} owed
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-amount">Amount paid (AED)</Label>
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
              <Label htmlFor="pay-date">Payment date</Label>
              <Input
                id="pay-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay-ref">Reference (optional)</Label>
              <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>

          {amount < courier.totalOwed && (
            <p className="text-xs text-warning-foreground">
              This is less than the full amount owed — the outstanding payables for {courier.courierName} covered
              by this payment will be marked partial, not paid, and will still show up here until settled in full.
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Saving…' : 'Record payment'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RecordSettlementDialog({
  courier,
  open,
  onOpenChange,
  onRecorded,
}: {
  courier: CourierSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(courier.netDue);
  const [settlementDate, setSettlementDate] = useState(todayISO());
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (amount <= 0) return setError('Enter an amount greater than zero.');

    setSubmitting(true);
    setError(null);
    try {
      // Fresh fetch rather than trusting the summary that opened this dialog
      // — another staff member could have recorded a settlement since.
      // Filtered client-side by manual_courier_name too: courier_id alone
      // isn't a unique company under the generic 'Other ... courier' rows,
      // so settling one must not sweep up a different manually-named
      // company that happens to share the same courier_id. created_at
      // drives the payoff order below.
      const { data: outstandingForCourierId, error: fetchError } = await supabase
        .from('courier_cod_receivables')
        .select('id, amount_collected, delivery_fee_deducted, net_due, created_at, shipment_legs(manual_courier_name)')
        .eq('courier_id', courier.courierId)
        .neq('status', 'remitted');
      if (fetchError) throw fetchError;
      const matchingCourier = (outstandingForCourierId ?? []).filter(
        (r) => (firstEmbedded(r.shipment_legs)?.manual_courier_name ?? null) === courier.manualCourierName,
      );
      if (matchingCourier.length === 0) {
        throw new Error('Nothing outstanding for this courier anymore — someone may have just settled it.');
      }

      // Each receivable's TRUE remaining balance, net of any prior partial
      // rounds already applied to it — not its original `net_due`, which is
      // what left this screen showing the full amount forever even after a
      // partial settlement. Oldest first: a settlement gets applied to the
      // longest-outstanding receivables before newer ones.
      const appliedMap = await fetchAppliedToReceivables(matchingCourier.map((r) => r.id));
      const outstanding = matchingCourier
        .map((r) => ({
          id: r.id,
          created_at: r.created_at,
          amount_collected: Number(r.amount_collected),
          delivery_fee_deducted: Number(r.delivery_fee_deducted),
          remaining: Math.max(0, Number(r.net_due) - (appliedMap.get(r.id) ?? 0)),
        }))
        .filter((r) => r.remaining > 0)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const totalRemaining = outstanding.reduce((sum, r) => sum + r.remaining, 0);
      if (totalRemaining <= 0) {
        throw new Error('Nothing outstanding for this courier anymore — someone may have just settled it.');
      }
      const status = amount >= totalRemaining ? 'settled' : 'partial';

      // Computed before any write — an allocation that touches nothing
      // outstanding should block before a courier_settlements row exists
      // to orphan.
      const allocated = allocateAcrossRows(outstanding, amount);
      const touched = [...allocated.keys()];
      if (touched.length === 0) {
        throw new Error('Amount did not cover any outstanding receivable — nothing to apply it to.');
      }
      const touchedRows = outstanding.filter((r) => touched.includes(r.id));
      const totalCollected = touchedRows.reduce((sum, r) => sum + r.amount_collected, 0);
      const totalFees = touchedRows.reduce((sum, r) => sum + r.delivery_fee_deducted, 0);

      const { data: settlement, error: settlementError } = await supabase
        .from('courier_settlements')
        .insert({
          courier_id: courier.courierId,
          settlement_reference: reference.trim() || null,
          settlement_date: settlementDate,
          total_collected: totalCollected,
          total_fees_deducted: totalFees,
          net_remitted: amount,
          status,
        })
        .select('id')
        .single();
      if (settlementError) throw settlementError;

      const { error: itemsError } = await supabase.from('courier_settlement_items').insert(
        touched.map((receivableId) => ({
          settlement_id: settlement.id,
          receivable_id: receivableId,
          amount_applied: allocated.get(receivableId),
        })),
      );
      if (itemsError) throw itemsError;

      // Status per row, not per batch: a lump settlement can fully clear
      // some receivables and only partially cover the one it runs out on,
      // so each row's own remaining-after-this-settlement decides its own
      // status — not the hardcoded/batch-wide value this used to use.
      const paidOffIds = touched.filter((id) => {
        const row = outstanding.find((o) => o.id === id)!;
        return row.remaining - allocated.get(id)! <= 0.005;
      });
      const stillPartialIds = touched.filter((id) => !paidOffIds.includes(id));

      if (paidOffIds.length > 0) {
        const { error } = await supabase
          .from('courier_cod_receivables')
          .update({ status: 'remitted' })
          .in('id', paidOffIds);
        if (error) throw error;
      }
      if (stillPartialIds.length > 0) {
        const { error } = await supabase
          .from('courier_cod_receivables')
          .update({ status: 'partially_remitted' })
          .in('id', stillPartialIds);
        if (error) throw error;
      }

      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record settlement.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Record settlement — {courier.courierName}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {courier.orderCount} order{courier.orderCount === 1 ? '' : 's'} outstanding · AED{' '}
            {courier.collected.toFixed(2)} collected · AED {courier.feesDeducted.toFixed(2)} fees · AED{' '}
            {courier.netDue.toFixed(2)} net due
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settle-amount">Amount received (AED)</Label>
            <Input
              id="settle-amount"
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
              <Label htmlFor="settle-date">Settlement date</Label>
              <Input
                id="settle-date"
                type="date"
                value={settlementDate}
                onChange={(e) => setSettlementDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settle-ref">Reference (optional)</Label>
              <Input id="settle-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>

          {amount < courier.netDue && (
            <p className="text-xs text-warning-foreground">
              This is less than the full net due — the settlement will be recorded as partial, and the
              outstanding receivables for {courier.courierName} covered by it will be marked partially remitted,
              not remitted, so they still show up here until settled in full.
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Saving…' : 'Record settlement'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
