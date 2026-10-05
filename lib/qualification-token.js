const crypto = require('crypto');

const TOKEN_LIFETIME_SECONDS = 60 * 60;

function getTokenSecret() {
  const secret = process.env.QUALIFICATION_TOKEN_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      'QUALIFICATION_TOKEN_SECRET must contain at least 32 characters.'
    );
  }

  return secret;
}

function sign(payload) {
  return crypto
    .createHmac('sha256', getTokenSecret())
    .update(payload)
    .digest('base64url');
}

function createQualificationToken(applicant) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    qualified: true,
    name: applicant.name,
    email: applicant.email.toLowerCase(),
    phone: applicant.phone || '',
    track: applicant.track,
    issuedAt: now,
    expiresAt: now + TOKEN_LIFETIME_SECONDS
  })).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

function verifyQualificationToken(token, options = {}) {
  if (typeof token !== 'string') {
    return null;
  }

  const [payload, signature, ...extraParts] = token.split('.');

  if (!payload || !signature || extraParts.length > 0) {
    return null;
  }

  let expectedSignature;

  try {
    expectedSignature = Buffer.from(sign(payload), 'base64url');
  } catch (error) {
    return null;
  }

  const receivedSignature = Buffer.from(signature, 'base64url');

  if (
    receivedSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return null;
  }

  let claims;

  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }

  if (
    claims.version !== 1 ||
    claims.qualified !== true ||
    typeof claims.email !== 'string' ||
    typeof claims.track !== 'string' ||
    !Number.isInteger(claims.expiresAt) ||
    (!options.allowExpired && claims.expiresAt <= Math.floor(Date.now() / 1000))
  ) {
    return null;
  }

  return claims;
}

module.exports = {
  createQualificationToken,
  verifyQualificationToken
};
