// Orders.tsx — the full searchable/filterable order list (the sidebar's
// "Orders" nav item, as opposed to Dashboard.tsx's space-constrained
// "Recent orders" widget which only ever shows the last 10). Filtering and
// pagination both happen server-side via PostgREST — client-side filtering
// like Customers.tsx does doesn't hold up once the orders table is the
// thing actually growing without bound.
//
// Reuses the same OrderDetail.tsx fulfillment-timeline view Dashboard.tsx's
// Recent Orders links into. Unlike Recent Orders (which only makes shipped
// orders clickable, since there's nothing else to show for in-store sales),
// every row here is clickable — OrderDetail already has its own graceful
// "completed in-store, no timeline" branch for fulfillment_type = 'instore',
// so there's no reason to special-case it away in a full list view.

import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { OrderDetail } from './OrderDetail';
import { embeddedName } from '@/lib/supabaseRelations';
import { PAYMENT_METHOD_LABELS, dayAfter } from '@/lib/orderConstants';
import { OrderStatusBadge, ORDER_STATUS_META } from '@/components/OrderStatusBadge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const ORDER_SOURCES = ['Instagram', 'WhatsApp', 'Facebook', 'TikTok', 'In-store'];
// STATUS_ORDER (OrderDetail.tsx) walks the shipped-order pipeline only —
// this list is every value ORDER_STATUS_META knows how to badge, which also
// covers in-store's 'completed', same reasoning the user flagged it for.
const STATUS_OPTIONS = Object.keys(ORDER_STATUS_META);
const PAGE_SIZE = 25;

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  total: number;
  currency_code: string;
  order_source: string;
  payment_method: string;
  created_at: string;
  customer_name: string | null;
};

export function Orders({
  staffId,
  initialProductFilter,
}: {
  staffId: string;
  initialProductFilter?: { id: string; name: string } | null;
}) {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [paymentMethod, setPaymentMethod] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // Same "only read once, on mount" reasoning as Customers.tsx's
  // initialSelectedId — a link from Reports.tsx ("Sales by item") remounts
  // this component fresh, and App.tsx's onNavigate clears this before any
  // ordinary sidebar-driven navigation to Orders.
  const [productFilter, setProductFilter] = useState(initialProductFilter ?? null);
  const [page, setPage] = useState(0);

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce the free-text search so every keystroke doesn't fire a query.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Any filter change invalidates the current page — a page 3 that made
  // sense under the old filters can easily not exist under the new ones.
  useEffect(() => {
    setPage(0);
  }, [debouncedQuery, status, source, paymentMethod, dateFrom, dateTo, productFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Order number and customer name live on different tables, and
        // PostgREST's .or() only reliably combines conditions on the base
        // table — so a name search resolves to matching customer ids first,
        // then ORs those into the orders query alongside order_number.
        let matchingCustomerIds: string[] = [];
        if (debouncedQuery) {
          const { data, error: custError } = await supabase
            .from('customers')
            .select('id')
            .ilike('name', `%${debouncedQuery}%`);
          if (custError) throw custError;
          matchingCustomerIds = (data ?? []).map((c) => c.id);
        }

        // Same resolve-ids-first approach as the customer name search above
        // — product_id lives on order_items, not orders, so a link from
        // Reports.tsx ("Sales by item") resolves to matching order ids
        // before the main query, then ANDs them in via .in() (a plain AND,
        // not grouped into the .or() above — this is a hard filter, not an
        // alternative match for the free-text search).
        let productOrderIds: string[] | null = null;
        if (productFilter) {
          const { data, error: itemsError } = await supabase
            .from('order_items')
            .select('order_id')
            .eq('product_id', productFilter.id);
          if (itemsError) throw itemsError;
          productOrderIds = [...new Set((data ?? []).map((i) => i.order_id))];
        }

        let q = supabase
          .from('orders')
          .select(
            'id, order_number, status, total, currency_code, order_source, payment_method, created_at, customers(name)',
            { count: 'exact' },
          )
          .order('created_at', { ascending: false });

        if (debouncedQuery) {
          const orParts = [`order_number.ilike.%${debouncedQuery}%`];
          if (matchingCustomerIds.length > 0) {
            orParts.push(`customer_id.in.(${matchingCustomerIds.join(',')})`);
          }
          q = q.or(orParts.join(','));
        }
        if (status !== 'all') q = q.eq('status', status);
        if (source !== 'all') q = q.eq('order_source', source);
        if (paymentMethod !== 'all') q = q.eq('payment_method', paymentMethod);
        if (dateFrom) q = q.gte('created_at', dateFrom);
        if (dateTo) q = q.lt('created_at', dayAfter(dateTo));
        if (productOrderIds) q = q.in('id', productOrderIds);

        q = q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

        const { data, count, error: fetchError } = await q;
        if (cancelled) return;
        if (fetchError) throw fetchError;

        setOrders(
          (data ?? []).map((o) => ({
            id: o.id,
            order_number: o.order_number,
            status: o.status,
            total: Number(o.total),
            currency_code: o.currency_code,
            order_source: o.order_source,
            payment_method: o.payment_method,
            created_at: o.created_at,
            customer_name: embeddedName(o.customers),
          })),
        );
        setTotalCount(count ?? 0);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load orders.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, status, source, paymentMethod, dateFrom, dateTo, productFilter, page]);

  if (selectedOrderId) {
    return (
      <OrderDetail
        orderId={selectedOrderId}
        staffId={staffId}
        onBack={() => setSelectedOrderId(null)}
        backLabel="Back to orders"
      />
    );
  }

  const hasActiveFilters =
    !!query || status !== 'all' || source !== 'all' || paymentMethod !== 'all' || !!dateFrom || !!dateTo || !!productFilter;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Orders</h1>

      {productFilter && (
        <div className="flex w-fit items-center gap-2 rounded-full border border-input bg-secondary px-3 py-1 text-xs">
          Filtered by product: <span className="font-medium">{productFilter.name}</span>
          <button
            type="button"
            onClick={() => setProductFilter(null)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Clear product filter"
          >
            ×
          </button>
        </div>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5 lg:col-span-1">
              <Label htmlFor="orders-search">Search</Label>
              <Input
                id="orders-search"
                placeholder="Customer name or order number"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {ORDER_STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  {ORDER_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Payment method</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All methods</SelectItem>
                  {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="orders-from">From date</Label>
              <Input id="orders-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="orders-to">To date</Label>
              <Input id="orders-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>

          {hasActiveFilters && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => {
                setQuery('');
                setStatus('all');
                setSource('all');
                setPaymentMethod('all');
                setDateFrom('');
                setDateTo('');
                setProductFilter(null);
              }}
            >
              Clear filters
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardContent className="p-0">
          {loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : orders.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No orders match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Order</th>
                    <th className="px-4 py-2 font-medium">Customer</th>
                    <th className="px-4 py-2 font-medium">Source</th>
                    <th className="px-4 py-2 font-medium">Payment</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Total</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      onClick={() => setSelectedOrderId(o.id)}
                      className="cursor-pointer hover:bg-secondary"
                    >
                      <td className="px-4 py-2.5 font-medium">{o.order_number}</td>
                      <td className="px-4 py-2.5">{o.customer_name ?? 'Unknown customer'}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{o.order_source}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {PAYMENT_METHOD_LABELS[o.payment_method] ?? o.payment_method}
                      </td>
                      <td className="px-4 py-2.5">
                        <OrderStatusBadge status={o.status} />
                      </td>
                      <td className="px-4 py-2.5">
                        {o.currency_code} {o.total.toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {new Date(o.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !error && orders.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
              <span className="text-xs text-muted-foreground">
                {totalCount} order{totalCount === 1 ? '' : 's'} · page {page + 1} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
