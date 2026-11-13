const SMS_CONSENT_PURPOSE =
  'SMS notifications confirming successful payment for a Cybanext programme.';
const SMS_CONSENT_POLICY_VERSION = 'sms-payment-success-v1';
const SMS_CONSENT_SOURCES = new Set([
  'main_application',
  'digital_forensics_standalone'
]);

function validateSmsConsent(smsConsent, phone) {
  if (smsConsent !== undefined && typeof smsConsent !== 'boolean') {
    throw new TypeError('SMS consent must be explicitly selected.');
  }

  if (smsConsent === true && !phone) {
    throw new TypeError(
      'A valid Ghanaian phone number is required to consent to SMS notifications.'
    );
  }
}

module.exports = {
  SMS_CONSENT_POLICY_VERSION,
  SMS_CONSENT_PURPOSE,
  SMS_CONSENT_SOURCES,
  validateSmsConsent
};
