async function sendMagicLink({ to, loginUrl, expiresInMinutes }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error('Applicant email provider is not configured.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Your Cybanext applicant sign-in link',
      text: `Use this secure sign-in link within ${expiresInMinutes} minutes:\n${loginUrl}`,
      html: `<p>Use this secure sign-in link within ${expiresInMinutes} minutes:</p><p><a href="${loginUrl}">Sign in to your applicant account</a></p>`
    }),
    signal: AbortSignal.timeout(2000)
  });

  if (!response.ok) {
    throw new Error('Applicant email provider rejected the message.');
  }
}

async function sendNotificationEmail({ to, subject, text, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM;

  if (!apiKey || !from) {
    throw Object.assign(new Error('Applicant email provider is not configured.'), {
      notificationErrorCode: 'configuration_missing'
    });
  }

  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html,
        ...(attachments ? { attachments } : {})
      }),
      signal: AbortSignal.timeout(2000)
    });
  } catch (error) {
    throw Object.assign(new Error('Email delivery request failed.'), {
      notificationErrorCode: error?.name === 'TimeoutError' ||
        error?.name === 'AbortError' ? 'timeout' : 'network_error'
    });
  }

  if (!response.ok) {
    const permanentRequestError = [400, 422].includes(response.status);
    const credentialError = [401, 403].includes(response.status);
    const errorCode = response.status === 429
      ? 'resend_rate_limited'
      : [408, 425].includes(response.status)
        ? 'timeout'
      : response.status >= 500
        ? 'resend_server_error'
        : credentialError
          ? 'configuration_missing'
          : 'resend_rejected';
    throw Object.assign(new Error('Email provider rejected the message.'), {
      notificationErrorCode: errorCode,
      permanentFailure: permanentRequestError
    });
  }
}

module.exports = { sendMagicLink, sendNotificationEmail };
