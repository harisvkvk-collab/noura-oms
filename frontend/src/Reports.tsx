// Reports.tsx — four simple, table-based reports covering the day-to-day
// questions (what's selling, who's spending, what's running low, how's
// each month tracking). No charts — plain sortable-by-eye tables, matching
// the "keep it simple" brief. Each report resolves its own filtered rows
// client-side from a couple of queries rather than leaning on PostgREST
// aggregation, the same "fetch then reduce in JS" approach Customers.tsx
// and Dashboard.tsx already use for their own summaries.
//
// Revenue is always normalized to AED (order_items.subtotal is in the
// order's own currency_code, not AED — orders.exchange_rate_snapshot is
// the same per-order conversion factor orders.total_in_aed was computed
// with at order-creation time, see NewOrder.tsx) so mixed-currency orders
// don't silently misreport revenue.

import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { embeddedName } from '@/lib/supabaseRelations';
import { dayAfter } from '@/lib/orderConstants';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

function DateRangeFilter({
  idPrefix,
  from,
  to,
  onFromChange,
  onToChange,
}: {
  idPrefix: string;
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-from`}>From date</Label>
        <Input id={`${idPrefix}-from`} type="date" value={from} onChange={(e) => onFromChange(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-to`}>To date</Label>
        <Input id={`${idPrefix}-to`} type="date" value={to} onChange={(e) => onToChange(e.target.value)} />
      </div>
      {(from || to) && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            onFromChange('');
            onToChange('');
          }}
        >
          Clear dates
        </Button>
      )}
    </div>
  );
}

export function Reports({
  onNavigateToCustomer,
  onNavigateToProductOrders,
}: {
  onNavigateToCustomer: (customerId: string) => void;
  onNavigateToProductOrders: (productId: string, productName: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Reports</h1>
      <Tabs defaultValue="sales-by-item">
        <TabsList>
          <TabsTrigger value="sales-by-item">Sales by item</TabsTrigger>
          <TabsTrigger value="sales-by-customer">Sales by customer</TabsTrigger>
          <TabsTrigger value="stock-value">Stock value</TabsTrigger>
          <TabsTrigger value="monthly-summary">Monthly summary</TabsTrigger>
        </TabsList>
        <TabsContent value="sales-by-item">
          <SalesByItemReport onNavigateToProductOrders={onNavigateToProductOrders} />
        </TabsContent>
        <TabsContent value="sales-by-customer">
          <SalesByCustomerReport onNavigateToCustomer={onNavigateToCustomer} />
        </TabsContent>
        <TabsContent value="stock-value">
          <StockValueReport />
        </TabsContent>
        <TabsContent value="monthly-summary">
          <MonthlySummaryReport />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type ItemRow = {
  key: string;
  productId: string | null;
  name: string;
  units: number;
  revenueAed: number;
  costAed: number;
  costKnown: boolean;
  grossProfitAed: number;
};

type ItemSortMetric = 'revenue' | 'profit' | 'units';

function SalesByItemReport({
  onNavigateToProductOrders,
}: {
  onNavigateToProductOrders: (productId: string, productName: string) => void;
}) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortMetric, setSortMetric] = useState<ItemSortMetric>('revenue');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Drafts aren't real sales — same exclusion Customers.tsx uses for
        // its own order stats.
        let orderQuery = supabase.from('orders').select('id, exchange_rate_snapshot').neq('status', 'draft');
        if (dateFrom) orderQuery = orderQuery.gte('created_at', dateFrom);
        if (dateTo) orderQuery = orderQuery.lt('created_at', dayAfter(dateTo));
        const { data: orders, error: ordersError } = await orderQuery;
        if (ordersError) throw ordersError;
        if (cancelled) return;

        const orderIds = (orders ?? []).map((o) => o.id);
        const rateByOrderId = new Map((orders ?? []).map((o) => [o.id, Number(o.exchange_rate_snapshot)]));

        if (orderIds.length === 0) {
          setRows([]);
          setError(null);
          return;
        }

        const { data: items, error: itemsError } = await supabase
          .from('order_items')
          .select('order_id, product_id, item_name, qty, subtotal, unit_cost_aed')
          .in('order_id', orderIds);
        if (itemsError) throw itemsError;
        if (cancelled) return;

        const byKey = new Map<string, ItemRow>();
        for (const it of items ?? []) {
          const key = it.product_id ?? `name:${it.item_name}:${it.order_id}`;
          const rate = rateByOrderId.get(it.order_id) ?? 1;
          const revenueAed = Number(it.subtotal) * rate;
          const costAed = it.unit_cost_aed ? Number(it.unit_cost_aed) * it.qty : 0;
          const costKnown = it.unit_cost_aed !== null && it.unit_cost_aed !== undefined;

          const entry = byKey.get(key) ?? {
            key,
            productId: it.product_id,
            name: it.item_name,
            units: 0,
            revenueAed: 0,
            costAed: 0,
            costKnown: true,
            grossProfitAed: 0,
          };
          entry.units += it.qty;
          entry.revenueAed += revenueAed;
          entry.costAed += costAed;
          entry.costKnown = entry.costKnown && costKnown;
          entry.grossProfitAed = entry.revenueAed - entry.costAed;
          byKey.set(key, entry);
        }
        setRows([...byKey.values()]);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dateFrom, dateTo]);

  const sortedRows = [...rows].sort((a, b) => {
    switch (sortMetric) {
      case 'revenue':
        return b.revenueAed - a.revenueAed;
      case 'profit':
        const profitA = a.costKnown ? a.grossProfitAed : -Infinity;
        const profitB = b.costKnown ? b.grossProfitAed : -Infinity;
        return profitB - profitA;
      case 'units':
        return b.units - a.units;
    }
  });

  const totalUnits = rows.reduce((sum, r) => sum + r.units, 0);
  const totalRevenue = rows.reduce((sum, r) => sum + r.revenueAed, 0);
  const totalCost = rows.reduce((sum, r) => (r.costKnown ? sum + r.costAed : sum), 0);
  const totalGrossProfit = rows.reduce((sum, r) => (r.costKnown ? sum + r.grossProfitAed : sum), 0);
  const anyCostKnown = rows.some((r) => r.costKnown);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <DateRangeFilter idPrefix="item" from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sales in this range.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Sort by:</Label>
              <div className="flex gap-1">
                {(['revenue', 'profit', 'units'] as const).map((metric) => (
                  <Button
                    key={metric}
                    size="sm"
                    variant={sortMetric === metric ? 'default' : 'outline'}
                    onClick={() => setSortMetric(metric)}
                    className="text-xs"
                  >
                    {metric === 'revenue' ? 'Revenue' : metric === 'profit' ? 'Gross profit' : 'Units'}
                  </Button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium text-right">Units sold</th>
                    <th className="px-3 py-2 font-medium text-right">Revenue (AED)</th>
                    {anyCostKnown && (
                      <>
                        <th className="px-3 py-2 font-medium text-right">Cost (AED)</th>
                        <th className="px-3 py-2 font-medium text-right">Gross profit (AED)</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sortedRows.map((r) => (
                    <tr key={r.key} className={r.productId ? 'cursor-pointer hover:bg-secondary' : ''}
                      onClick={() => r.productId && onNavigateToProductOrders(r.productId, r.name)}
                    >
                      <td className="px-3 py-2.5">
                        {r.productId ? <span className="text-primary underline-offset-2 hover:underline">{r.name}</span> : r.name}
                      </td>
                      <td className="px-3 py-2.5 text-right">{r.units}</td>
                      <td className="px-3 py-2.5 text-right">{r.revenueAed.toFixed(2)}</td>
                      {anyCostKnown && (
                        <>
                          <td className="px-3 py-2.5 text-right">{r.costKnown ? r.costAed.toFixed(2) : '—'}</td>
                          <td className="px-3 py-2.5 text-right">{r.costKnown ? r.grossProfitAed.toFixed(2) : '—'}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    <td className="px-3 py-2.5">Total</td>
                    <td className="px-3 py-2.5 text-right">{totalUnits}</td>
                    <td className="px-3 py-2.5 text-right">{totalRevenue.toFixed(2)}</td>
                    {anyCostKnown && (
                      <>
                        <td className="px-3 py-2.5 text-right">{totalCost.toFixed(2)}</td>
                        <td className="px-3 py-2.5 text-right">{totalGrossProfit.toFixed(2)}</td>
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type CustomerRow = { customerId: string; name: string; orderCount: number; totalAed: number };

type CustomerSortMetric = 'spent' | 'orders';

function SalesByCustomerReport({ onNavigateToCustomer }: { onNavigateToCustomer: (customerId: string) => void }) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortMetric, setSortMetric] = useState<CustomerSortMetric>('spent');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Same non-draft, total_in_aed logic as Customers.tsx's own
        // orders/spend stats — just with a date range on top.
        let q = supabase.from('orders').select('customer_id, total_in_aed, customers(name)').neq('status', 'draft');
        if (dateFrom) q = q.gte('created_at', dateFrom);
        if (dateTo) q = q.lt('created_at', dayAfter(dateTo));
        const { data, error: fetchError } = await q;
        if (fetchError) throw fetchError;
        if (cancelled) return;

        const byCustomer = new Map<string, CustomerRow>();
        for (const o of data ?? []) {
          if (!o.customer_id) continue;
          const entry = byCustomer.get(o.customer_id) ?? {
            customerId: o.customer_id,
            name: embeddedName(o.customers) ?? 'Unknown customer',
            orderCount: 0,
            totalAed: 0,
          };
          entry.orderCount += 1;
          entry.totalAed += Number(o.total_in_aed);
          byCustomer.set(o.customer_id, entry);
        }
        setRows([...byCustomer.values()]);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dateFrom, dateTo]);

  const sortedRows = [...rows].sort((a, b) => {
    if (sortMetric === 'spent') {
      return b.totalAed - a.totalAed;
    } else {
      return b.orderCount - a.orderCount;
    }
  });

  const totalOrders = rows.reduce((sum, r) => sum + r.orderCount, 0);
  const totalAed = rows.reduce((sum, r) => sum + r.totalAed, 0);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <DateRangeFilter idPrefix="cust" from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sales in this range.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Sort by:</Label>
              <div className="flex gap-1">
                {(['spent', 'orders'] as const).map((metric) => (
                  <Button
                    key={metric}
                    size="sm"
                    variant={sortMetric === metric ? 'default' : 'outline'}
                    onClick={() => setSortMetric(metric)}
                    className="text-xs"
                  >
                    {metric === 'spent' ? 'Total spent' : 'Order count'}
                  </Button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium text-right">Orders</th>
                    <th className="px-3 py-2 font-medium text-right">Total spent (AED)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sortedRows.map((r) => (
                    <tr key={r.customerId} className="cursor-pointer hover:bg-secondary" onClick={() => onNavigateToCustomer(r.customerId)}>
                      <td className="px-3 py-2.5">
                        <span className="text-primary underline-offset-2 hover:underline">{r.name}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">{r.orderCount}</td>
                      <td className="px-3 py-2.5 text-right">{r.totalAed.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    <td className="px-3 py-2.5">Total</td>
                    <td className="px-3 py-2.5 text-right">{totalOrders}</td>
                    <td className="px-3 py-2.5 text-right">{totalAed.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type StockValueRow = {
  id: string;
  sku: string | null;
  name: string;
  variant: string | null;
  categoryName: string | null;
  stockQty: number;
  reorderLevel: number;
  costPrice: number;
  sellingPrice: number;
  costBasisValue: number;
  potentialRetailValue: number;
};

type StockSortMetric = 'value' | 'quantity' | 'reorder';
type StockSortDirection = 'desc' | 'asc';

function StockValueReport() {
  const [rows, setRows] = useState<StockValueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortMetric, setSortMetric] = useState<StockSortMetric>('reorder');
  const [sortDirection, setSortDirection] = useState<StockSortDirection>('asc');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data, error: fetchError } = await supabase
          .from('products')
          .select('id, sku, name, variant, stock_qty, reorder_level, cost_price, selling_price, product_categories(name)')
          .eq('active', true);
        if (fetchError) throw fetchError;
        if (cancelled) return;

        const mapped = (data ?? []).map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          variant: p.variant,
          categoryName: embeddedName(p.product_categories),
          stockQty: p.stock_qty,
          reorderLevel: p.reorder_level,
          costPrice: Number(p.cost_price),
          sellingPrice: Number(p.selling_price),
          costBasisValue: p.stock_qty * Number(p.cost_price),
          potentialRetailValue: p.stock_qty * Number(p.selling_price),
        }));
        setRows(mapped);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedRows = [...rows].sort((a, b) => {
    let cmp = 0;
    if (sortMetric === 'value') {
      cmp = a.costBasisValue - b.costBasisValue;
    } else if (sortMetric === 'quantity') {
      cmp = a.stockQty - b.stockQty;
    } else {
      // 'reorder' — closest to reorder (lowest margin first)
      const marginA = a.stockQty - a.reorderLevel;
      const marginB = b.stockQty - b.reorderLevel;
      cmp = marginA - marginB;
    }
    return sortDirection === 'desc' ? -cmp : cmp;
  });

  const totalCostBasis = rows.reduce((sum, r) => sum + r.costBasisValue, 0);
  const totalRetailValue = rows.reduce((sum, r) => sum + r.potentialRetailValue, 0);
  const totalGrossProfit = totalRetailValue - totalCostBasis;

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Cost basis value</p>
            <p className="text-lg font-semibold">{totalCostBasis.toFixed(2)} AED</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Potential retail value</p>
            <p className="text-lg font-semibold">{totalRetailValue.toFixed(2)} AED</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Potential gross profit</p>
            <p className="text-lg font-semibold">{totalGrossProfit.toFixed(2)} AED</p>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active products found.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Label className="text-xs text-muted-foreground">Sort by:</Label>
              <div className="flex gap-1">
                {(['value', 'quantity', 'reorder'] as const).map((metric) => (
                  <Button
                    key={metric}
                    size="sm"
                    variant={sortMetric === metric ? 'default' : 'outline'}
                    onClick={() => setSortMetric(metric)}
                    className="text-xs"
                  >
                    {metric === 'value' ? 'Stock value' : metric === 'quantity' ? 'Quantity' : 'Reorder urgency'}
                  </Button>
                ))}
              </div>
              {sortMetric !== 'reorder' && (
                <div className="flex gap-1">
                  {(['desc', 'asc'] as const).map((dir) => (
                    <Button
                      key={dir}
                      size="sm"
                      variant={sortDirection === dir ? 'default' : 'outline'}
                      onClick={() => setSortDirection(dir)}
                      className="text-xs"
                    >
                      {dir === 'desc' ? 'High→Low' : 'Low→High'}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 font-medium">Category</th>
                    <th className="px-3 py-2 font-medium text-right">Stock qty</th>
                    <th className="px-3 py-2 font-medium text-right">Cost basis (AED)</th>
                    <th className="px-3 py-2 font-medium text-right">Potential retail (AED)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sortedRows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5">
                        {r.name}
                        {r.variant ? <span className="text-muted-foreground"> · {r.variant}</span> : ''}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{r.sku ?? '—'}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{r.categoryName ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right">
                        <Badge variant={r.stockQty === 0 ? 'destructive' : r.stockQty <= r.reorderLevel ? 'warning' : undefined}>
                          {r.stockQty}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right">{r.costBasisValue.toFixed(2)}</td>
                      <td className="px-3 py-2.5 text-right">{r.potentialRetailValue.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type MonthRow = { month: string; orderCount: number; totalAed: number };

function formatMonth(month: string) {
  const [year, m] = month.split('-');
  return new Date(Number(year), Number(m) - 1, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

function MonthlySummaryReport() {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [rows, setRows] = useState<MonthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let q = supabase.from('orders').select('created_at, total_in_aed').neq('status', 'draft');
        if (dateFrom) q = q.gte('created_at', dateFrom);
        if (dateTo) q = q.lt('created_at', dayAfter(dateTo));
        const { data, error: fetchError } = await q;
        if (fetchError) throw fetchError;
        if (cancelled) return;

        const byMonth = new Map<string, MonthRow>();
        for (const o of data ?? []) {
          const month = o.created_at.slice(0, 7); // "YYYY-MM" — created_at is ISO 8601, this is a plain prefix
          const entry = byMonth.get(month) ?? { month, orderCount: 0, totalAed: 0 };
          entry.orderCount += 1;
          entry.totalAed += Number(o.total_in_aed);
          byMonth.set(month, entry);
        }
        setRows([...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dateFrom, dateTo]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <DateRangeFilter idPrefix="month" from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No orders in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Month</th>
                  <th className="px-3 py-2 font-medium text-right">Orders</th>
                  <th className="px-3 py-2 font-medium text-right">Revenue (AED)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.month}>
                    <td className="px-3 py-2.5">{formatMonth(r.month)}</td>
                    <td className="px-3 py-2.5 text-right">{r.orderCount}</td>
                    <td className="px-3 py-2.5 text-right">{r.totalAed.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
