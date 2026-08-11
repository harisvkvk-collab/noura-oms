// CompanySettings.tsx — admin-only "Company" tab inside Settings.tsx.
// Backed by company_settings — a table that already existed on the live DB
// before this screen was built (seeded with one row, business_name =
// 'Noura Abaya'; see schema.sql comment). This screen only ever updates
// that existing row by its real id, never inserts or deletes, so there's
// no list/add-new affordance like PickupLocations.tsx has. Also the source
// of the business_name shown on the printable shipping slip header
// (OrderDetail.tsx "Print shipping slip" — see lib/shippingSlip.ts).

import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { getErrorMessage } from './Settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Country = { code: string; name: string };

type FormValues = {
  business_name: string;
  address: string;
  city: string;
  country_code: string | undefined;
  phone: string;
  email: string;
};

const EMPTY: FormValues = { business_name: '', address: '', city: '', country_code: undefined, phone: '', email: '' };

export function CompanySettings() {
  const [rowId, setRowId] = useState<string | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [settingsRes, countriesRes] = await Promise.all([
        // company_settings is a singleton table with no fixed id — take
        // whichever one row exists rather than assuming an id.
        supabase
          .from('company_settings')
          .select('id, business_name, address, city, country_code, phone, email')
          .limit(1)
          .maybeSingle(),
        supabase.from('countries').select('code, name').order('name'),
      ]);
      if (cancelled) return;
      const firstError = settingsRes.error ?? countriesRes.error;
      if (firstError) {
        setError(getErrorMessage(firstError));
      } else {
        setCountries(countriesRes.data ?? []);
        const data = settingsRes.data;
        setRowId(data?.id ?? null);
        setValues({
          business_name: data?.business_name ?? '',
          address: data?.address ?? '',
          city: data?.city ?? '',
          country_code: data?.country_code ?? undefined,
          phone: data?.phone ?? '',
          email: data?.email ?? '',
        });
        setError(null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setSuccess(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (!rowId) return setError('No company settings row found to update.');
    if (!values.business_name.trim()) return setError('Business name is required.');

    setSubmitting(true);
    try {
      const { error: updateError } = await supabase
        .from('company_settings')
        .update({
          business_name: values.business_name.trim(),
          address: values.address.trim() || null,
          city: values.city.trim() || null,
          country_code: values.country_code ?? null,
          phone: values.phone.trim() || null,
          email: values.email.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', rowId);
      if (updateError) throw updateError;
      setSuccess(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">Company details</h2>
          <p className="text-xs text-muted-foreground">
            Shown on the printable shipping slip header (Business name → "From: ...").
          </p>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 sm:w-96">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cs-name">Business name</Label>
              <Input id="cs-name" value={values.business_name} onChange={(e) => set('business_name', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cs-address">Address</Label>
              <Input id="cs-address" value={values.address} onChange={(e) => set('address', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cs-city">City</Label>
              <Input id="cs-city" value={values.city} onChange={(e) => set('city', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Country</Label>
              <Select value={values.country_code} onValueChange={(v) => set('country_code', v)}>
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
              <Label htmlFor="cs-phone">Phone</Label>
              <Input id="cs-phone" value={values.phone} onChange={(e) => set('phone', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cs-email">Email</Label>
              <Input id="cs-email" type="email" value={values.email} onChange={(e) => set('email', e.target.value)} />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-success-foreground">Saved.</p>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? 'Saving…' : 'Save'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
