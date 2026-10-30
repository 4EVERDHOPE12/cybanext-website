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

module.exports = { sendMagicLink };
