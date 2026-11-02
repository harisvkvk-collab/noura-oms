// "Request pickup" card for Delhivery. Asks Delhivery to collect booked parcels
// from the warehouse on a chosen day. Only staging is enabled for now (the
// edge function refuses production), so the button is disabled for production.

import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { callEdgeFunction } from '@/lib/edgeFunctions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PICKUP_WINDOW_DAYS, localDateISO, pickupDateProblem } from '@/lib/pickupDate';

type DelhiveryCourier = { id: string; api_environment: string | null };
type WarehouseLocation = { id: string; name: string; delhivery_warehouse_name: string | null; is_default: boolean };

export function DelhiveryPickupCard() {
  const [courier, setCourier] = useState<DelhiveryCourier | null>(null);
  const [locations, setLocations] = useState<WarehouseLocation[]>([]);
  const [pickupLocationId, setPickupLocationId] = useState<string | null>(null);
  const [pickupDate, setPickupDate] = useState(localDateISO(1));
  const [pickupTime, setPickupTime] = useState('14:00');
  const [packageCount, setPackageCount] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: courierRow }, { data: locationRows }] = await Promise.all([
        supabase
          .from('couriers')
          .select('id, api_environment')
          .eq('api_provider', 'delhivery')
          .eq('active', true)
          .limit(1)
          .maybeSingle(),
        supabase
          .from('pickup_locations')
          .select('id, name, delhivery_warehouse_name, is_default')
          .eq('active', true)
          .not('delhivery_warehouse_name', 'is', null)
          .order('name'),
      ]);
      if (cancelled) return;
      const offered = (locationRows ?? []) as WarehouseLocation[];
      setCourier(courierRow ?? null);
      setLocations(offered);
      setPickupLocationId((prev) => prev ?? offered.find((l) => l.is_default)?.id ?? offered[0]?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!courier) return null;

  const isStaging = courier.api_environment === 'staging';
  const dateProblem = pickupDateProblem(pickupDate);

  async function handleRequestPickup() {
    if (!courier || !pickupLocationId) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await callEdgeFunction<{ ok: boolean; detail?: string; error?: string }>(
        'request-pickup',
        {
          courierId: courier.id,
          pickupLocationId,
          pickupDate,
          pickupTime: `${pickupTime}:00`,
          packageCount: Number(packageCount),
        },
      );
      if (!result.ok) throw new Error(result.error ?? 'Delhivery did not accept the pickup request.');
      setMessage({ kind: 'ok', text: result.detail ?? 'Pickup requested.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to request the pickup.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold">Request Delhivery pickup</h2>
          <p className="text-xs text-muted-foreground">
            {isStaging
              ? 'Staging test: no real collection happens.'
              : 'Pickup requests are available on Delhivery staging only for now.'}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          <div className="flex flex-col gap-1.5">
            <Label>Warehouse</Label>
            <Select value={pickupLocationId ?? undefined} onValueChange={setPickupLocationId} disabled={locations.length === 0}>
              <SelectTrigger>
                <SelectValue placeholder={locations.length === 0 ? 'None set up' : 'Select'} />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                    {l.is_default ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pickup-date">Pickup date</Label>
            <Input
              id="pickup-date"
              type="date"
              value={pickupDate}
              min={localDateISO(0)}
              max={localDateISO(PICKUP_WINDOW_DAYS)}
              onChange={(e) => setPickupDate(e.target.value)}
            />
            {dateProblem && <p className="text-xs text-red-600">{dateProblem}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pickup-time">Pickup time</Label>
            <Input id="pickup-time" type="time" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pickup-count">Parcels</Label>
            <Input id="pickup-count" type="number" min={1} value={packageCount} onChange={(e) => setPackageCount(e.target.value)} />
          </div>
          <div className="flex flex-col justify-end">
            <Button onClick={handleRequestPickup} disabled={!isStaging || submitting || !pickupLocationId || !pickupTime || !!dateProblem}>
              {submitting ? 'Requesting…' : 'Request pickup'}
            </Button>
          </div>
        </div>
        {message && (
          <p className={`text-xs ${message.kind === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>{message.text}</p>
        )}
      </CardContent>
    </Card>
  );
}
