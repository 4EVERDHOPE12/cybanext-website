const crypto = require('node:crypto');
const net = require('node:net');
const store = require('./applicant-auth-store');
const { sendMagicLink } = require('./applicant-email');

const CONFIRMATION_MESSAGE =
  "If that email has an account, we've sent a login link";
const SESSION_COOKIE_NAME = 'cybanext_applicant_session';
const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_RATE_LIMIT = 3;
const IP_RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return typeof email === 'string' &&
    email.length <= 254 &&
    EMAIL_PATTERN.test(email);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashRateLimitKey(secret, scope, value) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${scope}:${value}`)
    .digest('hex');
}

function getClientIp(req) {
  const forwardedFor = req.headers &&
    (req.headers['x-forwarded-for'] || req.headers['x-vercel-forwarded-for']);
  const candidates = typeof forwardedFor === 'string'
    ? forwardedFor.split(',').map((candidate) => candidate.trim())
    : [];
  const candidate = candidates.length
    ? candidates[candidates.length - 1]
    : req.socket && req.socket.remoteAddress;

  return typeof candidate === 'string' && net.isIP(candidate)
    ? candidate
    : null;
}

function buildMagicLink(siteUrl, token, isProduction) {
  const baseUrl = new URL(siteUrl);
  if (
    !['https:', 'http:'].includes(baseUrl.protocol) ||
    (isProduction && baseUrl.protocol !== 'https:') ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new Error('Applicant login site URL is invalid.');
  }

  const loginUrl = new URL('/applicant-login.html', baseUrl.origin);
  loginUrl.hash = new URLSearchParams({ token }).toString();
  return loginUrl.toString();
}

function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') {
    return null;
  }

  const prefix = `${SESSION_COOKIE_NAME}=`;
  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!cookie) {
    return null;
  }

  const token = cookie.slice(prefix.length);
  return TOKEN_PATTERN.test(token) ? token : null;
}

function createClearedSessionCookie(isProduction) {
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    'Path=/'
  ];

  if (isProduction) {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

function createApplicantAuthService(options = {}) {
  const authStore = options.store || store;
  const emailSender = options.sendMagicLink || sendMagicLink;
  const now = options.now || (() => new Date());
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const rateLimitSecret =
    options.rateLimitSecret || process.env.MAGIC_LINK_RATE_LIMIT_SECRET;
  const siteUrl = options.siteUrl || process.env.SITE_URL;
  const minimumResponseTimeMs = options.minimumResponseTimeMs === undefined
    ? 2200
    : options.minimumResponseTimeMs;
  const isProduction = options.isProduction === undefined
    ? process.env.NODE_ENV === 'production'
    : options.isProduction;
  const logger = options.logger || console;

  async function requestLogin({ email, ipAddress }) {
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return {
        statusCode: 400,
        body: { error: 'Enter a valid email address.' }
      };
    }

    const requestStartedAt = Date.now();

    try {
      if (
        typeof ipAddress !== 'string' ||
        !net.isIP(ipAddress) ||
        typeof rateLimitSecret !== 'string' ||
        rateLimitSecret.length < 32
      ) {
        throw new Error('Applicant login rate limiting is not configured.');
      }

      const emailKey = hashRateLimitKey(
        rateLimitSecret,
        'email',
        normalizedEmail
      );
      const ipKey = hashRateLimitKey(rateLimitSecret, 'ip', ipAddress);
      const [emailLimit, ipLimit] = await Promise.all([
        authStore.incrementRateLimit('email', emailKey, EMAIL_RATE_LIMIT),
        authStore.incrementRateLimit('ip', ipKey, IP_RATE_LIMIT)
      ]);

      if (emailLimit.allowed && ipLimit.allowed) {
        const applicant = await authStore.findEligibleApplicant(normalizedEmail);
        if (applicant) {
          const token = randomBytes(32).toString('base64url');
          const expiresAt = new Date(
            now().getTime() + MAGIC_LINK_LIFETIME_MS
          );
          const loginUrl = buildMagicLink(siteUrl, token, isProduction);

          await authStore.createMagicLinkToken({
            registrationId: applicant.registrationId,
            tokenHash: hashToken(token),
            expiresAt
          });

          try {
            await emailSender({
              to: normalizedEmail,
              loginUrl,
              expiresInMinutes: 15
            });
          } catch {
            logger.error('Applicant magic-link delivery failed.');
          }
        }
      }
    } catch (error) {
      logger.error('Applicant magic-link request failed.', {
        code: error && typeof error.code === 'string' ? error.code : 'unknown'
      });
    }

    const remainingDelay =
      minimumResponseTimeMs - (Date.now() - requestStartedAt);
    if (remainingDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingDelay));
    }

    return { statusCode: 200, body: { message: CONFIRMATION_MESSAGE } };
  }

  async function verifyLoginToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      return { authenticated: false };
    }

    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + SESSION_LIFETIME_MS);
    const session = await authStore.redeemMagicLinkToken({
      tokenHash: hashToken(token),
      sessionTokenHash: hashToken(sessionToken),
      expiresAt
    });

    if (!session) {
      return { authenticated: false };
    }

    const cookieParts = [
      `${SESSION_COOKIE_NAME}=${sessionToken}`,
      `Expires=${expiresAt.toUTCString()}`,
      `Max-Age=${SESSION_LIFETIME_MS / 1000}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/'
    ];

    if (isProduction) {
      cookieParts.push('Secure');
    }

    return {
      authenticated: true,
      cookie: cookieParts.join('; ')
    };
  }

  async function getSession(cookieHeader) {
    const sessionToken = readSessionCookie(cookieHeader);
    if (!sessionToken) {
      return null;
    }

    return authStore.findApplicantSession(hashToken(sessionToken));
  }

  async function logout(cookieHeader) {
    const sessionToken = readSessionCookie(cookieHeader);
    if (!sessionToken) {
      return false;
    }

    return authStore.revokeApplicantSession(hashToken(sessionToken));
  }

  return {
    getSession,
    logout,
    requestLogin,
    verifyLoginToken
  };
}

module.exports = {
  CONFIRMATION_MESSAGE,
  SESSION_COOKIE_NAME,
  createClearedSessionCookie,
  createApplicantAuthService,
  getClientIp,
  hashToken,
  isValidEmail,
  normalizeEmail
};
