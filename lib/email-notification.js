const { sendNotificationEmail } = require('./applicant-email');

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

  const text = `${name},\n\n${message}\n\n${siteUrl()}`;
  const html = `<p>${escapeHtml(name)},</p><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(siteUrl())}">Visit Cybanext</a></p>`;
  return { subject, text, html };
}

async function deliverNotification(event) {
  const message = createMessage(event);
  await sendNotificationEmail({
    to: event.recipientEmail,
    ...message
  });
}

module.exports = {
  MAX_ATTEMPTS,
  createMessage,
  deliverNotification
};
