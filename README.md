# Cybanext Website

## Week 4 payments

Applicants are screened by `/api/scan-cv`. A passing result receives a short-lived, signed qualification token tied to the applicant and selected track. Regular-track applicants go directly to hosted Paystack checkout; Digital Forensics applicants first choose the local GHS or USD-reference option on the dedicated payment page. The server determines every charge amount, and `/api/verify-payment` confirms the Paystack reference, status, amount, currency, track, and qualification before success is shown.

CV uploads are limited to 4 MB so the multipart request stays below the serverless platform's request-body limit. Oversized files are rejected in the browser before upload; unexpected non-JSON API responses are reported with their HTTP status rather than a generic JSON parsing error.

Paystack checkout uses GHS and pesewas for all transactions. Regular tracks use the $30 reference price (GH₵346.50 at the default rate); Digital Forensics uses GH₵1,200 locally or the $120 reference price (GH₵1,386 at the default rate). Card and Mobile Money are enabled.

Configure these server-side environment variables in the deployment environment:

- `PAYSTACK_SECRET_KEY`: Paystack **TEST** secret key (`sk_test_...`). Live keys are rejected.
- `QUALIFICATION_TOKEN_SECRET`: random secret of at least 32 characters used to sign one-hour CV qualification tokens.
- `USD_GHS_RATE`: optional server-only exchange rate; defaults to `11.55`.
- `SITE_URL`: optional public site origin used for the Paystack callback URL.

Never commit `.env` files or payment secrets. Run local pricing, qualification-token, initialization, and verification tests with:

```sh
npm test
```

Tests use mocked Paystack responses and do not create real transactions. Hosted checkout card and Mobile Money flows require valid Paystack TEST credentials and an actual sandbox transaction.
