// Thin wrapper for calling Supabase Edge Functions from the frontend. Every
// function invoked through here keeps its default JWT verification on
// (unlike functions/nextdrop-webhook, which is called by NextDrop itself
// and deliberately disables it) — the caller's own session token is what
// authorizes the call.

import { supabase } from '../supabaseClient';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export async function callEdgeFunction<T>(name: string, body: unknown): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok && !json) {
    throw new Error(`${name} failed: HTTP ${res.status}`);
  }
  return json as T;
}
