// Quotations: list of quotes, and one scrolling page to create or edit one.
// Items keep a snapshot of description and price, so changing a product later
// never changes a saved quotation. Photos live in the private quotation-images
// bucket and are shown through short-lived signed links.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, ArrowDown, ArrowUp, Copy, Pencil, Plus, Search, Trash2, Camera } from 'lucide-react';
import { toast } from 'sonner';

const BUCKET = 'quotation-images';
const STATUSES = ['draft', 'sent', 'accepted', 'expired', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_STYLE: Record<Status, string> = {
  draft: 'bg-secondary text-foreground',
  sent: 'bg-blue-100 text-blue-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  expired: 'bg-amber-100 text-amber-800',
  cancelled: 'bg-red-100 text-red-800',
};

type QuotationRow = {
  id: string;
  quote_number: number;
  status: Status;
  quote_date: string;
  valid_until: string | null;
  company_name: string | null;
  bill_to_name: string | null;
  total_amount: number;
  currency_code: string;
};

type LineItem = {
  key: string;
  productId: string | null;
  description: string;
  imagePath: string | null;
  unitPrice: number;
  qty: number;
};

function todayISO() {
  return addDaysISO(0);
}

function addDaysISO(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function newKey() {
  return Math.random().toString(36).slice(2);
}

function formatMoney(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatusChip({ status }: { status: Status }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

// ---------- List ----------

export function Quotations() {
  const [rows, setRows] = useState<QuotationRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  async function load() {
    // Mark quotes past their valid-until date as expired (drafts and sent only).
    await supabase
      .from('quotations')
      .update({ status: 'expired' })
      .in('status', ['draft', 'sent'])
      .lt('valid_until', todayISO());
    const { data, error } = await supabase
      .from('quotations')
      .select('id, quote_number, status, quote_date, valid_until, company_name, bill_to_name, total_amount, currency_code')
      .order('quote_number', { ascending: false });
    if (error) {
      toast.error(error.message);
      return;
    }
    setRows((data ?? []) as QuotationRow[]);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows) return [];
    if (!q) return rows;
    return rows.filter(
      (r) =>
        String(r.quote_number).includes(q) ||
        (r.bill_to_name ?? '').toLowerCase().includes(q) ||
        (r.company_name ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  if (editing !== null) {
    return (
      <QuotationEditor
        quotationId={editing === 'new' ? null : editing}
        onBack={() => {
          setEditing(null);
          load();
        }}
      />
    );
  }

  async function duplicate(id: string) {
    setMenuFor(null);
    const { data: source } = await supabase.from('quotations').select('*').eq('id', id).single();
    const { data: sourceItems } = await supabase
      .from('quotation_items')
      .select('sort_order, product_id, description, image_path, unit_price, qty')
      .eq('quotation_id', id)
      .order('sort_order');
    if (!source) return toast.error('Could not load that quotation.');
    const { data: number, error: numberError } = await supabase.rpc('next_quotation_number');
    if (numberError) return toast.error(numberError.message);
    const { data: created, error } = await supabase
      .from('quotations')
      .insert({
        quote_number: number,
        quote_date: todayISO(),
        valid_until: addDaysISO(15),
        status: 'draft',
        customer_id: source.customer_id,
        company_name: source.company_name,
        bill_to_name: source.bill_to_name,
        address_lines: source.address_lines,
        city: source.city,
        country: source.country,
        phone: source.phone,
        customer_ref: source.customer_ref,
        prepared_by: source.prepared_by,
        prepared_by_phone: source.prepared_by_phone,
        currency_code: source.currency_code,
        terms_text: source.terms_text,
        notes: source.notes,
      })
      .select('id')
      .single();
    if (error || !created) return toast.error(error?.message ?? 'Could not copy the quotation.');
    if (sourceItems && sourceItems.length > 0) {
      await supabase.from('quotation_items').insert(sourceItems.map((i) => ({ ...i, quotation_id: created.id })));
    }
    toast.success(`Copied as quotation ${number}. You can edit the copy.`);
    load();
  }

  async function deleteDraft(row: QuotationRow) {
    setMenuFor(null);
    if (!window.confirm(`Delete draft quotation ${row.quote_number}? This cannot be undone.`)) return;
    const { error } = await supabase.from('quotations').delete().eq('id', row.id);
    if (error) return toast.error(error.message);
    toast.success('Draft deleted.');
    load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Quotations</h1>
        <Button onClick={() => setEditing('new')}>
          <Plus className="size-4" /> New quotation
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search by number or customer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {rows === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {rows !== null && visible.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {rows.length === 0 ? 'No quotations yet. Tap "New quotation" to make one.' : 'No quotations match that search.'}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {visible.map((r) => (
          <Card key={r.id} className="relative">
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(r.id)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">#{r.quote_number}</span>
                  <StatusChip status={r.status} />
                </div>
                <div className="truncate text-sm">{r.bill_to_name || r.company_name || 'No customer name'}</div>
                <div className="text-xs text-muted-foreground">
                  {r.quote_date}
                  {r.valid_until ? ` · valid until ${r.valid_until}` : ''}
                </div>
              </button>
              <div className="flex flex-col items-end gap-2">
                <div className="text-sm font-semibold">{formatMoney(Number(r.total_amount), r.currency_code)}</div>
                <button
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
                  onClick={() => setMenuFor(menuFor === r.id ? null : r.id)}
                  aria-label={`Actions for quotation ${r.quote_number}`}
                >
                  ···
                </button>
              </div>
            </CardContent>
            {menuFor === r.id && (
              <div className="absolute right-3 top-12 z-10 flex w-40 flex-col rounded-md border border-border bg-card p-1 shadow-md">
                <button className="flex items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-secondary" onClick={() => { setMenuFor(null); setEditing(r.id); }}>
                  <Pencil className="size-4" /> Edit
                </button>
                <button className="flex items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-secondary" onClick={() => duplicate(r.id)}>
                  <Copy className="size-4" /> Duplicate
                </button>
                {r.status === 'draft' && (
                  <button className="flex items-center gap-2 rounded px-2 py-2 text-left text-sm text-red-600 hover:bg-secondary" onClick={() => deleteDraft(r)}>
                    <Trash2 className="size-4" /> Delete
                  </button>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------- Create / edit ----------

function QuotationEditor({ quotationId, onBack }: { quotationId: string | null; onBack: () => void }) {
  const [loaded, setLoaded] = useState(!quotationId);
  const [saving, setSaving] = useState(false);
  // Set on the first save of a new quotation, so later saves update it instead of creating another.
  const [currentId, setCurrentId] = useState<string | null>(quotationId);
  const [quoteNumber, setQuoteNumber] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>('draft');
  const [quoteDate, setQuoteDate] = useState(todayISO());
  const [validUntil, setValidUntil] = useState(addDaysISO(15));
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerMatches, setCustomerMatches] = useState<{ id: string; name: string }[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [billToName, setBillToName] = useState('');
  const [addressLines, setAddressLines] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [phone, setPhone] = useState('');
  const [customerRef, setCustomerRef] = useState('');
  const [preparedBy, setPreparedBy] = useState('');
  const [preparedByPhone, setPreparedByPhone] = useState('');
  const [currency, setCurrency] = useState('AED');
  const [terms, setTerms] = useState('');
  const [defaultTerms, setDefaultTerms] = useState('');
  const [items, setItems] = useState<LineItem[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  // Defaults from Settings (for new quotations) or the saved quotation (for edits).
  useEffect(() => {
    (async () => {
      const { data: settings } = await supabase
        .from('quotation_settings')
        .select('default_terms, default_prepared_by, currency_code, validity_days')
        .eq('id', 1)
        .single();
      if (settings) {
        setDefaultTerms(settings.default_terms ?? '');
        if (!quotationId) {
          setTerms(settings.default_terms ?? '');
          setPreparedBy(settings.default_prepared_by ?? '');
          setCurrency(settings.currency_code ?? 'AED');
          setValidUntil(addDaysISO(settings.validity_days ?? 15));
        }
      }
      if (!quotationId) return;
      const { data: q, error } = await supabase.from('quotations').select('*').eq('id', quotationId).single();
      if (error || !q) {
        toast.error(error?.message ?? 'Could not open that quotation.');
        onBack();
        return;
      }
      const { data: rows } = await supabase
        .from('quotation_items')
        .select('*')
        .eq('quotation_id', quotationId)
        .order('sort_order');
      setQuoteNumber(q.quote_number);
      setStatus(q.status);
      setQuoteDate(q.quote_date);
      setValidUntil(q.valid_until ?? '');
      setCustomerId(q.customer_id);
      setCompanyName(q.company_name ?? '');
      setBillToName(q.bill_to_name ?? '');
      setAddressLines(q.address_lines ?? '');
      setCity(q.city ?? '');
      setCountry(q.country ?? '');
      setPhone(q.phone ?? '');
      setCustomerRef(q.customer_ref ?? '');
      setPreparedBy(q.prepared_by ?? '');
      setPreparedByPhone(q.prepared_by_phone ?? '');
      setCurrency(q.currency_code);
      setTerms(q.terms_text ?? '');
      setItems(
        (rows ?? []).map((r) => ({
          key: newKey(),
          productId: r.product_id,
          description: r.description,
          imagePath: r.image_path,
          unitPrice: Number(r.unit_price),
          qty: r.qty,
        })),
      );
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotationId]);

  // Signed links for every stored photo (external product image URLs are used as-is).
  useEffect(() => {
    const paths = items.map((i) => i.imagePath).filter((p): p is string => !!p && !imageUrls[p]);
    if (paths.length === 0) return;
    (async () => {
      const next: Record<string, string> = {};
      for (const path of paths) {
        if (path.startsWith('http')) {
          next[path] = path;
          continue;
        }
        const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
        if (data?.signedUrl) next[path] = data.signedUrl;
      }
      setImageUrls((prev) => ({ ...prev, ...next }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Customer search: fills the snapshot fields, which stay editable afterwards.
  useEffect(() => {
    const q = customerQuery.trim();
    if (q.length < 2) {
      setCustomerMatches([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      const { data } = await supabase.from('customers').select('id, name').ilike('name', `%${q}%`).limit(8);
      setCustomerMatches((data ?? []) as { id: string; name: string }[]);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [customerQuery]);

  async function pickCustomer(id: string, name: string) {
    setCustomerId(id);
    setCustomerQuery('');
    setCustomerMatches([]);
    setBillToName(name);
    const { data: address } = await supabase
      .from('customer_addresses')
      .select('full_address, city, country_code')
      .eq('customer_id', id)
      .eq('is_default', true)
      .maybeSingle();
    const { data: customer } = await supabase.from('customers').select('phone').eq('id', id).single();
    setAddressLines(address?.full_address ?? '');
    setCity(address?.city ?? '');
    setCountry(address?.country_code ?? '');
    setPhone(customer?.phone ?? '');
    setCustomerRef(id.slice(0, 8).toUpperCase());
  }

  const totals = useMemo(() => {
    const qty = items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
    const amount = items.reduce((sum, i) => sum + (Number(i.unitPrice) || 0) * (Number(i.qty) || 0), 0);
    return { qty, amount: Math.round(amount * 100) / 100 };
  }, [items]);

  function updateItem(key: string, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function moveItem(index: number, direction: -1 | 1) {
    setItems((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function uploadPhoto(key: string, file: File) {
    try {
      const blob = await shrinkImage(file);
      const folder = currentId ?? 'new';
      const path = `${folder}/${newKey()}${newKey()}.jpg`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      updateItem(key, { imagePath: path });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload the photo.');
    }
  }

  async function save(): Promise<string | null> {
    if (!billToName.trim()) {
      toast.error('Enter the customer name (bill-to).');
      return null;
    }
    const usable = items.filter((i) => i.description.trim());
    if (usable.length === 0) {
      toast.error('Add at least one item with a description.');
      return null;
    }
    setSaving(true);
    try {
      const fields = {
        quote_date: quoteDate,
        valid_until: validUntil || null,
        status,
        customer_id: customerId,
        company_name: companyName || null,
        bill_to_name: billToName.trim(),
        address_lines: addressLines || null,
        city: city || null,
        country: country || null,
        phone: phone || null,
        customer_ref: customerRef || null,
        prepared_by: preparedBy || null,
        prepared_by_phone: preparedByPhone || null,
        currency_code: currency,
        terms_text: terms,
        total_qty: totals.qty,
        total_amount: totals.amount,
        updated_at: new Date().toISOString(),
      };

      let id = currentId;
      if (!id) {
        const { data: number, error: numberError } = await supabase.rpc('next_quotation_number');
        if (numberError) throw numberError;
        const { data: created, error } = await supabase
          .from('quotations')
          .insert({ ...fields, quote_number: number })
          .select('id, quote_number')
          .single();
        if (error || !created) throw error ?? new Error('Could not save the quotation.');
        id = created.id;
        setCurrentId(created.id);
        setQuoteNumber(created.quote_number);
      } else {
        const { error } = await supabase.from('quotations').update(fields).eq('id', id);
        if (error) throw error;
      }

      // Items are replaced as a set, so the order on screen is the saved order.
      await supabase.from('quotation_items').delete().eq('quotation_id', id);
      const { error: itemsError } = await supabase.from('quotation_items').insert(
        usable.map((i, index) => ({
          quotation_id: id,
          sort_order: index + 1,
          product_id: i.productId,
          description: i.description.trim(),
          image_path: i.imagePath,
          unit_price: i.unitPrice,
          qty: i.qty,
        })),
      );
      if (itemsError) throw itemsError;

      toast.success('Quotation saved.');
      return id;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the quotation.');
      return null;
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-6 pb-24">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <h1 className="text-xl font-bold tracking-tight">
          {currentId ? `Quotation ${quoteNumber ?? ''}` : 'New quotation'}
        </h1>
      </div>

      {/* Customer */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold">Customer</h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cust-search">Pick an existing customer (optional)</Label>
            <Input
              id="cust-search"
              placeholder="Type a customer name"
              value={customerQuery}
              onChange={(e) => setCustomerQuery(e.target.value)}
            />
            {customerMatches.length > 0 && (
              <div className="flex flex-col rounded-md border border-border bg-card">
                {customerMatches.map((c) => (
                  <button key={c.id} className="px-3 py-2 text-left text-sm hover:bg-secondary" onClick={() => pickCustomer(c.id, c.name)}>
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Picking a customer fills these fields. Changing them here does not change the customer record.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Company name (optional)" value={companyName} onChange={setCompanyName} />
            <Field label="Bill-to name" value={billToName} onChange={setBillToName} />
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label>Address</Label>
              <Textarea rows={3} value={addressLines} onChange={(e) => setAddressLines(e.target.value)} />
            </div>
            <Field label="City" value={city} onChange={setCity} />
            <Field label="Country" value={country} onChange={setCountry} />
            <Field label="Phone" value={phone} onChange={setPhone} />
            <Field label="Customer reference" value={customerRef} onChange={setCustomerRef} />
          </div>
        </CardContent>
      </Card>

      {/* Dates and preparer */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <h2 className="text-sm font-semibold sm:col-span-2">Details</h2>
          <div className="flex flex-col gap-1.5">
            <Label>Quotation number</Label>
            <div className="text-sm">{quoteNumber ?? 'Will be assigned on save'}</div>
          </div>
          <Field label="Currency" value={currency} onChange={setCurrency} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="q-date">Date</Label>
            <Input id="q-date" type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="q-valid">Valid until</Label>
            <Input id="q-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>
          <Field label="Prepared by" value={preparedBy} onChange={setPreparedBy} />
          <Field label="Prepared-by phone" value={preparedByPhone} onChange={setPreparedByPhone} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="q-status">Status</Label>
            <select
              id="q-status"
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Items */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold">Items</h2>
          {items.length === 0 && <p className="text-sm text-muted-foreground">No items yet.</p>}
          {items.map((item, index) => (
            <div key={item.key} className="flex flex-col gap-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Item {index + 1}</span>
                <div className="flex items-center gap-1">
                  <button className="rounded p-1 text-muted-foreground hover:bg-secondary" onClick={() => moveItem(index, -1)} aria-label="Move up">
                    <ArrowUp className="size-4" />
                  </button>
                  <button className="rounded p-1 text-muted-foreground hover:bg-secondary" onClick={() => moveItem(index, 1)} aria-label="Move down">
                    <ArrowDown className="size-4" />
                  </button>
                  <button
                    className="rounded p-1 text-red-600 hover:bg-secondary"
                    onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                    aria-label="Delete item"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <PhotoBox
                  url={item.imagePath ? imageUrls[item.imagePath] : undefined}
                  onPick={(file) => uploadPhoto(item.key, file)}
                  onRemove={() => updateItem(item.key, { imagePath: null })}
                  hasPhoto={!!item.imagePath}
                />
              </div>

              <ProductPicker
                description={item.description}
                onDescribe={(text) => updateItem(item.key, { description: text, productId: null })}
                onPickProduct={(p) => {
                  updateItem(item.key, {
                    productId: p.id,
                    description: p.name,
                    unitPrice: Number(p.selling_price),
                    imagePath: p.image_url ?? item.imagePath,
                  });
                }}
              />

              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Price</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.unitPrice}
                    onChange={(e) => updateItem(item.key, { unitPrice: Number(e.target.value) })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Qty</Label>
                  <Input type="number" min={0} value={item.qty} onChange={(e) => updateItem(item.key, { qty: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Amount</Label>
                  <div className="flex h-9 items-center text-sm font-semibold">
                    {formatMoney((Number(item.unitPrice) || 0) * (Number(item.qty) || 0), currency)}
                  </div>
                </div>
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() => setItems((prev) => [...prev, { key: newKey(), productId: null, description: '', imagePath: null, unitPrice: 0, qty: 1 }])}
          >
            <Plus className="size-4" /> Add another item
          </Button>

          <div className="flex flex-col items-end gap-1 border-t border-border pt-4 text-sm">
            <div>Total quantity: <span className="font-semibold">{totals.qty}</span></div>
            <div className="text-lg font-bold">{formatMoney(totals.amount, currency)}</div>
            <div className="text-xs text-muted-foreground">No tax or discount.</div>
          </div>
        </CardContent>
      </Card>

      {/* Terms */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Terms and conditions</h2>
            <Button variant="ghost" size="sm" onClick={() => setTerms(defaultTerms)}>
              Reset to default
            </Button>
          </div>
          <Textarea rows={8} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </CardContent>
      </Card>

      {/* Save bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-end gap-2 border-t border-border bg-card px-4 py-3 md:left-56">
        <Button variant="outline" onClick={onBack} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function PhotoBox({
  url,
  hasPhoto,
  onPick,
  onRemove,
}: {
  url: string | undefined;
  hasPhoto: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-24 w-[4.5rem] items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-secondary">
        {url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <Camera className="size-5 text-muted-foreground" />}
      </div>
      <div className="flex flex-col gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 py-1.5 text-sm hover:bg-secondary">
          <Camera className="size-4" />
          {hasPhoto ? 'Change photo' : 'Add photo'}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPick(file);
              e.target.value = '';
            }}
          />
        </label>
        {hasPhoto && (
          <button className="self-start text-xs text-red-600" onClick={onRemove}>
            Remove photo
          </button>
        )}
      </div>
    </div>
  );
}

type ProductHit = { id: string; name: string; sku: string | null; selling_price: number; image_url: string | null };

function ProductPicker({
  description,
  onDescribe,
  onPickProduct,
}: {
  description: string;
  onDescribe: (text: string) => void;
  onPickProduct: (p: ProductHit) => void;
}) {
  const [hits, setHits] = useState<ProductHit[]>([]);

  useEffect(() => {
    const q = description.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      const { data } = await supabase
        .from('products')
        .select('id, name, sku, selling_price, image_url')
        .eq('active', true)
        .or(`name.ilike.%${q}%,sku.ilike.%${q}%`)
        .limit(6);
      setHits((data ?? []) as ProductHit[]);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [description]);

  return (
    <div className="flex flex-col gap-1.5">
      <Label>Description</Label>
      <Input
        placeholder="Type a product or a new description"
        value={description}
        onChange={(e) => onDescribe(e.target.value)}
      />
      {hits.length > 0 && (
        <div className="flex flex-col rounded-md border border-border bg-card">
          {hits.map((p) => (
            <button
              key={p.id}
              className="flex justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
              onClick={() => {
                setHits([]);
                onPickProduct(p);
              }}
            >
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-muted-foreground">{p.sku ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Resize a photo to at most 800px on its long side and re-encode as JPEG (80%),
// so uploads stay small on a phone connection.
async function shrinkImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the photo.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read the photo.'))), 'image/jpeg', 0.8),
  );
}
