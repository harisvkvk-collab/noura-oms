// Inventory.tsx — category-tabbed product list with an Add item dialog.
// Status (in stock / low stock / out of stock) is derived, never stored:
// out of stock when stock_qty is 0, low stock when it's at or below
// reorder_level, in stock otherwise.

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { supabase } from './supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const UNCATEGORIZED = '__uncategorized__';

type Category = { id: number; name: string };
type Product = {
  id: string;
  sku: string | null;
  name: string;
  variant: string | null;
  category_id: number | null;
  cost_price: number;
  selling_price: number;
  stock_qty: number;
  reorder_level: number;
};

type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

function stockStatus(p: Product): StockStatus {
  if (p.stock_qty <= 0) return 'out_of_stock';
  if (p.stock_qty <= p.reorder_level) return 'low_stock';
  return 'in_stock';
}

const STATUS_META: Record<StockStatus, { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  in_stock: { label: 'In stock', variant: 'success' },
  low_stock: { label: 'Low stock', variant: 'warning' },
  out_of_stock: { label: 'Out of stock', variant: 'destructive' },
};

export function Inventory() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  function openAddDialog() {
    setEditingProduct(null);
    setDialogOpen(true);
  }

  function openEditDialog(p: Product) {
    setEditingProduct(p);
    setDialogOpen(true);
  }

  async function load() {
    setLoading(true);
    const [categoriesRes, productsRes] = await Promise.all([
      supabase.from('product_categories').select('id, name').order('name'),
      supabase
        .from('products')
        .select('id, sku, name, variant, category_id, cost_price, selling_price, stock_qty, reorder_level')
        .eq('active', true)
        .order('name'),
    ]);
    if (categoriesRes.error) {
      setError(categoriesRes.error.message);
      setLoading(false);
      return;
    }
    if (productsRes.error) {
      setError(productsRes.error.message);
      setLoading(false);
      return;
    }
    setCategories(categoriesRes.data ?? []);
    setProducts(productsRes.data ?? []);
    setError(null);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;

  const hasUncategorized = products.some((p) => p.category_id === null);

  const tabs = [
    { key: 'all', label: 'All', count: products.length },
    ...categories.map((c) => ({
      key: String(c.id),
      label: c.name,
      count: products.filter((p) => p.category_id === c.id).length,
    })),
    ...(hasUncategorized
      ? [{ key: UNCATEGORIZED, label: 'Uncategorized', count: products.filter((p) => p.category_id === null).length }]
      : []),
  ];

  const filtered = products.filter((p) => {
    if (activeTab === 'all') return true;
    if (activeTab === UNCATEGORIZED) return p.category_id === null;
    return p.category_id === Number(activeTab);
  });

  const categoryName = (id: number | null) => {
    if (id === null) return 'Uncategorized';
    return categories.find((c) => c.id === id)?.name ?? 'Uncategorized';
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Inventory</h1>
        <Button size="sm" onClick={openAddDialog}>
          <Plus className="size-4" /> Add item
        </Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <ProductForm
              product={editingProduct}
              categories={categories}
              onDone={() => {
                setDialogOpen(false);
                load();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === t.key
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      <Card className="min-w-0">
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No items in this category yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Item</th>
                    <th className="px-4 py-2 font-medium">Category</th>
                    <th className="px-4 py-2 font-medium">Stock</th>
                    <th className="px-4 py-2 font-medium">Cost</th>
                    <th className="px-4 py-2 font-medium">Price</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((p) => {
                    const status = STATUS_META[stockStatus(p)];
                    return (
                      <tr
                        key={p.id}
                        onClick={() => openEditDialog(p)}
                        className="cursor-pointer hover:bg-secondary"
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{p.name}</div>
                          {p.variant && <div className="text-xs text-muted-foreground">{p.variant}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{categoryName(p.category_id)}</td>
                        <td
                          className={`px-4 py-2.5 ${stockStatus(p) !== 'in_stock' ? 'font-semibold text-destructive' : ''}`}
                        >
                          {p.stock_qty}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">AED {p.cost_price.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">AED {p.selling_price.toFixed(2)}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProductForm({
  product,
  categories,
  onDone,
}: {
  product: Product | null;
  categories: Category[];
  onDone: () => void;
}) {
  const isEditing = product !== null;
  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [categoryId, setCategoryId] = useState<string | undefined>(
    product?.category_id != null ? String(product.category_id) : undefined,
  );
  const [variant, setVariant] = useState(product?.variant ?? '');
  const [costPrice, setCostPrice] = useState(product?.cost_price ?? 0);
  const [sellingPrice, setSellingPrice] = useState(product?.selling_price ?? 0);
  const [stockQty, setStockQty] = useState(product?.stock_qty ?? 0);
  const [reorderLevel, setReorderLevel] = useState(product?.reorder_level ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Item name is required.');

    setSubmitting(true);
    setError(null);
    const values = {
      name: name.trim(),
      sku: sku.trim() || null,
      category_id: categoryId ? Number(categoryId) : null,
      variant: variant.trim() || null,
      cost_price: costPrice,
      selling_price: sellingPrice,
      stock_qty: stockQty,
      reorder_level: reorderLevel,
    };
    const { error: saveError } = isEditing
      ? await supabase.from('products').update(values).eq('id', product.id)
      : await supabase.from('products').insert({ ...values, active: true });
    setSubmitting(false);

    if (saveError) {
      setError(saveError.message);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit item' : 'Add item'}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="item-name">Name</Label>
        <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-sku">SKU (optional)</Label>
          <Input id="item-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Category</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger>
              <SelectValue placeholder="Uncategorized" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="item-variant">Variant (optional)</Label>
        <Input
          id="item-variant"
          value={variant}
          onChange={(e) => setVariant(e.target.value)}
          placeholder="e.g. Black, Size M"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-cost">Cost price (AED)</Label>
          <Input
            id="item-cost"
            type="number"
            min={0}
            step="0.01"
            value={costPrice}
            onChange={(e) => setCostPrice(Number(e.target.value))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-price">Selling price (AED)</Label>
          <Input
            id="item-price"
            type="number"
            min={0}
            step="0.01"
            value={sellingPrice}
            onChange={(e) => setSellingPrice(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-stock">Stock qty</Label>
          <Input
            id="item-stock"
            type="number"
            min={0}
            value={stockQty}
            onChange={(e) => setStockQty(Number(e.target.value))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-reorder">Reorder level</Label>
          <Input
            id="item-reorder"
            type="number"
            min={0}
            value={reorderLevel}
            onChange={(e) => setReorderLevel(Number(e.target.value))}
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Saving…' : isEditing ? 'Save' : 'Add item'}
      </Button>
    </form>
  );
}
