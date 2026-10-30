// Shared contract every courier adapter implements. The order/shipment code
// only ever talks to this interface — it never checks "if courier === 'nextdrop'"
// anywhere outside the adapters themselves. Adding a new courier later means
// writing one new file that implements this interface, nothing else changes.

export type SimplifiedStatus =
  | 'pending'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed_rto'
  | 'cancelled';

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
  receiverPostalCode?: string;   // required by Delhivery (6-digit Indian pincode)
  receiverState?: string;        // Delhivery
  invoiceValue?: number;         // goods value, Delhivery total_amount

  // Set when the shipment_legs.pickup_location_id chosen for this leg isn't
  // the pickup_locations row with is_default = true. NextDrop uses these
  // (/Order/thirdparty_order) to ship from an alternate address; adapters
  // that don't support it ignore this field.
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
  // "Test connection" button. Must never create or modify anything real.
  // Optional: callers say so plainly if an adapter doesn't provide one.
  testConnection?(): Promise<{ ok: boolean; detail: string }>;

  // Checks that the courier delivers to a destination pincode, before any
  // shipment is created. Couriers without a check skip this step.
  checkServiceability?(pincode: string): Promise<{ serviceable: boolean; detail: string }>;

  // Cancels a booked shipment at the courier (only allowed before pickup).
  cancelShipment?(trackingNumber: string): Promise<{ detail: string }>;

  // Estimated shipping charge for a prepaid parcel. Approximate; the courier
  // may change its rates, so it is only shown to staff before booking.
  estimateCost?(input: {
    originPincode: string;
    destinationPincode: string;
    weightKg: number;
  }): Promise<{ totalAmount: number; currency: 'INR' }>;

  // Not every courier exposes a pull-based tracking endpoint (NextDrop relies
  // on webhook push instead) — adapters that don't support this should throw
  // a clear 'NotSupported' error rather than silently returning nothing.
  trackShipment?(trackingNumber: string): Promise<WebhookStatusUpdate>;

  generatePostageLabel?(trackingNumber: string): Promise<PostageLabelResult>;

  // Parses a courier's raw webhook payload into our normalized shape.
  // Only implemented by couriers that actually push webhooks.
  parseWebhookPayload?(rawBody: unknown): WebhookStatusUpdate[];
}
