-- Daily Delhivery status refresh (06:30 Dubai time = 02:30 UTC).
-- Run ONCE, after the refresh-shipment-status function is deployed.
--
-- Before running:
--   a) Enable the pg_cron and pg_net extensions (Supabase Dashboard > Database > Extensions).
--   b) Store the service role key in Vault — do NOT paste it into this file:
--        select vault.create_secret('<service role key>', 'service_role_key');
--
-- To stop the schedule later: select cron.unschedule('delhivery-daily-refresh');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'delhivery-daily-refresh',
  '30 2 * * *',
  $$
  select net.http_post(
    url := 'https://zmdueujrxolyzoafrqib.supabase.co/functions/v1/refresh-shipment-status',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
