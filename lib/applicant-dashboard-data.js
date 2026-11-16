const { findRegistration } = require('./digital-forensics-store');

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
  findApplicantRegistration = findRegistration
) {
  if (!registrationId) {
    return null;
  }

  const registration = await findApplicantRegistration(registrationId);
  if (!registration) {
    return null;
  }

  const status = normalizeStatus(registration.status);

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
    reference: registration.id
  };
}

module.exports = {
  applicationStatusLabel,
  getApplicantDashboardData,
  paymentStatusLabel,
  normalizeStatus
};
