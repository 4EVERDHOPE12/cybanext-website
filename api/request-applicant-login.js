const {
  createApplicantAuthService,
  getClientIp
} = require('../lib/applicant-auth-service');

function createHandler(service = createApplicantAuthService()) {
  return async function requestApplicantLogin(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    try {
      const body = req.body || {};
      const result = await service.requestLogin({
        email: body.email,
        ipAddress: getClientIp(req)
      });

      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      console.error('Applicant magic-link request could not be processed.');
      return res.status(503).json({
        error: 'Sign-in is temporarily unavailable. Please try again later.'
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
