// PickupLocations.tsx — admin-only "Manage pickup locations" screen,
// rendered as a tab inside Settings.tsx. Backed by pickup_locations, which
// (unlike courier_api_credentials) holds nothing sensitive — just
// addresses and contact info — so unlike Settings' key-management tab this
// is a normal read/edit CRUD screen, no write-only masking.
//
// Whichever row has is_default = true is what NewOrder.tsx preselects for
// every shipped order, and what adapters/nextdrop.ts treats as "ship from
// our registered branch" (customer_order) vs. any other row, which it
// treats as a one-off pickup address (thirdparty_order) — see
// functions/create-shipment. Only one row can be default at a time; saving
// a new default here clears it off whichever row had it before.

import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type PickupLocation = {
  id: string;
  name: string;
  address: string;
  city: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  is_default: boolean;
  active: boolean;
};

export function PickupLocations() {
  const [locations, setLocations] = useState<PickupLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editing, setEditing] = useState<PickupLocation | 'new' | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: fetchError } = await supabase
        .from('pickup_locations')
        .select('id, name, address, city, contact_person, contact_phone, is_default, active')
        .order('name');
      if (cancelled) return;
      if (fetchError) {
        setError(fetchError.message);
      } else {
        setLocations(data ?? []);
        setError(null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="min-w-0">
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Pickup locations</h2>
              <p className="text-xs text-muted-foreground">
                Where shipped orders get picked up from. The default one is preselected on every new order.
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing('new')}>
              Add pickup location
            </Button>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pickup locations yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {locations.map((loc) => (
                <li key={loc.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{loc.name}</span>
                      {loc.is_default && <Badge variant="success">Default</Badge>}
                      {!loc.active && <Badge variant="neutral">Inactive</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {loc.address}
                      {loc.city ? `, ${loc.city}` : ''}
                      {loc.contact_person ? ` · ${loc.contact_person}` : ''}
                      {loc.contact_phone ? ` · ${loc.contact_phone}` : ''}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditing(loc)}>
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {editing && (
        <PickupLocationDialog
          location={editing === 'new' ? null : editing}
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function PickupLocationDialog({
  location,
  open,
  onOpenChange,
  onSaved,
}: {
  location: PickupLocation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(location?.name ?? '');
  const [address, setAddress] = useState(location?.address ?? '');
  const [city, setCity] = useState(location?.city ?? '');
  const [contactPerson, setContactPerson] = useState(location?.contact_person ?? '');
  const [contactPhone, setContactPhone] = useState(location?.contact_phone ?? '');
  const [isDefault, setIsDefault] = useState(location?.is_default ?? false);
  const [active, setActive] = useState(location?.active ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Name is required.');
    if (!address.trim()) return setError('Address is required.');

    setSubmitting(true);
    try {
      // Only one row can be default — clear it off everything else first
      // if this save is about to set it. Not wrapped in a transaction (no
      // RPC for that exists in this codebase — same known limitation as
      // NewOrder.tsx), so a failure between these two steps could
      // theoretically leave two rows marked default; low-stakes enough
      // (staff would just notice and re-save) not to build one for it.
      if (isDefault) {
        const { error: clearError } = await supabase
          .from('pickup_locations')
          .update({ is_default: false })
          .eq('is_default', true);
        if (clearError) throw clearError;
      }

      const row = {
        name: name.trim(),
        address: address.trim(),
        city: city.trim() || null,
        contact_person: contactPerson.trim() || null,
        contact_phone: contactPhone.trim() || null,
        is_default: isDefault,
        active,
      };

      const { error: writeError } = location
        ? await supabase.from('pickup_locations').update(row).eq('id', location.id)
        : await supabase.from('pickup_locations').insert(row);
      if (writeError) throw writeError;

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{location ? 'Edit pickup location' : 'Add pickup location'}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loc-name">Name</Label>
            <Input id="loc-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loc-address">Address</Label>
            <Input id="loc-address" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loc-city">City</Label>
            <Input id="loc-city" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="loc-contact-person">Contact person</Label>
              <Input id="loc-contact-person" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="loc-contact-phone">Contact phone</Label>
              <Input id="loc-contact-phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="size-4 rounded border-input"
            />
            Default pickup location
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="size-4 rounded border-input"
            />
            Active (shows up in the order-form picker)
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
