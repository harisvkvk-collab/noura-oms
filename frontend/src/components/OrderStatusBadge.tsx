import { Badge } from '@/components/ui/badge';

export const ORDER_STATUS_META: Record<
  string,
  { label: string; variant: 'neutral' | 'warning' | 'info' | 'success' | 'destructive' }
> = {
  draft: { label: 'Draft', variant: 'neutral' },
  confirmed: { label: 'Confirmed', variant: 'warning' },
  packed: { label: 'Packed', variant: 'warning' },
  postage_printed: { label: 'Postage printed', variant: 'info' },
  dispatched: { label: 'Shipped', variant: 'info' },
  delivered: { label: 'Delivered', variant: 'success' },
  completed: { label: 'Completed', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const meta = ORDER_STATUS_META[status] ?? { label: status, variant: 'neutral' as const };
  if (meta.variant === 'neutral') {
    return <span className="shrink-0 text-xs text-muted-foreground">{meta.label}</span>;
  }
  return (
    <Badge variant={meta.variant} className="shrink-0">
      {meta.label}
    </Badge>
  );
}
