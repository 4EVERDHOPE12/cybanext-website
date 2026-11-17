const crypto = require('node:crypto');
const net = require('node:net');
const authStore = require('./applicant-auth-store');
const {
  getClientIp,
  isValidEmail,
  normalizeEmail
} = require('./applicant-auth-service');
const applicantPaymentReceipts = require('./applicant-payment-receipts');
const { enqueueReceiptResend } = require('./email-notification-outbox');

const CONFIRMATION_MESSAGE =
  'If an eligible paid application is found, the receipt will be sent to the registered email address.';
const WINDOW_MS = 15 * 60 * 1000;
const EMAIL_LIMIT = 3;
const IP_LIMIT = 10;

function hashRateLimitKey(secret, scope, value) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${scope}:${value}`)
    .digest('hex');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createApplicantReceiptResendService({
  store = authStore,
  receiptService = applicantPaymentReceipts,
  enqueue = enqueueReceiptResend,
  rateLimitSecret = process.env.MAGIC_LINK_RATE_LIMIT_SECRET,
  now = () => Date.now(),
  minimumResponseTimeMs = 2200
} = {}) {
  async function checkRateLimits({ email, ipAddress }) {
    if (
      typeof rateLimitSecret !== 'string' ||
      rateLimitSecret.length < 32 ||
      typeof ipAddress !== 'string' ||
      !net.isIP(ipAddress)
    ) {
      throw new Error('Receipt resend rate limiting is not configured.');
    }

    const limits = [];
    if (email) {
      limits.push(store.incrementRateLimit(
        'receipt_resend_email',
        hashRateLimitKey(rateLimitSecret, 'receipt_resend_email', email),
        EMAIL_LIMIT
      ));
    }
    limits.push(store.incrementRateLimit(
      'receipt_resend_ip',
      hashRateLimitKey(rateLimitSecret, 'receipt_resend_ip', ipAddress),
      IP_LIMIT
    ));
    const results = await Promise.all(limits);
    return results.every((result) => result && result.allowed);
  }

  function makeEventKey(registrationId) {
    const registrationHash = crypto
      .createHash('sha256')
      .update(registrationId)
      .digest('hex');
    return `digital-forensics-receipt-resend:${registrationHash}:${Math.floor(now() / WINDOW_MS)}`;
  }

  async function requestPublicResend({ email, ipAddress }) {
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return {
        statusCode: 400,
        body: { error: 'Enter a valid email address.' }
      };
    }

    const requestStartedAt = Date.now();
    try {
      const allowed = await checkRateLimits({
        email: normalizedEmail,
        ipAddress
      });
      if (allowed) {
        const receipt = await receiptService.findReadyReceiptForEmail(normalizedEmail);
        if (receipt && typeof receipt.registrationId === 'string') {
          await enqueue({
            registrationId: receipt.registrationId,
            eventKey: makeEventKey(receipt.registrationId)
          });
        }
      }
    } finally {
      const delay = minimumResponseTimeMs - (Date.now() - requestStartedAt);
      if (delay > 0) await wait(delay);
    }

    return {
      statusCode: 200,
      body: { message: CONFIRMATION_MESSAGE }
    };
  }

  async function requestAuthenticatedResend({ registrationId, ipAddress }) {
    if (typeof registrationId !== 'string' || registrationId.length === 0) {
      throw new TypeError('An authenticated registration ID is required.');
    }
    const allowed = await checkRateLimits({ ipAddress });
    if (!allowed) {
      return {
        statusCode: 429,
        body: { error: 'Please wait before requesting another receipt email.' }
      };
    }

    const eligibility =
      await receiptService.getReceiptEligibilityForRegistration(registrationId);
    if (!eligibility.paymentVerified) {
      return {
        statusCode: 409,
        body: { error: 'A verified payment is required before a receipt can be resent.' }
      };
    }
    const receipt = eligibility.receipt;
    if (!receipt || receipt.registrationId !== registrationId) {
      return {
        statusCode: 404,
        body: { error: 'A verified payment receipt is not available.' }
      };
    }

    await enqueue({
      registrationId,
      eventKey: makeEventKey(registrationId)
    });
    return {
      statusCode: 202,
      body: { message: 'Your receipt email request has been accepted.' }
    };
  }

  return { requestAuthenticatedResend, requestPublicResend };
}

const service = createApplicantReceiptResendService();

module.exports = {
  CONFIRMATION_MESSAGE,
  createApplicantReceiptResendService,
  requestAuthenticatedResend: service.requestAuthenticatedResend,
  requestPublicResend: service.requestPublicResend,
  getClientIp
};