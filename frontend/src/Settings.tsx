// Settings.tsx — admin-only screen for managing courier API credentials.
// Backed by courier_api_credentials, but this screen never reads or
// displays a raw value: status comes from courier_api_key_status (a view
// exposing only has_api_token/has_pickup_location/has_customer_branch
// booleans per courier+environment row, see schema.sql), and saving only
// ever writes new values, never fetches old ones back. RLS enforces the
// admin-only write (and the view itself returns zero rows for non-admins)
// — the route gating in App.tsx is a UX convenience on top of that, not
// the real gate.
//
// Which fields show for a courier is driven by courierCredentialFields
// (lib/courierCredentialFields.ts), keyed by api_provider. Couriers not in
// that config fall back to a single generic "API Key" field, so this
// screen never breaks for a courier nobody's mapped out yet.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from './supabaseClient';
import { callEdgeFunction } from '@/lib/edgeFunctions';
import { cn } from '@/lib/utils';
import {
  fieldsForProvider,
  resolveEnvironment,
  courierCredentialFields,
  type CredentialFieldDef,
} from '@/lib/courierCredentialFields';
import { PickupLocations } from './PickupLocations';
import { CompanySettings } from './CompanySettings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

type Courier = {
  id: string;
  name: string;
  api_provider: string | null;
  whatsapp_number: string | null;
  contact_person: string | null;
  integration_status: string | null;
};

type KeyStatusRow = {
  courier_id: string;
  environment: string;
  has_api_token: boolean;
  has_pickup_location: boolean;
  has_customer_branch: boolean;
  active: boolean;
};

// supabase-js throws PostgrestError as a plain object, not an Error
// instance — `err instanceof Error` is always false for it, which would
// otherwise mask the real message behind a generic fallback. Exported for
// reuse by CompanySettings.tsx (same admin-form shape, same bug to avoid).
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return 'Failed to save.';
}

export function Settings() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <Tabs defaultValue="couriers">
        <TabsList>
          <TabsTrigger value="couriers">Courier API keys</TabsTrigger>
          <TabsTrigger value="pickup-locations">Pickup locations</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp Messages</TabsTrigger>
          <TabsTrigger value="company">Company</TabsTrigger>
        </TabsList>
        <TabsContent value="couriers">
          <CourierApiKeysPanel />
        </TabsContent>
        <TabsContent value="pickup-locations">
          <PickupLocations />
        </TabsContent>
        <TabsContent value="whatsapp">
          <WhatsAppMessagesPanel />
        </TabsContent>
        <TabsContent value="company">
          <CompanySettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CourierApiKeysPanel() {
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [statusRows, setStatusRows] = useState<KeyStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedCourierId, setSelectedCourierId] = useState<string | null>(null);
  const [addCourierDialogOpen, setAddCourierDialogOpen] = useState(false);
  const [editCourierDialogOpen, setEditCourierDialogOpen] = useState(false);
  const [editingCourier, setEditingCourier] = useState<Courier | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [courierRes, statusRes] = await Promise.all([
        supabase.from('couriers').select('id, name, api_provider, whatsapp_number, contact_person, integration_status').order('name'),
        supabase
          .from('courier_api_key_status')
          .select('courier_id, environment, has_api_token, has_pickup_location, has_customer_branch, active'),
      ]);
      if (cancelled) return;
      const firstError = [courierRes, statusRes].find((r) => r.error)?.error;
      if (firstError) {
        setError(firstError.message);
        setLoading(false);
        return;
      }
      setCouriers(courierRes.data ?? []);
      setStatusRows(statusRes.data ?? []);
      setSelectedCourierId((prev) => prev ?? courierRes.data?.[0]?.id ?? null);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const selectedCourier = couriers.find((c) => c.id === selectedCourierId) ?? null;
  const usesGenericFallback =
    selectedCourier != null &&
    !(selectedCourier.api_provider && courierCredentialFields[selectedCourier.api_provider]);

  // "Has a row" per the ask — reading existence, never the value. A
  // courier can have credentials for more than one environment (Delhivery
  // staging + production); any row at all counts as "saved".
  function hasCredentialRow(courierId: string) {
    return statusRows.some((r) => r.courier_id === courierId);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="min-w-0">
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold">Courier API credentials</h2>
              <p className="text-xs text-muted-foreground">
                Values are write-only here — once saved, they're never shown again, even to admins.
              </p>
            </div>
            {!loading && !error && (
              <Button size="sm" onClick={() => setAddCourierDialogOpen(true)}>
                Add courier
              </Button>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : couriers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No couriers found.</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 sm:w-96">
                <Label>Courier</Label>
                <div className="flex flex-col divide-y divide-border rounded-md border border-input overflow-hidden">
                  {couriers.map((c) => {
                    const saved = hasCredentialRow(c.id);
                    const active = c.id === selectedCourierId;
                    const isManual = c.integration_status === 'manual';
                    return (
                      <div
                        key={c.id}
                        className={cn(
                          'flex items-center justify-between px-3 py-2 text-sm transition-colors',
                          active ? 'bg-accent' : 'hover:bg-secondary',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedCourierId(c.id)}
                          className="flex flex-1 items-center justify-between text-left"
                        >
                          <span className="font-medium">{c.name}</span>
                          <Badge variant={saved ? 'success' : 'neutral'}>{saved ? 'Key saved' : 'No key set'}</Badge>
                        </button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="ml-2 h-auto p-1"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingCourier(c);
                            setEditCourierDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {usesGenericFallback && (
                  <p className="text-xs text-muted-foreground">
                    No dedicated field schema for this courier yet — showing a generic API key field.
                  </p>
                )}
              </div>

              {selectedCourier && (
                <CredentialForm
                  key={selectedCourier.id}
                  courier={selectedCourier}
                  statusRows={statusRows.filter((r) => r.courier_id === selectedCourier.id)}
                  onSaved={() => setRefreshKey((k) => k + 1)}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>

      <AddCourierDialog
        open={addCourierDialogOpen}
        onOpenChange={setAddCourierDialogOpen}
        onAdded={() => {
          setAddCourierDialogOpen(false);
          setRefreshKey((k) => k + 1);
        }}
      />

      {editingCourier && (
        <EditCourierDialog
          open={editCourierDialogOpen}
          onOpenChange={setEditCourierDialogOpen}
          courier={editingCourier}
          onSaved={() => {
            setEditCourierDialogOpen(false);
            setEditingCourier(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function statusColumnFor(field: CredentialFieldDef): keyof KeyStatusRow {
  if (field.key === 'api_token') return 'has_api_token';
  if (field.key === 'pickup_location') return 'has_pickup_location';
  return 'has_customer_branch';
}

function CredentialForm({
  courier,
  statusRows,
  onSaved,
}: {
  courier: Courier;
  statusRows: KeyStatusRow[];
  onSaved: () => void;
}) {
  const fields = fieldsForProvider(courier.api_provider);
  const [values, setValues] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  function statusFor(field: CredentialFieldDef) {
    const env = resolveEnvironment(field);
    const row = statusRows.find((r) => r.environment === env);
    if (!row) return false;
    return Boolean(row[statusColumnFor(field)]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTestResult(null);

    // Group by resolved environment first — two fields sharing an
    // environment (e.g. Delhivery's production token + its
    // not-environment-scoped pickup location, which also resolves to
    // 'production') must land in the same write, not two separate ones
    // that would each stomp the other's columns via their defaults.
    const rowsByEnv = new Map<string, { api_token?: string; pickup_location?: string; extraConfig?: Record<string, string> }>();
    fields.forEach((field, idx) => {
      const raw = values[idx];
      if (!raw || !raw.trim()) return; // blank = leave this field unchanged
      const env = resolveEnvironment(field);
      const entry = rowsByEnv.get(env) ?? {};
      if ('extraConfig' in field && field.extraConfig) {
        entry.extraConfig = { ...(entry.extraConfig ?? {}), [field.key]: raw.trim() };
      } else {
        entry[field.key as 'api_token' | 'pickup_location'] = raw.trim();
      }
      rowsByEnv.set(env, entry);
    });

    if (rowsByEnv.size === 0) {
      const message = 'Enter at least one value to save.';
      setError(message);
      toast.error(message);
      return;
    }

    setSubmitting(true);
    try {
      for (const [env, fieldsForEnv] of rowsByEnv) {
        // Routed through an edge function (service role) rather than a
        // direct client write — courier_api_credentials has no SELECT
        // policy (api_token must never be readable via the client, even by
        // admins), and Postgres RLS requires a row to be visible under a
        // SELECT-capable policy before an UPDATE's WHERE clause can match
        // it. A client-side .update() here always silently affects 0 rows
        // (PostgREST still returns 204 as if it succeeded) — see
        // save-courier-credential/index.ts for the full story.
        const result = await callEdgeFunction<{ ok: boolean; error?: string }>('save-courier-credential', {
          courierId: courier.id,
          environment: env,
          fields: fieldsForEnv,
        });
        if (!result.ok) throw new Error(result.error ?? 'Failed to save.');
      }
      setValues({});
      toast.success(`Saved credentials for ${courier.name}.`);
      onSaved();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      toast.error(`Failed to save: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await callEdgeFunction<{ ok: boolean; detail: string }>('test-courier-connection', {
        courierId: courier.id,
      });
      setTestResult(result);
      if (result.ok) {
        toast.success(`${courier.name}: connection OK.`);
      } else {
        toast.error(`${courier.name}: ${result.detail}`);
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setTestResult({ ok: false, detail: message });
      toast.error(`${courier.name}: ${message}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 border-t border-border pt-4">
      {fields.map((field, idx) => {
        const isSaved = statusFor(field);
        const hasNewValue = (values[idx] ?? '').trim().length > 0;
        return (
          <div key={idx} className="flex flex-col gap-1.5 sm:w-96">
            <div className="flex items-center gap-2">
              <Label htmlFor={`field-${idx}`}>{field.label}</Label>
              <Badge variant={hasNewValue ? 'default' : isSaved ? 'success' : 'neutral'}>
                {hasNewValue ? 'New value' : isSaved ? '✓ Saved' : 'Not set'}
              </Badge>
            </div>
            <div className="relative">
              <Input
                id={`field-${idx}`}
                type="password"
                autoComplete="off"
                placeholder={isSaved ? '••••••• (saved value)' : 'Enter value to save'}
                value={values[idx] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [idx]: e.target.value }))}
              />
              {isSaved && !hasNewValue && (
                <p className="text-xs text-muted-foreground mt-1">
                  Value is saved. Enter new value above to update, or leave empty to keep unchanged.
                </p>
              )}
            </div>
          </div>
        );
      })}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={submitting} className="w-fit">
          {submitting ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" disabled={testing} onClick={handleTestConnection} className="w-fit">
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
      </div>

      {testResult && (
        <p className={cn('text-sm', testResult.ok ? 'text-success-foreground' : 'text-destructive')}>
          {testResult.ok ? 'Connected ✓ — ' : 'Failed: '}
          {testResult.detail}
        </p>
      )}
    </form>
  );
}

function AddCourierDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Courier name is required.');
      return;
    }

    if (!whatsappNumber.trim()) {
      setError('WhatsApp number is required.');
      return;
    }

    setSubmitting(true);
    try {
      const { error: insertError } = await supabase.from('couriers').insert({
        name: name.trim(),
        whatsapp_number: whatsappNumber.trim(),
        contact_person: contactPerson.trim() || null,
        integration_status: 'manual',
        active: true,
      });
      if (insertError) throw insertError;

      setName('');
      setWhatsappNumber('');
      setContactPerson('');
      toast.success(`${name} added successfully.`);
      onAdded();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      toast.error(`Failed to add courier: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add courier</DialogTitle>
          <DialogDescription>Register a new courier company for manual booking.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="courier-name">Courier name</Label>
            <Input
              id="courier-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Smiles Express"
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="whatsapp-number">WhatsApp number</Label>
            <Input
              id="whatsapp-number"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              placeholder="+971501234567 or 971501234567"
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contact-person">Contact person (optional)</Label>
            <Input
              id="contact-person"
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
              placeholder="Name of contact"
              disabled={submitting}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add courier'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WhatsAppMessagesPanel() {
  const [customerTemplate, setCustomerTemplate] = useState(
    'Hi {CUSTOMER_NAME}, thank you for your order {ORDER_NUMBER}!\n\n{ITEMS}\nTotal: {CURRENCY} {TOTAL} ({PAYMENT_METHOD})\n\nWe\'ll notify you once it\'s packed and on its way.',
  );
  const [courierTemplate, setCourierTemplate] = useState(
    'Order: {ORDER_NUMBER}\n\nFrom\n{PICKUP_ADDRESS}\n\nTo\n{CUSTOMER_NAME}\n{CUSTOMER_PHONE}\n{DELIVERY_ADDRESS}\n\nPayment\n{PAYMENT_TYPE}\n\nItems\n{ITEMS}',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('company_settings')
        .select('whatsapp_customer_template, whatsapp_courier_template')
        .maybeSingle();
      if (data?.whatsapp_customer_template) setCustomerTemplate(data.whatsapp_customer_template);
      if (data?.whatsapp_courier_template) setCourierTemplate(data.whatsapp_courier_template);
    }
    load();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    setSubmitting(true);
    try {
      const { error: err } = await supabase
        .from('company_settings')
        .upsert({
          whatsapp_customer_template: customerTemplate,
          whatsapp_courier_template: courierTemplate,
        })
        .maybeSingle();
      if (err) throw err;
      setSaved(true);
      toast.success('WhatsApp message templates updated successfully.');
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      toast.error(`Failed to save: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-4">
        <div>
          <h2 className="text-sm font-semibold">WhatsApp Message Templates</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Customize the messages sent to customers and couriers. Use placeholders like {'{'}<code>CUSTOMER_NAME</code>{'}'},  {'{'}<code>ORDER_NUMBER</code>{'}'}, etc.
          </p>
        </div>

        <form onSubmit={handleSave} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="customer-template" className="font-medium">Customer Confirmation Message</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Placeholders: {'{'}<code>CUSTOMER_NAME</code>{'}'}, {'{'}<code>ORDER_NUMBER</code>{'}'}, {'{'}<code>ITEMS</code>{'}'}, {'{'}<code>CURRENCY</code>{'}'}, {'{'}<code>TOTAL</code>{'}'}, {'{'}<code>PAYMENT_METHOD</code>{'}'}
            </p>
            <Textarea
              id="customer-template"
              value={customerTemplate}
              onChange={(e) => setCustomerTemplate(e.target.value)}
              disabled={submitting}
              className="font-mono text-xs min-h-32"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="courier-template" className="font-medium">Courier Booking Message</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Placeholders: {'{'}<code>ORDER_NUMBER</code>{'}'}, {'{'}<code>PICKUP_ADDRESS</code>{'}'}, {'{'}<code>CUSTOMER_NAME</code>{'}'}, {'{'}<code>CUSTOMER_PHONE</code>{'}'}, {'{'}<code>DELIVERY_ADDRESS</code>{'}'}, {'{'}<code>PAYMENT_TYPE</code>{'}'}, {'{'}<code>ITEMS</code>{'}'}
            </p>
            <Textarea
              id="courier-template"
              value={courierTemplate}
              onChange={(e) => setCourierTemplate(e.target.value)}
              disabled={submitting}
              className="font-mono text-xs min-h-32"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && <p className="text-sm text-success-foreground">✓ Templates saved successfully</p>}

          <Button type="submit" disabled={submitting} className="w-fit">
            {submitting ? 'Saving…' : 'Save Templates'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function EditCourierDialog({
  open,
  onOpenChange,
  courier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courier: Courier;
  onSaved: () => void;
}) {
  const [whatsappNumber, setWhatsappNumber] = useState(courier.whatsapp_number || '');
  const [contactPerson, setContactPerson] = useState(courier.contact_person || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!whatsappNumber.trim()) {
      setError('WhatsApp number is required.');
      return;
    }

    setSubmitting(true);
    try {
      const { error: updateError } = await supabase
        .from('couriers')
        .update({
          whatsapp_number: whatsappNumber.trim(),
          contact_person: contactPerson.trim() || null,
        })
        .eq('id', courier.id);
      if (updateError) throw updateError;

      toast.success(`${courier.name} updated successfully.`);
      onSaved();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      toast.error(`Failed to update courier: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit courier</DialogTitle>
          <DialogDescription>Update contact details for {courier.name}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-courier-name">Courier name</Label>
            <Input
              id="edit-courier-name"
              value={courier.name}
              disabled
              className="text-muted-foreground"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-whatsapp-number">WhatsApp number</Label>
            <Input
              id="edit-whatsapp-number"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              placeholder="+971501234567 or 971501234567"
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-contact-person">Contact person (optional)</Label>
            <Input
              id="edit-contact-person"
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
              placeholder="Name of contact"
              disabled={submitting}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
