-- Adds Instagram/Facebook/TikTok/Snapchat handle fields to customers, for
-- the message/view-profile icon buttons on the customer Details tab.
-- instagram_handle and tiktok_handle already existed on the live DB before
-- this migration was written (added out-of-band) — add_column guards make
-- this safe to run regardless. Run once in the Supabase SQL editor.

alter table customers add column if not exists instagram_handle text;
alter table customers add column if not exists facebook_handle text;
alter table customers add column if not exists tiktok_handle text;
alter table customers add column if not exists snapchat_handle text;
