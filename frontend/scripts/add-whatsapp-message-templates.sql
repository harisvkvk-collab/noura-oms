-- Add WhatsApp message template columns to company_settings (idempotent)
-- Allows admin staff to customize the WhatsApp messages sent to customers
-- and couriers without code changes.

alter table if exists public.company_settings
  add column if not exists whatsapp_customer_template text,
  add column if not exists whatsapp_courier_template text;

-- Set default templates
update public.company_settings
set whatsapp_customer_template = 'Hi {CUSTOMER_NAME}, thank you for your order {ORDER_NUMBER}!

{ITEMS}
Total: {CURRENCY} {TOTAL} ({PAYMENT_METHOD})

We''ll notify you once it''s packed and on its way.'
where whatsapp_customer_template is null;

update public.company_settings
set whatsapp_courier_template = 'Order: {ORDER_NUMBER}

Pickup: {PICKUP_ADDRESS}

Delivery: {DELIVERY_ADDRESS}

Customer: {CUSTOMER_NAME}
Phone: {CUSTOMER_PHONE}

Payment: {PAYMENT_TYPE}

Items:
{ITEMS}'
where whatsapp_courier_template is null;
