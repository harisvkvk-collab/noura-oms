// Shared contract every courier adapter implements. The order/shipment code
// only ever talks to this interface — it never checks "if courier === 'nextdrop'"
// anywhere outside the adapters themselves. Adding a new courier later means
// writing one new file that implements this interface, nothing else changes.

export type SimplifiedStatus =
  | 'pending'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed_rto';

export interface CreateShipmentInput {
  orderId: string;               // our internal order id, sent as reference_number where supported
  orderNumber: string;           // human-readable order number, e.g. '#1045'
  receiverName: string;
  receiverAddress: string;
  receiverCity: string;
  receiverArea?: string;
  receiverCountry: string;
  receiverPhone: string;
  weightKg?: number;
  pieces?: number;
  itemDescription?: string;
  specialInstruction?: string;
  currencyCode?: string;
  codAmount?: number;            // omit / 0 for non-COD orders

  // Set when the shipment_legs.pickup_location_id chosen for this leg isn't
  // the pickup_locations row with is_default = true — i.e. staff picked a
  // specific alternate address to ship from. Adapters that support
  // shipping from somewhere other than the courier account's registered
  // default location (NextDrop: /Order/thirdparty_order) should use these
  // instead of their usual pickup address; adapters that don't support it
  // should just ignore this field.
  shipFrom?: {
    contactName: string;
    contactPhone: string;
    address: string;
    city: string;
    area?: string;
    country: string;
  };
}

export interface CreateShipmentResult {
  trackingNumber: string;        // AWB / booking number
  rawStatus: string;             // courier's own status string, stored as provider_status_raw
  rawResponse: unknown;          // full response, useful for debugging/support calls
}

export interface PostageLabelResult {
  fileName: string;
  contentType: string;           // usually 'application/pdf'
  base64Data: string;
}

export interface WebhookStatusUpdate {
  trackingNumber: string;
  referenceNumber?: string;      // maps back to our order_id if the courier echoes it
  simplifiedStatus: SimplifiedStatus;
  rawStatus: string;
  statusDetails?: string;
  statusDatetime: string;
  location?: string;
}

export interface DeliveryAdapter {
  courierName: string;

  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;

  // Cheap, side-effect-free credential check for the Settings screen's
  // "Test connection" button — must never create/modify anything real
  // (no bookings). Optional since not every adapter can find a safe
  // endpoint to probe; the caller should say so plainly if it's missing
  // rather than silently doing nothing.
  testConnection?(): Promise<{ ok: boolean; detail: string }>;

  // Not every courier exposes a pull-based tracking endpoint (NextDrop relies
  // on webhook push instead) — adapters that don't support this should throw
  // a clear 'NotSupported' error rather than silently returning nothing.
  trackShipment?(trackingNumber: string): Promise<WebhookStatusUpdate>;

  generatePostageLabel?(trackingNumber: string): Promise<PostageLabelResult>;

  // Parses a courier's raw webhook payload into our normalized shape.
  // Only implemented by couriers that actually push webhooks.
  parseWebhookPayload?(rawBody: unknown): WebhookStatusUpdate[];
}
