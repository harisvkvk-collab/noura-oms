-- Add google_location_link column to customer_addresses (idempotent)
-- Stores Google Maps share links for delivery locations, used for QR codes
-- on shipping slips and in WhatsApp courier messages.

alter table if exists public.customer_addresses
  add column if not exists google_location_link text;
