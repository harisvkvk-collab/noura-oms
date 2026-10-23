// Delhivery B2C courier adapter (India last-mile leg).
//
// Built from the B2C developer-portal review, NOT yet run against a real
// token. Items marked VERIFY were not in that review and must be checked
// against the staging environment before going live.
//
// Key facts from the docs:
// - Auth: static header  Authorization: Token <token>  (no OAuth, no expiry).
//   Staging and production use DIFFERENT tokens; mixing them is a common error.
// - Hosts: staging-express.delhivery.com (staging), track.delhivery.com (prod).
//   Their pages disagree on the staging hostname (one also shows
//   express-dev-test.delhivery.com), so the base URL comes from
//   courier_api_credentials.base_url rather than being hardcoded.
// - Create shipment: POST /api/cmu/create.json with a FORM-ENCODED body:
//       format=json&data=<url-encoded JSON string>
//   Forgetting the "format=json&data=" wrapper is the #1 integration error.
//   Do not "fix" this into a plain JSON body.
// - pickup_location must exactly match a warehouse name registered with
//   Delhivery. Stored in courier_api_credentials.pickup_location.
// - A prepaid wallet balance (minimum around Rs 500) must be maintained or
//   shipment creation fails. Not explained in their docs; ask the Delhivery
//   contact how it works for this account.
// - COD: NOT used for India. Customers pay by UPI before dispatch, so every
//   shipment is created with payment_mode "Prepaid". The codAmount branch
//   exists only so the adapter stays generic.
// - No COD remittance/settlement API exists. Not relevant while India is
//   prepaid-only.
// - Tracking is pull-based (GET). Webhooks exist but need a manual
//   "Webhook Requirement Document" emailed to Delhivery, so for now status is
//   obtained by calling trackShipment().

import type {
  DeliveryAdapter,
  CreateShipmentInput,
  CreateShipmentResult,
  PostageLabelResult,
  WebhookStatusUpdate,
  SimplifiedStatus,
} from './types.ts';

interface DelhiveryConfig {
  token: string;            // from courier_api_credentials (staging OR production, never both)
  baseUrl: string;          // e.g. https://staging-express.delhivery.com or https://track.delhivery.com
  pickupLocation: string;   // registered warehouse name, exact match required
}

// Delhivery's own docs recommend NOT exposing their granular NSL sub-codes,
// and building a simplified mapping instead. The raw status is still stored
// in shipment_legs.provider_status_raw for support calls.
function mapDelhiveryStatus(statusType: string, status: string): SimplifiedStatus {
  const s = `${statusType} ${status}`.trim().toLowerCase();
  if (s.includes('delivered') && !s.includes('rto')) return 'delivered';
  if (s.includes('rto') || s.includes('dto') || s.includes('return')) return 'failed_rto';
  if (s.includes('dispatched') || s.includes('out for delivery')) return 'out_for_delivery';
  if (s.includes('manifested') || s.includes('not picked')) return 'pending';
  return 'in_transit'; // In Transit, Pending, and any unseen status
}

export const DELHIVERY_DEFAULT_BASE_URLS = {
  staging: 'https://staging-express.delhivery.com',
  production: 'https://track.delhivery.com',
} as const;

// Builds the adapter config from a courier_api_credentials row (see
// functions/_shared/getCourierCredentials.ts). Base URL falls back to the
// documented host for the environment when the row has none saved.
export function buildDelhiveryConfig(
  credentials: { apiToken: string; baseUrl: string | null; pickupLocation: string | null },
  environment: 'staging' | 'production',
): DelhiveryConfig {
  if (!credentials.pickupLocation) {
    throw new Error(`Delhivery ${environment}: registered warehouse name is not set in Settings.`);
  }
  return {
    token: credentials.apiToken,
    baseUrl: credentials.baseUrl || DELHIVERY_DEFAULT_BASE_URLS[environment],
    pickupLocation: credentials.pickupLocation,
  };
}

// Accepts one Indian mobile in these forms only: 10 digits, 0+10, 91+10 or
// +91+10 (spaces, dashes and brackets are ignored). The mobile must start
// with 6-9. Anything else returns null, including extra digits, other
// country codes, and short numbers. Never guesses by taking the last digits.
export function normalizeIndianMobile(raw: string): string | null {
  const digits = raw.trim().replace(/[\s\-()]/g, '');
  const match = digits.match(/^(?:\+91|91|0)?([6-9]\d{9})$/);
  return match ? match[1] : null;
}

// Checked locally before any request is sent, so a bad booking never reaches
// Delhivery. Returns the first problem found, phrased for the staff member.
export function validateDelhiveryShipment(input: CreateShipmentInput, pickupLocation: string): string | null {
  if (!pickupLocation.trim()) return 'Delhivery warehouse name is not set for this environment.';
  if (!input.receiverName.trim()) return 'Customer name is required for Delhivery.';
  if (!input.receiverAddress.trim()) return 'Customer address is required for Delhivery.';
  if (!input.receiverCity.trim()) return 'Customer city is required for Delhivery.';
  if (!/^\d{6}$/.test(input.receiverPostalCode ?? '')) return 'Delhivery needs a 6-digit pincode.';
  if (!input.receiverState?.trim()) return 'Delhivery needs the customer state.';
  if (!normalizeIndianMobile(input.receiverPhone ?? '')) {
    return 'Delhivery needs a valid Indian mobile number: 10 digits, optionally with +91 or 0 in front.';
  }
  if (typeof input.invoiceValue !== 'number' || !Number.isFinite(input.invoiceValue) || input.invoiceValue <= 0) {
    return 'Delhivery needs a finite order value greater than zero.';
  }
  if (input.codAmount && input.codAmount > 0) return 'Delhivery bookings are prepaid only (no COD in India).';
  return null;
}

export class DelhiveryAdapter implements DeliveryAdapter {
  courierName = 'Delhivery';
  private config: DelhiveryConfig;

  constructor(config: DelhiveryConfig) {
    this.config = config;
  }

  private authHeader() {
    return { Authorization: `Token ${this.config.token}` };
  }

  // VERIFY on staging: a lookup for a waybill that doesn't exist should
  // return a normal response when the token is accepted, and 401/403 when
  // it isn't. Only the status code is reported back; the token never is.
  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    const url = `${this.config.baseUrl}/api/v1/packages/json/?waybill=0`;
    try {
      const res = await fetch(url, { headers: { ...this.authHeader(), Accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `Token rejected by Delhivery (HTTP ${res.status}). Check the token matches this environment.` };
      }
      if (res.status >= 500) {
        return { ok: false, detail: `Delhivery server error (HTTP ${res.status}). Try again later.` };
      }
      if (!res.ok) {
        return { ok: false, detail: `Unexpected response from Delhivery (HTTP ${res.status}).` };
      }
      // A valid answer is a JSON object with ShipmentData, even when the list
      // is empty (an unknown waybill). Anything else is treated as unexpected.
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== 'object' || !Array.isArray((body as { ShipmentData?: unknown }).ShipmentData)) {
        return { ok: false, detail: 'Delhivery answered, but the response format was not recognised.' };
      }
      const found = (body as { ShipmentData: unknown[] }).ShipmentData.length;
      return {
        ok: true,
        detail: `Token accepted by ${new URL(this.config.baseUrl).host} (${found === 0 ? 'no shipment for the test waybill, as expected' : 'lookup returned data'}).`,
      };
    } catch {
      return { ok: false, detail: `Could not reach ${new URL(this.config.baseUrl).host}.` };
    }
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const problem = validateDelhiveryShipment(input, this.config.pickupLocation);
    if (problem) throw new Error(`Delhivery booking not sent: ${problem}`);

    const isCod = !!input.codAmount && input.codAmount > 0;

    const payload = {
      shipments: [
        {
          name: input.receiverName,
          add: input.receiverAddress,
          pin: input.receiverPostalCode,          // 6-digit Indian pincode, required
          city: input.receiverCity,
          state: input.receiverState ?? '',
          country: input.receiverCountry || 'India',
          phone: normalizeIndianMobile(input.receiverPhone ?? '') ?? '',
          order: input.orderNumber,                // echoed back on tracking
          payment_mode: isCod ? 'COD' : 'Prepaid', // India is prepaid (UPI) in practice
          cod_amount: isCod ? String(input.codAmount) : '0',
          total_amount: String(input.invoiceValue ?? 0),
          products_desc: input.itemDescription ?? '',
          quantity: String(input.pieces ?? 1),
          weight: String((input.weightKg ?? 0.5) * 1000), // Delhivery takes grams
          shipping_mode: 'Surface',
          address_type: 'home',
          // waybill intentionally omitted: Delhivery auto-generates and returns it
        },
      ],
      pickup_location: { name: this.config.pickupLocation },
    };

    // The literal "format=json&data=" wrapper is required; see header note.
    const body = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

    const res = await fetch(`${this.config.baseUrl}/api/cmu/create.json`, {
      method: 'POST',
      headers: {
        ...this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`Delhivery createShipment failed: HTTP ${res.status}`);
    }

    // Body is parsed but never logged or echoed in errors (it can include
    // customer data); only the status code is reported.
    const json = await res.json().catch(() => {
      throw new Error('Delhivery createShipment returned a non-JSON response.');
    });
    // VERIFY on staging: expected shape is { success: true, packages: [{ waybill, status, remarks }] }
    const pkg = json?.packages?.[0];
    if (!json?.success || !pkg?.waybill) {
      const reason = pkg?.remarks?.join?.('; ') ?? json?.rmk ?? 'unknown error';
      throw new Error(`Delhivery createShipment error: ${reason}`);
    }

    return {
      trackingNumber: pkg.waybill,
      rawStatus: pkg.status ?? 'Manifested',
      rawResponse: json,
    };
  }

  /**
   * Pull-based tracking. Up to 50 comma-separated waybills per call.
   * Rate limit is 750 requests / 5 minutes, so batch rather than looping.
   * VERIFY response shape on staging: ShipmentData[].Shipment.Status.
   */
  async trackShipment(trackingNumber: string): Promise<WebhookStatusUpdate> {
    const url = `${this.config.baseUrl}/api/v1/packages/json/?waybill=${encodeURIComponent(trackingNumber)}`;
    const res = await fetch(url, { headers: { ...this.authHeader(), Accept: 'application/json' } });

    if (!res.ok) {
      throw new Error(`Delhivery trackShipment failed: HTTP ${res.status}`);
    }

    const json = await res.json();
    const shipment = json?.ShipmentData?.[0]?.Shipment;
    if (!shipment) {
      throw new Error(`Delhivery trackShipment: no data for waybill ${trackingNumber}`);
    }

    const statusType = shipment.Status?.StatusType ?? '';
    const status = shipment.Status?.Status ?? '';

    return {
      trackingNumber,
      referenceNumber: shipment.ReferenceNo,
      simplifiedStatus: mapDelhiveryStatus(statusType, status),
      rawStatus: `${statusType}/${status}`,
      statusDetails: shipment.Status?.Instructions,
      statusDatetime: shipment.Status?.StatusDateTime ?? new Date().toISOString(),
      location: shipment.Status?.StatusLocation,
    };
  }

  /**
   * Shipping label PDF. VERIFY: this endpoint was not covered in the portal
   * review. Delhivery's packing-slip endpoint is believed to be
   * GET /api/p/packing_slip?wbns=<waybill>&pdf=true, but confirm on the
   * portal's "Download Document" page before relying on it. If it returns
   * JSON rather than a PDF, adjust the decoding below.
   */
  async generatePostageLabel(trackingNumber: string): Promise<PostageLabelResult> {
    const url = `${this.config.baseUrl}/api/p/packing_slip?wbns=${encodeURIComponent(trackingNumber)}&pdf=true`;
    const res = await fetch(url, { headers: this.authHeader() });

    if (!res.ok) {
      throw new Error(`Delhivery generatePostageLabel failed: HTTP ${res.status}`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);

    return {
      fileName: `${trackingNumber}.pdf`,
      contentType: 'application/pdf',
      base64Data: btoa(binary),
    };
  }

  // No parseWebhookPayload(): Delhivery webhooks are not self-serve.
}
