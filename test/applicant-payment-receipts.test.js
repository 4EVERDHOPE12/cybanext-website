const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const pdfParse = require('pdf-parse');
const {
  createApplicantPaymentReceiptService,
  isVerifiedRegistration
} = require('../lib/applicant-payment-receipts');
const { generatePaymentReceiptPdf } = require('../lib/applicant-payment-receipt-pdf');
const { createNotificationDelivery } = require('../lib/email-notification');
const {
  createPrivateReceiptStorage
} = require('../lib/applicant-payment-receipt-storage');

const registration = {
  id: 'DF-123456-ABCDEF',
  fullName: 'Ada Cybanext',
  course: 'digital_forensics',
  status: 'payment_verified',
  expectedAmount: 1500,
  expectedCurrency: 'GHS',
  paymentReference: 'DF-PAY-REFERENCE-123',
  verifiedTransactionId: 87654321,
  paymentVerificationTimestamp: '2025-06-15T12:30:00.000Z'
};

function createReceiptDatabase(initialRegistrations = [registration]) {
  const records = new Map();
  const registrations = new Map(initialRegistrations.map((item) => [item.id, item]));
  const statements = [];
  let now = Date.now();
  let referenceLookupError = null;

  function toRow(record) {
    return {
      id: record.id,
      registrationId: record.registrationId,
      receiptNumber: record.receiptNumber,
      paymentReference: record.paymentReference,
      verifiedTransactionId: record.verifiedTransactionId,
      applicantName: record.applicantName,
      amount: record.amount,
      currency: record.currency,
      verifiedAt: record.verifiedAt,
      blobPathname: record.blobPathname,
      generationStatus: record.generationStatus,
      generationToken: record.generationToken,
      leaseExpiresAt: record.leaseExpiresAt,
      pdfSha256: record.pdfSha256
    };
  }

  return {
    records,
    registrations,
    statements,
    async query(strings, ...values) {
      const statement = strings.join(' ');
      statements.push(statement);
      if (statement.includes('INSERT INTO applicant_payment_receipts')) {
        const [receiptNumber, registrationId, paymentReference, transactionId] = values;
        const source = registrations.get(registrationId);
        if (
          source &&
          ['payment_verified', 'paid'].includes(source.status) &&
          source.paymentReference === paymentReference &&
          String(source.verifiedTransactionId) === transactionId &&
          !records.has(registrationId)
        ) {
          records.set(registrationId, {
            id: crypto.randomUUID(),
            registrationId,
            receiptNumber,
            paymentReference,
            verifiedTransactionId: transactionId,
            applicantName: source.fullName,
            amount: source.expectedAmount,
            currency: source.expectedCurrency,
            verifiedAt: source.paymentVerificationTimestamp,
            blobPathname: null,
            generationStatus: 'pending',
            generationToken: null,
            leaseExpiresAt: null,
            pdfSha256: null
          });
        }
        return [];
      }

      if (statement.includes('SELECT 1 AS referenced')) {
        if (referenceLookupError) throw referenceLookupError;
        const [blobPathname] = values;
        return [...records.values()].some((record) => record.blobPathname === blobPathname)
          ? [{ referenced: 1 }]
          : [];
      }

      if (statement.includes('FROM applicant_payment_receipts')) {
        const [registrationId] = values;
        const record = records.get(registrationId);
        return record ? [toRow(record)] : [];
      }

      if (statement.includes("SET generation_status = 'generating'")) {
        const [claimToken, leaseMs, receiptId] = values;
        const record = [...records.values()].find((item) => item.id === receiptId);
        if (
          record &&
          (record.generationStatus === 'pending' ||
            (record.generationStatus === 'generating' && record.leaseExpiresAt <= now))
        ) {
          record.generationStatus = 'generating';
          record.generationToken = claimToken;
          record.leaseExpiresAt = now + leaseMs;
          return [{ id: record.id }];
        }
        return [];
      }

      if (statement.includes("SET generation_status = 'ready'")) {
        const [blobPathname, checksum, receiptId, claimToken] = values;
        const record = [...records.values()].find((item) => item.id === receiptId);
        if (
          record &&
          record.generationStatus === 'generating' &&
          record.generationToken === claimToken &&
          record.leaseExpiresAt > now
        ) {
          record.generationStatus = 'ready';
          record.generationToken = null;
          record.leaseExpiresAt = null;
          record.blobPathname = blobPathname;
          record.pdfSha256 = checksum;
          return [{ id: record.id }];
        }
        return [];
      }

      if (statement.includes("SET generation_status = 'pending'")) {
        const [receiptId, claimToken] = values;
        const record = [...records.values()].find((item) => item.id === receiptId);
        if (record && record.generationToken === claimToken) {
          record.generationStatus = 'pending';
          record.generationToken = null;
          record.leaseExpiresAt = null;
        }
        return [];
      }

      throw new Error(`Unexpected receipt test query: ${statement}`);
    },
    advanceTime(milliseconds) {
      now += milliseconds;
    },
    setReferenceLookupError(error) {
      referenceLookupError = error;
    }
  };
}

function createService(options = {}) {
  const receiptDatabase = options.receiptDatabase ||
    createReceiptDatabase(options.registrations);
  const written = [];
  const deleted = [];
  let generated = 0;
  const service = createApplicantPaymentReceiptService({
    receiptDatabase,
    applicantStore: {
      async findRegistration(id) {
        return receiptDatabase.registrations.get(id) || null;
      }
    },
    async pdfGenerator(receipt) {
      generated += 1;
      if (options.generatePdf) return options.generatePdf(receipt, generated);
      return Buffer.from(`receipt ${receipt.receiptNumber}`);
    },
    async blobWriter(pathname, body) {
      written.push({ pathname, body });
      if (options.writeBlob) return options.writeBlob(pathname, body, written.length);
    },
    async blobDeleter(pathname) {
      deleted.push(pathname);
      if (options.deleteBlob) return options.deleteBlob(pathname, deleted.length);
    }
  });
  return {
    ...service,
    deleted,
    receiptDatabase,
    written,
    getGenerated: () => generated
  };
}

async function createExpiredGenerationScenario(options = {}) {
  const receiptDatabase = createReceiptDatabase();
  const uploadedObjects = new Map();
  let releaseWorkerAUpload;
  let resolveWorkerAUpload;
  const workerAUploadStarted = new Promise((resolve) => {
    resolveWorkerAUpload = resolve;
  });
  const workerA = createService({
    receiptDatabase,
    generatePdf: async () => Buffer.from('worker A PDF'),
    writeBlob: async (pathname, body) => {
      resolveWorkerAUpload({ pathname, body });
      await new Promise((resolve) => { releaseWorkerAUpload = resolve; });
      uploadedObjects.set(pathname, body);
    },
    deleteBlob: options.deleteBlob ||
      (async (pathname) => uploadedObjects.delete(pathname))
  });
  const workerAPromise = workerA.ensureReceiptForRegistration(registration.id);
  const uploadA = await workerAUploadStarted;

  receiptDatabase.advanceTime(5 * 60 * 1000 + 1);
  const workerB = createService({
    receiptDatabase,
    generatePdf: async () => Buffer.from('worker B winning PDF'),
    writeBlob: async (pathname, body) => {
      uploadedObjects.set(pathname, body);
    }
  });
  const winningReceipt = await workerB.ensureReceiptForRegistration(registration.id);

  if (options.referenceLookupError) {
    receiptDatabase.setReferenceLookupError(options.referenceLookupError);
  }
  if (options.addReference) {
    options.addReference({ receiptDatabase, uploadA, winningReceipt });
  }

  releaseWorkerAUpload();
  const staleWorkerReceipt = await workerAPromise;
  return {
    receiptDatabase,
    uploadedObjects,
    uploadA,
    winningReceipt,
    staleWorkerReceipt,
    workerA,
    workerB
  };
}

test('only successfully verified Digital Forensics registrations qualify for a receipt', () => {
  assert.equal(isVerifiedRegistration(registration), true);
  for (const patch of [
    { status: 'payment_initiated' },
    { status: 'payment_failed' },
    { course: 'incident_response' },
    { verifiedTransactionId: null },
    { paymentVerificationTimestamp: null }
  ]) {
    assert.equal(isVerifiedRegistration({ ...registration, ...patch }), false);
  }
});

test('receipt creation uses one verified-payment snapshot and is idempotent', async () => {
  const service = createService();
  const first = await service.ensureReceiptForRegistration(registration.id);
  const second = await service.ensureReceiptForRegistration(registration.id);

  assert.equal(first.generationStatus, 'ready');
  assert.equal(first.receiptNumber, second.receiptNumber);
  assert.equal(first.paymentReference, registration.paymentReference);
  assert.equal(String(first.verifiedTransactionId), String(registration.verifiedTransactionId));
  assert.equal(service.receiptDatabase.records.size, 1);
  assert.equal(service.getGenerated(), 1);
  assert.equal(service.written.length, 1);
  assert.deepEqual(service.deleted, []);
});

test('generation lease acquisition and completion use wall-clock expiry checks', async () => {
  const service = createService();
  await service.ensureReceiptForRegistration(registration.id);

  const acquireStatement = service.receiptDatabase.statements.find((statement) =>
    statement.includes("SET generation_status = 'generating'"));
  const completionStatement = service.receiptDatabase.statements.find((statement) =>
    statement.includes("SET generation_status = 'ready'"));

  assert.match(acquireStatement, /lease_expires_at = clock_timestamp\(\)/);
  assert.match(acquireStatement, /lease_expires_at <= clock_timestamp\(\)/);
  assert.match(completionStatement, /lease_expires_at > clock_timestamp\(\)/);
  assert.match(acquireStatement, /updated_at = CURRENT_TIMESTAMP/);
  assert.match(completionStatement, /updated_at = CURRENT_TIMESTAMP/);
});

test('ready receipt eligibility reuses an existing receipt and never generates one', async () => {
  const service = createService();
  const generatedReceipt = await service.ensureReceiptForRegistration(registration.id);
  const generationCount = service.getGenerated();

  const eligibility =
    await service.getReceiptEligibilityForRegistration(registration.id);

  assert.equal(eligibility.paymentVerified, true);
  assert.equal(eligibility.receipt.receiptNumber, generatedReceipt.receiptNumber);
  assert.equal(service.getGenerated(), generationCount);
  assert.equal(service.receiptDatabase.records.size, 1);
});

test('repeated payment-success email processing reuses the same ready receipt', async () => {
  const service = createService();
  const sentMessages = [];
  const delivery = createNotificationDelivery({
    receiptService: service,
    receiptStorage: {
      async getVerifiedReceiptPdf(receipt) {
        assert.equal(receipt.blobPathname, service.written[0].pathname);
        assert.equal(
          receipt.pdfSha256,
          crypto.createHash('sha256').update(service.written[0].body).digest('hex')
        );
        return service.written[0].body;
      }
    },
    async emailSender(message) { sentMessages.push(message); }
  });
  const event = {
    eventType: 'digital_forensics_payment_success',
    eventKey: `digital-forensics-payment-success:${registration.id}:${registration.paymentReference}`,
    digitalForensicsRegistrationId: registration.id,
    recipientEmail: 'applicant@example.com',
    templateData: { fullName: registration.fullName, track: 'Digital Forensics' }
  };

  await delivery(event);
  const firstReceipt = [...service.receiptDatabase.records.values()][0];
  await delivery(event);
  const finalReceipt = [...service.receiptDatabase.records.values()][0];

  assert.equal(service.receiptDatabase.records.size, 1);
  assert.equal(service.getGenerated(), 1);
  assert.equal(service.written.length, 1);
  assert.equal(finalReceipt.receiptNumber, firstReceipt.receiptNumber);
  assert.equal(finalReceipt.blobPathname, firstReceipt.blobPathname);
  assert.equal(finalReceipt.pdfSha256, firstReceipt.pdfSha256);
  assert.equal(sentMessages.length, 2);
  assert.equal(
    sentMessages[0].attachments[0].filename,
    sentMessages[1].attachments[0].filename
  );
  assert.equal(
    sentMessages[0].attachments[0].content,
    sentMessages[1].attachments[0].content
  );
});

test('concurrent generation claims create and upload only one receipt', async () => {
  let releasePdf;
  const service = createService({
    generatePdf: () => new Promise((resolve) => {
      releasePdf = () => resolve(Buffer.from('same receipt'));
    })
  });

  const firstGeneration = service.ensureReceiptForRegistration(registration.id);
  while (!releasePdf) await new Promise((resolve) => setImmediate(resolve));
  const concurrentGeneration = await service.ensureReceiptForRegistration(registration.id);
  assert.equal(concurrentGeneration.generationStatus, 'generating');
  releasePdf();
  const firstReceipt = await firstGeneration;

  assert.equal(firstReceipt.generationStatus, 'ready');
  assert.equal(service.receiptDatabase.records.size, 1);
  assert.equal(service.getGenerated(), 1);
  assert.equal(service.written.length, 1);
});

test('generation failures release the claim and retry the same receipt and pathname', async () => {
  const service = createService({
    generatePdf(_receipt, attempt) {
      if (attempt === 1) throw new Error('test PDF failure');
      return Buffer.from('receipt PDF');
    }
  });

  await assert.rejects(
    service.ensureReceiptForRegistration(registration.id),
    /test PDF failure/
  );
  const retried = await service.ensureReceiptForRegistration(registration.id);

  assert.equal(retried.generationStatus, 'ready');
  assert.equal(service.receiptDatabase.records.size, 1);
  assert.equal(service.getGenerated(), 2);
  assert.equal(service.written.length, 1);
});

test('storage failures preserve one receipt and retry with a new immutable pathname', async () => {
  const service = createService({
    writeBlob(pathname, _body, attempt) {
      if (attempt === 1) throw new Error('test Blob failure');
      return pathname;
    }
  });

  await assert.rejects(
    service.ensureReceiptForRegistration(registration.id),
    /test Blob failure/
  );
  const retried = await service.ensureReceiptForRegistration(registration.id);

  assert.equal(retried.generationStatus, 'ready');
  assert.equal(service.receiptDatabase.records.size, 1);
  assert.equal(service.written.length, 2);
  assert.notEqual(service.written[0].pathname, service.written[1].pathname);
  assert.equal(retried.blobPathname, service.written[1].pathname);
});

test('expired generation lease can be reclaimed and stale worker cannot publish or overwrite winner', async () => {
  const {
    receiptDatabase,
    uploadedObjects,
    uploadA,
    winningReceipt,
    staleWorkerReceipt,
    workerA
  } = await createExpiredGenerationScenario();
  assert.equal(winningReceipt.generationStatus, 'ready');
  assert.notEqual(uploadA.pathname, winningReceipt.blobPathname);
  assert.match(winningReceipt.blobPathname, /\/[0-9a-f-]{36}\.pdf$/);

  const finalReceipt = [...receiptDatabase.records.values()][0];
  assert.equal(staleWorkerReceipt.blobPathname, winningReceipt.blobPathname);
  assert.equal(finalReceipt.blobPathname, winningReceipt.blobPathname);
  assert.equal(
    finalReceipt.pdfSha256,
    crypto.createHash('sha256').update('worker B winning PDF').digest('hex')
  );
  assert.notEqual(
    finalReceipt.pdfSha256,
    crypto.createHash('sha256').update(uploadA.body).digest('hex')
  );
  assert.equal(
    uploadedObjects.get(finalReceipt.blobPathname).toString(),
    'worker B winning PDF'
  );
  assert.equal(uploadedObjects.has(uploadA.pathname), false);
  assert.deepEqual(workerA.deleted, [uploadA.pathname]);
  assert.equal(workerA.deleted.includes(winningReceipt.blobPathname), false);
});

test('stale worker retains an uploaded pathname already referenced by a receipt', async () => {
  const scenario = await createExpiredGenerationScenario({
    addReference({ receiptDatabase, uploadA }) {
      receiptDatabase.records.set('DF-OTHER-REGISTRATION', {
        id: crypto.randomUUID(),
        registrationId: 'DF-OTHER-REGISTRATION',
        receiptNumber: 'CN-DF-2025-OTHER',
        paymentReference: 'other-payment',
        verifiedTransactionId: 'other-transaction',
        applicantName: 'Other Applicant',
        amount: 1500,
        currency: 'GHS',
        verifiedAt: '2025-06-15T12:30:00.000Z',
        blobPathname: uploadA.pathname,
        generationStatus: 'ready',
        generationToken: null,
        leaseExpiresAt: null,
        pdfSha256: 'a'.repeat(64)
      });
    }
  });

  assert.deepEqual(scenario.workerA.deleted, []);
  assert.equal(scenario.uploadedObjects.has(scenario.uploadA.pathname), true);
  assert.equal(
    scenario.receiptDatabase.records.get('DF-OTHER-REGISTRATION').blobPathname,
    scenario.uploadA.pathname
  );
  assert.equal(
    scenario.staleWorkerReceipt.blobPathname,
    scenario.winningReceipt.blobPathname
  );
});

test('stale worker leaves its Blob untouched when the reference lookup fails', async () => {
  const originalConsoleError = console.error;
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args);
  try {
    const scenario = await createExpiredGenerationScenario({
      referenceLookupError: Object.assign(new Error('private database details'), {
        code: 'DB-LOOKUP-FAILED'
      })
    });

    assert.deepEqual(scenario.workerA.deleted, []);
    assert.equal(scenario.uploadedObjects.has(scenario.uploadA.pathname), true);
    assert.equal(
      scenario.staleWorkerReceipt.blobPathname,
      scenario.winningReceipt.blobPathname
    );
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0][0],
      'Receipt Blob cleanup reference check failed; leaving object untouched.');
    assert.deepEqual(loggedErrors[0][1], { code: 'DB-LOOKUP-FAILED' });
    assert.equal(JSON.stringify(loggedErrors).includes('private database details'), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('Blob deletion failure does not alter the published receipt state', async () => {
  const originalConsoleError = console.error;
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args);
  try {
    const scenario = await createExpiredGenerationScenario({
      deleteBlob: async () => {
        throw Object.assign(new Error('private Blob provider details'), {
          code: 'BLOB-DELETE-FAILED'
        });
      }
    });

    assert.deepEqual(scenario.workerA.deleted, [scenario.uploadA.pathname]);
    assert.equal(scenario.uploadedObjects.has(scenario.uploadA.pathname), true);
    assert.equal(
      scenario.receiptDatabase.records.get(registration.id).blobPathname,
      scenario.winningReceipt.blobPathname
    );
    assert.equal(scenario.staleWorkerReceipt.generationStatus, 'ready');
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0][0], 'Unreferenced receipt Blob cleanup failed.');
    assert.deepEqual(loggedErrors[0][1], { code: 'BLOB-DELETE-FAILED' });
    assert.equal(JSON.stringify(loggedErrors).includes('private Blob provider details'), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('private Blob deletion accepts only a generation-specific pathname', async () => {
  const deleted = [];
  const storage = createPrivateReceiptStorage({
    async deleteBlob(pathname) {
      deleted.push(pathname);
    }
  });
  const pathname =
    'applicant-payment-receipts/CN-DF-2025-ABC123/12345678-1234-1234-1234-123456789abc.pdf';

  await storage.deletePrivateReceipt(pathname);
  await assert.rejects(
    storage.deletePrivateReceipt('applicant-payment-receipts/CN-DF-2025-ABC123/'),
    /unique receipt Blob pathname/
  );

  assert.deepEqual(deleted, [pathname]);
});

test('unverified registrations never create receipt rows or write a PDF', async () => {
  const unpaid = { ...registration, status: 'payment_initiated' };
  const service = createService({ registrations: [unpaid] });

  assert.equal(await service.ensureReceiptForRegistration(unpaid.id), null);
  assert.equal(service.receiptDatabase.records.size, 0);
  assert.equal(service.written.length, 0);
});

test('generated PDF contains the verified receipt information and Cybanext support details', async () => {
  const pdf = await generatePaymentReceiptPdf({
    receiptNumber: 'CN-DF-2025-ABC123',
    applicantName: registration.fullName,
    amount: registration.expectedAmount,
    currency: registration.expectedCurrency,
    paymentReference: registration.paymentReference,
    verifiedTransactionId: registration.verifiedTransactionId,
    verifiedAt: registration.paymentVerificationTimestamp
  });
  const parsed = await pdfParse(pdf);

  assert.match(parsed.text, /PAYMENT SUCCESSFUL/);
  assert.match(parsed.text, /CN-DF-2025-ABC123/);
  assert.match(parsed.text, /Ada Cybanext/);
  assert.match(parsed.text, /Digital Forensics/);
  assert.match(parsed.text, /GHS 1500\.00/);
  assert.match(parsed.text, /DF-PAY-REFERENCE-123/);
  assert.match(parsed.text, /87654321/);
  assert.match(parsed.text, /support@cybanext\.com/);
  assert.equal(parsed.numpages, 1);
});

test('long receipt values wrap without truncation and remain on one A4 page', async () => {
  const longName = `Applicant ${'Name '.repeat(22)}`.trim();
  const longReference = `REF-${'1234567890'.repeat(10)}`;
  const longTransactionId = '9876543210'.repeat(10);
  const pdf = await generatePaymentReceiptPdf({
    receiptNumber: 'CN-DF-2025-ABC123',
    applicantName: longName,
    amount: registration.expectedAmount,
    currency: registration.expectedCurrency,
    paymentReference: longReference,
    verifiedTransactionId: longTransactionId,
    verifiedAt: registration.paymentVerificationTimestamp
  });
  const parsed = await pdfParse(pdf);
  const normalizedText = parsed.text.replace(/\s+/g, '');

  assert.equal(parsed.numpages, 1);
  assert.ok(normalizedText.includes(longName.replace(/\s+/g, '')));
  assert.ok(normalizedText.includes(longReference));
  assert.ok(normalizedText.includes(longTransactionId));
  assert.match(parsed.text, /support@cybanext\.com/);
});

test('private Blob adapter requires private access and a stable pathname', async () => {
  let call;
  const { putPrivateReceipt: putReceipt } = createPrivateReceiptStorage({
    async putBlob(...args) {
      call = args;
    }
  });
  const body = Buffer.from('private pdf');
  const result = await putReceipt('applicant-payment-receipts/receipt.pdf', body);

  assert.equal(result, 'applicant-payment-receipts/receipt.pdf');
  assert.equal(call[0], result);
  assert.equal(call[1], body);
  assert.deepEqual(call[2], {
    access: 'private',
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
    contentType: 'application/pdf'
  });
  assert.equal(Object.hasOwn(call[2], 'allowOverwrite'), false);
});

function blobStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
      controller.close();
    }
  });
}

function readyReceipt(pdf, overrides = {}) {
  return {
    generationStatus: 'ready',
    blobPathname: 'applicant-payment-receipts/CN-DF-2025-ABC123/claim.pdf',
    pdfSha256: crypto.createHash('sha256').update(pdf).digest('hex'),
    ...overrides
  };
}

test('private Blob retrieval reads by pathname and returns only checksum-verified PDF bytes', async () => {
  const pdf = Buffer.from('%PDF-1.4\nverified receipt');
  const pathname = 'applicant-payment-receipts/CN-DF-2025-ABC123/claim.pdf';
  let call;
  const storage = createPrivateReceiptStorage({
    async getBlob(...args) {
      call = args;
      return {
        statusCode: 200,
        stream: blobStream(pdf),
        blob: {
          pathname,
          contentType: 'application/pdf',
          size: pdf.length,
          url: 'https://private-url-must-not-be-exposed.example'
        }
      };
    }
  });

  const result = await storage.getVerifiedReceiptPdf(readyReceipt(pdf, {
    blobPathname: pathname
  }));
  assert.deepEqual(call, [pathname, { access: 'private', useCache: false }]);
  assert.deepEqual(result, pdf);
  assert.equal(result.toString('ascii', 0, 5), '%PDF-');
  assert.equal(result.toString().includes('private-url-must-not-be-exposed'), false);
});

test('private Blob retrieval rejects missing objects and provider failures', async (t) => {
  const pdf = Buffer.from('%PDF-1.4\nreceipt');
  const receipt = readyReceipt(pdf);
  const missingStorage = createPrivateReceiptStorage({
    async getBlob() { return null; }
  });
  await assert.rejects(missingStorage.getVerifiedReceiptPdf(receipt));

  const failedStorage = createPrivateReceiptStorage({
    async getBlob() { throw new Error('provider details remain private'); }
  });
  await assert.rejects(
    failedStorage.getVerifiedReceiptPdf(receipt),
    /provider details remain private/
  );
});

test('private Blob retrieval rejects empty and non-PDF content', async () => {
  const pathname = 'applicant-payment-receipts/CN-DF-2025-ABC123/claim.pdf';
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a PDF')]) {
    const storage = createPrivateReceiptStorage({
      async getBlob() {
        return {
          statusCode: 200,
          stream: blobStream(bytes),
          blob: { pathname }
        };
      }
    });
    await assert.rejects(storage.getVerifiedReceiptPdf(readyReceipt(bytes, {
      blobPathname: pathname
    })));
  }
});

test('private Blob retrieval rejects malformed and mismatched receipt checksums', async () => {
  const pdf = Buffer.from('%PDF-1.4\nreceipt');
  const pathname = 'applicant-payment-receipts/CN-DF-2025-ABC123/claim.pdf';
  const storage = createPrivateReceiptStorage({
    async getBlob() {
      return {
        statusCode: 200,
        stream: blobStream(pdf),
        blob: { pathname }
      };
    }
  });
  await assert.rejects(storage.getVerifiedReceiptPdf(readyReceipt(pdf, {
    blobPathname: pathname,
    pdfSha256: 'not-a-checksum'
  })));
  await assert.rejects(storage.getVerifiedReceiptPdf(readyReceipt(pdf, {
    blobPathname: pathname,
    pdfSha256: crypto.createHash('sha256').update('different PDF').digest('hex')
  })));
});
