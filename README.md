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

The migration runner requires `DATABASE_URL`, `MIGRATION_DEV_ENDPOINT_HOST`, and `MIGRATION_PRODUCTION_ENDPOINT_HOST`. These endpoint values are hostnames only, copied from Neon Connect after selecting the intended branch, compute endpoint, database, and role. Configure one hostname per target; the runner rejects missing or malformed values and rejects development and production hostnames that are identical (case-insensitive). It compares the URL hostname exactly with the selected target's configured hostname and checks `current_database()` is `neondb` before applying changes. It never prints the URL, credentials, or endpoint host.

Hostname verification is not independent proof of Neon branch identity: PostgreSQL's database name and connection hostname do not prove the branch name. Before setting either allowlist value, independently select the intended branch in Neon Console, open **Connect**, confirm the branch and compute endpoint shown there, and copy that endpoint's hostname into the matching variable. Repeat this separately for development and production. Recheck this mapping after an endpoint is recreated. The runner also requires separate explicit development and production confirmation arguments.

The runner defaults to dry-run mode and does not create a database client or execute SQL. Select a target explicitly:

```powershell
node .\scripts\run-db-migrations.js --target=development
node .\scripts\run-db-migrations.js --target=production
```

### Development branch

The existing `dev/cybanext-phase2c-test` branch already has migrations 001 and 002 but has no migration history. For the first use of the runner, use the development-only adoption operation. It checks each expected column's type, nullability, default, generated/identity state; exact primary, unique, and check constraints and their validation status; foreign-key columns, referenced table/columns, delete action; and all expected indexes including uniqueness, key columns, access method, and exact partial-index predicate. Missing, extra, altered, or unvalidated objects cause adoption to stop. After schema inspection, the runner acquires the migration advisory lock and refuses adoption if migration history is nonempty. It records both current filenames and SHA-256 checksums without rerunning migration DDL. Use a private `.env` containing the verified development `DATABASE_URL` plus both distinct endpoint-host allowlist values:

```powershell
Invoke-CybanextMigration -EnvFile .env -RunnerArguments @('--target=development')
Invoke-CybanextMigration -EnvFile .env -RunnerArguments @('--target=development', '--apply', '--confirm-development=dev/cybanext-phase2c-test', '--adopt-existing')
```

After adoption, future development migrations use the normal apply path:

```powershell
Invoke-CybanextMigration -EnvFile .env -RunnerArguments @('--target=development', '--apply', '--confirm-development=dev/cybanext-phase2c-test')
```

### Production branch

Prepare a separate ignored local file such as `.env.production` from the verified Neon Production Connect details. It must contain the production `DATABASE_URL` and both distinct endpoint-host allowlist values; verify that the production hostname came from the Production branch's Connect dialog. Do not point `.env` at Production. This local migration procedure does not configure Vercel.

**PowerShell environment isolation:** Node's `--env-file` does not override variables already present in the process environment. Use the helper below for dry-runs and apply commands. It temporarily clears the three database-target variables so Node loads them from the selected file, then restores the PowerShell process values. This prevents inherited values from silently taking precedence.

```powershell
function Invoke-CybanextMigration {
  param([string]$EnvFile, [string[]]$RunnerArguments)
  $names = @('DATABASE_URL', 'MIGRATION_DEV_ENDPOINT_HOST', 'MIGRATION_PRODUCTION_ENDPOINT_HOST')
  $saved = @{}
  try {
    foreach ($name in $names) {
      $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    & node "--env-file=$EnvFile" .\scripts\run-db-migrations.js @RunnerArguments
    if ($LASTEXITCODE -ne 0) { throw "Migration runner exited with code $LASTEXITCODE." }
  } finally {
    foreach ($name in $names) {
      [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }
  }
}
```

The dry-run only prints the migration order; it does not connect or verify the configured target. The apply path performs the hostname and database-name checks.

Run the Production dry-run first:

```powershell
Invoke-CybanextMigration -EnvFile .env.production -RunnerArguments @('--target=production')
```

The following command requires deliberate operator confirmation and is **NOT EXECUTED by this change**:

```powershell
Invoke-CybanextMigration -EnvFile .env.production -RunnerArguments @('--target=production', '--apply', '--confirm-production=I-UNDERSTAND-THIS-IS-PRODUCTION')
```

Production adoption is disabled; this path is for an empty application schema. The runner acquires a transaction-scoped advisory lock before reading migration history, validates the complete history as an exact ordered prefix of the known migrations, then applies missing migrations and records filenames, SHA-256 checksums, and timestamps in the same transaction. A history gap (for example, 002 without 001), unknown filename, or checksum mismatch stops execution. A failed transaction should roll back its DDL and history together; local tests use a mock and do not prove PostgreSQL rollback behavior. `IF NOT EXISTS` does not repair pre-existing schema drift.

Neon SQL metadata does not identify a branch by itself. The runner's hostname comparison and live database-name check are safeguards against accidental target mismatch, not independent branch-identity verification. The operator must verify each hostname against its intended branch in Neon Console before configuring the allowlist. If either target hostname is missing/malformed, the allowlist values are identical, or the actual endpoint/database name does not match, the runner refuses to apply. Keep both hostnames current when an endpoint is recreated.

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
