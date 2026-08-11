// Shared CORS headers for Edge Functions called directly from the browser
// (create-shipment, generate-postage-label) — unlike nextdrop-webhook, which
// is called server-to-server by NextDrop and never hits browser CORS at all.
// Without these, every browser fetch() to these functions fails outright
// with a generic "Failed to fetch" before the request even reaches Deno.serve.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
