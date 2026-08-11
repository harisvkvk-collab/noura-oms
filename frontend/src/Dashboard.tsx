// Dashboard.tsx — the "Dashboard" page content: Overview tab (stat cards,
// Pending Actions grouped by Sales/Purchases/Inventory, Recent Orders) and a
// New Order placeholder tab. Rendered inside AppShell by App.tsx.

import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { NewOrder } from './NewOrder';
import { OrderDetail } from './OrderDetail';
import { embeddedName, firstEmbedded } from '@/lib/supabaseRelations';
import { displayCourierName } from '@/lib/courier';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OrderStatusBadge } from '@/components/OrderStatusBadge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const SHIPPED_ORDER_FILTER = { fulfillment_type: 'shipped' } as const;

type RecentOrder = {
  id: string;
  order_number: string;
  status: string;
  total: number;
  currency_code: string;
  order_source: string;
  fulfillment_type: string;
  customer_name: string | null;
  courier_name: string | null;
};

type OverviewData = {
  ordersToday: number;
  revenueTodayAed: number;
  pendingDelivery: number;
  lowStockCount: number;
  toBePacked: number;
  toBeShipped: number;
  toBeDelivered: number;
  awaitingPayment: number;
  purchasesToBeReceived: number;
  purchasesReceiving: number;
  recentOrders: RecentOrder[];
};

function startOfTodayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function count(query: PromiseLike<{ count: number | null; error: unknown }>) {
  const { count: n, error } = await query;
  if (error) throw error;
  return n ?? 0;
}

async function fetchOverviewData(): Promise<OverviewData> {
  const todayStart = startOfTodayISO();

  const [
    ordersToday,
    revenueTodayRes,
    toBePacked,
    toBeShipped,
    toBeDelivered,
    awaitingPayment,
    purchasesToBeReceived,
    purchasesReceiving,
    productsRes,
    recentOrdersRes,
  ] = await Promise.all([
    count(supabase.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', todayStart)),
    supabase.from('orders').select('total_in_aed').gte('created_at', todayStart),
    count(
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .match(SHIPPED_ORDER_FILTER)
        .eq('status', 'confirmed'),
    ),
    count(
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .match(SHIPPED_ORDER_FILTER)
        .in('status', ['packed', 'postage_printed']),
    ),
    count(
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .match(SHIPPED_ORDER_FILTER)
        .eq('status', 'dispatched'),
    ),
    count(
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .match(SHIPPED_ORDER_FILTER)
        .neq('status', 'draft')
        .eq('payment_status', 'awaiting_courier_settlement'),
    ),
    count(supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('status', 'ordered')),
    count(supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('status', 'receiving')),
    supabase.from('products').select('stock_qty, reorder_level').eq('active', true),
    supabase
      .from('orders')
      .select(
        'id, order_number, status, total, currency_code, order_source, fulfillment_type, created_at, customers(name), shipments(shipment_legs(manual_courier_name, couriers(name)))',
      )
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  if (revenueTodayRes.error) throw revenueTodayRes.error;
  if (productsRes.error) throw productsRes.error;
  if (recentOrdersRes.error) throw recentOrdersRes.error;

  const lowStockCount = (productsRes.data ?? []).filter((p) => p.stock_qty <= p.reorder_level).length;

  return {
    ordersToday,
    revenueTodayAed: (revenueTodayRes.data ?? []).reduce((sum, o) => sum + Number(o.total_in_aed), 0),
    pendingDelivery: toBeDelivered,
    lowStockCount,
    toBePacked,
    toBeShipped,
    toBeDelivered,
    awaitingPayment,
    purchasesToBeReceived,
    purchasesReceiving,
    recentOrders: (recentOrdersRes.data ?? []).map((o) => {
      const shipment = firstEmbedded(o.shipments);
      const leg = shipment ? firstEmbedded(shipment.shipment_legs) : null;
      return {
        id: o.id,
        order_number: o.order_number,
        status: o.status,
        total: Number(o.total),
        currency_code: o.currency_code,
        order_source: o.order_source,
        fulfillment_type: o.fulfillment_type,
        customer_name: embeddedName(o.customers),
        courier_name: leg ? displayCourierName(embeddedName(leg.couriers), leg.manual_courier_name) : null,
      };
    }),
  };
}

export function Dashboard({ staffId }: { staffId: string }) {
  const [overviewKey, setOverviewKey] = useState(0);

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  if (selectedOrderId) {
    return (
      <OrderDetail
        orderId={selectedOrderId}
        staffId={staffId}
        onBack={() => {
          setSelectedOrderId(null);
          setOverviewKey((k) => k + 1);
        }}
      />
    );
  }

  return (
    <div>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="new-order">New order</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview key={overviewKey} onSelectOrder={setSelectedOrderId} />
        </TabsContent>
        <TabsContent value="new-order">
          <NewOrder staffId={staffId} onCreated={() => setOverviewKey((k) => k + 1)} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({ onSelectOrder }: { onSelectOrder: (orderId: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOverviewData()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: { message?: string }) => {
        if (!cancelled) setError(err.message ?? 'Failed to load dashboard data.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-4">
        <StatCard label="Today's orders" value={data.ordersToday} />
        <StatCard label="Revenue today" value={`AED ${data.revenueTodayAed.toFixed(2)}`} />
        <StatCard label="Pending delivery" value={data.pendingDelivery} />
        <StatCard
          label="Low stock items"
          value={data.lowStockCount}
          valueClassName={data.lowStockCount > 0 ? 'text-destructive' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Pending actions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <PendingGroup title="Sales">
              <PendingRow label="To be packed" value={data.toBePacked} />
              <PendingRow label="To be shipped" value={data.toBeShipped} />
              <PendingRow label="To be delivered" value={data.toBeDelivered} />
              <PendingRow label="Awaiting payment" value={data.awaitingPayment} />
            </PendingGroup>
            <PendingGroup title="Purchases">
              <PendingRow label="To be received" value={data.purchasesToBeReceived} />
              <PendingRow label="Receiving in progress" value={data.purchasesReceiving} />
            </PendingGroup>
            <PendingGroup title="Inventory">
              <PendingRow label="Below reorder level" value={data.lowStockCount} tone="destructive" />
            </PendingGroup>
          </CardContent>
        </Card>

        {/* min-w-0 matters here: as a CSS grid item this Card defaults to
            min-width:auto, which stops the customer-name truncate below from
            actually shrinking — without it, long names push the status badge
            past the card's right edge instead of the text eliding. */}
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Recent orders</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.recentOrders.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">No orders yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.recentOrders.map((o) => {
                  // In-store orders complete immediately with no fulfillment
                  // timeline (see NewOrder.tsx) — there's nothing to click
                  // into, so only shipped orders are interactive here.
                  const clickable = o.fulfillment_type === 'shipped';
                  return (
                    <li
                      key={o.id}
                      onClick={clickable ? () => onSelectOrder(o.id) : undefined}
                      className={`flex items-center justify-between gap-3 px-4 py-3 ${clickable ? 'cursor-pointer hover:bg-secondary' : ''}`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {o.order_number} · {o.customer_name ?? 'Unknown customer'}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {o.order_source} · {o.currency_code} {o.total.toFixed(0)}
                          {o.courier_name && <> · {o.courier_name}</>}
                        </div>
                      </div>
                      <OrderStatusBadge status={o.status} />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string | number;
  valueClassName?: string;
}) {
  return (
    <Card>
      <CardContent className="p-2 sm:p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-xl sm:text-3xl font-bold tracking-tight ${valueClassName ?? ''}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function PendingGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function PendingRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'destructive';
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${tone === 'destructive' ? 'text-destructive' : 'text-primary'}`}>
        {value}
      </span>
    </div>
  );
}
