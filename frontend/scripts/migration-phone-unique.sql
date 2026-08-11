-- Add unique constraint on customers.phone (idempotent)
-- Ensures phone numbers are unique after normalization to E.164 format.
-- Run this after checking for duplicate phone numbers in existing data.

alter table if exists public.customers
  add constraint unique_customer_phone unique(phone)
  deferrable initially deferred;
