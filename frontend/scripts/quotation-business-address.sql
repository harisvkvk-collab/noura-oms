-- Business address and phone shown at the top left of quotations. Safe to run more than once.
alter table quotation_settings add column if not exists business_address text;
alter table quotation_settings add column if not exists business_phone text;

update quotation_settings
   set business_address = 'Al Zakhrafah Hypermarket, Al Wahada Street, Oman Road, Kalba, Sharjah, UAE',
       business_phone   = '+971541939691'
 where id = 1 and business_address is null;
