// Mocked-fetch tests for the Delhivery adapter. No network calls, no real
// credentials. Run with:  node --test adapters/delhivery.test.ts
// (Node 24 strips the TypeScript types natively.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DelhiveryAdapter, buildDelhiveryConfig, normalizeIndianMobile, validateDelhiveryShipment } from './delhivery.ts';
import type { CreateShipmentInput } from './types.ts';

const TOKEN = 'TEST-TOKEN-DO-NOT-LEAK';
const BASE = 'https://staging-express.delhivery.com';

const validInput: CreateShipmentInput = {
  orderId: 'o1',
  orderNumber: '#1001',
  receiverName: 'Test Customer',
  receiverAddress: '12 Test Street',
  receiverCity: 'Kochi',
  receiverCountry: 'India',
  receiverPhone: '+919876543210',
  receiverPostalCode: '682001',
  receiverState: 'Kerala',
  invoiceValue: 1500,
  pieces: 1,
  itemDescription: '1x Abaya',
};

type Call = { url: string; init: RequestInit };

function mockFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function adapter() {
  return new DelhiveryAdapter({ token: TOKEN, baseUrl: BASE, pickupLocation: 'Staging Warehouse' });
}

test('validation rejects a bad pincode before any request', async () => {
  const m = mockFetch(() => json({}));
  try {
    await assert.rejects(adapter().createShipment({ ...validInput, receiverPostalCode: '6820' }), /6-digit pincode/);
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test('validation rejects COD and missing warehouse name', () => {
  assert.match(validateDelhiveryShipment({ ...validInput, codAmount: 100 }, 'WH') ?? '', /prepaid only/);
  assert.match(validateDelhiveryShipment(validInput, '   ') ?? '', /warehouse name is not set/);
  assert.equal(validateDelhiveryShipment(validInput, 'WH'), null);
});

test('createShipment sends form-encoded body with the Token header', async () => {
  const m = mockFetch(() => json({ success: true, packages: [{ waybill: '1234567890', status: 'Manifested' }] }));
  try {
    const result = await adapter().createShipment(validInput);
    assert.equal(result.trackingNumber, '1234567890');
    assert.equal(result.rawStatus, 'Manifested');

    const { url, init } = m.calls[0];
    assert.equal(url, `${BASE}/api/cmu/create.json`);
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal((init.headers as Record<string, string>).Authorization, `Token ${TOKEN}`);
    assert.ok(String(init.body).startsWith('format=json&data='));
    const payload = JSON.parse(decodeURIComponent(String(init.body).slice('format=json&data='.length)));
    assert.equal(payload.shipments[0].payment_mode, 'Prepaid');
    assert.equal(payload.shipments[0].pin, '682001');
    assert.equal(payload.pickup_location.name, 'Staging Warehouse');
  } finally {
    m.restore();
  }
});

test('courier rejection error shows remarks but never the token', async () => {
  const m = mockFetch(() => json({ success: false, packages: [{ remarks: ['Invalid pin'] }] }));
  try {
    const err = await adapter().createShipment(validInput).catch((e: Error) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /Invalid pin/);
    assert.ok(!err.message.includes(TOKEN));
  } finally {
    m.restore();
  }
});

test('HTTP 401 is reported by status only', async () => {
  const m = mockFetch(() => new Response('denied', { status: 401 }));
  try {
    const err = await adapter().createShipment(validInput).catch((e: Error) => e);
    assert.match((err as Error).message, /HTTP 401/);
    assert.ok(!(err as Error).message.includes(TOKEN));
  } finally {
    m.restore();
  }
});

test('non-JSON success body gives a clear error', async () => {
  const m = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
  try {
    await assert.rejects(adapter().createShipment(validInput), /non-JSON response/);
  } finally {
    m.restore();
  }
});

test('trackShipment maps statuses to the simplified set', async () => {
  const cases: Array<[string, string, string]> = [
    ['Delivered', 'Delivered', 'delivered'],
    ['RTO', 'Returned to origin', 'failed_rto'],
    ['UD', 'Out for Delivery', 'out_for_delivery'],
    ['UD', 'In Transit', 'in_transit'],
  ];
  for (const [statusType, status, expected] of cases) {
    const m = mockFetch(() =>
      json({ ShipmentData: [{ Shipment: { ReferenceNo: 'REF', Status: { StatusType: statusType, Status: status } } }] }),
    );
    try {
      const update = await adapter().trackShipment('1234567890');
      assert.equal(update.simplifiedStatus, expected, `${statusType}/${status}`);
    } finally {
      m.restore();
    }
  }
});

test('testConnection: 401 fails without leaking the token', async () => {
  const m = mockFetch(() => new Response('', { status: 401 }));
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, false);
    assert.match(result.detail, /Token rejected/);
    assert.ok(!result.detail.includes(TOKEN));
  } finally {
    m.restore();
  }
});

test('serviceability: an empty list means NSZ and the pincode is refused', async () => {
  const m = mockFetch(() => json({ delivery_codes: [] }));
  try {
    const result = await adapter().checkServiceability!('679585');
    assert.equal(result.serviceable, false);
    assert.match(result.detail, /NSZ/);
    assert.match(m.calls[0].url, /\/c\/api\/pin-codes\/json\/\?filter_codes=679585$/);
  } finally {
    m.restore();
  }
});

test('serviceability: a prepaid-enabled pincode is accepted', async () => {
  const m = mockFetch(() => json({ delivery_codes: [{ postal_code: { pin: 680005, pre_paid: 'Y', cod: 'Y', remarks: '' } }] }));
  try {
    const result = await adapter().checkServiceability!('680005');
    assert.equal(result.serviceable, true);
  } finally {
    m.restore();
  }
});

test('serviceability: an embargoed pincode is refused even when listed', async () => {
  const m = mockFetch(() => json({ delivery_codes: [{ postal_code: { pin: 680005, pre_paid: 'Y', remarks: 'Embargo' } }] }));
  try {
    const result = await adapter().checkServiceability!('680005');
    assert.equal(result.serviceable, false);
    assert.match(result.detail, /embargo/);
  } finally {
    m.restore();
  }
});

test('serviceability: a pincode without prepaid is refused', async () => {
  const m = mockFetch(() => json({ delivery_codes: [{ postal_code: { pin: 680005, pre_paid: 'N', remarks: '' } }] }));
  try {
    const result = await adapter().checkServiceability!('680005');
    assert.equal(result.serviceable, false);
    assert.match(result.detail, /prepaid/);
  } finally {
    m.restore();
  }
});

test('serviceability: an HTTP error throws rather than approving the pincode', async () => {
  const m = mockFetch(() => new Response('', { status: 503 }));
  try {
    await assert.rejects(adapter().checkServiceability!('680005'), /HTTP 503/);
  } finally {
    m.restore();
  }
});

test('tracking: a cancelled manifested waybill maps to cancelled, not pending', async () => {
  const m = mockFetch(() =>
    json({ ShipmentData: [{ Shipment: { Status: { Status: 'Manifested', StatusType: 'UD', Instructions: 'Seller cancelled the order' } } }] }),
  );
  try {
    const result = await adapter().trackShipment('86589610000011');
    assert.equal(result.simplifiedStatus, 'cancelled');
  } finally {
    m.restore();
  }
});

test('tracking: a parcel on its way back (RT) stays open as in_transit', async () => {
  const m = mockFetch(() =>
    json({ ShipmentData: [{ Shipment: { Status: { Status: 'In Transit', StatusType: 'RT', Instructions: 'Seller cancelled the order' } } }] }),
  );
  try {
    const result = await adapter().trackShipment('86589610000011');
    assert.equal(result.simplifiedStatus, 'in_transit');
  } finally {
    m.restore();
  }
});

test('tracking: the final returned-to-origin status (DL RTO) closes as failed_rto', async () => {
  const m = mockFetch(() =>
    json({ ShipmentData: [{ Shipment: { Status: { Status: 'RTO', StatusType: 'DL', Instructions: 'Returned to origin' } } }] }),
  );
  try {
    const result = await adapter().trackShipment('86589610000011');
    assert.equal(result.simplifiedStatus, 'failed_rto');
  } finally {
    m.restore();
  }
});

test('cost estimate: sends surface prepaid parameters and returns the total', async () => {
  const m = mockFetch(() => json([{ status: 'Delivered', charged_weight: 500, total_amount: 42.74 }]));
  try {
    const result = await adapter().estimateCost!({ originPincode: '679585', destinationPincode: '680005', weightKg: 0.5 });
    assert.deepEqual(result, { totalAmount: 42.74, currency: 'INR' });
    const url = new URL(m.calls[0].url);
    assert.equal(url.pathname, '/api/kinko/v1/invoice/charges/.json');
    assert.equal(url.searchParams.get('md'), 'S');
    assert.equal(url.searchParams.get('o_pin'), '679585');
    assert.equal(url.searchParams.get('d_pin'), '680005');
    assert.equal(url.searchParams.get('cgm'), '500');
    assert.equal(url.searchParams.get('pt'), 'Pre-paid');
  } finally {
    m.restore();
  }
});

test('express: the booking payload and the estimate both use Express', async () => {
  const m = mockFetch((call) =>
    call.url.includes('/api/cmu/create.json')
      ? json({ success: true, packages: [{ waybill: '1234567890', status: 'Manifested' }] })
      : json([{ total_amount: 45.1 }]),
  );
  try {
    await adapter().createShipment({ ...validInput, shippingMode: 'Express' });
    const sent = new URLSearchParams(String(m.calls[0].init.body)).get('data');
    assert.equal(JSON.parse(sent!).shipments[0].shipping_mode, 'Express');

    const estimate = await adapter().estimateCost!({ originPincode: '679585', destinationPincode: '680005', weightKg: 0.5, shippingMode: 'Express' });
    assert.equal(estimate.totalAmount, 45.1);
    assert.equal(new URL(m.calls[1].url).searchParams.get('md'), 'E');
  } finally {
    m.restore();
  }
});

test('cost estimate: a response without an amount is an error, not a zero charge', async () => {
  const m = mockFetch(() => json({ error: 'Unable to process request for provided o_pin' }));
  try {
    await assert.rejects(
      adapter().estimateCost!({ originPincode: '679585', destinationPincode: '680005', weightKg: 0.5 }),
      /returned no amount/,
    );
  } finally {
    m.restore();
  }
});

test('cancel: sends the cancellation flag for the waybill and reports success', async () => {
  const m = mockFetch(() => json({ status: true, waybill: '86589610000011', order_id: '#1014', remark: 'Shipment has been cancelled.' }));
  try {
    const result = await adapter().cancelShipment!('86589610000011');
    assert.equal(result.detail, 'Shipment has been cancelled.');
    assert.equal(m.calls[0].url, `${BASE}/api/p/edit`);
    assert.equal(m.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(m.calls[0].init.body)), { waybill: '86589610000011', cancellation: 'true' });
  } finally {
    m.restore();
  }
});

test('cancel: Delhivery refusing the cancel is an error with its reason', async () => {
  const m = mockFetch(() => json({ status: false, remark: 'Shipment is already dispatched.' }));
  try {
    await assert.rejects(adapter().cancelShipment!('86589610000011'), /already dispatched/);
  } finally {
    m.restore();
  }
});

test('cancel: an HTTP error is an error, not a silent success', async () => {
  const m = mockFetch(() => new Response('', { status: 500 }));
  try {
    await assert.rejects(adapter().cancelShipment!('86589610000011'), /HTTP 500/);
  } finally {
    m.restore();
  }
});

test('buildDelhiveryConfig uses the documented default host and requires a warehouse', () => {
  const config = buildDelhiveryConfig({ apiToken: TOKEN, baseUrl: null, pickupLocation: 'WH' }, 'staging');
  assert.equal(config.baseUrl, 'https://staging-express.delhivery.com');
  assert.throws(
    () => buildDelhiveryConfig({ apiToken: TOKEN, baseUrl: null, pickupLocation: null }, 'production'),
    /warehouse name is not set/,
  );
});

test('testConnection: valid empty tracking result is success', async () => {
  const m = mockFetch(() => json({ ShipmentData: [] }));
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, true);
    assert.match(result.detail, /no shipment for the test waybill/);
    assert.ok(!result.detail.includes(TOKEN));
  } finally {
    m.restore();
  }
});

test('testConnection: 5xx is reported as a server error', async () => {
  const m = mockFetch(() => new Response('', { status: 503 }));
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, false);
    assert.match(result.detail, /server error \(HTTP 503\)/);
  } finally {
    m.restore();
  }
});

test('testConnection: other non-2xx is reported as unexpected', async () => {
  const m = mockFetch(() => new Response('', { status: 404 }));
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, false);
    assert.match(result.detail, /Unexpected response .*HTTP 404/);
  } finally {
    m.restore();
  }
});

test('testConnection: non-JSON or wrong-shape 200 is unexpected, not success', async () => {
  const bodies = [new Response('<html>maintenance</html>', { status: 200 }), json({ message: 'hello' })];
  for (const response of bodies) {
    const m = mockFetch(() => response.clone());
    try {
      const result = await adapter().testConnection();
      assert.equal(result.ok, false);
      assert.match(result.detail, /response format was not recognised/);
    } finally {
      m.restore();
    }
  }
});

test('buildDelhiveryConfig never falls back to another environment warehouse', () => {
  // Staging with no staging warehouse must fail, even if production has one.
  assert.throws(
    () => buildDelhiveryConfig({ apiToken: TOKEN, baseUrl: null, pickupLocation: null }, 'staging'),
    /Delhivery staging: registered warehouse name is not set/,
  );
});

test('normalizeIndianMobile accepts only the supported Indian formats', () => {
  const accepted = ['9876543210', '09876543210', '919876543210', '+919876543210', '+91 98765-43210', '(+91) 98765 43210'];
  for (const raw of accepted) assert.equal(normalizeIndianMobile(raw), '9876543210', raw);
  const rejected = ['+14155550123', '98765432100', '+9198765432101', '5876543210', '12345', '', '+91 5876543210'];
  for (const raw of rejected) assert.equal(normalizeIndianMobile(raw), null, raw);
});

test('payload carries the normalised 10-digit mobile', async () => {
  const m = mockFetch(() => json({ success: true, packages: [{ waybill: '1234567890', status: 'Manifested' }] }));
  try {
    await adapter().createShipment({ ...validInput, receiverPhone: '+91 98765-43210' });
    const body = String(m.calls[0].init.body);
    const payload = JSON.parse(decodeURIComponent(body.slice('format=json&data='.length)));
    assert.equal(payload.shipments[0].phone, '9876543210');
  } finally {
    m.restore();
  }
});

test('invoiceValue must be finite and greater than zero', () => {
  for (const bad of [NaN, Infinity, 0, -5, undefined]) {
    assert.match(
      validateDelhiveryShipment({ ...validInput, invoiceValue: bad as number }, 'WH') ?? '',
      /finite order value/,
      String(bad),
    );
  }
  assert.equal(validateDelhiveryShipment({ ...validInput, invoiceValue: 0.5 }, 'WH'), null);
});

test('connection: valid tracking data is success', async () => {
  const m = mockFetch(() =>
    json({ ShipmentData: [{ Shipment: { ReferenceNo: 'R', Status: { StatusType: 'UD', Status: 'In Transit' } } }] }),
  );
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, true);
    assert.match(result.detail, /lookup returned data/);
  } finally {
    m.restore();
  }
});

test('connection: network failure is reported without the token', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'Could not reach staging-express.delhivery.com.');
    assert.ok(!result.detail.includes(TOKEN));
  } finally {
    globalThis.fetch = original;
  }
});

test('connection: "data does not exist" reply on staging counts as token accepted', async () => {
  const m = mockFetch(() =>
    json({
      Success: false,
      Error: 'Data does not exists for provided Waybill(s)',
      rmk: 'Some error has occurred. Please contact client.support@delhivery.com with error message- Data does not exists for provided Waybill(s)',
    }),
  );
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, true);
    assert.match(result.detail, /Token accepted/);
    assert.ok(!result.detail.includes(TOKEN));
  } finally {
    m.restore();
  }
});

test('connection: other Success:false replies are still unexpected', async () => {
  const m = mockFetch(() => json({ Success: false, Error: 'Some other problem' }));
  try {
    const result = await adapter().testConnection();
    assert.equal(result.ok, false);
    assert.match(result.detail, /response format was not recognised/);
  } finally {
    m.restore();
  }
});

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% test label\n');

function labelFetch(linkBody: string | null, pdfResponse: () => Response) {
  return mockFetch((call) => {
    if (call.url.includes('/api/p/packing_slip')) {
      return json({ packages: [{ pdf_download_link: linkBody ?? undefined }] });
    }
    return pdfResponse();
  });
}

test('label: JSON link is followed without the API token and returns a PDF', async () => {
  const link = 'https://signed.example.amazonaws.com/label.pdf?X-Amz-Signature=abc';
  const m = labelFetch(link, () => new Response(PDF_BYTES, { status: 200 }));
  try {
    const label = await adapter().generatePostageLabel('1234567890');
    assert.equal(label.contentType, 'application/pdf');
    assert.equal(Buffer.from(label.base64Data, 'base64').subarray(0, 4).toString(), '%PDF');
    const linkCall = m.calls.find((c) => c.url === link);
    assert.ok(linkCall, 'signed link was fetched');
    assert.equal((linkCall!.init?.headers as Record<string, string> | undefined)?.Authorization, undefined);
  } finally {
    m.restore();
  }
});

test('label: a direct PDF response is accepted', async () => {
  const m = mockFetch(() => new Response(PDF_BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
  try {
    const label = await adapter().generatePostageLabel('1234567890');
    assert.equal(Buffer.from(label.base64Data, 'base64').subarray(0, 4).toString(), '%PDF');
  } finally {
    m.restore();
  }
});

test('label: missing link is refused', async () => {
  const m = labelFetch(null, () => new Response(PDF_BYTES, { status: 200 }));
  try {
    await assert.rejects(adapter().generatePostageLabel('1234567890'), /did not include a PDF link/);
  } finally {
    m.restore();
  }
});

test('label: a link that does not return a PDF is refused, not saved as one', async () => {
  const link = 'https://signed.example.amazonaws.com/label.pdf?X-Amz-Signature=abc';
  const m = labelFetch(link, () => new Response('{"error":"expired"}', { status: 200 }));
  try {
    await assert.rejects(adapter().generatePostageLabel('1234567890'), /not a valid PDF/);
  } finally {
    m.restore();
  }
});
