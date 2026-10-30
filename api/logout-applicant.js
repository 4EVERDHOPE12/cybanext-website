const {
  createApplicantAuthService,
  createClearedSessionCookie
} = require('../lib/applicant-auth-service');

function createHandler(service = createApplicantAuthService()) {
  return async function logoutApplicant(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const isProduction = process.env.NODE_ENV === 'production';
    res.setHeader(
      'Set-Cookie',
      createClearedSessionCookie(isProduction)
    );

    try {
      await service.logout(req.headers && req.headers.cookie);
      return res.status(200).json({ loggedOut: true });
    } catch {
      console.error('Applicant logout could not revoke the session.');
      return res.status(503).json({
        error: 'Sign-out is temporarily unavailable. Please try again.'
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
