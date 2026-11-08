const { parsePhoneNumberFromString } = require('libphonenumber-js');

const MAX_INPUT_LENGTH = 30;

function normalizeGhanaPhone(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  if (typeof value !== 'string') {
    throw new TypeError('Please provide a valid Ghanaian phone number.');
  }

  const input = value.trim();
  if (!input) {
    return '';
  }

  if (input.length > MAX_INPUT_LENGTH) {
    throw new TypeError('Please provide a valid Ghanaian phone number.');
  }

  const internationalInput = input.startsWith('+')
    ? input
    : input.startsWith('233')
      ? `+${input}`
      : input;
  const phone = input.startsWith('+') || input.startsWith('233')
    ? parsePhoneNumberFromString(internationalInput)
    : parsePhoneNumberFromString(input, 'GH');

  if (!phone || phone.country !== 'GH' || !phone.isValid()) {
    throw new TypeError('Please provide a valid Ghanaian phone number.');
  }

  return phone.number;
}

module.exports = { normalizeGhanaPhone };
