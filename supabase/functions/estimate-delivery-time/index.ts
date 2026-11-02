// Re-export shim so `supabase functions deploy` finds this under
// supabase/functions/ — edit ../../../functions/estimate-delivery-time/index.ts,
// not this file. See supabase/functions/estimate-shipping-cost/index.ts for the
// same pattern.
export * from '../../../functions/estimate-delivery-time/index.ts';
