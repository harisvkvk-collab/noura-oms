-- One-time: exchange_rates was never seeded in schema.sql. Run this in the
-- Supabase SQL editor (reference tables are read-only to the app by design —
-- see policies.sql). Approximate rates as of mid-2026; update periodically,
-- there's no live FX feed wired up.
insert into exchange_rates (currency_code, rate_to_aed) values
  ('AED', 1.000000),
  ('SAR', 0.979100),
  ('USD', 3.672500),
  ('GBP', 4.650000),
  ('EUR', 3.980000),
  ('INR', 0.044000)
on conflict (currency_code) do update set
  rate_to_aed = excluded.rate_to_aed,
  updated_at = now();
