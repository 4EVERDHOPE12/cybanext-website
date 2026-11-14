const ARKESEL_SEND_URL = 'https://sms.arkesel.com/api/v2/sms/send';
const REQUEST_TIMEOUT_MS = 10000;

function createSmsError(message, notificationErrorCode, permanentFailure = false) {
  return Object.assign(new Error(message), {
    notificationErrorCode,
    permanentFailure
  });
}

function createPaymentSuccessMessage(event) {
  if (event.eventType !== 'sms_payment_success') {
    throw createSmsError('Unsupported SMS notification event.', 'invalid_template_data', true);
  }

  const track = event.templateData?.track;
  if (typeof track !== 'string' || !/^[A-Za-z0-9_ -]{1,60}$/.test(track)) {
    throw createSmsError('SMS notification template is invalid.', 'invalid_template_data', true);
  }

  const trackLabel = track
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
  return `Cybanext: Your payment for ${trackLabel} is confirmed.`;
}

function responseMessageId(body) {
  const firstResult = Array.isArray(body?.data) ? body.data[0] : body?.data;
  const value = firstResult?.message_id ?? firstResult?.id ?? body?.message_id;
  if ((typeof value === 'string' || typeof value === 'number') &&
      String(value).length <= 256) {
    return String(value);
  }
  return null;
}

async function sendPaymentSuccessSms(event) {
  const message = createPaymentSuccessMessage(event);
  const apiKey = process.env.ARKESEL_API_KEY;
  const senderId = process.env.ARKESEL_SENDER_ID;
  if (!apiKey || !senderId || !/^[A-Za-z0-9]{1,11}$/.test(senderId)) {
    throw createSmsError('Arkesel SMS is not configured.', 'configuration_missing');
  }
  if (typeof event.phoneSnapshot !== 'string' ||
      !/^\+233[0-9]{9}$/.test(event.phoneSnapshot)) {
    throw createSmsError('SMS recipient phone number is invalid.', 'invalid_phone', true);
  }
  if (typeof globalThis.fetch !== 'function') {
    throw createSmsError('SMS transport is unavailable.', 'network_error');
  }

  let response;
  try {
    response = await globalThis.fetch(ARKESEL_SEND_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: senderId,
        message,
        recipients: [event.phoneSnapshot.slice(1)]
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw createSmsError(
      timedOut ? 'Arkesel SMS request timed out.' : 'Arkesel SMS request failed.',
      timedOut ? 'timeout' : 'network_error'
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw createSmsError('Arkesel SMS authentication failed.', 'configuration_missing');
    }
    if (response.status === 403) {
      throw createSmsError('Arkesel SMS gateway is inactive.', 'configuration_missing');
    }
    if (response.status === 429) {
      throw createSmsError('Arkesel SMS rate limit was reached.', 'arkesel_rate_limited');
    }
    if (response.status >= 500) {
      throw createSmsError('Arkesel SMS service is unavailable.', 'arkesel_server_error');
    }
    const permanentFailure = [400, 422].includes(response.status);
    throw createSmsError(
      'Arkesel rejected the SMS request.',
      'arkesel_rejected',
      permanentFailure
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw createSmsError('Arkesel returned an invalid response.', 'invalid_response');
  }

  if (!body || String(body.status).toLowerCase() !== 'success') {
    throw createSmsError('Arkesel did not accept the SMS request.', 'arkesel_rejected');
  }

  return { providerMessageId: responseMessageId(body) };
}

module.exports = {
  ARKESEL_SEND_URL,
  createPaymentSuccessMessage,
  sendPaymentSuccessSms
};
