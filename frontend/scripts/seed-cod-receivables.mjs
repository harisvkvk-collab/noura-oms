// One-off verification helper — nothing in the app writes to
// courier_cod_receivables yet (there's no "mark delivered" step wired up,
// see OrderDetail.tsx), so the new Deliveries screen has nothing real to
// show. This backfills a receivable for every existing COD order that has a
// shipment leg and doesn't already have one, so the screen can actually be
// exercised. Not meant to be a permanent fixture — once real delivery
// confirmation exists, this script (and the gap it papers over) goes away.
//
// Usage (from frontend/):
//   STAFF_EMAIL=... STAFF_PASSWORD=... node scripts/seed-cod-receivables.mjs

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

async function main() {
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: staffEmail,
    password: staffPassword,
  });
  if (signInError) throw signInError;

  const { data: codOrders, error: ordersError } = await supabase
    .from('orders')
    .select('id, order_number, total_in_aed, shipments(id, shipment_legs(id, courier_id, cost))')
    .eq('payment_method', 'cod');
  if (ordersError) throw ordersError;

  const { data: existing, error: existingError } = await supabase
    .from('courier_cod_receivables')
    .select('order_id');
  if (existingError) throw existingError;
  const alreadyCovered = new Set(existing.map((r) => r.order_id));

  let created = 0;
  for (const order of codOrders) {
    if (alreadyCovered.has(order.id)) continue;
    const shipment = Array.isArray(order.shipments) ? order.shipments[0] : order.shipments;
    const leg = shipment ? (Array.isArray(shipment.shipment_legs) ? shipment.shipment_legs[0] : shipment.shipment_legs) : null;
    if (!leg) continue;

    const amountCollected = Number(order.total_in_aed);
    const feeDeducted = Number(leg.cost ?? 0);
    const { error: insertError } = await supabase.from('courier_cod_receivables').insert({
      order_id: order.id,
      shipment_leg_id: leg.id,
      courier_id: leg.courier_id,
      amount_collected: amountCollected,
      delivery_fee_deducted: feeDeducted,
      net_due: amountCollected - feeDeducted,
      status: 'pending',
    });
    if (insertError) throw insertError;
    console.log(`Created receivable for ${order.order_number}: AED ${amountCollected} - AED ${feeDeducted} fee`);
    created += 1;
  }

  console.log(`Done. Created ${created} receivable(s).`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message ?? err);
  process.exit(1);
});
