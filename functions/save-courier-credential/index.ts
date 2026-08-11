// Supabase Edge Function: the only path that can write to
// courier_api_credentials (insert or update).
//
// Why this exists: that table deliberately has no SELECT policy (api_token
// must never be readable via the client, even by admins -- see
// policies.sql), which used to be paired with client-side admin
// insert/update RLS policies so the Settings screen could still write
// directly. That doesn't work for UPDATE: Postgres RLS requires a row to
// be visible under a SELECT-capable policy before an UPDATE's WHERE
// clause can touch it, even when the UPDATE policy's own USING clause is
// wide open. With zero SELECT policy, every UPDATE to an existing row
// silently affected 0 rows -- PostgREST still returned 204 (success) with
// no error, so the Settings screen showed "Saved" toasts and the value
// never actually changed. INSERT doesn't have this problem (no existing
// row to see), which is why saving a brand-new courier's key worked in
// testing but rotating an existing one (or NextDrop's customer_branch)
// never persisted.
//
// This function runs with the service role, which bypasses RLS entirely,
// so it does its own admin check up front instead of relying on RLS -- and
// since it can actually read extra_config server-side, it merges into the
// existing value instead of the client's old whole-column overwrite.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const serviceClient = createClient(
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
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const {
      data: { user },
      error: userError,
    } = await serviceClient.auth.getUser(token);
    if (userError || !user) return json({ ok: false, error: 'Not authenticated.' }, 401);

    const { data: staff, error: staffError } = await serviceClient
      .from('staff_users')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (staffError) throw staffError;
    if (!staff || staff.role !== 'admin') {
      return json({ ok: false, error: 'Admin access required.' }, 403);
    }

    const { courierId, environment, fields } = await req.json();
    if (!courierId || !environment || !fields || typeof fields !== 'object') {
      return json({ ok: false, error: 'courierId, environment, and fields are required.' }, 400);
    }

    const { data: existingRow, error: lookupError } = await serviceClient
      .from('courier_api_credentials')
      .select('id, extra_config')
      .eq('courier_id', courierId)
      .eq('environment', environment)
      .maybeSingle();
    if (lookupError) throw lookupError;

    // Whitelist -- never let the request body set arbitrary columns.
    const row: Record<string, unknown> = { courier_id: courierId, environment, active: true };
    if (typeof fields.api_token === 'string') row.api_token = fields.api_token;
    if (typeof fields.pickup_location === 'string') row.pickup_location = fields.pickup_location;
    if (fields.extraConfig && typeof fields.extraConfig === 'object') {
      row.extra_config = { ...((existingRow?.extra_config as Record<string, unknown>) ?? {}), ...fields.extraConfig };
    }

    const { error: writeError } = existingRow
      ? await serviceClient.from('courier_api_credentials').update(row).eq('id', existingRow.id)
      : await serviceClient.from('courier_api_credentials').insert(row);
    if (writeError) throw writeError;

    return json({ ok: true });
  } catch (err) {
    console.error('save-courier-credential failed', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
