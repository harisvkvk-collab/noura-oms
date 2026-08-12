// Customers.tsx — searchable list (left) + a tabbed Details/Address/Notes
// panel (right) that's reused as-is for both viewing/editing an existing
// customer and adding a new one, matching the mockup's single-form pattern.

import { useEffect, useState } from 'react';
import { Plus, Phone } from 'lucide-react';
import { supabase } from './supabaseClient';
import { cn } from '@/lib/utils';
import { normalizePhoneNumber } from '@/lib/phoneUtils';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { InstagramIcon } from '@/components/icons/InstagramIcon';
import { FacebookIcon } from '@/components/icons/FacebookIcon';
import { TikTokIcon } from '@/components/icons/TikTokIcon';
import { SnapchatIcon } from '@/components/icons/SnapchatIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { HOME_COUNTRY, UAE_CITIES } from '@/lib/orderConstants';

const CHANNELS = ['Instagram', 'WhatsApp', 'Facebook', 'TikTok', 'In-store'] as const;

type CustomerListItem = {
  id: string;
  name: string;
  phone: string | null;
  ordersCount: number;
  lifetimeValueAed: number;
};
type Country = { code: string; name: string };
type Currency = { code: string; name: string };

export function Customers({ initialSelectedId }: { initialSelectedId?: string | null } = {}) {
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [query, setQuery] = useState('');
  // Only read once, on mount — a link from Reports.tsx ("Sales by
  // customer") remounts this component fresh each time nav switches to
  // it (see App.tsx's onNavigate reset), so there's no case where this
  // needs to react to the prop changing after the fact.
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(initialSelectedId ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function load() {
    setLoading(true);
    const [custRes, countryRes, currencyRes, orderStatsRes] = await Promise.all([
      supabase.from('customers').select('id, name, phone').order('name'),
      supabase.from('countries').select('code, name').order('name'),
      supabase.from('currencies').select('code, name').order('code'),
      // Drafts aren't real sales yet, so they don't count toward orders/spend.
      supabase.from('orders').select('customer_id, total_in_aed').neq('status', 'draft'),
    ]);
    const firstError = [custRes, countryRes, currencyRes, orderStatsRes].find((r) => r.error)?.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }

    const statsByCustomer = new Map<string, { count: number; total: number }>();
    for (const o of orderStatsRes.data ?? []) {
      if (!o.customer_id) continue;
      const entry = statsByCustomer.get(o.customer_id) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += Number(o.total_in_aed);
      statsByCustomer.set(o.customer_id, entry);
    }

    setCustomers(
      (custRes.data ?? []).map((c) => ({
        ...c,
        ordersCount: statsByCustomer.get(c.id)?.count ?? 0,
        lifetimeValueAed: statsByCustomer.get(c.id)?.total ?? 0,
      })),
    );
    setCountries(countryRes.data ?? []);
    setCurrencies(currencyRes.data ?? []);
    setError(null);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;

  const filtered = customers.filter(
    (c) => c.name.toLowerCase().includes(query.toLowerCase()) || (c.phone ?? '').includes(query),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Customers</h1>
        <Button size="sm" onClick={() => setSelectedId('new')}>
          <Plus className="size-4" /> Add customer
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[440px_1fr] min-w-0">
        <Card className="min-w-0">
          <CardContent className="p-0">
            <div className="p-3">
              <Input
                placeholder="Search customers"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {filtered.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">No customers found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Orders</th>
                    <th className="px-3 py-2 font-medium">Spent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        'cursor-pointer transition-colors',
                        selectedId === c.id ? 'bg-accent' : 'hover:bg-secondary',
                      )}
                    >
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.phone ?? 'No phone'}</div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{c.ordersCount}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">AED {c.lifetimeValueAed.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardContent className="p-4">
            {selectedId ? (
              <CustomerDetailPanel
                key={selectedId}
                customerId={selectedId}
                countries={countries}
                currencies={currencies}
                onSaved={(id) => {
                  setRefreshKey((k) => k + 1);
                  setSelectedId(id);
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Select a customer, or add a new one.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CustomerDetailPanel({
  customerId,
  countries,
  currencies,
  onSaved,
}: {
  customerId: string | 'new';
  countries: Country[];
  currencies: Currency[];
  onSaved: (id: string) => void;
}) {
  const isNew = customerId === 'new';
  const [loading, setLoading] = useState(!isNew);
  const [tab, setTab] = useState('details');

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [preferredCurrency, setPreferredCurrency] = useState('AED');
  const [usualChannel, setUsualChannel] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState('');
  const [instagramHandle, setInstagramHandle] = useState('');
  const [facebookHandle, setFacebookHandle] = useState('');
  const [tiktokHandle, setTiktokHandle] = useState('');
  const [snapchatHandle, setSnapchatHandle] = useState('');

  const [addressId, setAddressId] = useState<string | null>(null);
  const [countryCode, setCountryCode] = useState<string | undefined>(undefined);
  const [city, setCity] = useState('');
  const [area, setArea] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [fullAddress, setFullAddress] = useState('');
  const [googleLocationLink, setGoogleLocationLink] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      setLoading(true);
      const [custRes, addrRes] = await Promise.all([
        supabase
          .from('customers')
          .select(
            'id, name, phone, email, preferred_currency, usual_channel, notes, instagram_handle, facebook_handle, tiktok_handle, snapchat_handle',
          )
          .eq('id', customerId)
          .single(),
        supabase
          .from('customer_addresses')
          .select('id, country_code, city, area, zip_code, full_address, google_location_link')
          .eq('customer_id', customerId)
          .eq('is_default', true)
          .maybeSingle(),
      ]);
      if (custRes.error) {
        setError(custRes.error.message);
        setLoading(false);
        return;
      }
      const c = custRes.data;
      setName(c.name);
      setPhone(c.phone ?? '');
      setEmail(c.email ?? '');
      setPreferredCurrency(c.preferred_currency ?? 'AED');
      setUsualChannel(c.usual_channel ?? undefined);
      setNotes(c.notes ?? '');
      setInstagramHandle(c.instagram_handle ?? '');
      setFacebookHandle(c.facebook_handle ?? '');
      setTiktokHandle(c.tiktok_handle ?? '');
      setSnapchatHandle(c.snapchat_handle ?? '');

      const a = addrRes.data;
      if (a) {
        setAddressId(a.id);
        setCountryCode(a.country_code ?? undefined);
        // Existing addresses were free text before this became a dropdown —
        // a case-only mismatch ("sharjah" vs "Sharjah") shouldn't force a
        // re-pick, so match case-insensitively against the fixed list
        // before falling back to the raw stored value (which just won't
        // match any option, same as a genuinely different city would).
        const storedCity = a.city ?? '';
        const matchedCity = UAE_CITIES.find((c) => c.toLowerCase() === storedCity.toLowerCase());
        setCity(matchedCity ?? storedCity);
        setArea(a.area ?? '');
        setZipCode(a.zip_code ?? '');
        setFullAddress(a.full_address ?? '');
        setGoogleLocationLink(a.google_location_link ?? '');
      }
      setLoading(false);
    })();
  }, [customerId, isNew]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required.');

    setSubmitting(true);
    setError(null);

    // Normalize phone number
    let normalizedPhone: string | null = null;
    if (phone.trim()) {
      try {
        normalizedPhone = normalizePhoneNumber(phone);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid phone number.');
        setSubmitting(false);
        return;
      }
    }

    // For new customers, check if phone already exists
    if (isNew && normalizedPhone) {
      const { data: existing } = await supabase
        .from('customers')
        .select('id, name')
        .eq('phone', normalizedPhone)
        .maybeSingle();
      if (existing) {
        setError(`A customer with this phone number already exists: ${existing.name}`);
        setSubmitting(false);
        return;
      }
    }

    const customerValues = {
      name: name.trim(),
      phone: normalizedPhone,
      email: email.trim() || null,
      preferred_currency: preferredCurrency,
      usual_channel: usualChannel ?? null,
      notes: notes.trim() || null,
      instagram_handle: instagramHandle.trim() || null,
      facebook_handle: facebookHandle.trim() || null,
      tiktok_handle: tiktokHandle.trim() || null,
      snapchat_handle: snapchatHandle.trim() || null,
    };

    let id = isNew ? null : customerId;
    if (isNew) {
      const { data, error: insertError } = await supabase
        .from('customers')
        .insert(customerValues)
        .select('id')
        .single();
      if (insertError) {
        setError(insertError.message);
        setSubmitting(false);
        return;
      }
      id = data.id;
    } else {
      const { error: updateError } = await supabase.from('customers').update(customerValues).eq('id', customerId);
      if (updateError) {
        setError(updateError.message);
        setSubmitting(false);
        return;
      }
    }

    const hasAddressInput = Boolean(countryCode || city.trim() || area.trim() || zipCode.trim() || fullAddress.trim() || googleLocationLink.trim());
    if (hasAddressInput) {
      const addressValues = {
        customer_id: id,
        country_code: countryCode ?? null,
        city: city.trim() || null,
        area: area.trim() || null,
        zip_code: zipCode.trim() || null,
        full_address: fullAddress.trim() || null,
        google_location_link: googleLocationLink.trim() || null,
        is_default: true,
      };
      const { error: addressError } = addressId
        ? await supabase.from('customer_addresses').update(addressValues).eq('id', addressId)
        : await supabase.from('customer_addresses').insert(addressValues);
      if (addressError) {
        setError(addressError.message);
        setSubmitting(false);
        return;
      }
    }

    setSubmitting(false);
    onSaved(id!);
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  // All hrefs below are derived straight from their handle/phone state, so
  // they update on every keystroke — no separate "live preview" wiring
  // needed. cleanHandle strips a leading '@' (people type handles either
  // way) since ig.me/m/, m.me/, and snapchat.com/add/ all expect the bare
  // username — tiktok.com/@ is the one exception that wants it back, added
  // explicitly in that href below.
  const digitsOnly = phone.replace(/\D/g, '');
  const waHref = digitsOnly ? `https://wa.me/${digitsOnly}` : undefined;
  const telHref = phone.trim() ? `tel:${phone.trim()}` : undefined;

  const cleanHandle = (value: string) => value.trim().replace(/^@/, '');
  const igHandle = cleanHandle(instagramHandle);
  const igHref = igHandle ? `https://ig.me/m/${encodeURIComponent(igHandle)}` : undefined;
  const fbHandle = cleanHandle(facebookHandle);
  const fbHref = fbHandle ? `https://m.me/${encodeURIComponent(fbHandle)}` : undefined;
  const ttHandle = cleanHandle(tiktokHandle);
  const ttHref = ttHandle ? `https://www.tiktok.com/@${encodeURIComponent(ttHandle)}` : undefined;
  const scHandle = cleanHandle(snapchatHandle);
  const scHref = scHandle ? `https://www.snapchat.com/add/${encodeURIComponent(scHandle)}` : undefined;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">{isNew ? 'Add customer' : name || 'Customer'}</h2>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="address">Address</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-name">Name</Label>
              <Input id="cust-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-phone">Phone</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="cust-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+971501234567"
                  className="flex-1"
                />
                <a
                  href={waHref}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Message on WhatsApp"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md border border-input',
                    waHref ? 'text-success-foreground hover:bg-secondary' : 'pointer-events-none opacity-40',
                  )}
                >
                  <WhatsAppIcon className="size-4" />
                </a>
                <a
                  href={telHref}
                  aria-label="Call"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md border border-input',
                    telHref ? 'text-primary hover:bg-secondary' : 'pointer-events-none opacity-40',
                  )}
                >
                  <Phone className="size-4" />
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-instagram">Instagram</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="cust-instagram"
                  value={instagramHandle}
                  onChange={(e) => setInstagramHandle(e.target.value)}
                  placeholder="handle"
                  className="flex-1"
                />
                <a
                  href={igHref}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Message on Instagram"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md border border-input',
                    igHref ? 'text-primary hover:bg-secondary' : 'pointer-events-none opacity-40',
                  )}
                >
                  <InstagramIcon className="size-4" />
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-facebook">Facebook</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="cust-facebook"
                  value={facebookHandle}
                  onChange={(e) => setFacebookHandle(e.target.value)}
                  placeholder="username"
                  className="flex-1"
                />
                <a
                  href={fbHref}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Message on Facebook"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md border border-input',
                    fbHref ? 'text-primary hover:bg-secondary' : 'pointer-events-none opacity-40',
                  )}
                >
                  <FacebookIcon className="size-4" />
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-tiktok">TikTok</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="cust-tiktok"
                  value={tiktokHandle}
                  onChange={(e) => setTiktokHandle(e.target.value)}
                  placeholder="handle"
                  className="flex-1"
                />
                <a
                  href={ttHref}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View profile on TikTok"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md border border-input',
                    ttHref ? 'text-primary hover:bg-secondary' : 'pointer-events-none opacity-40',
                  )}
                >
                  <TikTokIcon className="size-4" />
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-snapchat">Snapchat</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="cust-snapchat"
                  value={snapchatHandle}
                  onChange={(e) => setSnapchatHandle(e.target.value)}
                  placeholder="username"
                  className="flex-1"
                />
                <a
                  href={scHref}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View profile on Snapchat"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md border border-input',
                    scHref ? 'text-primary hover:bg-secondary' : 'pointer-events-none opacity-40',
                  )}
                >
                  <SnapchatIcon className="size-4" />
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-email">Email</Label>
              <Input id="cust-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Preferred currency</Label>
                <Select value={preferredCurrency} onValueChange={setPreferredCurrency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Usual channel</Label>
                <Select value={usualChannel} onValueChange={setUsualChannel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNELS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="address">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label>Country</Label>
              <Select value={countryCode} onValueChange={setCountryCode}>
                <SelectTrigger>
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent>
                  {countries.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-city">City</Label>
              {countryCode === HOME_COUNTRY ? (
                // A dropdown here, not free text: a mismatched/miscased city
                // name (e.g. "sharjah" vs "Sharjah") is a real, hard-to-
                // diagnose cause of NextDrop booking failures — this list is
                // their own documented set of valid domestic cities, so
                // anything picked here is guaranteed to match.
                <Select value={city || undefined} onValueChange={setCity}>
                  <SelectTrigger id="cust-city">
                    <SelectValue placeholder="Select city" />
                  </SelectTrigger>
                  <SelectContent>
                    {UAE_CITIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input id="cust-city" value={city} onChange={(e) => setCity(e.target.value)} />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-area">Area</Label>
              <Input id="cust-area" value={area} onChange={(e) => setArea(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cust-zip">Zip code</Label>
              <Input id="cust-zip" value={zipCode} onChange={(e) => setZipCode(e.target.value)} />
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="cust-full-address">Full address</Label>
              <Textarea
                id="cust-full-address"
                value={fullAddress}
                onChange={(e) => setFullAddress(e.target.value)}
                placeholder="Street, building, apartment/villa number…"
                className="min-h-20"
              />
              <p className="text-xs text-muted-foreground">
                Required for automatic courier booking (NextDrop etc.) — country/city/area/zip alone aren't enough.
              </p>
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="cust-google-link">Google Maps link</Label>
              <Input
                id="cust-google-link"
                value={googleLocationLink}
                onChange={(e) => setGoogleLocationLink(e.target.value)}
                placeholder="Paste a Google Maps share link (e.g., https://maps.app.goo.gl/...)"
                type="url"
              />
              <p className="text-xs text-muted-foreground">
                Optional: used for QR code on shipping slip and in WhatsApp courier messages.
              </p>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes about this customer…"
            className="min-h-32"
          />
        </TabsContent>
      </Tabs>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-fit">
        {submitting ? 'Saving…' : isNew ? 'Add customer' : 'Save'}
      </Button>
    </form>
  );
}
