'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');

const SITE_FILE =
  'Advocate Priyanka Choudhary _ GST, Income Tax & Legal Services in Jahangirabad, Bulandshahr.html';
const SERVICE_NAMES = [
  'GST Registration',
  'GST Return Filing',
  'Income Tax Return (ITR)',
  'Income Tax Notice Reply',
  'TDS Returns',
  'Tax Planning',
  'Company / LLP / Firm Registration',
  'Udyam Registration',
  'PAN, TAN and DSC',
  'Legal Notice Drafting',
  'Agreements and Documents',
  'Legal Consultation',
];
const PAGE_SIZE = 25;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const RECEIPT_FILENAME_PATTERN = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const RECEIPT_TYPES = {
  png: {
    mime: 'image/png',
    signature: (buffer) =>
      buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  jpg: {
    mime: 'image/jpeg',
    signature: (buffer) =>
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  webp: {
    mime: 'image/webp',
    signature: (buffer) =>
      buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP',
  },
};

function initializeDatabase(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      consent INTEGER NOT NULL CHECK (consent = 1),
      payment_made INTEGER NOT NULL DEFAULT 0 CHECK (payment_made IN (0, 1)),
      receipt_filename TEXT,
      receipt_mime TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS enquiries_created_at_idx
      ON enquiries (created_at DESC, id DESC);
  `);
  const columns = new Set(db.pragma('table_info(enquiries)').map((column) => column.name));
  if (!columns.has('payment_made')) {
    db.exec('ALTER TABLE enquiries ADD COLUMN payment_made INTEGER NOT NULL DEFAULT 0 CHECK (payment_made IN (0, 1))');
  }
  if (!columns.has('receipt_filename')) {
    db.exec('ALTER TABLE enquiries ADD COLUMN receipt_filename TEXT');
  }
  if (!columns.has('receipt_mime')) {
    db.exec('ALTER TABLE enquiries ADD COLUMN receipt_mime TEXT');
  }
}

function validReceiptMetadata(filename, mime) {
  if (typeof filename !== 'string' || !RECEIPT_FILENAME_PATTERN.test(filename)) {
    return false;
  }
  const extension = filename.split('.').pop();
  return RECEIPT_TYPES[extension]?.mime === mime;
}

function createSqliteStore(db, uploadDirectory) {
  const privateUploadDirectory = path.resolve(
    uploadDirectory || path.join(__dirname, 'data', 'uploads'),
  );
  fs.mkdirSync(privateUploadDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateUploadDirectory, 0o700);

  return {
    async createEnquiry(enquiry, receipt) {
      const filename = receipt ? `${crypto.randomUUID()}.${receipt.extension}` : null;
      const receiptPath = filename ? path.join(privateUploadDirectory, filename) : null;
      try {
        if (receiptPath) {
          fs.writeFileSync(receiptPath, receipt.buffer, { flag: 'wx', mode: 0o600 });
        }
        const inserted = db.prepare(`
          INSERT INTO enquiries (
            name, phone, service, message, consent, payment_made, receipt_filename, receipt_mime
          )
          VALUES (
            @name, @phone, @service, @message, 1, @paymentMade, @receiptFilename, @receiptMime
          )
        `).run({
          ...enquiry,
          paymentMade: enquiry.paymentMade ? 1 : 0,
          receiptFilename: filename,
          receiptMime: receipt?.mime || null,
        });
        return inserted.lastInsertRowid;
      } catch (error) {
        if (receiptPath) {
          try {
            fs.unlinkSync(receiptPath);
          } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
              console.error('Unable to remove an unassociated payment screenshot:', cleanupError);
            }
          }
        }
        throw error;
      }
    },

    async listEnquiries(page, pageSize) {
      const offset = (page - 1) * pageSize;
      const total = db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count;
      const rows = db.prepare(`
        SELECT
          id, name, phone, service, message, created_at AS createdAt,
          payment_made AS paymentMade,
          receipt_filename IS NOT NULL AS hasReceipt
        FROM enquiries
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(pageSize, offset);
      return {
        total,
        items: rows.map((row) => ({
          ...row,
          paymentMade: Boolean(row.paymentMade),
          hasReceipt: Boolean(row.hasReceipt),
        })),
      };
    },

    async getReceipt(id) {
      const enquiry = db.prepare(`
        SELECT receipt_filename AS filename, receipt_mime AS mime
        FROM enquiries WHERE id = ?
      `).get(id);
      if (!enquiry || !validReceiptMetadata(enquiry.filename, enquiry.mime)) {
        return null;
      }
      const receiptPath = path.join(privateUploadDirectory, enquiry.filename);
      if (!fs.existsSync(receiptPath)) {
        return null;
      }
      return {
        body: fs.readFileSync(receiptPath),
        mime: enquiry.mime,
        extension: enquiry.filename.split('.').pop(),
      };
    },

    async deleteEnquiry(id) {
      const enquiry = db.prepare(`
        SELECT receipt_filename AS filename, receipt_mime AS mime
        FROM enquiries WHERE id = ?
      `).get(id);
      if (!enquiry) {
        return false;
      }
      if (enquiry.filename) {
        if (!validReceiptMetadata(enquiry.filename, enquiry.mime)) {
          throw new Error('Unable to safely remove the payment screenshot.');
        }
        try {
          fs.unlinkSync(path.join(privateUploadDirectory, enquiry.filename));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return db.prepare('DELETE FROM enquiries WHERE id = ?').run(id).changes > 0;
    },
  };
}

function createSupabaseStore({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  bucket = process.env.SUPABASE_STORAGE_BUCKET || 'payment-receipts',
  client,
} = {}) {
  if (!client && (!url || !serviceRoleKey)) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for Supabase storage.');
  }
  if (!bucket) {
    throw new Error('SUPABASE_STORAGE_BUCKET must not be empty.');
  }
  const supabase = client || createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const receipts = supabase.storage.from(bucket);

  return {
    async createEnquiry(enquiry, receipt) {
      const filename = receipt ? `${crypto.randomUUID()}.${receipt.extension}` : null;
      let uploaded = false;
      try {
        if (receipt) {
          const { error } = await receipts.upload(filename, receipt.buffer, {
            contentType: receipt.mime,
            upsert: false,
          });
          if (error) throw error;
          uploaded = true;
        }
        const { data, error } = await supabase
          .from('enquiries')
          .insert({
            name: enquiry.name,
            phone: enquiry.phone,
            service: enquiry.service,
            message: enquiry.message,
            consent: true,
            payment_made: enquiry.paymentMade,
            receipt_filename: filename,
            receipt_mime: receipt?.mime || null,
          })
          .select('id')
          .single();
        if (error) throw error;
        return data.id;
      } catch (error) {
        if (uploaded) {
          const { error: cleanupError } = await receipts.remove([filename]);
          if (cleanupError) {
            console.error('Unable to remove an unassociated payment screenshot:', cleanupError);
          }
        }
        throw error;
      }
    },

    async listEnquiries(page, pageSize) {
      const offset = (page - 1) * pageSize;
      const [{ count, error: countError }, { data, error }] = await Promise.all([
        supabase.from('enquiries').select('id', { count: 'exact', head: true }),
        supabase
          .from('enquiries')
          .select('id, name, phone, service, message, created_at, payment_made, receipt_filename')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + pageSize - 1),
      ]);
      if (countError) throw countError;
      if (error) throw error;
      return {
        total: count || 0,
        items: data.map((row) => ({
          id: row.id,
          name: row.name,
          phone: row.phone,
          service: row.service,
          message: row.message,
          createdAt: row.created_at,
          paymentMade: Boolean(row.payment_made),
          hasReceipt: Boolean(row.receipt_filename),
        })),
      };
    },

    async getReceipt(id) {
      const { data: enquiry, error } = await supabase
        .from('enquiries')
        .select('receipt_filename, receipt_mime')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!enquiry || !validReceiptMetadata(enquiry.receipt_filename, enquiry.receipt_mime)) {
        return null;
      }
      const { data, error: downloadError } = await receipts.download(enquiry.receipt_filename);
      if (downloadError) {
        if (downloadError.statusCode === '404' || downloadError.status === 404) {
          return null;
        }
        throw downloadError;
      }
      return {
        body: Buffer.from(await data.arrayBuffer()),
        mime: enquiry.receipt_mime,
        extension: enquiry.receipt_filename.split('.').pop(),
      };
    },

    async deleteEnquiry(id) {
      const { data: enquiry, error: lookupError } = await supabase
        .from('enquiries')
        .select('receipt_filename, receipt_mime')
        .eq('id', id)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (!enquiry) return false;
      if (enquiry.receipt_filename) {
        if (!validReceiptMetadata(enquiry.receipt_filename, enquiry.receipt_mime)) {
          throw new Error('Unable to safely remove the payment screenshot.');
        }
        const { error } = await receipts.remove([enquiry.receipt_filename]);
        if (error) throw error;
      }
      const { data, error } = await supabase
        .from('enquiries')
        .delete()
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
  };
}

function sameSecret(provided, expected) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function createAdminAuth({ username, password }) {
  return function requireAdmin(req, res, next) {
    const header = req.get('authorization') || '';
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header);
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        const validUsername = sameSecret(decoded.slice(0, separator), username);
        const validPassword = sameSecret(decoded.slice(separator + 1), password);
        if (validUsername && validPassword) {
          return next();
        }
      }
    }

    res.set('WWW-Authenticate', 'Basic realm="Advocate Admin", charset="UTF-8"');
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('text').send('Authentication required.');
  };
}

function parseTrustProxy(value) {
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function validateEnquiry(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Please complete all required fields.' };
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const service = typeof body.service === 'string' ? body.service : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const paymentMade = body.paymentMade === true || body.paymentMade === 'true';

  if (name.length < 1 || name.length > 100) {
    return { error: 'Enter a name between 1 and 100 characters.' };
  }
  if (!/^[6-9]\d{9}$/.test(phone)) {
    return { error: 'Enter a valid 10-digit Indian mobile number.' };
  }
  if (!SERVICE_NAMES.includes(service)) {
    return { error: 'Choose a valid service.' };
  }
  if (message.length < 1 || message.length > 800) {
    return { error: 'Enter a message between 1 and 800 characters.' };
  }
  if (body.consent !== true && body.consent !== 'true') {
    return { error: 'Consent is required before submitting an enquiry.' };
  }

  return { enquiry: { name, phone, service, message, paymentMade } };
}

function createApp({
  db,
  store: suppliedStore,
  adminUsername,
  adminPassword,
  trustProxy,
  uploadDirectory,
  enquiryLimit = 5,
}) {
  if (
    !adminUsername ||
    adminUsername.includes(':') ||
    !adminPassword ||
    adminPassword.length < 16
  ) {
    throw new Error('Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 16 characters.');
  }
  const store = suppliedStore || (db ? createSqliteStore(db, uploadDirectory) : null);
  if (
    !store ||
    !['createEnquiry', 'listEnquiries', 'getReceipt', 'deleteEnquiry'].every(
      (method) => typeof store[method] === 'function',
    )
  ) {
    throw new Error('A valid enquiry storage provider is required.');
  }

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) {
    app.set('trust proxy', trustProxy);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'connect-src': ["'self'"],
          'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
          'frame-src': ['https://maps.google.com', 'https://www.google.com'],
          'img-src': ["'self'", 'data:'],
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        },
      },
    }),
  );
  app.use(express.json({ limit: '10kb', strict: true }));

  const enquiryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: enquiryLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many enquiries. Please try again later.' },
  });
  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
  });
  const requireAdmin = createAdminAuth({
    username: adminUsername,
    password: adminPassword,
  });
  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const receiveReceipt = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_RECEIPT_BYTES, files: 1, fields: 10, parts: 11 },
  }).single('paymentScreenshot');

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.use('/assets', express.static(path.join(__dirname, 'assets'), { index: false }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, SITE_FILE));
  });

  app.post('/api/enquiries', enquiryLimiter, receiveReceipt, async (req, res, next) => {
    const result = validateEnquiry(req.body);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    if (result.enquiry.paymentMade && !req.file) {
      return res.status(400).json({ error: 'A payment screenshot is required when payment has been made.' });
    }

    let receipt;
    if (req.file) {
      const receiptType = Object.values(RECEIPT_TYPES).find((type) =>
        type.signature(req.file.buffer),
      );
      if (!receiptType) {
        return res.status(400).json({ error: 'Upload a valid PNG, JPEG, or WebP image.' });
      }
      const extension = Object.entries(RECEIPT_TYPES).find(([, type]) => type === receiptType)[0];
      receipt = { buffer: req.file.buffer, mime: receiptType.mime, extension };
    }

    try {
      const enquiryId = await store.createEnquiry(result.enquiry, receipt);
      return res.status(201).json({ success: true, enquiryId });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/admin', noStore, adminLimiter, requireAdmin, (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(__dirname, 'admin.html'));
  });

  app.get('/admin.js', noStore, adminLimiter, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.js'));
  });

  app.use('/api/admin', noStore, adminLimiter, requireAdmin);

  app.get('/api/admin/enquiries', async (req, res, next) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isSafeInteger(page) || page < 1) {
      return res.status(400).json({ error: 'Page must be a positive integer.' });
    }
    const offset = (page - 1) * PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) {
      return res.status(400).json({ error: 'Page is out of range.' });
    }

    try {
      const { items, total } = await store.listEnquiries(page, PAGE_SIZE);
      return res.json({ items, page, pageSize: PAGE_SIZE, total });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/enquiries/:id/receipt', async (req, res, next) => {
    const id = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
      return res.status(400).json({ error: 'Invalid enquiry ID.' });
    }

    try {
      const receipt = await store.getReceipt(id);
      if (!receipt) {
        return res.status(404).json({ error: 'Payment screenshot not found.' });
      }
      res.set('Content-Type', receipt.mime);
      res.set('Content-Disposition', `inline; filename="payment-screenshot.${receipt.extension}"`);
      res.set('X-Content-Type-Options', 'nosniff');
      return res.send(receipt.body);
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/api/admin/enquiries/:id', async (req, res, next) => {
    if (!/^[1-9]\d*$/.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid enquiry ID.' });
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) {
      return res.status(400).json({ error: 'Invalid enquiry ID.' });
    }

    try {
      const deleted = await store.deleteEnquiry(id);
      if (!deleted) return res.status(404).json({ error: 'Enquiry not found.' });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({
        error:
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Payment screenshot must be 5 MB or smaller.'
            : 'Invalid form submission or payment screenshot.',
      });
    }
    console.error('Request failed:', error);
    return res.status(500).json({ error: 'The request could not be completed.' });
  });

  return app;
}

function startServer() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (
    !adminUsername ||
    adminUsername.includes(':') ||
    !adminPassword ||
    adminPassword.length < 16
  ) {
    throw new Error('Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 16 characters.');
  }

  let db;
  let store;
  const storageMode = process.env.STORAGE_MODE || 'sqlite';
  if (storageMode === 'supabase') {
    store = createSupabaseStore();
  } else if (storageMode === 'sqlite') {
    const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDirectory, 0o700);
    const databasePath = path.join(dataDirectory, 'enquiries.sqlite3');
    db = new Database(databasePath);
    initializeDatabase(db);
    fs.chmodSync(databasePath, 0o600);
    store = createSqliteStore(db, path.join(dataDirectory, 'uploads'));
  } else {
    throw new Error('STORAGE_MODE must be either sqlite or supabase.');
  }

  const app = createApp({
    store,
    adminUsername,
    adminPassword,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const server = app.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Website server listening on port ${port}.`);
  });

  function shutdown() {
    server.close((error) => {
      db?.close();
      if (error) {
        console.error('Server shutdown failed:', error);
        process.exitCode = 1;
      }
    });
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  createApp,
  createSqliteStore,
  createSupabaseStore,
  initializeDatabase,
  parseTrustProxy,
  validateEnquiry,
};
