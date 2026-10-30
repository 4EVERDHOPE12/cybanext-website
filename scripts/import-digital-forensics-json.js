const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const DEFAULT_FILE = path.join(
  __dirname,
  '..',
  '.data',
  'digital-forensics-registrations.json'
);

const INSERT_FIELDS = [
  'id',
  'fullName',
  'email',
  'phone',
  'course',
  'status',
  'pricingOption',
  'expectedAmount',
  'expectedCurrency',
  'paymentReference',
  'verifiedTransactionId',
  'paymentVerificationTimestamp',
  'emailNotificationStatus',
  'smsNotificationStatus',
  'createdAt',
  'updatedAt'
];

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
}

function normalizeRegistration(record) {
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.fullName !== 'string' ||
    typeof record.email !== 'string' ||
    typeof record.phone !== 'string' ||
    record.course !== 'digital_forensics' ||
    !['pending', 'payment_initiated', 'payment_verified', 'paid'].includes(record.status) ||
    !Number.isFinite(Number(record.expectedAmount)) ||
    record.expectedAmount <= 0 ||
    record.expectedCurrency !== 'GHS' ||
    !record.createdAt ||
    !record.updatedAt
  ) {
    throw new Error('A legacy registration record is incomplete or invalid.');
  }

  return {
    id: record.id,
    fullName: record.fullName,
    email: record.email.trim().toLowerCase(),
    phone: record.phone,
    course: record.course,
    status: record.status,
    pricingOption: record.pricingOption || null,
    expectedAmount: Number(record.expectedAmount),
    expectedCurrency: record.expectedCurrency,
    paymentReference: record.paymentReference || null,
    verifiedTransactionId:
      record.verifiedTransactionId === null ||
      record.verifiedTransactionId === undefined
      ? null
      : String(record.verifiedTransactionId),
    paymentVerificationTimestamp:
      normalizeTimestamp(record.paymentVerificationTimestamp),
    emailNotificationStatus: record.emailNotificationStatus || 'pending',
    smsNotificationStatus: record.smsNotificationStatus || 'pending',
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt)
  };
}

function sameRegistration(existing, source) {
  return INSERT_FIELDS.every((field) => {
    const existingValue =
      field === 'expectedAmount'
        ? Number(existing[field])
        : ['createdAt', 'updatedAt', 'paymentVerificationTimestamp'].includes(field)
          ? normalizeTimestamp(existing[field])
          : existing[field] ?? null;
    const sourceValue =
      field === 'createdAt' || field === 'updatedAt' ||
        field === 'paymentVerificationTimestamp'
        ? normalizeTimestamp(source[field])
        : source[field] ?? null;
    return existingValue === sourceValue;
  });
}

async function importRecords(filePath, apply) {
  if (!fs.existsSync(filePath)) {
    throw new Error('The legacy JSON registration file was not found.');
  }

  const raw = await fs.promises.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('The legacy JSON registration file must contain an array.');
  }

  const records = parsed.map(normalizeRegistration);

  if (!apply) {
    console.log(`Validated ${records.length} registration records. No data was imported.`);
    console.log('Review the source and rerun with --apply to import into PostgreSQL.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when importing records.');
  }

  const sql = neon(process.env.DATABASE_URL);
  let imported = 0;
  let alreadyImported = 0;

  for (const record of records) {
    const inserted = await sql`
      INSERT INTO digital_forensics_registrations (
        registration_id,
        full_name,
        email,
        phone,
        course,
        status,
        pricing_option,
        expected_amount,
        expected_currency,
        payment_reference,
        verified_transaction_id,
        payment_verification_timestamp,
        email_notification_status,
        sms_notification_status,
        created_at,
        updated_at
      )
      VALUES (
        ${record.id},
        ${record.fullName},
        ${record.email},
        ${record.phone},
        ${record.course},
        ${record.status},
        ${record.pricingOption},
        ${record.expectedAmount},
        ${record.expectedCurrency},
        ${record.paymentReference},
        ${record.verifiedTransactionId},
        ${record.paymentVerificationTimestamp},
        ${record.emailNotificationStatus},
        ${record.smsNotificationStatus},
        ${record.createdAt},
        ${record.updatedAt}
      )
      ON CONFLICT (registration_id) DO NOTHING
      RETURNING registration_id
    `;

    if (inserted.length > 0) {
      imported += 1;
      continue;
    }

    const existingRows = await sql`
      SELECT
        registration_id AS id,
        full_name AS "fullName",
        email,
        phone,
        course,
        status,
        pricing_option AS "pricingOption",
        expected_amount AS "expectedAmount",
        expected_currency AS "expectedCurrency",
        payment_reference AS "paymentReference",
        verified_transaction_id AS "verifiedTransactionId",
        payment_verification_timestamp AS "paymentVerificationTimestamp",
        email_notification_status AS "emailNotificationStatus",
        sms_notification_status AS "smsNotificationStatus",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM digital_forensics_registrations
      WHERE registration_id = ${record.id}
      LIMIT 1
    `;

    if (!existingRows[0] || !sameRegistration(existingRows[0], record)) {
      throw new Error(
        'A registration ID already exists with different data, or a payment reference conflicts. Import stopped.'
      );
    }

    alreadyImported += 1;
  }

  console.log(
    `Import complete: ${imported} inserted, ${alreadyImported} identical records already present.`
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const fileArgumentIndex = process.argv.indexOf('--file');
  const filePath = fileArgumentIndex === -1
    ? DEFAULT_FILE
    : path.resolve(process.cwd(), process.argv[fileArgumentIndex + 1] || '');

  await importRecords(filePath, apply);
}

main().catch((error) => {
  const code = error && typeof error.code === 'string' ? error.code : 'unknown';
  console.error(`Registration import failed (database/error code: ${code}).`);
  process.exitCode = 1;
});
