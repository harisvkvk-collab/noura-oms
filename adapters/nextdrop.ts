// NextDrop courier adapter — built against "Next Drop API Documentation v1.0".
//
// Notes from the docs worth remembering when touching this file:
// - No real sandbox exists; both "production" and "staging" URLs in their docs
//   are the same host (https://app.nextdrop.ae/). Test carefully — there is no
//   safe environment separate from live bookings until NextDrop support
//   confirms otherwise.
// - Rate limit is 30 requests/minute per API key. Keep write volume low and
//   avoid tight retry loops.
// - COD is passed directly on shipment creation (cod_amount) — no separate
//   COD endpoint. There is NO documented COD settlement/reconciliation API;
//   their "COD Reports" sidebar section implies that stays dashboard-only,
//   same as Delhivery. courier_cod_receivables / courier_settlements in our
//   schema stay manually entered for NextDrop until confirmed otherwise.
// - The docs mix a "Product Code" (CN/ME/CB) with numeric "Service Type" codes
//   (101/104/105 domestic, 102/103 international) in a way that isn't fully
//   clear from the sample payload alone (package_code: "101" + service_code:
//   "CN" together). DEFAULT_PACKAGE_CODE / DEFAULT_SERVICE_CODE below are our
//   best reading — confirm with NextDrop support before relying on this in
//   production, and adjust the constants rather than hunting through the code.

import type {
  DeliveryAdapter,
  CreateShipmentInput,
  CreateShipmentResult,
  PostageLabelResult,
  WebhookStatusUpdate,
  SimplifiedStatus,
} from './types.ts';

const BASE_URL = 'https://app.nextdrop.ae'; // same for "production" and "staging" per their docs

// Best-effort defaults for a standard UAE domestic e-commerce delivery.
// CN = Domestic product code; 101 = E-commerce Delivery service type.
// Confirm this pairing with NextDrop support — see note above.
const DEFAULT_SERVICE_CODE = 'CN';
const DEFAULT_PACKAGE_CODE = '101';

interface NextDropConfig {
  apiKey: string;
  customerBranch: string; // the branch name registered with NextDrop, e.g. "Dubai"
}

// Builds a NextDropConfig from the generic shape getCourierCredentials()
// returns (functions/_shared/getCourierCredentials.ts) — keeps this file
// free of any Supabase/Deno import so it stays usable outside Edge
// Functions too. customer_branch lives in extra_config since it isn't a
// column on courier_api_credentials (that table's shared across couriers
// with very different config needs — see schema.sql).
export function buildNextDropConfig(cred: {
  apiToken: string;
  extraConfig: Record<string, unknown>;
}): NextDropConfig {
  return {
    apiKey: cred.apiToken,
    customerBranch: typeof cred.extraConfig.customer_branch === 'string' ? cred.extraConfig.customer_branch : '',
  };
}

// NextDrop's sample payloads uniformly show phone numbers as "+971
// 566541210" — country code, a literal space, then the local number with
// no leading 0. Our stored customer/pickup phone numbers are plain local
// UAE mobile format ("0551065747") since that's what staff actually type —
// normalize here rather than forcing a specific input format on every
// phone field in the app. Keeping the space to match their sample exactly
// in case their validation is a strict regex rather than a lenient digit
// check.
function formatUaePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  let local = digits;
  if (local.startsWith('+971')) local = local.slice(4);
  else if (local.startsWith('971')) local = local.slice(3);
  else if (local.startsWith('0')) local = local.slice(1);
  return `+971 ${local}`;
}

// customer_branch and to_city/from_city must match NextDrop's fixed
// "Domestic Cities" list (Dubai, Sharjah, Abu Dhabi, ...), which their docs
// show in Title Case — our stored city values are whatever casing staff
// typed (often lowercase). Normalizing here avoids a silent rejection over
// something as trivial as "sharjah" vs "Sharjah".
// customer_addresses.full_address is a free-text textarea (frontend/src/
// Customers.tsx) — staff routinely enter it as multiple lines (building,
// street, landmark). Every NextDrop sample payload shows to_address as a
// single comma-separated line ("Mozna Building, POBox 235371"); sending
// raw embedded newlines inside a JSON string is valid JSON, but there's no
// guarantee their backend's own parsing is newline-safe, and this is the
// one mandatory field we send that's meaningfully different in shape from
// every documented example. Collapse to a single line as cheap insurance.
function flattenAddress(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');
}

function titleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// Maps NextDrop's free-text courier_status strings to our internal 5-value
// status. Their docs only show two example values ("AWB Created", "Out For
// Delivery") — extend this map as real statuses are observed in testing/
// production rather than guessing further ones now.
function mapNextDropStatus(rawStatus: string): SimplifiedStatus {
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized.includes('delivered')) return 'delivered';
  if (normalized.includes('out for delivery')) return 'out_for_delivery';
  if (normalized.includes('rto') || normalized.includes('return')) return 'failed_rto';
  if (normalized.includes('awb created') || normalized.includes('submitted')) return 'pending';
  return 'in_transit'; // safe default for any in-between status we haven't seen yet
}

export class NextDropAdapter implements DeliveryAdapter {
  courierName = 'NextDrop';
  private config: NextDropConfig;

  constructor(config: NextDropConfig) {
    this.config = config;
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      APIKEY: this.config.apiKey,
    };
  }

  /**
   * Creates a booking. Uses /Order/customer_order — the simplest of
   * NextDrop's three booking endpoints — when shipping from the branch
   * registered on this account (the default pickup_locations row). When
   * input.shipFrom is set (staff picked a non-default pickup location in
   * NewOrder.tsx), switches to /Order/thirdparty_order instead, which
   * needs the actual pickup address/contact spelled out per-booking rather
   * than relying on the account's on-file branch.
   */
  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    // Use pickup location's city as the customer_branch if shipping from a non-default location,
    // otherwise use the configured branch. This allows shipping from different NextDrop branches
    // depending on which warehouse the order is being fulfilled from.
    const customerBranch = input.shipFrom
      ? titleCase(input.shipFrom.city)
      : titleCase(this.config.customerBranch);

    const commonFields = {
      customer_branch: customerBranch,
      to_customer: input.receiverName,
      to_address: flattenAddress(input.receiverAddress),
      to_city: titleCase(input.receiverCity),
      to_location: input.receiverArea ?? input.receiverCity,
      to_country: input.receiverCountry,
      to_cperson: input.receiverName,
      to_contactno: formatUaePhone(input.receiverPhone),
      to_mobileno: formatUaePhone(input.receiverPhone),
      reference_number: input.orderNumber, // echoed back on webhook updates, ties status to our order
      weight: String(input.weightKg ?? 0.5),
      pieces: String(input.pieces ?? 1),
      package_code: DEFAULT_PACKAGE_CODE,
      service_code: DEFAULT_SERVICE_CODE,
      currency_code: input.currencyCode ?? 'AED',
      // Documented as Optional and omitted for non-COD orders in every
      // attempt so far (all failing identically with "Incomplete request
      // parameters" regardless of what else changed) — but NextDrop's own
      // sample payload always includes cod_amount and the customs_declared_*
      // pair, COD or not. Their docs and their actual validation don't have
      // to agree; sending these unconditionally, matching their sample
      // exactly, is the one thing every failed attempt has had in common
      // that we haven't yet tried changing.
      cod_amount: input.codAmount ? input.codAmount.toFixed(2) : '0.00',
      item_description: input.itemDescription ?? '',
      special_instruction: input.specialInstruction ?? '',
      customs_declared_currency_code: input.currencyCode ?? 'AED',
      customs_declared_value: 0,
    };

    const endpoint = input.shipFrom ? '/Order/thirdparty_order' : '/Order/customer_order';
    const payload = input.shipFrom
      ? {
          ...commonFields,
          from_customer: input.shipFrom.contactName,
          from_address: flattenAddress(input.shipFrom.address),
          from_city: titleCase(input.shipFrom.city),
          from_location: input.shipFrom.area ?? input.shipFrom.city,
          from_country: input.shipFrom.country,
          from_cperson: input.shipFrom.contactName,
          from_contactno: formatUaePhone(input.shipFrom.contactPhone),
          from_mobileno: formatUaePhone(input.shipFrom.contactPhone),
        }
      : commonFields;

    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      // The body is where NextDrop actually explains a 4xx (which field it
      // didn't like, why) — discarding it left every failure looking like
      // a bare "HTTP 422" with no way to tell what was actually wrong.
      // "Incomplete request parameters" has stayed byte-for-byte identical
      // across several genuinely different payloads (address format, phone
      // format, city/branch casing) — including the actual outgoing
      // payload here (no secrets in it; the API key lives in headers, not
      // here) so the next failure is diagnosable from the error text alone
      // instead of guessing at another possible mismatch blind.
      const body = await res.text().catch(() => '');
      throw new Error(
        `NextDrop createShipment failed: HTTP ${res.status}${body ? ` — ${body}` : ''} — payload sent: ${JSON.stringify(payload)}`,
      );
    }

    const json = await res.json();
    if (json.status !== 1) {
      throw new Error(`NextDrop createShipment error: ${json.message ?? 'unknown error'}`);
    }

    return {
      trackingNumber: json.data.awb_number,
      rawStatus: json.data.current_status,
      rawResponse: json,
    };
  }

  /**
   * Generates the shippable label PDF for a booking. Call this at the
   * "Print postage" step of the fulfillment timeline. Returns base64 PDF
   * data — the caller decides whether to render it inline, save it, or
   * send straight to a printer.
   */
  async generatePostageLabel(trackingNumber: string): Promise<PostageLabelResult> {
    const res = await fetch(`${BASE_URL}/Order/generate_label`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ awb_number: trackingNumber }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`NextDrop generatePostageLabel failed: HTTP ${res.status}${body ? ` — ${body}` : ''}`);
    }

    const json = await res.json();
    if (json.status !== 1) {
      throw new Error('NextDrop generatePostageLabel returned an error status');
    }

    // Their own docs show "data" as the bare base64 string, sibling to a
    // top-level "metadata" object with name/content-type. The real API
    // nests it instead: "data":{"base64":"...", possibly name/content-type
    // alongside it too} — verified directly against a live response.
    // Handling both shapes rather than trusting the docs a second time.
    const rawData: unknown =
      typeof json.data === 'string' ? json.data : typeof json.data?.base64 === 'string' ? json.data.base64 : null;
    if (!rawData) {
      throw new Error(
        `NextDrop generatePostageLabel returned no label data (raw response: ${JSON.stringify(json).slice(0, 300)})`,
      );
    }

    // Guard against a data: URI prefix (some backends send
    // "data:application/pdf;base64,JVBERi0..." instead of bare base64) —
    // atob() can't handle that prefix and fails with an unhelpful
    // "not correctly encoded" error that gives no clue why.
    const base64Data = rawData.includes(',') ? rawData.slice(rawData.indexOf(',') + 1) : rawData;

    return {
      fileName: json.metadata?.name ?? json.data?.name ?? `${trackingNumber}.pdf`,
      contentType: json.metadata?.['content-type'] ?? json.data?.['content-type'] ?? 'application/pdf',
      base64Data,
    };
  }

  // NextDrop has no dedicated auth-check/ping endpoint in their docs, so
  // this reuses generate_label with a nonsense awb_number — that endpoint
  // only ever *reads* an existing booking's label, it can't create or
  // modify anything, so a bogus AWB is safe to send. A 401/403 means the
  // key itself was rejected; anything else (including a "not found" for
  // our fake AWB) means NextDrop authenticated the request and got as far
  // as looking for it, which is as much "the key works" as we can confirm
  // without a real booking to test against.
  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${BASE_URL}/Order/generate_label`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ awb_number: '__NOURA_OMS_CONNECTION_TEST__' }),
      });
      const bodyText = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `Unauthorized (HTTP ${res.status}) — API key looks invalid or missing.` };
      }
      return { ok: true, detail: `NextDrop responded (HTTP ${res.status}): ${bodyText.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Network error reaching NextDrop.' };
    }
  }

  // NextDrop has no documented pull-based tracking endpoint — status only
  // arrives via webhook push. Intentionally not implementing trackShipment()
  // here; callers should rely on parseWebhookPayload() + stored shipment_leg
  // status instead of polling.

  /**
   * Parses NextDrop's webhook payload (an array of status update objects)
   * into our normalized shape. Call this from the webhook receiver endpoint.
   */
  parseWebhookPayload(rawBody: unknown): WebhookStatusUpdate[] {
    const events = Array.isArray(rawBody) ? rawBody : [rawBody];
    return events.map((event: any) => ({
      trackingNumber: event.booking_number,
      referenceNumber: event.reference_number,
      simplifiedStatus: mapNextDropStatus(event.courier_status ?? ''),
      rawStatus: event.courier_status ?? '',
      statusDetails: event.status_details,
      statusDatetime: event.status_datetime,
      location: event.location,
    }));
  }
}
