-- Private bucket for photos on quotation lines. Safe to run more than once.
insert into storage.buckets (id, name, public)
values ('quotation-images', 'quotation-images', false)
on conflict (id) do nothing;

drop policy if exists "staff full access to quotation-images" on storage.objects;
create policy "staff full access to quotation-images" on storage.objects for all
  using (bucket_id = 'quotation-images' and auth.role() = 'authenticated')
  with check (bucket_id = 'quotation-images' and auth.role() = 'authenticated');
