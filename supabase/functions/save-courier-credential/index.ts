// Re-export shim so `supabase functions deploy` finds this under
// supabase/functions/ — edit ../../../functions/save-courier-credential/index.ts,
// not this file. See supabase/functions/nextdrop-webhook/index.ts for the
// same pattern.
export * from '../../../functions/save-courier-credential/index.ts';
