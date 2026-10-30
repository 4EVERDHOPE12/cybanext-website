const { createApplicantAuthService } = require('../lib/applicant-auth-service');

function createHandler(service = createApplicantAuthService()) {
  return async function getApplicantSession(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    try {
      const session = await service.getSession(
        req.headers && req.headers.cookie
      );

      if (!session) {
        return res.status(401).json({ authenticated: false });
      }

      return res.status(200).json({ authenticated: true });
    } catch {
      console.error('Applicant session validation failed.');
      return res.status(503).json({
        error: 'Sign-in is temporarily unavailable. Please try again later.'
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
