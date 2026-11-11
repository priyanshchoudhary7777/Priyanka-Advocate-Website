'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
  adminUsername,
  adminPassword,
  trustProxy,
  uploadDirectory,
  enquiryLimit = 5,
}) {
  if (!db) {
    throw new Error('A database connection is required.');
  }
  if (
    !adminUsername ||
    adminUsername.includes(':') ||
    !adminPassword ||
    adminPassword.length < 16
  ) {
    throw new Error('Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 16 characters.');
  }

  const app = express();
  const privateUploadDirectory = path.resolve(uploadDirectory || path.join(__dirname, 'data', 'uploads'));
  fs.mkdirSync(privateUploadDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateUploadDirectory, 0o700);
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

  app.post('/api/enquiries', enquiryLimiter, receiveReceipt, (req, res, next) => {
    const result = validateEnquiry(req.body);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    if (result.enquiry.paymentMade && !req.file) {
      return res.status(400).json({ error: 'A payment screenshot is required when payment has been made.' });
    }

    let receiptType;
    let receiptFilename = null;
    let receiptPath;
    if (req.file) {
      receiptType = Object.values(RECEIPT_TYPES).find((type) =>
        type.signature(req.file.buffer),
      );
      if (!receiptType) {
        return res.status(400).json({ error: 'Upload a valid PNG, JPEG, or WebP image.' });
      }

      const extension = Object.entries(RECEIPT_TYPES).find(([, type]) => type === receiptType)[0];
      receiptFilename = `${crypto.randomUUID()}.${extension}`;
      receiptPath = path.join(privateUploadDirectory, receiptFilename);
    }

    try {
      if (req.file) {
        fs.writeFileSync(receiptPath, req.file.buffer, { flag: 'wx', mode: 0o600 });
      }
      const insert = db.prepare(`
        INSERT INTO enquiries (
          name, phone, service, message, consent, payment_made, receipt_filename, receipt_mime
        )
        VALUES (
          @name, @phone, @service, @message, 1, @paymentMade, @receiptFilename, @receiptMime
        )
      `);
      const inserted = insert.run({
        ...result.enquiry,
        paymentMade: result.enquiry.paymentMade ? 1 : 0,
        receiptFilename,
        receiptMime: receiptType?.mime || null,
      });
      return res.status(201).json({ success: true, enquiryId: inserted.lastInsertRowid });
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

  app.get('/api/admin/enquiries', (req, res, next) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isSafeInteger(page) || page < 1) {
      return res.status(400).json({ error: 'Page must be a positive integer.' });
    }
    const offset = (page - 1) * PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) {
      return res.status(400).json({ error: 'Page is out of range.' });
    }

    try {
      const total = db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count;
      const rows = db
        .prepare(`
          SELECT
            id, name, phone, service, message, created_at AS createdAt,
            payment_made AS paymentMade,
            receipt_filename IS NOT NULL AS hasReceipt
          FROM enquiries
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `)
        .all(PAGE_SIZE, offset);
      const items = rows.map((row) => ({
        ...row,
        paymentMade: Boolean(row.paymentMade),
        hasReceipt: Boolean(row.hasReceipt),
      }));
      return res.json({ items, page, pageSize: PAGE_SIZE, total });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/enquiries/:id/receipt', (req, res, next) => {
    const id = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
      return res.status(400).json({ error: 'Invalid enquiry ID.' });
    }

    try {
      const enquiry = db
        .prepare('SELECT receipt_filename AS filename, receipt_mime AS mime FROM enquiries WHERE id = ?')
        .get(id);
      if (!enquiry || !enquiry.filename || !enquiry.mime) {
        return res.status(404).json({ error: 'Payment screenshot not found.' });
      }
      if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(enquiry.filename)) {
        return res.status(404).json({ error: 'Payment screenshot not found.' });
      }
      const expectedMime = RECEIPT_TYPES[enquiry.filename.split('.').pop()]?.mime;
      if (enquiry.mime !== expectedMime) {
        return res.status(404).json({ error: 'Payment screenshot not found.' });
      }
      const receiptPath = path.join(privateUploadDirectory, enquiry.filename);
      if (!fs.existsSync(receiptPath)) {
        return res.status(404).json({ error: 'Payment screenshot not found.' });
      }
      res.set('Content-Type', enquiry.mime);
      const extension = enquiry.filename.split('.').pop();
      res.set('Content-Disposition', `inline; filename="payment-screenshot.${extension}"`);
      res.set('X-Content-Type-Options', 'nosniff');
      return res.sendFile(receiptPath, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/api/admin/enquiries/:id', (req, res, next) => {
    if (!/^[1-9]\d*$/.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid enquiry ID.' });
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) {
      return res.status(400).json({ error: 'Invalid enquiry ID.' });
    }

    try {
      const enquiry = db
        .prepare('SELECT receipt_filename AS filename FROM enquiries WHERE id = ?')
        .get(id);
      if (!enquiry) {
        return res.status(404).json({ error: 'Enquiry not found.' });
      }
      if (enquiry.filename) {
        if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(enquiry.filename)) {
          return res.status(500).json({ error: 'Unable to safely remove the payment screenshot.' });
        }
        try {
          fs.unlinkSync(path.join(privateUploadDirectory, enquiry.filename));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const result = db.prepare('DELETE FROM enquiries WHERE id = ?').run(id);
      if (result.changes === 0) return res.status(404).json({ error: 'Enquiry not found.' });
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

  const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDirectory, 0o700);
  const databasePath = path.join(dataDirectory, 'enquiries.sqlite3');
  const db = new Database(databasePath);
  initializeDatabase(db);
  fs.chmodSync(databasePath, 0o600);
  const uploadDirectory = path.join(dataDirectory, 'uploads');
  fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });

  const app = createApp({
    db,
    adminUsername,
    adminPassword,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    uploadDirectory,
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
      db.close();
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

module.exports = { createApp, initializeDatabase, parseTrustProxy, validateEnquiry };
