const { createApplicantAuthService } = require('../lib/applicant-auth-service');
const { getApplicantDashboardData } = require('../lib/applicant-dashboard-data');

function createHandler(
  service = createApplicantAuthService(),
  getDashboardData = getApplicantDashboardData
) {
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

      if (req.query && req.query.includeDashboard === 'true') {
        if (!session.registrationId) {
          return res.status(401).json({ authenticated: false });
        }

        try {
          const applicant = await getDashboardData(session.registrationId);
          if (!applicant) {
            return res.status(404).json({
              authenticated: true,
              applicant: null,
              error: 'Applicant record not found.'
            });
          }

          return res.status(200).json({
            authenticated: true,
            applicant
          });
        } catch {
          console.error('Applicant dashboard data lookup failed.');
          return res.status(503).json({
            authenticated: false,
            error: 'Your dashboard is temporarily unavailable. Please try again later.'
          });
        }
      }

      return res.status(200).json({
        authenticated: true,
        applicationReference: session.registrationId || null
      });
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
