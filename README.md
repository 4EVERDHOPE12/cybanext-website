# Cybanext Website

## Week 4 payments

Regular-track applicants are screened by `/api/scan-cv`. A passing result receives a short-lived, signed qualification token tied to the applicant and selected track. Digital Forensics creates a persisted registration before opening checkout and stores its registration and payment state in PostgreSQL. The server determines every charge amount, and `/api/verify-payment` checks the Paystack reference, status, amount, currency, and registration association before success is shown.

CV uploads are limited to 10 MB in the browser and the screening API. Oversized files are rejected in the browser before upload; unexpected non-JSON API responses are reported with their HTTP status rather than a generic JSON parsing error. The hosting provider may enforce a lower request-body limit before the API can receive a 10 MB upload.

Paystack checkout uses GHS and pesewas for all transactions. Regular tracks use the $30 reference price (GH₵346.50 at the default rate); Digital Forensics uses GH₵1,200 locally or the $120 reference price (GH₵1,386 at the default rate). Card and Mobile Money are enabled.

Configure these server-side environment variables in the deployment environment:

- `PAYSTACK_SECRET_KEY`: Paystack **TEST** secret key (`sk_test_...`). Live keys are rejected.
- `QUALIFICATION_TOKEN_SECRET`: recommended random secret of at least 32 characters used to sign one-hour CV qualification tokens. If omitted, the server derives the token-signing key from `PAYSTACK_SECRET_KEY` only when it is a Paystack TEST key.
- `DATABASE_URL`: PostgreSQL connection string for the Digital Forensics registration database. Use a pooled/serverless-compatible URL for serverless deployment.
- `USD_GHS_RATE`: optional server-only exchange rate; defaults to `11.55`.
- `SITE_URL`: optional public site origin used for the Paystack callback URL.

Never commit `.env` files or payment/database credentials. The repo indicates Vercel as the likely host but does not include an explicit deployment configuration; production hosting and database settings must be confirmed separately.

### PostgreSQL setup

The Digital Forensics API uses the Neon serverless PostgreSQL driver, which sends parameterized queries over HTTP and supports Node.js 19+. Create a PostgreSQL database with your managed provider; for Vercel, use a provider-issued serverless/pooled connection URL. Keep development, test, and production databases separate.

Copy `.env.example` to `.env` for local development and set `DATABASE_URL` to the intended non-production database URL. Migrations are applied manually; the repository has no migration-history table or automatic migration runner. The Node/Neon runner defaults to a dry run and does not connect to the database:

```powershell
node .\scripts\run-db-migrations.js
```

For the dedicated test branch, execution requires both the explicit apply flag and an exact non-production target confirmation. Node loads `.env` without printing its contents:

```powershell
node --env-file=.env .\scripts\run-db-migrations.js --apply --confirm-non-production=dev/cybanext-phase2c-test
```

The runner validates both reviewed files before execution, then applies each file's statements in order inside its own PostgreSQL transaction using the existing Neon driver. It does not submit a whole multi-statement script as one query, does not record migration history, and stops on the first error without retrying. The confirmation flag is an operator assertion; the runner does not independently identify the Neon branch from `DATABASE_URL`. Verify the endpoint in Neon Console before applying.

Migration 001 commits before migration 002 begins. If an error occurs, do not blindly rerun. Inspect the target's catalogs for the expected tables, columns, indexes, and constraints to determine whether the failed migration rolled back or completed despite a connection error. `IF NOT EXISTS` does not repair a pre-existing object with a different definition; reconcile any mismatch before deciding how to proceed. Keep production and the isolated test branch separate.

If registrations already exist in `.data/digital-forensics-registrations.json`, keep that file unchanged and back it up before import. After applying the schema and setting `DATABASE_URL` to the intended database, first validate the source without writes:

```sh
node scripts/import-digital-forensics-json.js
```

Then explicitly apply the import:

```sh
node scripts/import-digital-forensics-json.js --apply
```

The importer does not overwrite existing rows, is safe to rerun for identical records, stops on conflicting data, and reports counts without printing personal information. Review the target database and backup before retiring the JSON file. The application no longer reads or writes `.data` after this migration.

Run local pricing, qualification-token, initialization, and verification tests with:

```sh
npm test
```

Tests use mocked database queries and Paystack responses; they do not require a database connection or create real transactions. Hosted checkout card and Mobile Money flows require valid Paystack TEST credentials and an actual sandbox transaction.

## Applicant magic-link sign-in

Applicant sign-in is available only to existing Digital Forensics registrations stored in `digital_forensics_registrations`; this repository does not currently persist other internship applications. The login flow never creates an applicant account. The sign-in page is `applicant-login.html`, and its destination is a session-guarded placeholder until a dashboard is added separately.

The flow requires the existing registration schema plus `db/migrations/002_create_applicant_magic_link_auth.sql`. Apply migration 001 followed by migration 002 using the dry-run-first runner described above. The authentication migration creates the one-time-token, session, and persistent rate-limit tables and references existing registration IDs.

Configure these server-side variables for email-enabled environments:

- `MAGIC_LINK_RATE_LIMIT_SECRET`: random secret of at least 32 characters used to HMAC email/IP rate-limit keys.
- `RESEND_API_KEY`: Resend API key. The adapter sends only when configured; no test credentials are included.
- `AUTH_EMAIL_FROM`: verified sender address configured with Resend.
- `SITE_URL`: HTTPS site origin used to form the sign-in link.

The endpoint returns the same confirmation for known and unknown addresses. Links expire after 15 minutes and are single-use. Sessions expire after 30 days. Limits are three requests per normalized email and ten per IP in each rolling 15-minute window, stored in PostgreSQL. Automated tests use mocked storage and email transport and do not contact Resend or a database.
