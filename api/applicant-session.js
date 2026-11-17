const { createApplicantAuthService } = require('../lib/applicant-auth-service');
const { getApplicantDashboardData } = require('../lib/applicant-dashboard-data');
const applicantPaymentReceipts = require('../lib/applicant-payment-receipts');
const receiptStorage = require('../lib/applicant-payment-receipt-storage');
const receiptResendService = require('../lib/applicant-receipt-resend-service');

function createHandler(
  service = createApplicantAuthService(),
  getDashboardData = getApplicantDashboardData,
  receipts = applicantPaymentReceipts,
  storage = receiptStorage,
  resends = receiptResendService
) {
  async function getAuthenticatedSession(req, res) {
    const session = await service.getSession(
      req.headers && req.headers.cookie
    );
    if (!session) {
      res.status(401).json({ authenticated: false });
      return null;
    }
    if (
      (!session.registrationId || !session.applicantType) &&
      session.selectionRequired !== true
    ) {
      res.status(401).json({ authenticated: false });
      return null;
    }
    return session;
  }

  async function downloadReceipt(registrationId, res) {
    const eligibility =
      await receipts.getReceiptEligibilityForRegistration(registrationId);
    if (!eligibility.paymentVerified) {
      return res.status(409).json({
        error: 'A verified payment is required before a receipt is available.'
      });
    }
    if (!eligibility.receipt) {
      return res.status(404).json({
        error: 'A payment receipt is not available yet.'
      });
    }

    const receipt = eligibility.receipt;
    if (
      typeof receipt.receiptNumber !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(receipt.receiptNumber)
    ) {
      throw new Error('Stored receipt filename metadata is invalid.');
    }
    const pdf = await storage.getVerifiedReceiptPdf(receipt);
    if (!Buffer.isBuffer(pdf) || pdf.length === 0) {
      throw new Error('Stored receipt content is unavailable.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Cybanext-Payment-Receipt-${receipt.receiptNumber}.pdf"`
    );
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(pdf);
  }

  return async function applicantSession(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const body = req.body || {};
    if (req.method === 'POST' && body.action === 'request-receipt-resend') {
      try {
        const result = await resends.requestPublicResend({
          email: body.email,
          ipAddress: receiptResendService.getClientIp(req)
        });
        return res.status(result.statusCode).json(result.body);
      } catch (error) {
        console.error('Public applicant receipt request failed.', {
          code: error && typeof error.code === 'string' &&
            /^[A-Za-z0-9_-]{1,32}$/.test(error.code)
            ? error.code
            : 'unknown'
        });
        return res.status(200).json({
          message: receiptResendService.CONFIRMATION_MESSAGE
        });
      }
    }

    try {
      const session = await getAuthenticatedSession(req, res);
      if (!session) return;

      if (req.method === 'GET') {
        if (req.query && req.query.includeRegistrations === 'true') {
          if (!session.selectionRequired) {
            return res.status(200).json({
              authenticated: true,
              selectionRequired: false
            });
          }

          try {
            const registrations = await service.listApplicantRegistrations(
              req.headers && req.headers.cookie
            );
            return res.status(200).json({
              authenticated: true,
              selectionRequired: true,
              registrations
            });
          } catch {
            console.error('Applicant registration selection lookup failed.');
            return res.status(503).json({
              authenticated: false,
              error: 'Your registrations are temporarily unavailable. Please try again later.'
            });
          }
        }

        if (req.query && req.query.includeDashboard === 'true') {
          if (session.selectionRequired) {
            return res.status(200).json({
              authenticated: true,
              selectionRequired: true
            });
          }

          try {
            const applicant = await getDashboardData(
              session.registrationId,
              session.applicantType
            );
            if (!applicant) {
              return res.status(404).json({
                authenticated: true,
                applicant: null,
                error: 'Applicant record not found.'
              });
            }
            return res.status(200).json({ authenticated: true, applicant });
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
          ...(session.selectionRequired
            ? { selectionRequired: true }
            : {
              applicationReference: session.registrationId,
              applicantType: session.applicantType
            })
        });
      }

      if (body.action === 'select-registration') {
        if (
          !session.selectionRequired ||
          typeof body.registrationId !== 'string' ||
          !['digital_forensics', 'regular_track'].includes(body.applicantType)
        ) {
          return res.status(400).json({ error: 'Invalid registration selection.' });
        }

        try {
          const selected = await service.selectApplicantRegistration(
            req.headers && req.headers.cookie,
            {
              applicantType: body.applicantType,
              registrationId: body.registrationId
            }
          );
          if (!selected) {
            return res.status(403).json({
              error: 'That registration is not available for this sign-in.'
            });
          }
          return res.status(200).json({ selected: true });
        } catch {
          console.error('Applicant registration selection failed.');
          return res.status(503).json({
            error: 'Your registration could not be selected. Please try again.'
          });
        }
      }

      if (body.action === 'download-receipt') {
        if (session.applicantType !== 'digital_forensics') {
          return res.status(403).json({
            error: 'Receipts are not available for this registration.'
          });
        }
        try {
          return await downloadReceipt(session.registrationId, res);
        } catch (error) {
          console.error('Applicant receipt download failed.', {
            code: error && typeof error.code === 'string' ? error.code : 'unknown'
          });
          return res.status(503).json({
            error: 'Your receipt is temporarily unavailable. Please try again later.'
          });
        }
      }

      if (body.action === 'resend-receipt') {
        if (session.applicantType !== 'digital_forensics') {
          return res.status(403).json({
            error: 'Receipts are not available for this registration.'
          });
        }
        try {
          const result = await resends.requestAuthenticatedResend({
            registrationId: session.registrationId,
            ipAddress: receiptResendService.getClientIp(req)
          });
          return res.status(result.statusCode).json(result.body);
        } catch (error) {
          console.error('Applicant receipt resend failed.', {
            code: error && typeof error.code === 'string' ? error.code : 'unknown'
          });
          return res.status(503).json({
            error: 'Your receipt email request could not be processed. Please try again later.'
          });
        }
      }

      return res.status(400).json({ error: 'Invalid applicant session request.' });
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
