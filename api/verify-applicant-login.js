const { createApplicantAuthService } = require('../lib/applicant-auth-service');

function createHandler(service = createApplicantAuthService()) {
  return async function verifyApplicantLogin(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    try {
      const result = await service.verifyLoginToken(
        req.body && req.body.token
      );

      if (!result.authenticated) {
        return res.status(401).json({
          error: 'That sign-in link has expired or was already used. Request a new link.'
        });
      }

      res.setHeader('Set-Cookie', result.cookie);
      return res.status(200).json({ authenticated: true });
    } catch {
      console.error('Applicant magic-link verification failed.');
      return res.status(503).json({
        error: 'Sign-in is temporarily unavailable. Please try again later.'
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
