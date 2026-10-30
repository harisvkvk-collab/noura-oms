// Re-export shim so `supabase functions deploy` finds this under
// supabase/functions/ — edit ../../../functions/cancel-courier-shipment/index.ts,
// not this file. See supabase/functions/test-courier-connection/index.ts for the
// same pattern.
export * from '../../../functions/cancel-courier-shipment/index.ts';
