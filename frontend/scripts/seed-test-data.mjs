// Seeds a small set of demo rows for local dashboard testing: a handful of
// products across all three categories, two test customers, and four orders
// covering the draft/confirmed/packed/dispatched statuses. Inserts go through
// the anon key + a real staff sign-in (same as the app itself), so this
// exercises RLS the same way normal usage would rather than bypassing it.
//
// Safe to re-run — skips creating rows if same-named test customers already
// exist, but does not delete anything. All seeded rows are tagged with a
// "[seed]" note so they're easy to find and remove later.
//
// Usage (from frontend/):
//   STAFF_EMAIL=... STAFF_PASSWORD=... node scripts/seed-test-data.mjs

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnvFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) out[match[1]] = match[2].trim();
    }
  } catch {
    // no .env file — fine, caller may set env vars directly
  }
  return out;
}

const envFile = loadEnvFile(new URL('../.env', import.meta.url));
const url = process.env.SUPABASE_URL ?? envFile.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY ?? envFile.VITE_SUPABASE_ANON_KEY;
const staffEmail = process.env.STAFF_EMAIL;
const staffPassword = process.env.STAFF_PASSWORD;

if (!url || !anonKey || !staffEmail || !staffPassword) {
  console.error('Missing SUPABASE_URL/SUPABASE_ANON_KEY (or frontend/.env) and STAFF_EMAIL/STAFF_PASSWORD.');
  process.exit(1);
}

const supabase = createClient(url, anonKey);

const SEED_NOTE = '[seed] test data added for dashboard verification';

async function main() {
  const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({
    email: staffEmail,
    password: staffPassword,
  });
  if (signInError) throw signInError;
  const staffId = signIn.user.id;

  const { data: categories, error: categoriesError } = await supabase
    .from('product_categories')
    .select('id, name');
  if (categoriesError) throw categoriesError;
  const categoryId = (name) => categories.find((c) => c.name === name)?.id;

  const { data: existingCustomers, error: existingCustomersError } = await supabase
    .from('customers')
    .select('id, name')
    .in('name', ['Fatima Al Suwaidi', 'Mariam Yusuf']);
  if (existingCustomersError) throw existingCustomersError;

  if (existingCustomers.length > 0) {
    console.log('Seed customers already exist — skipping (script is safe to re-run, not additive).');
    return;
  }

  const { data: products, error: productsError } = await supabase
    .from('products')
    .insert([
      {
        sku: 'ABY-BLK-M',
        name: 'Abaya - Black, Size M',
        category_id: categoryId('Abaya'),
        variant: 'Black, Size M',
        cost_price: 210,
        selling_price: 380,
        stock_qty: 24,
        reorder_level: 5,
      },
      {
        sku: 'MKH-BEG',
        name: 'Mukhawar - Beige',
        category_id: categoryId('Mukhawar'),
        variant: 'Beige',
        cost_price: 85,
        selling_price: 150,
        stock_qty: 3,
        reorder_level: 5,
      },
      {
        sku: 'ABY-EMR-L',
        name: 'Abaya - Emerald, Size L',
        category_id: categoryId('Abaya'),
        variant: 'Emerald, Size L',
        cost_price: 240,
        selling_price: 420,
        stock_qty: 0,
        reorder_level: 5,
      },
      {
        sku: 'ACC-PEARL-PIN',
        name: 'Pearl Pin Set',
        category_id: categoryId('Accessory'),
        cost_price: 18,
        selling_price: 45,
        stock_qty: 41,
        reorder_level: 5,
      },
    ])
    .select('id, name');
  if (productsError) throw productsError;
  const productId = (name) => products.find((p) => p.name === name)?.id;

  const { data: customers, error: customersError } = await supabase
    .from('customers')
    .insert([
      {
        name: 'Fatima Al Suwaidi',
        phone: '+966500000001',
        preferred_currency: 'SAR',
        usual_channel: 'Instagram',
        notes: SEED_NOTE,
      },
      {
        name: 'Mariam Yusuf',
        phone: '+971500000002',
        preferred_currency: 'AED',
        usual_channel: 'WhatsApp',
        notes: SEED_NOTE,
      },
    ])
    .select('id, name');
  if (customersError) throw customersError;
  const customerId = (name) => customers.find((c) => c.name === name)?.id;

  const orderSeeds = [
    {
      order_number: '#1001',
      customer_id: customerId('Mariam Yusuf'),
      order_source: 'WhatsApp',
      fulfillment_type: 'shipped',
      currency_code: 'AED',
      exchange_rate_snapshot: 1,
      payment_method: 'cod',
      payment_status: 'unpaid',
      status: 'draft',
      delivery_country_code: 'AE',
      notes: SEED_NOTE,
      items: [{ name: 'Mukhawar - Beige', qty: 1, unit_price: 150 }],
    },
    {
      order_number: '#1002',
      customer_id: customerId('Fatima Al Suwaidi'),
      order_source: 'Instagram',
      fulfillment_type: 'shipped',
      currency_code: 'SAR',
      exchange_rate_snapshot: 0.9791,
      payment_method: 'cod',
      payment_status: 'unpaid',
      status: 'confirmed',
      delivery_country_code: 'SA',
      notes: SEED_NOTE,
      items: [
        { name: 'Abaya - Black, Size M', qty: 1, unit_price: 380 },
        { name: 'Mukhawar - Beige', qty: 1, unit_price: 150 },
      ],
    },
    {
      order_number: '#1003',
      customer_id: customerId('Mariam Yusuf'),
      order_source: 'Facebook',
      fulfillment_type: 'shipped',
      currency_code: 'AED',
      exchange_rate_snapshot: 1,
      payment_method: 'cod',
      payment_status: 'unpaid',
      status: 'packed',
      delivery_country_code: 'AE',
      notes: SEED_NOTE,
      items: [{ name: 'Pearl Pin Set', qty: 2, unit_price: 45 }],
    },
    {
      order_number: '#1004',
      customer_id: customerId('Fatima Al Suwaidi'),
      order_source: 'TikTok',
      fulfillment_type: 'shipped',
      currency_code: 'AED',
      exchange_rate_snapshot: 1,
      payment_method: 'cod',
      payment_status: 'awaiting_courier_settlement',
      status: 'dispatched',
      delivery_country_code: 'AE',
      notes: SEED_NOTE,
      items: [{ name: 'Abaya - Emerald, Size L', qty: 1, unit_price: 420 }],
    },
  ];

  for (const seed of orderSeeds) {
    const subtotal = seed.items.reduce((sum, i) => sum + i.qty * i.unit_price, 0);
    const total = subtotal;
    const totalInAed = Math.round(total * seed.exchange_rate_snapshot * 100) / 100;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        order_number: seed.order_number,
        customer_id: seed.customer_id,
        order_source: seed.order_source,
        fulfillment_type: seed.fulfillment_type,
        currency_code: seed.currency_code,
        exchange_rate_snapshot: seed.exchange_rate_snapshot,
        subtotal,
        discount: 0,
        total,
        total_in_aed: totalInAed,
        payment_method: seed.payment_method,
        payment_status: seed.payment_status,
        status: seed.status,
        delivery_country_code: seed.delivery_country_code,
        notes: seed.notes,
        created_by: staffId,
      })
      .select('id, order_number')
      .single();
    if (orderError) throw orderError;

    const { error: itemsError } = await supabase.from('order_items').insert(
      seed.items.map((i) => ({
        order_id: order.id,
        product_id: productId(i.name),
        item_name: i.name,
        qty: i.qty,
        unit_price: i.unit_price,
        subtotal: i.qty * i.unit_price,
      })),
    );
    if (itemsError) throw itemsError;

    console.log(`Created order ${order.order_number} (${seed.status})`);
  }

  console.log(`Seeded ${products.length} products, ${customers.length} customers, ${orderSeeds.length} orders.`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message ?? err);
  process.exit(1);
});
