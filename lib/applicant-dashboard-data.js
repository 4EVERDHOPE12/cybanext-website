const { findRegistration } = require('./digital-forensics-store');
const regularTrackStore = require('./regular-track-payment-store');
const {
  getReceiptEligibilityForRegistration
} = require('./applicant-payment-receipts');

const REGULAR_TRACK_LABELS = {
  incident_response: 'Incident Response',
  soc_analyst: 'SOC Analyst',
  network_security: 'Network Security',
  web_app_penetration_testing: 'Web Application Penetration Testing',
  cloud_security: 'Cloud Security'
};

const PAYMENT_STATUSES = new Set([
  'pending',
  'payment_initiated',
  'payment_verified',
  'paid',
  'payment_failed'
]);

function normalizeStatus(status) {
  if (status === 'paid') {
    return 'payment_verified';
  }
  return PAYMENT_STATUSES.has(status) ? status : 'unknown';
}

function paymentStatusLabel(status) {
  switch (normalizeStatus(status)) {
    case 'payment_verified':
      return 'Verified';
    case 'payment_initiated':
      return 'Verification pending';
    case 'payment_failed':
      return 'Payment failed';
    case 'pending':
      return 'Not started';
    default:
      return 'Status unavailable';
  }
}

function applicationStatusLabel(status) {
  const normalizedStatus = normalizeStatus(status);
  if (normalizedStatus === 'payment_verified') {
    return 'Confirmed';
  }
  return normalizedStatus === 'unknown' ? 'Status unavailable' : 'Received';
}

async function getApplicantDashboardData(
  registrationId,
  applicantType,
  dependencies = {}
) {
  if (
    !registrationId ||
    !['digital_forensics', 'regular_track'].includes(applicantType)
  ) {
    return null;
  }

  const {
    findDigitalForensicsRegistration = findRegistration,
    findRegularTrackApplicant = regularTrackStore.findApplicant,
    findLatestRegularTrackPaymentAttempt =
      regularTrackStore.findLatestPaymentAttemptForApplicant,
    getReceiptEligibility = getReceiptEligibilityForRegistration
  } = dependencies;

  if (applicantType === 'regular_track') {
    const registration = await findRegularTrackApplicant(registrationId);
    if (!registration) {
      return null;
    }

    const paymentAttempt =
      await findLatestRegularTrackPaymentAttempt(registrationId);
    const attemptStatus = paymentAttempt && paymentAttempt.status;
    const status = registration.status === 'payment_verified' ||
      attemptStatus === 'payment_verified'
      ? 'payment_verified'
      : ['initializing', 'payment_initiated'].includes(attemptStatus)
        ? 'payment_initiated'
        : ['failed', 'initialization_failed'].includes(attemptStatus)
          ? 'payment_failed'
          : normalizeStatus(registration.status);

    return {
      fullName: registration.fullName || 'Applicant',
      email: registration.email,
      registrationId: registration.id,
      role: 'applicant',
      track: REGULAR_TRACK_LABELS[registration.track] || 'Regular Track',
      status,
      applicationStatus: applicationStatusLabel(status),
      paymentStatus: paymentStatusLabel(status),
      amountDue: null,
      currency: null,
      paymentReference: paymentAttempt ? paymentAttempt.reference : null,
      verifiedTransactionId:
        paymentAttempt && paymentAttempt.verifiedTransactionId
          ? paymentAttempt.verifiedTransactionId
          : null,
      paymentVerificationTimestamp:
        paymentAttempt && paymentAttempt.paymentVerificationTimestamp
          ? paymentAttempt.paymentVerificationTimestamp
          : null,
      createdAt: registration.createdAt || null,
      canPay: false,
      canDownloadReceipt: false,
      canResendReceipt: false,
      reference: registration.id
    };
  }

  const registration = await findDigitalForensicsRegistration(registrationId);
  if (!registration) {
    return null;
  }

  const status = normalizeStatus(registration.status);
  const receiptEligibility = registration.course === 'digital_forensics' &&
    status === 'payment_verified'
    ? await getReceiptEligibility(registrationId)
    : { paymentVerified: false, receipt: null };
  const receiptReady = receiptEligibility.paymentVerified &&
    Boolean(receiptEligibility.receipt);

  return {
    fullName: registration.fullName || 'Applicant',
    email: registration.email,
    registrationId: registration.id,
    role: 'applicant',
    track: registration.course === 'digital_forensics'
      ? 'Digital Forensics'
      : registration.course,
    status,
    applicationStatus: applicationStatusLabel(status),
    paymentStatus: paymentStatusLabel(status),
    amountDue: Number(registration.expectedAmount),
    currency: registration.expectedCurrency,
    pricingOption: registration.pricingOption,
    paymentReference: registration.paymentReference || null,
    verifiedTransactionId: registration.verifiedTransactionId || null,
    paymentVerificationTimestamp:
      registration.paymentVerificationTimestamp || null,
    createdAt: registration.createdAt || null,
    canPay: ['pending', 'payment_failed'].includes(status),
    canDownloadReceipt: receiptReady,
    canResendReceipt: receiptReady,
    reference: registration.id
  };
}

module.exports = {
  applicationStatusLabel,
  getApplicantDashboardData,
  paymentStatusLabel,
  normalizeStatus,
  REGULAR_TRACK_LABELS
};
