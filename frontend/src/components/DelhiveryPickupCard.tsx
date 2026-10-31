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

type DelhiveryCourier = { id: string; api_environment: string | null };

// Local calendar date (YYYY-MM-DD) for a day offset from today.
function localDateISO(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function DelhiveryPickupCard() {
  const [courier, setCourier] = useState<DelhiveryCourier | null>(null);
  const [pickupDate, setPickupDate] = useState(localDateISO(1));
  const [pickupTime, setPickupTime] = useState('14:00');
  const [packageCount, setPackageCount] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('couriers')
        .select('id, api_environment')
        .eq('api_provider', 'delhivery')
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      if (!cancelled) setCourier(data ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!courier) return null;

  const isStaging = courier.api_environment === 'staging';

  async function handleRequestPickup() {
    if (!courier) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await callEdgeFunction<{ ok: boolean; detail?: string; error?: string }>(
        'request-pickup',
        {
          courierId: courier.id,
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pickup-date">Pickup date</Label>
            <Input id="pickup-date" type="date" value={pickupDate} min={localDateISO(0)} onChange={(e) => setPickupDate(e.target.value)} />
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
            <Button onClick={handleRequestPickup} disabled={!isStaging || submitting || !pickupDate || !pickupTime}>
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
