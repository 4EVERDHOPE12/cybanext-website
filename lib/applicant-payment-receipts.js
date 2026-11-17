const crypto = require('node:crypto');
const database = require('./digital-forensics-database');
const registrationStore = require('./digital-forensics-store');
const { generatePaymentReceiptPdf } = require('./applicant-payment-receipt-pdf');
const {
  deletePrivateReceipt,
  putPrivateReceipt
} = require('./applicant-payment-receipt-storage');

const GENERATION_LEASE_MS = 5 * 60 * 1000;

function mapReceipt(row) {
  if (!row) return null;
  return {
    id: row.id,
    registrationId: row.registrationId,
    receiptNumber: row.receiptNumber,
    paymentReference: row.paymentReference,
    verifiedTransactionId: row.verifiedTransactionId,
    applicantName: row.applicantName,
    amount: Number(row.amount),
    currency: row.currency,
    verifiedAt: row.verifiedAt instanceof Date
      ? row.verifiedAt.toISOString()
      : new Date(row.verifiedAt).toISOString(),
    blobPathname: row.blobPathname,
    generationStatus: row.generationStatus,
    generationToken: row.generationToken,
    leaseExpiresAt: row.leaseExpiresAt,
    pdfSha256: row.pdfSha256
  };
}

function createReceiptNumber(verifiedAt) {
  const year = new Date(verifiedAt).getUTCFullYear();
  return `CN-DF-${year}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function isVerifiedRegistration(registration) {
  const amount = Number(registration && registration.expectedAmount);
  const verifiedAt = registration && new Date(registration.paymentVerificationTimestamp);
  return Boolean(
    registration &&
    ['payment_verified', 'paid'].includes(registration.status) &&
    registration.course === 'digital_forensics' &&
    typeof registration.paymentReference === 'string' &&
    registration.paymentReference.length > 0 &&
    registration.verifiedTransactionId !== null &&
    registration.verifiedTransactionId !== undefined &&
    String(registration.verifiedTransactionId).length > 0 &&
    Number.isFinite(amount) &&
    amount > 0 &&
    registration.expectedCurrency === 'GHS' &&
    registration.paymentVerificationTimestamp !== null &&
    registration.paymentVerificationTimestamp !== undefined &&
    verifiedAt &&
    !Number.isNaN(verifiedAt.getTime())
  );
}

function createApplicantPaymentReceiptService({
  receiptDatabase = database,
  applicantStore = registrationStore,
  pdfGenerator = generatePaymentReceiptPdf,
  blobWriter = putPrivateReceipt,
  blobDeleter = deletePrivateReceipt
} = {}) {
  async function findReceipt(registrationId) {
    const rows = await receiptDatabase.query`
      SELECT
        receipt_id AS id,
        registration_id AS "registrationId",
        receipt_number AS "receiptNumber",
        payment_reference AS "paymentReference",
        verified_transaction_id AS "verifiedTransactionId",
        applicant_name AS "applicantName",
        amount,
        currency,
        verified_at AS "verifiedAt",
        blob_pathname AS "blobPathname",
        generation_status AS "generationStatus",
        generation_token AS "generationToken",
        lease_expires_at AS "leaseExpiresAt",
        pdf_sha256 AS "pdfSha256"
      FROM applicant_payment_receipts
      WHERE registration_id = ${registrationId}
      LIMIT 1
    `;
    return mapReceipt(rows[0]);
  }

  async function getReceiptEligibilityForRegistration(registrationId) {
    if (typeof registrationId !== 'string' || registrationId.length === 0) {
      throw new TypeError('A Digital Forensics registration ID is required.');
    }

    const registration = await applicantStore.findRegistration(registrationId);
    if (!isVerifiedRegistration(registration)) {
      return { paymentVerified: false, receipt: null };
    }
    if (registration.id !== registrationId) {
      throw new Error('Registration lookup returned a different applicant.');
    }

    const receipt = await findReceipt(registrationId);
    if (!receipt) return { paymentVerified: true, receipt: null };
    if (
      receipt.registrationId !== registration.id ||
      receipt.paymentReference !== registration.paymentReference ||
      String(receipt.verifiedTransactionId) !== String(registration.verifiedTransactionId)
    ) {
      throw new Error('Stored receipt does not match the verified payment.');
    }
    const receiptReady = receipt.generationStatus === 'ready' &&
      typeof receipt.blobPathname === 'string' &&
      /^[a-f0-9]{64}$/.test(receipt.pdfSha256 || '');
    return {
      paymentVerified: true,
      receipt: receiptReady ? receipt : null
    };
  }

  async function getReadyReceiptForRegistration(registrationId) {
    const eligibility =
      await getReceiptEligibilityForRegistration(registrationId);
    return eligibility.receipt;
  }

  async function findReadyReceiptForEmail(email) {
    const rows = await receiptDatabase.query`
      SELECT receipt.registration_id AS "registrationId"
      FROM applicant_payment_receipts AS receipt
      JOIN digital_forensics_registrations AS registration
        ON registration.registration_id = receipt.registration_id
      WHERE registration.email = ${email}
        AND registration.course = 'digital_forensics'
        AND registration.status IN ('payment_verified', 'paid')
        AND registration.payment_reference = receipt.payment_reference
        AND registration.verified_transaction_id::text = receipt.verified_transaction_id
        AND registration.payment_verification_timestamp = receipt.verified_at
        AND receipt.generation_status = 'ready'
        AND receipt.blob_pathname IS NOT NULL
        AND receipt.pdf_sha256 ~ '^[a-f0-9]{64}$'
      ORDER BY receipt.created_at DESC
      LIMIT 1
    `;
    if (!rows[0]) return null;
    return getReadyReceiptForRegistration(rows[0].registrationId);
  }

  async function createReceipt(registration) {
    const receiptNumber = createReceiptNumber(registration.paymentVerificationTimestamp);
    await receiptDatabase.query`
      INSERT INTO applicant_payment_receipts (
        receipt_number,
        registration_id,
        payment_reference,
        verified_transaction_id,
        applicant_name,
        amount,
        currency,
        verified_at
      )
      SELECT
        ${receiptNumber},
        registration_id,
        payment_reference,
        verified_transaction_id,
        full_name,
        expected_amount,
        expected_currency,
        payment_verification_timestamp
      FROM digital_forensics_registrations
      WHERE registration_id = ${registration.id}
        AND status IN ('payment_verified', 'paid')
        AND payment_reference = ${registration.paymentReference}
        AND verified_transaction_id::text = ${String(registration.verifiedTransactionId)}
        AND payment_verification_timestamp IS NOT NULL
      ON CONFLICT (registration_id) DO NOTHING
      RETURNING receipt_id AS id
    `;
    return findReceipt(registration.id);
  }

  async function acquireGenerationClaim(receipt) {
    const claimToken = crypto.randomUUID();
    const rows = await receiptDatabase.query`
      UPDATE applicant_payment_receipts
      SET generation_status = 'generating',
          generation_token = ${claimToken}::uuid,
          lease_expires_at = clock_timestamp() + (${GENERATION_LEASE_MS} * INTERVAL '1 millisecond'),
          updated_at = CURRENT_TIMESTAMP
      WHERE receipt_id = ${receipt.id}::uuid
        AND generation_status <> 'ready'
        AND (
          generation_status = 'pending'
          OR lease_expires_at <= clock_timestamp()
        )
      RETURNING receipt_id AS id
    `;
    return rows[0] ? claimToken : null;
  }

  async function completeGeneration(receipt, claimToken, blobPathname, checksum) {
    const rows = await receiptDatabase.query`
      UPDATE applicant_payment_receipts
      SET generation_status = 'ready',
          generation_token = NULL,
          lease_expires_at = NULL,
          blob_pathname = ${blobPathname},
          pdf_sha256 = ${checksum},
          updated_at = CURRENT_TIMESTAMP
      WHERE receipt_id = ${receipt.id}::uuid
        AND generation_status = 'generating'
        AND generation_token = ${claimToken}::uuid
        AND lease_expires_at > clock_timestamp()
      RETURNING receipt_id AS id
    `;
    return rows[0] ? findReceipt(receipt.registrationId) : null;
  }

  async function releaseGenerationClaim(receipt, claimToken) {
    await receiptDatabase.query`
      UPDATE applicant_payment_receipts
      SET generation_status = 'pending',
          generation_token = NULL,
          lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE receipt_id = ${receipt.id}::uuid
        AND generation_status = 'generating'
        AND generation_token = ${claimToken}::uuid
    `;
  }

  async function cleanupUnreferencedBlob(blobPathname) {
    let rows;
    try {
      rows = await receiptDatabase.query`
        SELECT 1 AS referenced
        FROM applicant_payment_receipts
        WHERE blob_pathname = ${blobPathname}
        LIMIT 1
      `;
    } catch (error) {
      console.error('Receipt Blob cleanup reference check failed; leaving object untouched.', {
        code: error && typeof error.code === 'string' &&
          /^[A-Za-z0-9_-]{1,32}$/.test(error.code)
          ? error.code
          : 'unknown'
      });
      return;
    }

    if (!Array.isArray(rows)) {
      console.error('Receipt Blob cleanup reference check returned an invalid result; leaving object untouched.');
      return;
    }
    if (rows.length > 0) return;

    try {
      await blobDeleter(blobPathname);
    } catch (error) {
      console.error('Unreferenced receipt Blob cleanup failed.', {
        code: error && typeof error.code === 'string' &&
          /^[A-Za-z0-9_-]{1,32}$/.test(error.code)
          ? error.code
          : 'unknown'
      });
    }
  }

  async function ensureReceiptForRegistration(registrationId) {
    if (typeof registrationId !== 'string' || registrationId.length === 0) {
      throw new TypeError('A Digital Forensics registration ID is required.');
    }

    const registration = await applicantStore.findRegistration(registrationId);
    if (!isVerifiedRegistration(registration)) return null;
    if (registration.id !== registrationId) {
      throw new Error('Registration lookup returned a different applicant.');
    }

    let receipt = await createReceipt(registration);
    if (!receipt) return null;

    if (
      receipt.registrationId !== registration.id ||
      receipt.paymentReference !== registration.paymentReference ||
      String(receipt.verifiedTransactionId) !== String(registration.verifiedTransactionId)
    ) {
      throw new Error('Stored receipt does not match the verified payment.');
    }
    if (receipt.generationStatus === 'ready') return receipt;

    const claimToken = await acquireGenerationClaim(receipt);
    if (!claimToken) {
      receipt = await findReceipt(registrationId);
      return receipt;
    }

    try {
      const pdf = await pdfGenerator(receipt);
      if (!Buffer.isBuffer(pdf)) {
        throw new TypeError('Receipt PDF generator must return a Buffer.');
      }
      const checksum = crypto.createHash('sha256').update(pdf).digest('hex');
      const blobPathname =
        `applicant-payment-receipts/${receipt.receiptNumber}/${claimToken}.pdf`;
      await blobWriter(blobPathname, pdf);
      const completedReceipt =
        await completeGeneration(receipt, claimToken, blobPathname, checksum);
      if (completedReceipt) return completedReceipt;
      // The claim UUID makes this pathname unique to the worker that just lost publication.
      await cleanupUnreferencedBlob(blobPathname);
      return findReceipt(registrationId);
    } catch (error) {
      try {
        await releaseGenerationClaim(receipt, claimToken);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'Receipt generation failed and its generation claim could not be released.'
        );
      }
      throw error;
    }
  }

  return {
    ensureReceiptForRegistration,
    findReadyReceiptForEmail,
    getReceiptEligibilityForRegistration,
    getReadyReceiptForRegistration
  };
}

const service = createApplicantPaymentReceiptService();

module.exports = {
  createApplicantPaymentReceiptService,
  findReadyReceiptForEmail: service.findReadyReceiptForEmail,
  getReceiptEligibilityForRegistration: service.getReceiptEligibilityForRegistration,
  getReadyReceiptForRegistration: service.getReadyReceiptForRegistration,
  ensureReceiptForRegistration: service.ensureReceiptForRegistration,
  isVerifiedRegistration
};