const { sendNotificationEmail } = require('./applicant-email');
const applicantPaymentReceipts = require('./applicant-payment-receipts');
const privateReceiptStorage = require('./applicant-payment-receipt-storage');

const MAX_ATTEMPTS = 5;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function siteUrl() {
  return (process.env.SITE_URL || 'https://cybanext-website.vercel.app').replace(/\/+$/, '');
}

function createMessage(event) {
  const data = event.templateData || {};
  const name = typeof data.fullName === 'string' ? data.fullName : 'Applicant';
  const track = typeof data.track === 'string' ? data.track : 'your programme';
  const isDigitalForensicsPaymentSuccess =
    event.eventType === 'digital_forensics_payment_success';
  const callToAction = isDigitalForensicsPaymentSuccess
    ? 'Visit Applicant Dashboard'
    : 'Visit Cybanext';
  const callToActionUrl = isDigitalForensicsPaymentSuccess
    ? `${siteUrl()}/applicant-login.html`
    : siteUrl();
  let subject;
  let message;

  switch (event.eventType) {
    case 'regular_track_registration_confirmation':
    case 'digital_forensics_registration_confirmation':
      subject = 'Cybanext registration received';
      message = `Your registration for ${track} has been received. We will share further updates with you by email.`;
      break;
    case 'regular_track_payment_success':
    case 'digital_forensics_payment_success':
      subject = 'Cybanext payment confirmed';
      message = `Your payment for ${track} has been verified. Your registration is now marked as payment verified.`;
      break;
    case 'digital_forensics_receipt_resend':
      subject = 'Your Cybanext payment receipt';
      message = `As requested, your verified payment receipt for ${track} is attached.`;
      break;
    case 'regular_track_payment_failure':
    case 'digital_forensics_payment_failure':
      subject = 'Cybanext payment not completed';
      message = `Paystack reported that the payment attempt for ${track} failed. You may return to your registration and try again.`;
      break;
    default:
      throw Object.assign(new Error('Unsupported notification event.'), {
        notificationErrorCode: 'invalid_template_data'
      });
  }

  const textCallToAction = isDigitalForensicsPaymentSuccess
    ? `${callToAction}: ${callToActionUrl}`
    : callToActionUrl;
  const text = `${name},\n\n${message}\n\n${textCallToAction}`;
  const html = `<p>${escapeHtml(name)},</p><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(callToActionUrl)}">${callToAction}</a></p>`;
  return { subject, text, html };
}

function createNotificationDelivery({
  receiptService = applicantPaymentReceipts,
  receiptStorage = privateReceiptStorage,
  emailSender = sendNotificationEmail
} = {}) {
  return async function deliverNotification(event) {
    const message = createMessage(event);
    let attachments;

    if (
      event.eventType === 'digital_forensics_payment_success' ||
      event.eventType === 'digital_forensics_receipt_resend'
    ) {
      if (typeof event.digitalForensicsRegistrationId !== 'string') {
        throw Object.assign(new Error('Receipt registration is unavailable.'), {
          notificationErrorCode: 'invalid_template_data'
        });
      }

      const receipt = event.eventType === 'digital_forensics_payment_success'
        ? await receiptService.ensureReceiptForRegistration(
          event.digitalForensicsRegistrationId
        )
        : await receiptService.getReadyReceiptForRegistration(
          event.digitalForensicsRegistrationId
        );
      if (!receipt || receipt.generationStatus !== 'ready') {
        throw Object.assign(new Error('Verified payment receipt is unavailable.'), {
          notificationErrorCode: 'delivery_error'
        });
      }
      if (
        typeof receipt.receiptNumber !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(receipt.receiptNumber)
      ) {
        throw Object.assign(new Error('Verified payment receipt details are invalid.'), {
          notificationErrorCode: 'delivery_error'
        });
      }

      const pdf = await receiptStorage.getVerifiedReceiptPdf(receipt);
      if (!Buffer.isBuffer(pdf) || pdf.length === 0) {
        throw Object.assign(new Error('Verified payment receipt content is invalid.'), {
          notificationErrorCode: 'delivery_error'
        });
      }
      attachments = [{
        filename: `Cybanext-Payment-Receipt-${receipt.receiptNumber}.pdf`,
        content: pdf.toString('base64'),
        content_type: 'application/pdf'
      }];
    }

    await emailSender({
      to: event.recipientEmail,
      ...message,
      ...(attachments ? { attachments } : {})
    });
  };
}

const deliverNotification = createNotificationDelivery();

module.exports = {
  MAX_ATTEMPTS,
  createMessage,
  createNotificationDelivery,
  deliverNotification
};
