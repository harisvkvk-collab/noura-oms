// The Supabase CLI requires functions to live under supabase/functions/<name>/,
// but this repo keeps the actual source at the top-level functions/ directory
// (see the adapters/, functions/, frontend/ layout). This file just re-exports
// the real implementation so `supabase functions deploy` finds it here without
// duplicating the code — edit ../../../functions/nextdrop-webhook/index.ts, not
// this file.
export * from '../../../functions/nextdrop-webhook/index.ts';
