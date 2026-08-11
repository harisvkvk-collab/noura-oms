// Supabase Edge Function: backs the "Test connection" button on the admin
// Settings screen (CourierApiKeysPanel, Settings.tsx). Runs server-side
// because the frontend never has direct access to courier_api_credentials
// (no SELECT policy at all — see policies.sql); this is the only path that
// can actually exercise a saved key. Delegates the real probe to the
// adapter's own testConnection() (adapters/types.ts) so this file stays
// courier-agnostic, same pattern as create-shipment/generate-postage-label.
// Keeps JWT verification on — only our own authenticated admin frontend
// calls this.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdapterForCourier } from '../_shared/getAdapterForCourier.ts';
import { corsHeaders } from '../_shared/cors.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { courierId } = await req.json();
    if (!courierId) return json({ ok: false, detail: 'courierId is required.' });

    const { data: courier, error: courierError } = await supabase
      .from('couriers')
      .select('name, api_provider')
      .eq('id', courierId)
      .maybeSingle();
    if (courierError) throw courierError;
    if (!courier) return json({ ok: false, detail: 'Courier not found.' });

    const adapter = await getAdapterForCourier(supabase, courier);
    if (!adapter) {
      return json({ ok: false, detail: `No active API credentials on file for ${courier.name}.` });
    }
    if (!adapter.testConnection) {
      return json({ ok: false, detail: `${courier.name}'s integration doesn't support a connection test yet.` });
    }

    const result = await adapter.testConnection();
    return json(result);
  } catch (err) {
    console.error('test-courier-connection failed', err);
    return json({ ok: false, detail: err instanceof Error ? err.message : 'Unknown error.' });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
