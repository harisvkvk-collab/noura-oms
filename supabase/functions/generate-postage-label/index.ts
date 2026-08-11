// Re-export shim so `supabase functions deploy` finds this under
// supabase/functions/ — edit ../../../functions/generate-postage-label/index.ts,
// not this file. See supabase/functions/nextdrop-webhook/index.ts for the
// same pattern.
export * from '../../../functions/generate-postage-label/index.ts';
