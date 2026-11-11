'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSupabaseStore } = require('../server');

function fakeSupabaseClient(insertError = null) {
  const state = { inserted: null, uploads: [], removals: [] };
  const storage = {
    async upload(filename, buffer, options) {
      state.uploads.push({ filename, buffer, options });
      return { error: null };
    },
    async remove(filenames) {
      state.removals.push(filenames);
      return { error: null };
    },
  };
  const client = {
    storage: {
      from(bucket) {
        assert.equal(bucket, 'payment-receipts');
        return storage;
      },
    },
    from(table) {
      assert.equal(table, 'enquiries');
      return {
        insert(values) {
          state.inserted = values;
          return {
            select(columns) {
              assert.equal(columns, 'id');
              return {
                async single() {
                  return {
                    data: insertError ? null : { id: 17 },
                    error: insertError,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, state };
}

const enquiry = {
  name: 'Test Visitor',
  phone: '9876543210',
  service: 'GST Registration',
  message: 'Please contact me.',
  paymentMade: true,
};
const receipt = {
  buffer: Buffer.from('receipt'),
  extension: 'png',
  mime: 'image/png',
};

test('stores screenshots privately by object key and records their metadata', async () => {
  const { client, state } = fakeSupabaseClient();
  const store = createSupabaseStore({ client, bucket: 'payment-receipts' });
  const id = await store.createEnquiry(enquiry, receipt);

  assert.equal(id, 17);
  assert.equal(state.uploads.length, 1);
  assert.match(state.uploads[0].filename, /^[0-9a-f-]{36}\.png$/);
  assert.equal(state.uploads[0].options.contentType, 'image/png');
  assert.equal(state.uploads[0].options.upsert, false);
  assert.equal(state.inserted.receipt_filename, state.uploads[0].filename);
  assert.equal(state.inserted.receipt_mime, 'image/png');
  assert.equal(state.inserted.payment_made, true);
});

test('removes a screenshot if its enquiry record could not be saved', async () => {
  const { client, state } = fakeSupabaseClient(new Error('database unavailable'));
  const store = createSupabaseStore({ client, bucket: 'payment-receipts' });

  await assert.rejects(store.createEnquiry(enquiry, receipt), /database unavailable/);
  assert.equal(state.uploads.length, 1);
  assert.deepEqual(state.removals, [[state.uploads[0].filename]]);
});

test('requires Supabase credentials when no client is injected', () => {
  assert.throws(
    () => createSupabaseStore({ url: '', serviceRoleKey: '' }),
    /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/,
  );
});
