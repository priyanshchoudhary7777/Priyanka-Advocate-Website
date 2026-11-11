'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { after, before, test } = require('node:test');
const { createApp, initializeDatabase, parseTrustProxy } = require('../server');

const credentials = {
  adminUsername: 'test-admin',
  adminPassword: 'a-test-password-long-enough',
};
const authorization =
  `Basic ${Buffer.from(`${credentials.adminUsername}:${credentials.adminPassword}`).toString('base64')}`;
let db;
let server;
let baseUrl;
let uploadDirectory;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'advocate-website-test-'));
  uploadDirectory = path.join(temporaryDirectory, 'uploads');
  db = new Database(':memory:');
  initializeDatabase(db);
  const app = createApp({ db, ...credentials, uploadDirectory, enquiryLimit: 50 });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

const validEnquiry = {
  name: 'Test Visitor',
  phone: '9876543210',
  service: 'GST Registration',
  message: 'Please contact me.',
  consent: true,
  paymentMade: true,
};

function makeEnquiryForm(overrides = {}, includeReceipt = true, image = null) {
  const form = new FormData();
  Object.entries({ ...validEnquiry, ...overrides }).forEach(([key, value]) => {
    form.append(key, String(value));
  });
  if (includeReceipt) {
    const bytes = image || fs.readFileSync(path.join(__dirname, '..', 'assets', 'payment-qr.png'));
    form.append('paymentScreenshot', new Blob([bytes], { type: 'image/png' }), 'payment.png');
  }
  return form;
}

test('stores a valid enquiry and lists it only in the authenticated inbox', async () => {
  const submission = await fetch(`${baseUrl}/api/enquiries`, {
    method: 'POST',
    body: makeEnquiryForm(),
  });
  assert.equal(submission.status, 201);
  assert.equal((await submission.json()).success, true);

  const denied = await fetch(`${baseUrl}/api/admin/enquiries`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /^Basic/);

  const inbox = await fetch(`${baseUrl}/api/admin/enquiries`, {
    headers: { authorization },
  });
  assert.equal(inbox.status, 200);
  const result = await inbox.json();
  assert.equal(result.total, 1);
  assert.equal(result.items[0].name, validEnquiry.name);
  assert.equal(result.items[0].phone, validEnquiry.phone);
  assert.equal(result.items[0].paymentMade, true);
  assert.equal(result.items[0].hasReceipt, true);
  assert.equal(inbox.headers.get('cache-control'), 'no-store');

  const receiptPath = db.prepare('SELECT receipt_filename FROM enquiries WHERE id = ?').get(result.items[0].id);
  assert.equal(fs.existsSync(path.join(uploadDirectory, receiptPath.receipt_filename)), true);
  const privateReceipt = await fetch(`${baseUrl}/api/admin/enquiries/${result.items[0].id}/receipt`);
  assert.equal(privateReceipt.status, 401);
  const authorizedReceipt = await fetch(
    `${baseUrl}/api/admin/enquiries/${result.items[0].id}/receipt`,
    { headers: { authorization } },
  );
  assert.equal(authorizedReceipt.status, 200);
  assert.equal(authorizedReceipt.headers.get('content-type'), 'image/png');
  assert.equal((await authorizedReceipt.arrayBuffer()).byteLength, fs.statSync(path.join(uploadDirectory, receiptPath.receipt_filename)).size);
});

test('serves the website and protects the admin inbox and its assets', async () => {
  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  const page = await homepage.text();
  assert.match(page, /id="f"/);
  assert.match(page, /payment-qr\.png/);
  const qr = await fetch(`${baseUrl}/assets/payment-qr.png`);
  assert.equal(qr.status, 200);

  const denied = await fetch(`${baseUrl}/admin`);
  assert.equal(denied.status, 401);

  const adminPage = await fetch(`${baseUrl}/admin`, { headers: { authorization } });
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.headers.get('cache-control'), /no-store/);

  const adminScript = await fetch(`${baseUrl}/admin.js`, { headers: { authorization } });
  assert.equal(adminScript.status, 200);
  assert.match(await adminScript.text(), /api\/admin\/enquiries/);
});

test('rejects invalid submissions without writing them', async () => {
  const response = await fetch(`${baseUrl}/api/enquiries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validEnquiry, consent: false }),
  });
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count, 1);
});

test('requires a valid payment screenshot no larger than 5 MB', async () => {
  const missingReceipt = await fetch(`${baseUrl}/api/enquiries`, {
    method: 'POST',
    body: makeEnquiryForm({}, false),
  });
  assert.equal(missingReceipt.status, 400);
  assert.match((await missingReceipt.json()).error, /when payment has been made/);

  const invalidReceipt = await fetch(`${baseUrl}/api/enquiries`, {
    method: 'POST',
    body: makeEnquiryForm({}, true, Buffer.from('not an image')),
  });
  assert.equal(invalidReceipt.status, 400);
  assert.match((await invalidReceipt.json()).error, /valid PNG/);

  const oversizedReceipt = await fetch(`${baseUrl}/api/enquiries`, {
    method: 'POST',
    body: makeEnquiryForm({}, true, Buffer.alloc(5 * 1024 * 1024 + 1)),
  });
  assert.equal(oversizedReceipt.status, 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count, 1);
});

test('deletes an enquiry only through the authenticated inbox', async () => {
  const listed = await fetch(`${baseUrl}/api/admin/enquiries`, {
    headers: { authorization },
  });
  const { items } = await listed.json();
  const receiptFilename = db
    .prepare('SELECT receipt_filename FROM enquiries WHERE id = ?')
    .get(items[0].id).receipt_filename;
  const deletion = await fetch(`${baseUrl}/api/admin/enquiries/${items[0].id}`, {
    method: 'DELETE',
    headers: { authorization },
  });
  assert.equal(deletion.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count, 0);
  assert.equal(fs.existsSync(path.join(uploadDirectory, receiptFilename)), false);
});

test('allows an enquiry without payment or a screenshot', async () => {
  const submission = await fetch(`${baseUrl}/api/enquiries`, {
    method: 'POST',
    body: makeEnquiryForm({ name: 'Not paid yet', paymentMade: false }, false),
  });
  assert.equal(submission.status, 201);

  const listed = await fetch(`${baseUrl}/api/admin/enquiries`, {
    headers: { authorization },
  });
  const { items } = await listed.json();
  const enquiry = items.find((item) => item.name === 'Not paid yet');
  assert.ok(enquiry);
  assert.equal(enquiry.paymentMade, false);
  assert.equal(enquiry.hasReceipt, false);

  const deletion = await fetch(`${baseUrl}/api/admin/enquiries/${enquiry.id}`, {
    method: 'DELETE',
    headers: { authorization },
  });
  assert.equal(deletion.status, 204);
});

test('requires a long admin password', () => {
  assert.throws(
    () => createApp({ db, adminUsername: 'admin', adminPassword: 'short' }),
    /at least 16 characters/,
  );
});

test('parses the Render proxy hop count as a number', () => {
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('127.0.0.1,10.0.0.0/8'), ['127.0.0.1', '10.0.0.0/8']);
  assert.equal(parseTrustProxy(undefined), undefined);
});
