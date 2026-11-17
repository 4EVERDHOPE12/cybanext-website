const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { describe, test } = require('node:test');
const {
  EXPECTED_TABLES, MIGRATION_FILES, inspectExistingSchema, loadMigrations,
  runTestMigrations, sanitizeError
} = require('../scripts/run-db-migrations');

function validateLoopbackConnectionUrl(connectionString) {
  let parsed;
  try { parsed = new URL(connectionString); }
  catch { throw new Error('Integration database URL is invalid.'); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hasHostOverride = [...parsed.searchParams.keys()].some((key) =>
    ['host', 'hostaddr'].includes(key.toLowerCase()));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !['localhost', '127.0.0.1', '::1'].includes(host) ||
      hasHostOverride || !parsed.username || !parsed.password || parsed.pathname.length < 2) {
    throw new Error('Integration database must use an explicit loopback PostgreSQL URL without host overrides.');
  }
  return parsed;
}

function verifyDisposableHarnessContainer(connectionString, harnessId, containerId, inspection, postgresMajorVersion = '16') {
  const parsed = validateLoopbackConnectionUrl(connectionString);
  if (!/^(?:16|18)$/.test(postgresMajorVersion)) {
    throw new Error('Integration tests require a supported PostgreSQL major version.');
  }
  if (typeof harnessId !== 'string' || !/^[a-f0-9]{32}$/i.test(harnessId) ||
      typeof containerId !== 'string' || !/^[a-f0-9]{64}$/i.test(containerId)) {
    throw new Error('Integration tests require a disposable Docker container identity.');
  }
  if (!inspection || inspection.Id?.toLowerCase() !== containerId.toLowerCase() ||
      inspection.Config?.Image !== `postgres:${postgresMajorVersion}-alpine` || inspection.State?.Running !== true ||
      inspection.Config?.Labels?.['cybanext.migration-integration'] !== harnessId) {
    throw new Error('Integration database is not attached to the authorized disposable PostgreSQL container.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const configuredEnvironment = new Set(inspection.Config.Env || []);
  if (!configuredEnvironment.has(`POSTGRES_DB=${databaseName}`) ||
      !configuredEnvironment.has(`POSTGRES_USER=${decodeURIComponent(parsed.username)}`) ||
      !configuredEnvironment.has(`POSTGRES_PASSWORD=${decodeURIComponent(parsed.password)}`)) {
    throw new Error('Integration database credentials do not match the authorized disposable container.');
  }
  const bindings = inspection.NetworkSettings?.Ports?.['5432/tcp'];
  if (!Array.isArray(bindings) || !bindings.some((binding) =>
    binding.HostIp === '127.0.0.1' && binding.HostPort === parsed.port)) {
    throw new Error('Integration database is not published on the authorized loopback port.');
  }
}

async function verifyDisposableHarnessDatabase(sql, connectionString, harnessToken, harnessId, containerId, inspectContainer = (id) => {
  const output = execFileSync('docker', ['inspect', '--format', '{{json .}}', id], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(output);
}, postgresMajorVersion = '16') {
  if (typeof harnessToken !== 'string' || !/^[A-Za-z0-9]{32,}$/.test(harnessToken)) {
    throw new Error('Integration tests require a disposable-harness authorization token.');
  }
  const rows = await sql.query(`
    SELECT current_database() AS database_name,
           current_user AS database_user,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port,
           shobj_description(oid, 'pg_database') AS harness_marker
    FROM pg_catalog.pg_database
    WHERE datname = current_database()
  `);
  const actualMarker = rows[0]?.harness_marker ?? null;
  console.error('DISPOSABLE DATABASE MARKER DIAGNOSTIC', JSON.stringify({
    currentDatabase: rows[0]?.database_name ?? null,
    currentUser: rows[0]?.database_user ?? null,
    serverAddress: rows[0]?.server_address ?? null,
    serverPort: rows[0]?.server_port ?? null,
    commentIsNull: actualMarker === null,
    commentMatchesExpectedToken: actualMarker === harnessToken,
    actualTokenLength: typeof actualMarker === 'string' ? actualMarker.length : null,
    expectedTokenLength: harnessToken.length
  }));
  if (!rows[0] || actualMarker !== harnessToken) {
    throw new Error('Integration database was not created by the disposable PostgreSQL harness.');
  }
  let inspection;
  try { inspection = inspectContainer(containerId); }
  catch { throw new Error('Could not verify the disposable PostgreSQL container identity.'); }
  verifyDisposableHarnessContainer(
    connectionString,
    harnessId,
    containerId,
    inspection,
    postgresMajorVersion
  );
}

test('destructive integration reset requires the disposable harness marker', async () => {
  let markerRead = false;
  await assert.rejects(
    verifyDisposableHarnessDatabase(
      { async query() { markerRead = true; return [{ harness_marker: 'a'.repeat(48) }]; } },
      'postgresql://test:test@127.0.0.1:54321/test_db',
      'a'.repeat(48), 'b'.repeat(32), 'c'.repeat(64),
      () => ({ Id: 'c'.repeat(64), Config: { Image: 'postgres:16-alpine', Labels: {}, Env: [] }, State: { Running: true } })
    ),
    /not attached to the authorized disposable PostgreSQL container/
  );
  assert.equal(markerRead, true);
  await assert.rejects(
    verifyDisposableHarnessDatabase(
      { async query() { return [{ harness_marker: 'a'.repeat(48) }]; } },
      'postgresql://test:test@127.0.0.1:54321/test_db',
      'a'.repeat(48), 'b'.repeat(32), 'c'.repeat(64),
      () => { throw new Error('Docker container not found'); }
    ),
    /Could not verify the disposable PostgreSQL container identity/
  );
  await assert.rejects(
    verifyDisposableHarnessDatabase(
      { async query() { return [{ harness_marker: 'a'.repeat(48) }]; } },
      'postgresql://test:test@127.0.0.1:54321/test_db',
      'a'.repeat(48), 'b'.repeat(32), 'c'.repeat(64),
      () => ({
        Id: 'c'.repeat(64),
        Config: {
          Image: 'postgres:16-alpine',
          Labels: { 'cybanext.migration-integration': 'b'.repeat(32) },
          Env: ['POSTGRES_DB=test_db', 'POSTGRES_USER=test', 'POSTGRES_PASSWORD=test']
        },
        State: { Running: true },
        NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] } }
      })
    ),
    /not published on the authorized loopback port/
  );
  await assert.rejects(
    verifyDisposableHarnessDatabase(
      { async query() { return [{ harness_marker: 'wrong-marker' }]; } },
      'postgresql://test:test@127.0.0.1:54321/test_db',
      'a'.repeat(48), 'b'.repeat(32), 'c'.repeat(64),
      () => ({
        Id: 'c'.repeat(64),
        Config: {
          Image: 'postgres:16-alpine',
          Labels: { 'cybanext.migration-integration': 'b'.repeat(32) },
          Env: ['POSTGRES_DB=test_db', 'POSTGRES_USER=test', 'POSTGRES_PASSWORD=test']
        },
        State: { Running: true },
        NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }] } }
      })
    ),
    /not created by the disposable PostgreSQL harness/
  );
  await assert.rejects(
    verifyDisposableHarnessDatabase({ async query() { throw new Error('must not query'); } }, null, undefined, 'b'.repeat(32), 'c'.repeat(64)),
    /authorization token/
  );
});

test('integration database URL rejects host overrides that could escape loopback', () => {
  assert.doesNotThrow(() => validateLoopbackConnectionUrl('postgresql://u:p@127.0.0.1/test_db'));
  for (const override of ['host=remote.example', 'hostaddr=127.0.0.1', 'HOST=remote.example']) {
    assert.throws(
      () => validateLoopbackConnectionUrl(`postgresql://u:p@127.0.0.1/test_db?${override}`),
      /without host overrides/
    );
  }
});

const connectionString = process.env.CYBANEXT_TEST_DATABASE_URL;
const enabled = process.env.CYBANEXT_RUN_POSTGRES_INTEGRATION === '1';
if (!enabled) {
  test('PostgreSQL migration integration tests (run via scripts/run-postgres-integration.ps1)', { skip: 'Disposable PostgreSQL harness not enabled.' }, () => {});
} else {
  describe('Disposable PostgreSQL migration integration suite', { concurrency: 1 }, () => {
    assert.ok(connectionString, 'Harness must provide CYBANEXT_TEST_DATABASE_URL.');
    validateLoopbackConnectionUrl(connectionString);
    const { Client } = require('pg');
    const harnessToken = process.env.CYBANEXT_TEST_HARNESS_TOKEN;
    const harnessId = process.env.CYBANEXT_TEST_HARNESS_ID;
    const containerId = process.env.CYBANEXT_TEST_CONTAINER_ID;
    const postgresMajorVersion = process.env.CYBANEXT_TEST_POSTGRES_MAJOR_VERSION || '16';
    assert.match(postgresMajorVersion, /^(?:16|18)$/, 'Supported PostgreSQL major version is required.');
    assert.ok(/^[A-Za-z0-9]{32,}$/.test(harnessToken || ''), 'Disposable harness authorization is required.');
    assert.ok(/^[a-f0-9]{32}$/i.test(harnessId || ''), 'Disposable harness identity is required.');
    assert.ok(/^[a-f0-9]{64}$/i.test(containerId || ''), 'Disposable container identity is required.');
  const clientFactory = (transformStatement = (statement) => statement) => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    let connected = false;
    const ensureConnected = async () => { if (!connected) { await client.connect(); connected = true; } };
    return {
      async query(statement) { await ensureConnected(); return (await client.query(statement)).rows; },
      async transaction(queries) {
        await ensureConnected();
        await client.query('BEGIN');
        try {
          for (const query of queries) {
            await client.query(transformStatement(query.statement));
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { await client.end(); connected = false; }
      },
      async withTransaction(callback) {
        await ensureConnected(); await client.query('BEGIN');
        try {
          const result = await callback({
            query: async (statement) => (await client.query(transformStatement(statement))).rows
          });
          await client.query('COMMIT');
          return result;
        }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { await client.end(); connected = false; }
      },
      async close() { if (connected) { await client.end(); connected = false; } }
    };
  };
  const reset = async () => {
    const client = new Client({ connectionString }); await client.connect();
    try {
      await verifyDisposableHarnessDatabase({
        async query(statement) { return (await client.query(statement)).rows; }
      }, connectionString, harnessToken, harnessId, containerId, undefined, postgresMajorVersion);
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    finally { await client.end(); }
  };
  const migrate = (opts = {}) => runTestMigrations({
    connectionUrl: connectionString,
    createClient: clientFactory,
    logger: { log() {}, error() {} },
    onTestDiagnostic(diagnostic) { console.error('TEST-ONLY POSTGRES DIAGNOSTIC', JSON.stringify(diagnostic)); },
    ...opts
  });
  const query = async (sql, params = []) => {
    const client = new Client({ connectionString }); await client.connect();
    try { return (await client.query(sql, params)).rows; } finally { await client.end(); }
  };
  const bindDatabaseClient = (database, client, { manageTransaction = true } = {}) => {
    const originalQuery = database.query;
    const originalTransaction = database.transaction;
    const compile = (strings, values) => ({
      statement: strings.reduce((sql, part, index) =>
        sql + (index === 0 ? '' : `$${index}`) + part, ''),
      values
    });
    database.query = async (strings, ...values) => {
      const { statement, values: parameters } = compile(strings, values);
      return (await client.query(statement, parameters)).rows;
    };
    database.transaction = async (buildQueries) => {
      const statements = buildQueries((strings, ...values) => compile(strings, values));
      if (manageTransaction) await client.query('BEGIN');
      try {
        const results = [];
        for (const { statement, values } of statements) {
          results.push((await client.query(statement, values)).rows);
        }
        if (manageTransaction) await client.query('COMMIT');
        return results;
      } catch (error) {
        if (manageTransaction) await client.query('ROLLBACK');
        throw error;
      }
    };
    return () => {
      database.query = originalQuery;
      database.transaction = originalTransaction;
    };
  };
  const createSmsPaymentFixtures = async (
    digitalStore,
    regularStore,
    suffix,
    { digitalConsent = true, regularConsent = true } = {}
  ) => {
    const digital = await digitalStore.createRegistration({
      fullName: `SMS Digital ${suffix}`,
      email: `sms-digital-${suffix}@example.test`,
      phone: '0241234567',
      smsConsent: digitalConsent
    });
    const regular = await regularStore.createApplicant({
      fullName: `SMS Regular ${suffix}`,
      email: `sms-regular-${suffix}@example.test`,
      phone: '0241234567',
      track: 'incident_response',
      smsConsent: regularConsent
    });
    const digitalReference = `DF-SMS-${suffix}`;
    await digitalStore.updateRegistration(digital.id, {
      status: 'payment_initiated',
      paymentReference: digitalReference,
      pricingOption: 'GHS'
    }, { expectedStatus: 'pending', expectedPaymentReference: null });
    const regularReference = `CYB-SMS-${suffix}`;
    await regularStore.createPaymentAttempt({
      reference: regularReference,
      registrationId: regular.id,
      referenceAmount: 30,
      expectedAmount: 34650,
      expectedCurrency: 'GHS'
    });
    await regularStore.updatePaymentAttemptStatus(regularReference, 'payment_initiated');
    return { digital, regular, digitalReference, regularReference, suffix };
  };
  const verifySmsPaymentFixtures = async (
    digitalStore,
    regularStore,
    fixtures
  ) => {
    const digitalPayment = await digitalStore.updatePaymentStatusWithNotification({
      registrationId: fixtures.digital.id,
      reference: fixtures.digitalReference,
      status: 'payment_verified',
      transactionId: `digital-transaction-${fixtures.suffix}`,
      paymentVerificationTimestamp: new Date().toISOString()
    });
    const regularPayment = await regularStore.markPaymentAttemptVerified(
      fixtures.regularReference,
      `regular-transaction-${fixtures.suffix}`
    );
    return { digitalPayment, regularPayment };
  };
  // Migration 006 rollback tests must start from migrations 001 through 005.
  const pre006Migrations = loadMigrations().slice(0, 5);
  const installPre006Schema = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
          filename TEXT PRIMARY KEY,
          checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        for (const migration of pre006Migrations) {
          for (const statement of migration.statements) await client.query(statement);
          await client.query(
            'INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)',
            [migration.filename, migration.checksum]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      await client.end();
    }
  };
  const assertPre006SchemaIntact = async () => {
    const schemaClient = clientFactory();
    try {
      await inspectExistingSchema(schemaClient, {
        includeSmsOutbox: false,
        includeApplicantRegistrationSelection: false
      });
    } finally {
      await schemaClient.close();
    }
    const history = await query(
      'SELECT filename, checksum FROM public.schema_migrations ORDER BY filename'
    );
    assert.deepEqual(history, pre006Migrations.map(({ filename, checksum }) => ({
      filename, checksum
    })));
  };
  const assertSmsOutboxObjectsAbsent = async () => {
    const tableNames = ['sms_notification_outbox'];
    const indexNames = [
      'sms_notification_outbox_pkey',
      'sms_notification_outbox_event_key_key',
      'sms_notification_outbox_regular_registration_idx',
      'sms_notification_outbox_digital_registration_idx',
      'sms_notification_outbox_pending_due_idx',
      'sms_notification_outbox_lease_expiry_idx',
      'sms_notification_outbox_completed_retention_idx'
    ];
    const functionNames = [
      'require_paid_sms_notification_registration',
      'set_sms_notification_outbox_completion_timestamp',
      'prevent_early_sms_notification_outbox_deletion',
      'prevent_sms_notification_outbox_truncate',
      'purge_expired_sms_notification_outbox'
    ];
    const triggerNames = [
      'sms_notification_outbox_payment_success_guard',
      'sms_notification_outbox_completion_timestamp',
      'sms_notification_outbox_retention_guard',
      'sms_notification_outbox_no_truncate'
    ];

    assert.deepEqual(await query(`
      SELECT n.nspname AS schema_name, c.relname AS object_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    `, [tableNames]), []);
    assert.deepEqual(await query(`
      SELECT n.nspname AS schema_name, idx.relname AS object_name
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = 'public' AND idx.relname = ANY($1::text[])
    `, [indexNames]), []);
    assert.deepEqual(await query(`
      SELECT n.nspname AS schema_name, p.proname AS object_name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
    `, [functionNames]), []);
    assert.deepEqual(await query(`
      SELECT n.nspname AS schema_name, rel.relname AS table_name, t.tgname AS object_name
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class rel ON rel.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND rel.relname = 'sms_notification_outbox'
        AND t.tgname = ANY($1::text[]) AND NOT t.tgisinternal
    `, [triggerNames]), []);
  };
  const injectMigrationExecutionFailure = (failingStatement, replacementStatement) => {
    const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
    const originalLiteral = sqlLiteral(failingStatement);
    const replacementLiteral = sqlLiteral(replacementStatement);
    return (statement) => statement.replace(originalLiteral, replacementLiteral);
  };

  test('fresh migrations 001 through 010 create expected tables and checksummed history', async () => {
    await reset(); await migrate();
    const tables = await query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    for (const name of [...EXPECTED_TABLES, 'schema_migrations']) assert.ok(tables.some((row) => row.tablename === name), `Missing ${name}`);
    const history = await query('SELECT filename, checksum FROM public.schema_migrations ORDER BY filename');
    assert.deepEqual(history.map((row) => row.filename), MIGRATION_FILES);
    assert.deepEqual(history.map((row) => row.checksum), loadMigrations().map((row) => row.checksum));
    const version = await query('SELECT version() AS version');
    assert.match(version[0].version, new RegExp(`PostgreSQL ${postgresMajorVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  });

  test('magic-link sessions select only registrations belonging to the verified email', async () => {
    await reset();
    await migrate();

    const database = require('../lib/digital-forensics-database');
    const authStore = require('../lib/applicant-auth-store');
    const client = new Client({ connectionString });
    await client.connect();
    const restoreDatabase = bindDatabaseClient(database, client);

    try {
      const suffix = crypto.randomBytes(8).toString('hex');
      const sharedEmail = `portal-selection-${suffix}@example.test`;
      const otherEmail = `portal-other-${suffix}@example.test`;
      const registrations = [
        ['DF-portal-' + suffix, 'digital_forensics', 'digital_forensics'],
        ['RT-portal-' + suffix + '-1', 'regular_track', 'incident_response'],
        ['RT-portal-' + suffix + '-2', 'regular_track', 'soc_analyst']
      ];

      for (const [registrationId, , track] of registrations.slice(1)) {
        await query(`
          INSERT INTO public.regular_track_applicants
            (registration_id, full_name, email, track, status)
          VALUES ($1, 'Portal Applicant', $2, $3, 'pending')
        `, [registrationId, sharedEmail, track]);
      }
      await query(`
        INSERT INTO public.digital_forensics_registrations
          (registration_id, full_name, email, status, expected_amount, expected_currency)
        VALUES ($1, 'Portal Applicant', $2, 'pending', 1500, 'GHS')
      `, [registrations[0][0], sharedEmail]);
      const legacySessionHash = crypto.randomBytes(32).toString('hex');
      await query(`
        INSERT INTO public.applicant_sessions
          (registration_id, session_token_hash, expires_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '30 days')
      `, [registrations[0][0], legacySessionHash]);
      const legacySession = await authStore.findApplicantSession(legacySessionHash);
      assert.equal(legacySession.applicantType, 'digital_forensics');
      assert.equal(legacySession.registrationId, registrations[0][0]);
      assert.equal(legacySession.selectionRequired, false);
      await query(`
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, track, status)
        VALUES ($1, 'Other Applicant', $2, 'cloud_security', 'pending')
      `, [`RT-other-${suffix}`, otherEmail]);

      const anchor = await authStore.findEligibleApplicant(sharedEmail);
      assert.equal(anchor.applicantType, 'digital_forensics');
      const tokenHash = crypto.randomBytes(32).toString('hex');
      const sessionTokenHash = crypto.randomBytes(32).toString('hex');
      await authStore.createMagicLinkToken({
        ...anchor,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000)
      });

      const redeemed = await authStore.redeemMagicLinkToken({
        tokenHash,
        sessionTokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });
      assert.equal(redeemed.selectionRequired, true);

      const options = await authStore.listApplicantRegistrationsForSession(
        sessionTokenHash
      );
      assert.equal(options.length, 3);
      assert.equal(options.some((item) => Object.hasOwn(item, 'phone')), false);
      assert.equal(await authStore.selectApplicantRegistration({
        applicantType: 'regular_track',
        registrationId: `RT-other-${suffix}`,
        sessionTokenHash
      }), null);

      const selectedId = registrations[2][0];
      assert.deepEqual(await authStore.selectApplicantRegistration({
        applicantType: 'regular_track',
        registrationId: selectedId,
        sessionTokenHash
      }), { registrationId: selectedId });
      assert.equal(await authStore.selectApplicantRegistration({
        applicantType: 'digital_forensics',
        registrationId: registrations[0][0],
        sessionTokenHash
      }), null);
      const selectedSession =
        await authStore.findApplicantSession(sessionTokenHash);
      assert.equal(selectedSession.registrationId, selectedId);
      assert.equal(selectedSession.applicantType, 'regular_track');
      assert.equal(selectedSession.selectionRequired, false);

      const regularOnlyEmail = `portal-regular-${suffix}@example.test`;
      await query(`
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, track, status)
        VALUES ($1, 'Single Applicant', $2, 'network_security', 'pending')
      `, [`RT-single-${suffix}`, regularOnlyEmail]);
      const regularAnchor = await authStore.findEligibleApplicant(regularOnlyEmail);
      const regularTokenHash = crypto.randomBytes(32).toString('hex');
      const regularSessionHash = crypto.randomBytes(32).toString('hex');
      await authStore.createMagicLinkToken({
        ...regularAnchor,
        tokenHash: regularTokenHash,
        expiresAt: new Date(Date.now() + 60_000)
      });
      const single = await authStore.redeemMagicLinkToken({
        tokenHash: regularTokenHash,
        sessionTokenHash: regularSessionHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });
      assert.equal(single.selectionRequired, false);
      assert.equal(single.applicantType, 'regular_track');
      assert.equal(single.registrationId, `RT-single-${suffix}`);

      const digitalEmail = `portal-digital-${suffix}@example.test`;
      const digitalRegistrationIds = [
        `DF-single-${suffix}-1`,
        `DF-single-${suffix}-2`
      ];
      for (const registrationId of digitalRegistrationIds) {
        await query(`
          INSERT INTO public.digital_forensics_registrations
            (registration_id, full_name, email, status, expected_amount, expected_currency)
          VALUES ($1, 'Digital Applicant', $2, 'pending', 1500, 'GHS')
        `, [registrationId, digitalEmail]);
      }
      const digitalAnchor = await authStore.findEligibleApplicant(digitalEmail);
      const digitalTokenHash = crypto.randomBytes(32).toString('hex');
      const digitalSessionHash = crypto.randomBytes(32).toString('hex');
      await authStore.createMagicLinkToken({
        ...digitalAnchor,
        tokenHash: digitalTokenHash,
        expiresAt: new Date(Date.now() + 60_000)
      });
      const digitalSession = await authStore.redeemMagicLinkToken({
        tokenHash: digitalTokenHash,
        sessionTokenHash: digitalSessionHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });
      assert.equal(digitalSession.selectionRequired, true);
      assert.equal((await authStore.listApplicantRegistrationsForSession(
        digitalSessionHash
      )).length, 2);
      assert.deepEqual(await authStore.selectApplicantRegistration({
        applicantType: 'digital_forensics',
        registrationId: digitalRegistrationIds[1],
        sessionTokenHash: digitalSessionHash
      }), { registrationId: digitalRegistrationIds[1] });
      const selectedDigitalSession =
        await authStore.findApplicantSession(digitalSessionHash);
      assert.equal(selectedDigitalSession.applicantType, 'digital_forensics');
      assert.equal(selectedDigitalSession.registrationId, digitalRegistrationIds[1]);
    } finally {
      restoreDatabase();
      await client.end();
    }
  });

  test('ignores PostgreSQL 18 implicit NOT NULL constraints but rejects unexpected checks', async () => {
    try {
      await reset();
      await migrate();
      const implicitNotNullConstraints = await query(`
        SELECT count(*)::int AS count
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = 'public'
          AND rel.relname = 'regular_track_applicants'
          AND con.contype = 'n'
      `);
      if (postgresMajorVersion === '18') {
        assert.ok(implicitNotNullConstraints[0].count > 0);
      }
      await assert.doesNotReject(migrate());

      await query(`
        ALTER TABLE public.regular_track_applicants
        ADD CONSTRAINT compatibility_unexpected_check
        CHECK (char_length(full_name) >= 1)
      `);
      await assert.rejects(migrate(), /schema mismatch: constraints and relationships/);
    } finally {
      await reset();
    }
  });

  test('SMS consent grants are atomic and database-enforced append-only evidence', async () => {
    await reset();
    await migrate();
    const client = new Client({ connectionString });
    await client.connect();
    const database = require('../lib/digital-forensics-database');
    const regularStore = require('../lib/regular-track-payment-store');
    const originalQuery = database.query;
    database.query = async (strings, ...values) => {
      const statement = strings.reduce((sql, part, index) =>
        sql + (index === 0 ? '' : `$${index}`) + part, '');
      return (await client.query(statement, values)).rows;
    };

    try {
      await client.query('BEGIN');
      const applicant = await regularStore.createApplicant({
        fullName: 'SMS Consent Integration',
        email: 'sms-consent@example.test',
        phone: '0241234567',
        track: 'incident_response',
        smsConsent: true
      });
      const events = await client.query(`
        SELECT event_type, phone_snapshot, purpose, policy_version, source,
               occurred_at, regular_track_registration_id,
               digital_forensics_registration_id
        FROM public.sms_consent_events
        WHERE regular_track_registration_id = $1
      `, [applicant.id]);
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].event_type, 'grant');
      assert.equal(events.rows[0].phone_snapshot, '+233241234567');
      assert.equal(events.rows[0].purpose,
        'SMS notifications confirming successful payment for a Cybanext programme.');
      assert.equal(events.rows[0].policy_version, 'sms-payment-success-v1');
      assert.equal(events.rows[0].source, 'main_application');
      assert.ok(events.rows[0].occurred_at instanceof Date);
      assert.equal(events.rows[0].digital_forensics_registration_id, null);
      const currentConsent = await client.query(`
        SELECT phone_snapshot
        FROM public.sms_current_consent
        WHERE regular_track_registration_id = $1
      `, [applicant.id]);
      assert.deepEqual(currentConsent.rows, [{ phone_snapshot: '+233241234567' }]);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      const digitalStore = require('../lib/digital-forensics-store');
      const digital = await digitalStore.createRegistration({
        fullName: 'SMS Digital Consent Integration',
        email: 'sms-digital-consent@example.test',
        phone: '0241234567',
        smsConsent: true
      });
      const digitalEvidence = await client.query(`
        SELECT event_type, phone_snapshot, source
        FROM public.sms_consent_events
        WHERE digital_forensics_registration_id = $1
      `, [digital.id]);
      assert.deepEqual(digitalEvidence.rows, [{
        event_type: 'grant',
        phone_snapshot: '+233241234567',
        source: 'digital_forensics_standalone'
      }]);
      const digitalCurrentConsent = await client.query(`
        SELECT phone_snapshot
        FROM public.sms_current_consent
        WHERE digital_forensics_registration_id = $1
      `, [digital.id]);
      assert.deepEqual(digitalCurrentConsent.rows, [{ phone_snapshot: '+233241234567' }]);
      await client.query('ROLLBACK');

      const appRoleRegistration = await regularStore.createApplicant({
        fullName: 'SMS Application Role Integration',
        email: 'sms-app-role@example.test',
        phone: '0241234567',
        track: 'incident_response',
        smsConsent: false
      });
      await client.query('SET ROLE cybanext_sms_consent_application');
      try {
        await assert.rejects(
          client.query('SELECT * FROM public.sms_consent_events'),
          { code: '42501' }
        );
        await assert.rejects(
          client.query('UPDATE public.sms_consent_events SET occurred_at = clock_timestamp()'),
          { code: '42501' }
        );
        await assert.rejects(
          client.query('DELETE FROM public.sms_consent_events'),
          { code: '42501' }
        );
        await assert.rejects(
          client.query(`
            INSERT INTO public.sms_consent_events
              (regular_track_registration_id, event_type, phone_snapshot, purpose,
               policy_version, source)
            VALUES ($1, 'grant', '+233241234567',
              'SMS notifications confirming successful payment for a Cybanext programme.',
              'sms-payment-success-v1', 'main_application')
          `, [appRoleRegistration.id]),
          { code: '42501' }
        );
        await assert.rejects(
          client.query(`
            INSERT INTO public.sms_current_consent
              (regular_track_registration_id, phone_snapshot)
            VALUES ($1, '+233241234567')
          `, [appRoleRegistration.id]),
          { code: '42501' }
        );
        await assert.rejects(
          client.query(`
            UPDATE public.sms_current_consent
            SET phone_snapshot = '+233241234567'
            WHERE regular_track_registration_id = $1
          `, [appRoleRegistration.id]),
          { code: '42501' }
        );
        await assert.rejects(
          client.query(`
            DELETE FROM public.sms_current_consent
            WHERE regular_track_registration_id = $1
          `, [appRoleRegistration.id]),
          { code: '42501' }
        );
        await assert.rejects(
          client.query('SELECT public.purge_expired_sms_consent_events()'),
          { code: '42501' }
        );
        await assert.rejects(
          client.query('TRUNCATE public.sms_consent_events'),
          { code: '42501' }
        );
        await assert.rejects(
          client.query('TRUNCATE public.sms_current_consent'),
          { code: '42501' }
        );
        const recorded = await client.query(`
          SELECT public.record_sms_consent(
            $1, NULL::TEXT, '+233241234567',
            'sms-payment-success-v1', 'main_application'
          ) AS recorded
        `, [appRoleRegistration.id]);
        assert.deepEqual(recorded.rows, [{ recorded: true }]);
        const currentState = await client.query(`
          SELECT phone_snapshot
          FROM public.sms_current_consent
          WHERE regular_track_registration_id = $1
        `, [appRoleRegistration.id]);
        assert.deepEqual(currentState.rows, [{ phone_snapshot: '+233241234567' }]);
      } finally {
        await client.query('RESET ROLE');
      }

      const rejectingTriggerName = `reject_sms_consent_${crypto.randomUUID().replace(/-/g, '')}`;
      const rejectingFunctionName = `${rejectingTriggerName}_function`;
      await client.query(`
        CREATE FUNCTION public.${rejectingFunctionName}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'test consent evidence failure';
        END;
        $$
      `);
      await client.query(`
        CREATE TRIGGER ${rejectingTriggerName}
        BEFORE INSERT ON public.sms_consent_events
        FOR EACH ROW EXECUTE FUNCTION public.${rejectingFunctionName}()
      `);
      try {
        await assert.rejects(regularStore.createApplicant({
          fullName: 'Atomic Regular Consent',
          email: 'atomic-regular-consent@example.test',
          phone: '0241234567',
          track: 'incident_response',
          smsConsent: true
        }), /test consent evidence failure/);
        const regularRows = await client.query(`
          SELECT count(*)::int AS count
          FROM public.regular_track_applicants
          WHERE email = 'atomic-regular-consent@example.test'
        `);
        assert.equal(regularRows.rows[0].count, 0);

        const digitalStore = require('../lib/digital-forensics-store');
        await assert.rejects(digitalStore.createRegistration({
          fullName: 'Atomic Digital Consent',
          email: 'atomic-digital-consent@example.test',
          phone: '0241234567',
          smsConsent: true
        }), /test consent evidence failure/);
        const digitalRows = await client.query(`
          SELECT count(*)::int AS count
          FROM public.digital_forensics_registrations
          WHERE email = 'atomic-digital-consent@example.test'
        `);
        assert.equal(digitalRows.rows[0].count, 0);
      } finally {
        await client.query(`DROP TRIGGER ${rejectingTriggerName} ON public.sms_consent_events`);
        await client.query(`DROP FUNCTION public.${rejectingFunctionName}()`);
      }

      await client.query('BEGIN');
      await client.query(`
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, phone, track, status)
        VALUES ('sms-consent-append-only', 'Append Only Test',
          'append-only@example.test', '+233241234567', 'incident_response', 'pending')
      `);
      await client.query(`
        INSERT INTO public.sms_consent_events
          (regular_track_registration_id, event_type, phone_snapshot, purpose,
           policy_version, source)
        VALUES ('sms-consent-append-only', 'grant', '+233241234567',
          'SMS notifications confirming successful payment for a Cybanext programme.',
          'sms-payment-success-v1', 'main_application')
      `);
      await assert.rejects(
        client.query(`
          UPDATE public.sms_consent_events
          SET event_type = 'withdrawal'
          WHERE regular_track_registration_id = 'sms-consent-append-only'
        `),
        { code: '55000' }
      );
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, phone, track, status)
        VALUES ('sms-consent-delete-only', 'Append Only Test',
          'delete-only@example.test', '+233241234567', 'incident_response', 'pending')
      `);
      await client.query(`
        INSERT INTO public.sms_consent_events
          (regular_track_registration_id, event_type, phone_snapshot, purpose,
           policy_version, source)
        VALUES ('sms-consent-delete-only', 'grant', '+233241234567',
          'SMS notifications confirming successful payment for a Cybanext programme.',
          'sms-payment-success-v1', 'main_application')
      `);
      await assert.rejects(
        client.query(`
          DELETE FROM public.sms_consent_events
          WHERE regular_track_registration_id = 'sms-consent-delete-only'
        `),
        { code: '55000' }
      );
      await client.query('ROLLBACK');
    } finally {
      database.query = originalQuery;
      try { await client.query('ROLLBACK'); } catch {}
      await client.end();
    }
  });

  test('SMS consent retention removes only expired history and preserves current eligibility', async () => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const database = require('../lib/digital-forensics-database');
    const digitalStore = require('../lib/digital-forensics-store');
    const regularStore = require('../lib/regular-track-payment-store');
    const client = new Client({ connectionString });
    await client.connect();
    const restoreDatabase = bindDatabaseClient(database, client);
    const testRole = `sms_consent_app_${suffix}`;
    let roleCreated = false;

    try {
      const fixtures = await createSmsPaymentFixtures(
        digitalStore, regularStore, suffix
      );
      const recent = await regularStore.createApplicant({
        fullName: `SMS Recent ${suffix}`,
        email: `sms-recent-${suffix}@example.test`,
        phone: '0241234567',
        track: 'incident_response',
        smsConsent: true
      });

      await client.query('ALTER TABLE public.sms_consent_events DISABLE TRIGGER sms_consent_events_append_only');
      await client.query(`
        UPDATE public.sms_consent_events
        SET occurred_at = clock_timestamp() - INTERVAL '91 days'
        WHERE digital_forensics_registration_id = $1
           OR regular_track_registration_id = $2
      `, [fixtures.digital.id, fixtures.regular.id]);
      await client.query('ALTER TABLE public.sms_consent_events ENABLE TRIGGER sms_consent_events_append_only');

      await client.query(`CREATE ROLE ${testRole} NOLOGIN`);
      roleCreated = true;
      await client.query(`
        GRANT SELECT, UPDATE, DELETE ON public.sms_consent_events, public.sms_current_consent
        TO ${testRole}
      `);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${testRole}`);
      await client.query(`SET ROLE ${testRole}`);
      await assert.rejects(
        client.query('UPDATE public.sms_consent_events SET occurred_at = clock_timestamp()'),
        { code: '55000' }
      );
      await assert.rejects(
        client.query('DELETE FROM public.sms_consent_events'),
        { code: '55000' }
      );
      await assert.rejects(
        client.query('UPDATE public.sms_current_consent SET phone_snapshot = phone_snapshot'),
        { code: '55000' }
      );
      await assert.rejects(
        client.query('DELETE FROM public.sms_current_consent'),
        { code: '55000' }
      );
      await assert.rejects(
        client.query('SELECT public.purge_expired_sms_consent_events()'),
        { code: '42501' }
      );
      await client.query('RESET ROLE');

      const purge = async () => {
        await client.query('SET ROLE cybanext_sms_consent_retention_operator');
        try {
          const result = await client.query(
            'SELECT public.purge_expired_sms_consent_events() AS deleted_count'
          );
          return result.rows[0].deleted_count;
        } finally {
          await client.query('RESET ROLE');
        }
      };
      const removed = await purge();
      assert.equal(removed, 2);
      assert.equal(await purge(), 0);

      const remainingEvents = await client.query(`
        SELECT count(*)::int AS count
        FROM public.sms_consent_events
        WHERE digital_forensics_registration_id = $1
           OR regular_track_registration_id = $2
           OR regular_track_registration_id = $3
      `, [fixtures.digital.id, fixtures.regular.id, recent.id]);
      assert.equal(remainingEvents.rows[0].count, 1);
      const currentStates = await client.query(`
        SELECT count(*)::int AS count
        FROM public.sms_current_consent
        WHERE digital_forensics_registration_id = $1
           OR regular_track_registration_id = ANY($2::text[])
      `, [fixtures.digital.id, [fixtures.regular.id, recent.id]]);
      assert.equal(currentStates.rows[0].count, 3);

      const payments = await verifySmsPaymentFixtures(
        digitalStore, regularStore, fixtures
      );
      assert.equal(payments.digitalPayment.status, 'payment_verified');
      assert.equal(payments.regularPayment.reference, fixtures.regularReference);
      const queued = await client.query(
        'SELECT count(*)::int AS count FROM public.sms_notification_outbox WHERE event_key LIKE $1',
        [`%${suffix}`]
      );
      assert.equal(queued.rows[0].count, 2);
    } finally {
      try { await client.query('RESET ROLE'); } catch {}
      try {
        if (roleCreated) {
          await client.query(`REVOKE ALL ON public.sms_consent_events, public.sms_current_consent FROM ${testRole}`);
          await client.query(`REVOKE ALL ON SCHEMA public FROM ${testRole}`);
          await client.query(`DROP ROLE ${testRole}`);
        }
      } finally {
        restoreDatabase();
        await client.end();
      }
    }
  });

  test('notification outbox links registrations, deduplicates events, and serializes claims', async (t) => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID();
    const digitalId = `DF-NOTIFY-${suffix}`;
    const regularId = `RT-NOTIFY-${suffix}`;
    const digitalEventKey = `integration-digital-registration:${suffix}`;
    const regularEventKey = `integration-regular-registration:${suffix}`;
    t.after(async () => {
      await query('DELETE FROM public.email_notification_outbox WHERE event_key = ANY($1::text[])', [
        [digitalEventKey, regularEventKey]
      ]);
      await query(
        'DELETE FROM public.digital_forensics_registrations WHERE registration_id = $1',
        [digitalId]
      );
      await query(
        'DELETE FROM public.regular_track_applicants WHERE registration_id = $1',
        [regularId]
      );
    });

    await query(`
      WITH inserted AS (
        INSERT INTO public.digital_forensics_registrations
          (registration_id, full_name, email, status, expected_amount, expected_currency)
        VALUES ($1, 'Outbox Integration', 'outbox-digital@example.com', 'pending', 1500, 'GHS')
        RETURNING registration_id, full_name, email
      )
      INSERT INTO public.email_notification_outbox
        (event_key, event_type, digital_forensics_registration_id, recipient_email, template_data)
      SELECT $2, 'digital_forensics_registration_confirmation',
        registration_id, email, jsonb_build_object('fullName', full_name, 'track', 'Digital Forensics')
      FROM inserted
    `, [digitalId, digitalEventKey]);
    await query(`
      WITH inserted AS (
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, track, status)
        VALUES ($1, 'Outbox Integration', 'outbox-regular@example.com', 'incident_response', 'pending')
        RETURNING registration_id, full_name, email, track
      )
      INSERT INTO public.email_notification_outbox
        (event_key, event_type, regular_track_registration_id, recipient_email, template_data)
      SELECT $2, 'regular_track_registration_confirmation',
        registration_id, email, jsonb_build_object('fullName', full_name, 'track', track)
      FROM inserted
    `, [regularId, regularEventKey]);
    await query(`
      INSERT INTO public.email_notification_outbox
        (event_key, event_type, digital_forensics_registration_id, recipient_email, template_data)
      VALUES ($1, 'digital_forensics_registration_confirmation', $2,
        'outbox-digital@example.com', '{"fullName":"Outbox Integration","track":"Digital Forensics"}')
      ON CONFLICT (event_key) DO NOTHING
    `, [digitalEventKey, digitalId]);

    const events = await query(
      'SELECT event_key, status, recipient_email FROM public.email_notification_outbox WHERE event_key = ANY($1::text[]) ORDER BY event_key',
      [[digitalEventKey, regularEventKey]]
    );
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.status === 'pending'));
    assert.ok(events.some((event) => event.recipient_email === 'outbox-digital@example.com'));
    assert.ok(events.some((event) => event.recipient_email === 'outbox-regular@example.com'));

    const claims = await Promise.all([
      query(`
        UPDATE public.email_notification_outbox
        SET status = 'sending', claim_token = gen_random_uuid(),
            lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 minute'
        WHERE event_id = (
          SELECT event_id FROM public.email_notification_outbox
          WHERE event_key = $1 AND status = 'pending'
          FOR UPDATE SKIP LOCKED
        )
        RETURNING event_id
      `, [digitalEventKey]),
      query(`
        UPDATE public.email_notification_outbox
        SET status = 'sending', claim_token = gen_random_uuid(),
            lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 minute'
        WHERE event_id = (
          SELECT event_id FROM public.email_notification_outbox
          WHERE event_key = $1 AND status = 'pending'
          FOR UPDATE SKIP LOCKED
        )
        RETURNING event_id
      `, [digitalEventKey])
    ]);
    assert.equal(claims.flat().length, 1);
  });

  test('SMS outbox enforces payment-success state, registration links, and 90-day retention', async () => {
    await reset();
    await migrate();
    const client = new Client({ connectionString });
    await client.connect();
    const suffix = crypto.randomUUID();
    const digitalId = `DF-SMS-${suffix}`;
    const regularId = `RT-SMS-${suffix}`;
    const eventKey = `sms-payment-success:${suffix}`;
    const oldEventKey = `${eventKey}:expired`;
    const insertSms = async (overrides = {}) => client.query(`
      INSERT INTO public.sms_notification_outbox (
        event_key, event_type, regular_track_registration_id,
        digital_forensics_registration_id, phone_snapshot, template_data,
        status, attempt_count, next_attempt_at, lease_expires_at, claim_token,
        provider_message_id, last_error_code, sent_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, CURRENT_TIMESTAMP, $9, $10, $11, $12, $13, $14
      )
    `, [
      overrides.eventKey || eventKey,
      overrides.eventType || 'sms_payment_success',
      Object.prototype.hasOwnProperty.call(overrides, 'regularId') ? overrides.regularId : regularId,
      Object.prototype.hasOwnProperty.call(overrides, 'digitalId') ? overrides.digitalId : null,
      overrides.phone || '+233241234567',
      JSON.stringify(overrides.templateData || { fullName: 'SMS Integration' }),
      overrides.status || 'pending',
      overrides.attemptCount || 0,
      overrides.leaseExpiresAt || null,
      overrides.claimToken || null,
      overrides.providerMessageId || null,
      overrides.lastErrorCode || null,
      overrides.sentAt || null,
      overrides.completedAt || null
    ]);
    let savepointCount = 0;
    const expectRejected = async (operation, code) => {
      savepointCount += 1;
      const savepoint = `sms_outbox_check_${savepointCount}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      await assert.rejects(operation(), { code });
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    };

    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO public.digital_forensics_registrations
          (registration_id, full_name, email, status, expected_amount, expected_currency)
        VALUES ($1, 'SMS Integration', $2, 'pending', 1500, 'GHS')
      `, [digitalId, `sms-digital-${suffix}@example.test`]);
      await client.query(`
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, phone, track, status)
        VALUES ($1, 'SMS Integration', $2, '+233241234567', 'incident_response', 'pending')
      `, [regularId, `sms-regular-${suffix}@example.test`]);

      await expectRejected(() => insertSms(), '23514');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:digital-unpaid`,
        regularId: null,
        digitalId
      }), '23514');
      for (const [status, suffix] of [
        ['paid', 'paid'],
        ['payment_initiated', 'payment-initiated'],
        ['payment_failed', 'payment-failed'],
        ['pending', 'pending']
      ]) {
        await client.query(
          'UPDATE public.digital_forensics_registrations SET status = $1 WHERE registration_id = $2',
          [status, digitalId]
        );
        await expectRejected(() => insertSms({
          eventKey: `${eventKey}:digital-${suffix}`,
          regularId: null,
          digitalId
        }), '23514');
      }
      await client.query(
        "UPDATE public.regular_track_applicants SET status = 'payment_initiated' WHERE registration_id = $1",
        [regularId]
      );
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:regular-payment-initiated`
      }), '23514');
      await client.query(
        "UPDATE public.regular_track_applicants SET status = 'payment_verified' WHERE registration_id = $1",
        [regularId]
      );
      await client.query(
        "UPDATE public.digital_forensics_registrations SET status = 'payment_verified' WHERE registration_id = $1",
        [digitalId]
      );

      await insertSms();
      await insertSms({
        eventKey: `${eventKey}:digital`,
        regularId: null,
        digitalId
      });
      await expectRejected(() => insertSms({ eventKey }), '23505');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:invalid-event`,
        eventType: 'registration_confirmation'
      }), '23514');
      await expectRejected(() => insertSms({ eventKey: `${eventKey}:bad-status`, status: 'queued' }), '23514');
      await expectRejected(() => insertSms({ eventKey: `${eventKey}:bad-phone`, phone: '+12025550123' }), '23514');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:no-registration`,
        regularId: null,
        digitalId: null
      }), '23514');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:two-registrations`,
        digitalId
      }), '23514');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:missing-lease`,
        status: 'sending'
      }), '23514');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:bad-sent`,
        status: 'sent'
      }), '23514');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:backdated-insert`,
        status: 'sent',
        sentAt: new Date(),
        completedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)
      }), '55000');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:completed-sending`,
        status: 'sending',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        claimToken: crypto.randomUUID(),
        completedAt: new Date()
      }), '55000');
      await expectRejected(() => insertSms({
        eventKey: `${eventKey}:completed-pending`,
        completedAt: new Date()
      }), '55000');

      await insertSms({
        eventKey: `${eventKey}:valid-lease`,
        status: 'sending',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        claimToken: crypto.randomUUID()
      });
      const incomplete = await client.query(`
        SELECT status, completed_at
        FROM public.sms_notification_outbox
        WHERE event_key = ANY($1::text[])
      `, [[eventKey, `${eventKey}:valid-lease`]]);
      assert.equal(incomplete.rowCount, 2);
      assert.ok(incomplete.rows.every((row) => row.completed_at === null));
      await insertSms({
        eventKey: `${eventKey}:recent-completed`,
        status: 'sent',
        sentAt: new Date()
      });
      await insertSms({ eventKey: `${eventKey}:completion-transition` });
      const transitioned = await client.query(`
        UPDATE public.sms_notification_outbox
        SET status = 'permanent_failed'
        WHERE event_key = $1
        RETURNING completed_at, clock_timestamp() AS database_now
      `, [`${eventKey}:completion-transition`]);
      assert.equal(transitioned.rowCount, 1);
      assert.ok(Math.abs(
        new Date(transitioned.rows[0].completed_at).getTime() -
        new Date(transitioned.rows[0].database_now).getTime()
      ) < 5_000);
      for (const [status, suffix] of [['sent', 'sent-transition'], ['cancelled', 'cancelled-transition']]) {
        const transitionKey = `${eventKey}:${suffix}`;
        await insertSms({ eventKey: transitionKey });
        const transitionResult = await client.query(`
          UPDATE public.sms_notification_outbox
          SET status = $1,
              sent_at = CASE WHEN $1 = 'sent' THEN clock_timestamp() ELSE NULL END
          WHERE event_key = $2
          RETURNING completed_at, clock_timestamp() AS database_now
        `, [status, transitionKey]);
        assert.equal(transitionResult.rowCount, 1);
        assert.ok(Math.abs(
          new Date(transitionResult.rows[0].completed_at).getTime() -
          new Date(transitionResult.rows[0].database_now).getTime()
        ) < 5_000);
      }
      await expectRejected(
        () => client.query(`
          UPDATE public.sms_notification_outbox
          SET completed_at = completed_at - INTERVAL '91 days'
          WHERE event_key = $1
        `, [`${eventKey}:completion-transition`]),
        '55000'
      );
      await expectRejected(
        () => client.query('TRUNCATE public.sms_notification_outbox'),
        '55000'
      );
      await client.query(`
        INSERT INTO public.sms_consent_events
          (regular_track_registration_id, event_type, phone_snapshot, purpose, policy_version, source)
        VALUES ($1, 'grant', '+233241234567',
          'SMS notifications confirming successful payment for a Cybanext programme.',
          'sms-payment-success-v1', 'main_application')
      `, [regularId]);
      await client.query(
        'ALTER TABLE public.sms_notification_outbox DISABLE TRIGGER sms_notification_outbox_completion_timestamp'
      );
      await insertSms({
        eventKey: oldEventKey,
        status: 'sent',
        sentAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
        completedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)
      });
      await client.query(
        'ALTER TABLE public.sms_notification_outbox ENABLE TRIGGER sms_notification_outbox_completion_timestamp'
      );

      await expectRejected(
        () => client.query('DELETE FROM public.sms_notification_outbox WHERE event_key = $1', [`${eventKey}:recent-completed`]),
        '55000'
      );
      const purged = await client.query('SELECT public.purge_expired_sms_notification_outbox() AS deleted_count');
      assert.equal(purged.rows[0].deleted_count, 1);
      assert.equal((await client.query(
        'SELECT count(*)::int AS count FROM public.sms_notification_outbox WHERE event_key = $1',
        [oldEventKey]
      )).rows[0].count, 0);
      assert.equal((await client.query(
        'SELECT count(*)::int AS count FROM public.sms_notification_outbox WHERE event_key = $1',
        [`${eventKey}:recent-completed`]
      )).rows[0].count, 1);
      assert.equal((await client.query(
        'SELECT count(*)::int AS count FROM public.sms_consent_events WHERE regular_track_registration_id = $1',
        [regularId]
      )).rows[0].count, 1);
      await client.query('ROLLBACK');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      await client.end();
    }
  });

  test('registration stores atomically enqueue notifications and production outbox queries claim due events', async (t) => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID();
    const database = require('../lib/digital-forensics-database');
    const digitalStore = require('../lib/digital-forensics-store');
    const regularStore = require('../lib/regular-track-payment-store');
    const { claimDueEvents } = require('../lib/email-notification-outbox');
    const client = new Client({ connectionString });
    await client.connect();
    const registrationIds = [];
    const restoreDatabase = bindDatabaseClient(database, client);
    t.after(async () => {
      restoreDatabase();
      try {
        await client.query('DELETE FROM public.email_notification_outbox WHERE digital_forensics_registration_id = ANY($1::text[]) OR regular_track_registration_id = ANY($1::text[])', [registrationIds]);
        await client.query('DELETE FROM public.digital_forensics_registrations WHERE registration_id = ANY($1::text[])', [registrationIds]);
        await client.query('DELETE FROM public.regular_track_applicants WHERE registration_id = ANY($1::text[])', [registrationIds]);
      } finally {
        await client.end();
      }
    });

    const digital = await digitalStore.createRegistration({
      fullName: 'Outbox Store Test',
      email: 'outbox-digital-store@example.com'
    });
    const regular = await regularStore.createApplicant({
      fullName: 'Outbox Store Test',
      email: 'outbox-regular-store@example.com',
      phone: '',
      track: 'incident_response'
    });
    registrationIds.push(digital.id, regular.id);
    const digitalReference = `DF-NOTIFY-${suffix}`;
    await digitalStore.updateRegistration(digital.id, {
      status: 'payment_initiated',
      paymentReference: digitalReference,
      pricingOption: 'GHS'
    }, { expectedStatus: 'pending', expectedPaymentReference: null });
    const digitalPayment = await digitalStore.updatePaymentStatusWithNotification({
      registrationId: digital.id,
      reference: digitalReference,
      status: 'payment_verified',
      transactionId: `transaction-${suffix}`,
      paymentVerificationTimestamp: new Date().toISOString()
    });
    assert.equal(digitalPayment.status, 'payment_verified');

    const regularReference = `CYB-NOTIFY-${suffix}`;
    await regularStore.createPaymentAttempt({
      reference: regularReference,
      registrationId: regular.id,
      referenceAmount: 30,
      expectedAmount: 34650,
      expectedCurrency: 'GHS'
    });
    await regularStore.updatePaymentAttemptStatus(regularReference, 'payment_initiated');
    const regularPayment = await regularStore.markPaymentAttemptVerified(
      regularReference,
      `transaction-${suffix}`
    );
    assert.equal(regularPayment.reference, regularReference);

    const records = await client.query(`
      SELECT event_type, digital_forensics_registration_id,
        regular_track_registration_id, recipient_email
      FROM public.email_notification_outbox
      WHERE digital_forensics_registration_id = $1 OR regular_track_registration_id = $2
    `, [digital.id, regular.id]);
    assert.equal(records.rows.length, 4);
    assert.ok(records.rows.some((row) =>
      row.digital_forensics_registration_id === digital.id &&
      row.recipient_email === digital.email &&
      row.event_type === 'digital_forensics_registration_confirmation'
    ));
    assert.ok(records.rows.some((row) =>
      row.regular_track_registration_id === regular.id &&
      row.recipient_email === regular.email &&
      row.event_type === 'regular_track_registration_confirmation'
    ));
    assert.ok(records.rows.some((row) =>
      row.digital_forensics_registration_id === digital.id &&
      row.event_type === 'digital_forensics_payment_success'
    ));
    assert.ok(records.rows.some((row) =>
      row.regular_track_registration_id === regular.id &&
      row.event_type === 'regular_track_payment_success'
    ));

    await client.query(`
      UPDATE public.email_notification_outbox
      SET status = 'sent', sent_at = CURRENT_TIMESTAMP
      WHERE digital_forensics_registration_id = $1
        OR (regular_track_registration_id = $2 AND event_type = 'regular_track_payment_success')
    `, [digital.id, regular.id]);
    const claims = await Promise.all([claimDueEvents(1), claimDueEvents(1)]);
    const claimed = claims.flat();
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].eventType, 'regular_track_registration_confirmation');
    assert.equal(claimed[0].recipientEmail, regular.email);
    assert.equal(claimed[0].attemptCount, 1);
  });

  test('payment verification queues one SMS for each registration type and is idempotent', async () => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const database = require('../lib/digital-forensics-database');
    const digitalStore = require('../lib/digital-forensics-store');
    const regularStore = require('../lib/regular-track-payment-store');
    const client = new Client({ connectionString });
    await client.connect();
    const restoreDatabase = bindDatabaseClient(database, client);

    try {
      const fixtures = await createSmsPaymentFixtures(
        digitalStore, regularStore, suffix
      );
      const firstVerification = await verifySmsPaymentFixtures(
        digitalStore, regularStore, fixtures
      );
      assert.equal(firstVerification.digitalPayment.status, 'payment_verified');
      assert.equal(firstVerification.regularPayment.reference, fixtures.regularReference);

      const duplicateVerification = await verifySmsPaymentFixtures(
        digitalStore, regularStore, fixtures
      );
      assert.equal(duplicateVerification.digitalPayment, null);
      assert.equal(duplicateVerification.regularPayment, null);

      const events = await client.query(`
        SELECT event_key, event_type, phone_snapshot, template_data,
          regular_track_registration_id, digital_forensics_registration_id
        FROM public.sms_notification_outbox
        ORDER BY event_key
      `);
      assert.equal(events.rowCount, 2);
      assert.ok(events.rows.some((event) =>
        event.event_type === 'sms_payment_success' &&
        event.digital_forensics_registration_id === fixtures.digital.id &&
        event.regular_track_registration_id === null &&
        event.phone_snapshot === '+233241234567' &&
        event.template_data.track === 'Digital Forensics'
      ));
      assert.ok(events.rows.some((event) =>
        event.event_type === 'sms_payment_success' &&
        event.regular_track_registration_id === fixtures.regular.id &&
        event.digital_forensics_registration_id === null &&
        event.phone_snapshot === '+233241234567' &&
        event.template_data.track === 'incident_response'
      ));
      const paymentEmails = await client.query(`
        SELECT count(*)::int AS count
        FROM public.email_notification_outbox
        WHERE event_type IN (
          'digital_forensics_payment_success',
          'regular_track_payment_success'
        )
      `);
      assert.equal(paymentEmails.rows[0].count, 2);
    } finally {
      restoreDatabase();
      await client.end();
    }
  });

  test('SMS payment queueing suppresses missing current consent without blocking payment', async () => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const database = require('../lib/digital-forensics-database');
    const digitalStore = require('../lib/digital-forensics-store');
    const regularStore = require('../lib/regular-track-payment-store');
    const client = new Client({ connectionString });
    await client.connect();
    const restoreDatabase = bindDatabaseClient(database, client);

    try {
      const fixtures = await createSmsPaymentFixtures(
        digitalStore,
        regularStore,
        suffix,
        { digitalConsent: false, regularConsent: false }
      );

      const payments = await verifySmsPaymentFixtures(
        digitalStore, regularStore, fixtures
      );
      assert.equal(payments.digitalPayment.status, 'payment_verified');
      assert.equal(payments.regularPayment.reference, fixtures.regularReference);
      const smsCount = await client.query(
        'SELECT count(*)::int AS count FROM public.sms_notification_outbox'
      );
      assert.equal(smsCount.rows[0].count, 0);
      const emailCount = await client.query(`
        SELECT count(*)::int AS count
        FROM public.email_notification_outbox
        WHERE event_type IN (
          'digital_forensics_payment_success',
          'regular_track_payment_success'
        )
      `);
      assert.equal(emailCount.rows[0].count, 2);
    } finally {
      restoreDatabase();
      await client.end();
    }
  });

  test('SMS worker suppresses delivery when consent phone no longer matches for both registration types', async () => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const database = require('../lib/digital-forensics-database');
    const digitalStore = require('../lib/digital-forensics-store');
    const regularStore = require('../lib/regular-track-payment-store');
    const { processDueEvents } = require('../lib/sms-notification-outbox');
    const client = new Client({ connectionString });
    await client.connect();
    const restoreDatabase = bindDatabaseClient(database, client);
    const originalFetch = global.fetch;
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      throw new Error('Provider request must not be made after withdrawal.');
    };

    try {
      const fixtures = await createSmsPaymentFixtures(
        digitalStore, regularStore, suffix
      );
      await verifySmsPaymentFixtures(digitalStore, regularStore, fixtures);
      await client.query(`
        UPDATE public.digital_forensics_registrations
        SET phone = '+233201234567'
        WHERE registration_id = $1
      `, [fixtures.digital.id]);
      await client.query(`
        UPDATE public.regular_track_applicants
        SET phone = '+233201234567'
        WHERE registration_id = $1
      `, [fixtures.regular.id]);

      const results = await processDueEvents(10);
      assert.equal(results.length, 2);
      assert.ok(results.every((result) => result.status === 'cancelled'));
      assert.equal(fetchCount, 0);
      const states = await client.query(`
        SELECT status, completed_at, last_error_code
        FROM public.sms_notification_outbox
        ORDER BY event_key
      `);
      assert.equal(states.rowCount, 2);
      assert.ok(states.rows.every((row) =>
        row.status === 'cancelled' &&
        row.completed_at instanceof Date &&
        row.last_error_code === 'consent_not_active'
      ));
    } finally {
      restoreDatabase();
      global.fetch = originalFetch;
      await client.end();
    }
  });

  test('SMS outbox insertion failures roll back both payment verification transactions', async () => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const database = require('../lib/digital-forensics-database');
    const digitalStore = require('../lib/digital-forensics-store');
    const regularStore = require('../lib/regular-track-payment-store');
    const client = new Client({ connectionString });
    await client.connect();
    const restoreDatabase = bindDatabaseClient(database, client);

    try {
      const fixtures = await createSmsPaymentFixtures(
        digitalStore, regularStore, suffix
      );
      await client.query(`
        CREATE FUNCTION public.reject_test_sms_outbox_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected SMS outbox failure';
        END;
        $$
      `);
      await client.query(`
        CREATE TRIGGER reject_test_sms_outbox_insert
        BEFORE INSERT ON public.sms_notification_outbox
        FOR EACH ROW EXECUTE FUNCTION public.reject_test_sms_outbox_insert()
      `);

      for (const verify of [
        () => digitalStore.updatePaymentStatusWithNotification({
          registrationId: fixtures.digital.id,
          reference: fixtures.digitalReference,
          status: 'payment_verified',
          transactionId: `digital-transaction-${suffix}`,
          paymentVerificationTimestamp: new Date().toISOString()
        }),
        () => regularStore.markPaymentAttemptVerified(
          fixtures.regularReference,
          `regular-transaction-${suffix}`
        )
      ]) {
        await assert.rejects(verify(), { code: 'P0001' });
      }

      const paymentStates = await client.query(`
        SELECT 'digital' AS kind, status
        FROM public.digital_forensics_registrations
        WHERE registration_id = $1
        UNION ALL
        SELECT 'regular' AS kind, applicant.status
        FROM public.regular_track_applicants AS applicant
        WHERE applicant.registration_id = $2
        UNION ALL
        SELECT 'attempt' AS kind, status
        FROM public.regular_track_payment_attempts
        WHERE payment_reference = $3
      `, [fixtures.digital.id, fixtures.regular.id, fixtures.regularReference]);
      assert.deepEqual(
        Object.fromEntries(paymentStates.rows.map(({ kind, status }) => [kind, status])),
        {
          digital: 'payment_initiated',
          regular: 'payment_initiated',
          attempt: 'payment_initiated'
        }
      );
      const notificationCounts = await client.query(`
        SELECT
          (SELECT count(*)::int FROM public.sms_notification_outbox) AS sms_count,
          (SELECT count(*)::int FROM public.email_notification_outbox
            WHERE event_type IN (
              'digital_forensics_payment_success',
              'regular_track_payment_success'
            )) AS payment_email_count
      `);
      assert.equal(notificationCounts.rows[0].sms_count, 0);
      assert.equal(notificationCounts.rows[0].payment_email_count, 0);
    } finally {
      restoreDatabase();
      await client.query(`
        DROP TRIGGER IF EXISTS reject_test_sms_outbox_insert
          ON public.sms_notification_outbox
      `);
      await client.query(
        'DROP FUNCTION IF EXISTS public.reject_test_sms_outbox_insert()'
      );
      await client.end();
    }
  });

  test('SMS worker claims are exclusive and expired leases are reclaimed', async () => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const database = require('../lib/digital-forensics-database');
    const regularStore = require('../lib/regular-track-payment-store');
    const { claimDueEvents } = require('../lib/sms-notification-outbox');
    const setupClient = new Client({ connectionString });
    await setupClient.connect();
    const restoreSetupDatabase = bindDatabaseClient(database, setupClient);
    let clients;
    let restoreQuery = () => {};

    try {
      const applicant = await regularStore.createApplicant({
        fullName: `SMS Claim ${suffix}`,
        email: `sms-claim-${suffix}@example.test`,
        phone: '0241234567',
        track: 'incident_response',
        smsConsent: true
      });
      const reference = `CYB-SMS-CLAIM-${suffix}`;
      await regularStore.createPaymentAttempt({
        reference,
        registrationId: applicant.id,
        referenceAmount: 30,
        expectedAmount: 34650,
        expectedCurrency: 'GHS'
      });
      await regularStore.updatePaymentAttemptStatus(reference, 'payment_initiated');
      await regularStore.markPaymentAttemptVerified(reference, `tx-${suffix}`);
      restoreSetupDatabase();

      clients = [new Client({ connectionString }), new Client({ connectionString })];
      await Promise.all(clients.map((client) => client.connect()));
      await clients[0].query(`
        CREATE FUNCTION public.pause_test_sms_outbox_claim()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'sending' THEN PERFORM pg_sleep(0.3); END IF;
          RETURN NEW;
        END;
        $$
      `);
      await clients[0].query(`
        CREATE TRIGGER pause_test_sms_outbox_claim
        BEFORE UPDATE OF status ON public.sms_notification_outbox
        FOR EACH ROW EXECUTE FUNCTION public.pause_test_sms_outbox_claim()
      `);

      const originalQuery = database.query;
      let nextClient = 0;
      database.query = async (strings, ...values) => {
        const client = clients[nextClient % clients.length];
        nextClient += 1;
        const statement = strings.reduce((sql, part, index) =>
          sql + (index === 0 ? '' : `$${index}`) + part, '');
        return (await client.query(statement, values)).rows;
      };
      restoreQuery = () => { database.query = originalQuery; };
      const claims = await Promise.all([claimDueEvents(1), claimDueEvents(1)]);
      const claimed = claims.flat();
      assert.equal(claimed.length, 1);
      const firstClaim = claimed[0];
      assert.equal(firstClaim.regularTrackRegistrationId, applicant.id);
      assert.equal(firstClaim.attemptCount, 1);
      assert.ok(firstClaim.claimToken);

      const firstState = await clients[0].query(`
        SELECT status, attempt_count, claim_token, lease_expires_at
        FROM public.sms_notification_outbox
        WHERE event_id = $1
      `, [firstClaim.eventId]);
      assert.equal(firstState.rows[0].status, 'sending');
      assert.equal(firstState.rows[0].attempt_count, 1);
      assert.equal(firstState.rows[0].claim_token, firstClaim.claimToken);
      assert.ok(firstState.rows[0].lease_expires_at > new Date());

      await clients[0].query(`
        UPDATE public.sms_notification_outbox
        SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE event_id = $1
      `, [firstClaim.eventId]);
      database.query = async (strings, ...values) => {
        const statement = strings.reduce((sql, part, index) =>
          sql + (index === 0 ? '' : `$${index}`) + part, '');
        return (await clients[0].query(statement, values)).rows;
      };
      const reclaimed = await claimDueEvents(1);
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0].eventId, firstClaim.eventId);
      assert.equal(reclaimed[0].attemptCount, 2);
      assert.notEqual(reclaimed[0].claimToken, firstClaim.claimToken);
    } finally {
      restoreQuery();
      restoreSetupDatabase();
      if (clients) {
        try {
          await clients[0].query(`
            DROP TRIGGER IF EXISTS pause_test_sms_outbox_claim
              ON public.sms_notification_outbox
          `);
          await clients[0].query(
            'DROP FUNCTION IF EXISTS public.pause_test_sms_outbox_claim()'
          );
        } finally {
          await Promise.all(clients.map((client) => client.end()));
        }
      }
      await setupClient.end();
    }
  });

  test('production outbox claims are exclusive across concurrent PostgreSQL sessions', async (t) => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const registrationId = `RT-CLAIM-${suffix}`;
    const eventKey = `concurrent-claim:${suffix}`;
    const functionName = `pause_test_outbox_claim_${suffix}`;
    const triggerName = `pause_test_outbox_claim_trigger_${suffix}`;
    const database = require('../lib/digital-forensics-database');
    const { claimDueEvents } = require('../lib/email-notification-outbox');
    const originalQuery = database.query;
    const clients = [new Client({ connectionString }), new Client({ connectionString })];
    await Promise.all(clients.map((client) => client.connect()));

    try {
      await clients[0].query(`
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, track, status)
        VALUES ($1, 'Concurrent Claim Test', $2, 'incident_response', 'pending')
      `, [registrationId, `${suffix}@example.test`]);
      await clients[0].query(`
        INSERT INTO public.email_notification_outbox
          (event_key, event_type, regular_track_registration_id, recipient_email, template_data)
        VALUES ($1, 'regular_track_registration_confirmation', $2, $3, '{"fullName":"Concurrent Claim Test"}')
      `, [eventKey, registrationId, `${suffix}@example.test`]);
      await clients[0].query(`
        CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_key = '${eventKey}' THEN PERFORM pg_sleep(0.3); END IF;
          RETURN NEW;
        END
        $$
      `);
      await clients[0].query(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF status ON public.email_notification_outbox
        FOR EACH ROW EXECUTE FUNCTION public.${functionName}()
      `);

      const backendIds = await Promise.all(clients.map(async (client) =>
        (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      ));
      assert.notEqual(backendIds[0], backendIds[1]);

      let nextClient = 0;
      database.query = async (strings, ...values) => {
        const statement = strings.reduce((sql, part, index) =>
          sql + (index === 0 ? '' : `$${index}`) + part, '');
        const client = clients[nextClient++ % clients.length];
        return (await client.query(statement, values)).rows;
      };
      const claims = await Promise.all([claimDueEvents(1), claimDueEvents(1)]);
      const claimed = claims.flat();
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].eventKey, eventKey);
      assert.equal(claimed[0].attemptCount, 1);
      const stored = await clients[0].query(
        'SELECT status, attempt_count FROM public.email_notification_outbox WHERE event_key = $1',
        [eventKey]
      );
      assert.equal(stored.rows[0].status, 'sending');
      assert.equal(stored.rows[0].attempt_count, 1);
    } finally {
      database.query = originalQuery;
      await clients[0].query(`DROP TRIGGER IF EXISTS ${triggerName} ON public.email_notification_outbox`);
      await clients[0].query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      await clients[0].query('DELETE FROM public.email_notification_outbox WHERE event_key = $1', [eventKey]);
      await clients[0].query('DELETE FROM public.regular_track_applicants WHERE registration_id = $1', [registrationId]);
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  test('outbox recovers expired worker leases, schedules bounded retries, and exhausts attempts', async (t) => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const registrationId = `RT-RECOVERY-${suffix}`;
    const eventKey = `worker-recovery:${suffix}`;
    const database = require('../lib/digital-forensics-database');
    const { MAX_ATTEMPTS } = require('../lib/email-notification');
    const {
      claimDueEvents,
      processDueEvents,
      requeuePermanentFailure
    } = require('../lib/email-notification-outbox');
    const originalQuery = database.query;
    const client = new Client({ connectionString });
    await client.connect();
    database.query = async (strings, ...values) => {
      const statement = strings.reduce((sql, part, index) =>
        sql + (index === 0 ? '' : `$${index}`) + part, '');
      return (await client.query(statement, values)).rows;
    };
    const previousEnvironment = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      AUTH_EMAIL_FROM: process.env.AUTH_EMAIL_FROM
    };
    const originalFetch = global.fetch;
    t.after(async () => {
      database.query = originalQuery;
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await client.query('DELETE FROM public.email_notification_outbox WHERE event_key = $1', [eventKey]);
      await client.query('DELETE FROM public.regular_track_applicants WHERE registration_id = $1', [registrationId]);
      await client.end();
    });

    await client.query(`
      INSERT INTO public.regular_track_applicants
        (registration_id, full_name, email, track, status)
      VALUES ($1, 'Worker Recovery Test', $2, 'incident_response', 'pending')
    `, [registrationId, `${suffix}@example.test`]);
    await client.query(`
      INSERT INTO public.email_notification_outbox
        (event_key, event_type, regular_track_registration_id, recipient_email, template_data)
      VALUES ($1, 'regular_track_registration_confirmation', $2, $3, '{"fullName":"Worker Recovery Test"}')
    `, [eventKey, registrationId, `${suffix}@example.test`]);

    const firstClaim = await claimDueEvents(1);
    assert.equal(firstClaim[0].attemptCount, 1);
    await client.query(`
      UPDATE public.email_notification_outbox
      SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE event_key = $1
    `, [eventKey]);
    const recoveredClaim = await claimDueEvents(1);
    assert.equal(recoveredClaim[0].eventKey, eventKey);
    assert.equal(recoveredClaim[0].attemptCount, 2);
    assert.notEqual(recoveredClaim[0].claimToken, firstClaim[0].claimToken);

    process.env.RESEND_API_KEY = 'mock_resend_key';
    process.env.AUTH_EMAIL_FROM = 'verified@example.com';
    global.fetch = async () => ({ ok: false, status: 503 });
    await client.query(`
      UPDATE public.email_notification_outbox
      SET status = 'pending', attempt_count = 2,
          lease_expires_at = NULL, claim_token = NULL,
          next_attempt_at = CURRENT_TIMESTAMP
      WHERE event_key = $1
    `, [eventKey]);
    const beforeRetry = Date.now();
    const retryResults = await processDueEvents(1);
    assert.equal(retryResults[0].status, 'retry_scheduled');
    const retryRow = (await client.query(`
      SELECT status, attempt_count, last_error_code,
        EXTRACT(EPOCH FROM (next_attempt_at - CURRENT_TIMESTAMP)) AS delay_seconds
      FROM public.email_notification_outbox WHERE event_key = $1
    `, [eventKey])).rows[0];
    assert.equal(retryRow.status, 'pending');
    assert.equal(retryRow.attempt_count, 3);
    assert.equal(retryRow.last_error_code, 'resend_server_error');
    assert.ok(Number(retryRow.delay_seconds) > 225 && Number(retryRow.delay_seconds) <= 240);
    assert.ok(Date.now() - beforeRetry < 30000);

    await client.query(`
      UPDATE public.email_notification_outbox
      SET attempt_count = $2, next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE event_key = $1
    `, [eventKey, MAX_ATTEMPTS]);
    const exhausted = await claimDueEvents(1);
    assert.equal(exhausted[0].eventKey, eventKey);
    assert.equal(exhausted[0].claimStatus, 'permanent_failed');
    const finalRow = (await client.query(`
      SELECT status, attempt_count, last_error_code
      FROM public.email_notification_outbox WHERE event_key = $1
    `, [eventKey])).rows[0];
    assert.equal(finalRow.status, 'permanent_failed');
    assert.equal(finalRow.attempt_count, MAX_ATTEMPTS);
    assert.equal(finalRow.last_error_code, 'max_attempts');

    assert.equal(await requeuePermanentFailure(eventKey), true);
    const requeuedRow = (await client.query(`
      SELECT status, attempt_count, last_error_code
      FROM public.email_notification_outbox WHERE event_key = $1
    `, [eventKey])).rows[0];
    assert.equal(requeuedRow.status, 'pending');
    assert.equal(requeuedRow.attempt_count, 0);
    assert.equal(requeuedRow.last_error_code, null);
  });

  test('missing Resend configuration exhausts attempts and operator requeue reuses the same event', async (t) => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const registrationId = `RT-CONFIG-${suffix}`;
    const eventKey = `configuration-recovery:${suffix}`;
    const database = require('../lib/digital-forensics-database');
    const { claimDueEvents, processDueEvents, requeuePermanentFailure } =
      require('../lib/email-notification-outbox');
    const { MAX_ATTEMPTS } = require('../lib/email-notification');
    const originalQuery = database.query;
    const originalFetch = global.fetch;
    const previousEnvironment = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      AUTH_EMAIL_FROM: process.env.AUTH_EMAIL_FROM
    };
    const client = new Client({ connectionString });
    await client.connect();
    database.query = async (strings, ...values) => {
      const statement = strings.reduce((sql, part, index) =>
        sql + (index === 0 ? '' : `$${index}`) + part, '');
      return (await client.query(statement, values)).rows;
    };

    try {
      await client.query(`
        INSERT INTO public.regular_track_applicants
          (registration_id, full_name, email, track, status)
        VALUES ($1, 'Configuration Retry Test', $2, 'incident_response', 'pending')
      `, [registrationId, `${suffix}@example.test`]);
      await client.query(`
        INSERT INTO public.email_notification_outbox
          (event_key, event_type, regular_track_registration_id, recipient_email, template_data)
        VALUES ($1, 'regular_track_registration_confirmation', $2, $3, '{"fullName":"Configuration Retry Test"}')
      `, [eventKey, registrationId, `${suffix}@example.test`]);

      process.env.RESEND_API_KEY = '';
      process.env.AUTH_EMAIL_FROM = 'verified@example.com';
      let fetchCount = 0;
      global.fetch = async () => {
        fetchCount += 1;
        return { ok: true, status: 200 };
      };

      const statuses = [];
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        statuses.push((await processDueEvents(1))[0].status);
        await client.query(`
          UPDATE public.email_notification_outbox
          SET next_attempt_at = CURRENT_TIMESTAMP
          WHERE event_key = $1 AND status = 'pending'
        `, [eventKey]);
      }
      assert.deepEqual(statuses, [
        'retry_scheduled', 'retry_scheduled', 'retry_scheduled',
        'retry_scheduled', 'permanent_failed'
      ]);
      assert.equal(fetchCount, 0);

      const beforeRequeue = (await client.query(`
        SELECT event_id, status, attempt_count
        FROM public.email_notification_outbox WHERE event_key = $1
      `, [eventKey])).rows[0];
      assert.equal(beforeRequeue.status, 'permanent_failed');
      assert.equal(beforeRequeue.attempt_count, MAX_ATTEMPTS);
      assert.equal(await requeuePermanentFailure(eventKey), true);

      const afterRequeue = (await client.query(`
        SELECT event_id, status, attempt_count
        FROM public.email_notification_outbox WHERE event_key = $1
      `, [eventKey])).rows[0];
      assert.equal(afterRequeue.event_id, beforeRequeue.event_id);
      assert.equal(afterRequeue.status, 'pending');
      assert.equal(afterRequeue.attempt_count, 0);
      assert.equal((await client.query(
        'SELECT count(*)::int AS count FROM public.email_notification_outbox WHERE event_key = $1',
        [eventKey]
      )).rows[0].count, 1);

      process.env.RESEND_API_KEY = 'mock_resend_key';
      const recovered = await processDueEvents(1);
      assert.equal(recovered[0].status, 'sent');
      assert.equal(fetchCount, 1);
      const finalRecord = (await client.query(`
        SELECT event_id, status, attempt_count
        FROM public.email_notification_outbox WHERE event_key = $1
      `, [eventKey])).rows[0];
      assert.equal(finalRecord.event_id, beforeRequeue.event_id);
      assert.equal(finalRecord.status, 'sent');
      assert.equal(finalRecord.attempt_count, 1);
    } finally {
      database.query = originalQuery;
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await client.query('DELETE FROM public.email_notification_outbox WHERE event_key = $1', [eventKey]);
      await client.query('DELETE FROM public.regular_track_applicants WHERE registration_id = $1', [registrationId]);
      await client.end();
    }
  });

  test('registration and notification insertion roll back atomically on outbox failure', async (t) => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const functionName = `reject_test_notification_${suffix}`;
    const triggerName = `reject_test_notification_trigger_${suffix}`;
    const testEmail = `${suffix}@example.test`;
    const database = require('../lib/digital-forensics-database');
    const regularStore = require('../lib/regular-track-payment-store');
    const originalQuery = database.query;
    const client = new Client({ connectionString });
    await client.connect();
    database.query = async (strings, ...values) => {
      const statement = strings.reduce((sql, part, index) =>
        sql + (index === 0 ? '' : `$${index}`) + part, '');
      return (await client.query(statement, values)).rows;
    };

    try {
      await client.query(`
        CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.recipient_email = '${testEmail}' THEN
            RAISE EXCEPTION 'intentional outbox insertion failure' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await client.query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON public.email_notification_outbox
        FOR EACH ROW EXECUTE FUNCTION public.${functionName}()
      `);
      await assert.rejects(regularStore.createApplicant({
        fullName: 'Atomic Notification Rollback',
        email: testEmail,
        phone: '+233241234567',
        track: 'incident_response',
        smsConsent: true
      }));
      const applicants = await client.query(
        'SELECT count(*)::int AS count FROM public.regular_track_applicants WHERE email = $1',
        [testEmail]
      );
      assert.equal(applicants.rows[0].count, 0);
      const consentEvents = await client.query(
        `SELECT count(*)::int AS count
         FROM public.sms_consent_events
         WHERE phone_snapshot = '+233241234567' AND source = 'main_application'`
      );
      assert.equal(consentEvents.rows[0].count, 0);
    } finally {
      database.query = originalQuery;
      await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON public.email_notification_outbox`);
      await client.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      await client.query('DELETE FROM public.email_notification_outbox WHERE recipient_email = $1', [testEmail]);
      await client.query('DELETE FROM public.regular_track_applicants WHERE email = $1', [testEmail]);
      await client.end();
    }
  });

  test('repeated apply is idempotent and checksum mismatch is rejected', async () => {
    await reset(); await migrate(); await migrate();
    await query("UPDATE public.schema_migrations SET checksum = repeat('0', 64) WHERE filename = $1", [MIGRATION_FILES[0]]);
    await assert.rejects(migrate(), /Migration operation failed/);
  });

  test('schema drift with applied history fails without repairing schema or changing registration data', async () => {
    await reset(); await migrate();
    await query(`
      INSERT INTO public.digital_forensics_registrations
        (registration_id, full_name, email, status, expected_amount, expected_currency)
      VALUES ('drift-preservation', 'Drift Check', 'drift-check@example.com', 'pending', 1, 'GHS')
    `);
    await query('DROP INDEX public.digital_forensics_registrations_email_idx');
    await assert.rejects(migrate(), /Migration operation failed/);
    assert.equal((await query("SELECT to_regclass('public.digital_forensics_registrations_email_idx') AS index_name"))[0].index_name, null);
    assert.equal((await query("SELECT count(*)::int AS count FROM public.schema_migrations"))[0].count, MIGRATION_FILES.length);
    assert.equal((await query("SELECT full_name FROM public.digital_forensics_registrations WHERE registration_id = 'drift-preservation'"))[0].full_name, 'Drift Check');
  });

  test('schema verification failure rolls back pending migration DDL and history while preserving registration data', async () => {
    await reset();
    const [firstMigration] = loadMigrations();
    for (const statement of firstMigration.statements) await query(statement);
    await query(`
      CREATE TABLE public.schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await query(
      'INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)',
      [firstMigration.filename, firstMigration.checksum]
    );
    await query(`
      INSERT INTO public.digital_forensics_registrations
        (registration_id, full_name, email, status, expected_amount, expected_currency)
      VALUES ('pending-migration-preservation', 'Rollback Check', 'rollback-check@example.com', 'pending', 1, 'GHS')
    `);
    await query('DROP INDEX public.digital_forensics_registrations_email_idx');

    await assert.rejects(migrate(), /Migration operation failed/);

    const history = await query('SELECT filename FROM public.schema_migrations ORDER BY filename');
    assert.deepEqual(history.map((row) => row.filename), [firstMigration.filename]);
    for (const tableName of [
      'applicant_magic_link_tokens',
      'applicant_sessions',
      'applicant_login_rate_limits'
    ]) {
      assert.equal((await query('SELECT to_regclass($1) AS table_name', [`public.${tableName}`]))[0].table_name, null);
    }
    assert.equal(
      (await query("SELECT full_name FROM public.digital_forensics_registrations WHERE registration_id = 'pending-migration-preservation'"))[0].full_name,
      'Rollback Check'
    );
    assert.equal(
      (await query("SELECT to_regclass('public.digital_forensics_registrations_email_idx') AS index_name"))[0].index_name,
      null
    );
  });

  test('suppressed pending history insertion is detected and rolled back', async () => {
    await reset();
    const [firstMigration] = loadMigrations();
    for (const statement of firstMigration.statements) await query(statement);
    await query(`
      CREATE TABLE public.schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await query(
      'INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)',
      [firstMigration.filename, firstMigration.checksum]
    );
    await query(`
      CREATE FUNCTION public.suppress_pending_migration_history() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.filename = '${MIGRATION_FILES[1]}' THEN RETURN NULL; END IF;
        RETURN NEW;
      END
      $$
    `);
    await query(`
      CREATE TRIGGER suppress_pending_migration_history
      BEFORE INSERT ON public.schema_migrations
      FOR EACH ROW EXECUTE FUNCTION public.suppress_pending_migration_history()
    `);

    await assert.rejects(
      migrate(),
      (error) => error.schemaMismatchCategory === 'migration history records'
    );
    assert.deepEqual(
      (await query('SELECT filename FROM public.schema_migrations ORDER BY filename')).map((row) => row.filename),
      [firstMigration.filename]
    );
    for (const tableName of [
      'applicant_magic_link_tokens',
      'applicant_sessions',
      'applicant_login_rate_limits',
      'regular_track_applicants',
      'regular_track_payment_attempts'
    ]) {
      assert.equal((await query('SELECT to_regclass($1) AS table_name', [`public.${tableName}`]))[0].table_name, null);
    }
  });

  test('migration history triggers, policies, and direct ACL grants are rejected', async (t) => {
    const cases = [
      ['trigger', async () => {
        await query(`
          CREATE FUNCTION public.reject_history_trigger() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
        `);
        await query(`
          CREATE TRIGGER reject_history_trigger BEFORE INSERT ON public.schema_migrations
          FOR EACH ROW EXECUTE FUNCTION public.reject_history_trigger()
        `);
      }],
      ['RLS policy', async () => {
        await query('ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY');
        await query('CREATE POLICY reject_history_policy ON public.schema_migrations USING (true)');
      }],
      ['table ACL grant', async () => {
        await query('GRANT SELECT ON TABLE public.schema_migrations TO PUBLIC');
      }],
      ['column ACL grant', async () => {
        await query('GRANT SELECT (filename) ON TABLE public.schema_migrations TO PUBLIC');
      }]
    ];
    for (const [label, addMismatch] of cases) {
      await t.test(label, async () => {
        await reset();
        await migrate();
        await addMismatch();
        await assert.rejects(migrate(), /Migration operation failed/);
      });
    }
  });

  test('ordinary owner-only default table and column ACLs are accepted', async () => {
    await reset();
    await migrate();
    const defaultAclTables = EXPECTED_TABLES.filter((name) =>
      ![
        'sms_consent_events',
        'sms_current_consent',
        'regular_track_applicants',
        'digital_forensics_registrations'
      ].includes(name));
    const aclDefaults = await query(`
      SELECT c.relname AS table_name, c.relacl IS NULL AS default_table_acl,
             bool_and(a.attacl IS NULL) AS default_column_acls
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
        AND a.attnum > 0 AND NOT a.attisdropped
      GROUP BY c.relname, c.relacl
    `, [defaultAclTables]);
    assert.equal(aclDefaults.length, defaultAclTables.length);
    assert.ok(aclDefaults.every((row) => row.default_table_acl && row.default_column_acls));
    await assert.doesNotReject(migrate());
  });

  test('explicit non-owner table ACL grants are rejected', async () => {
    await reset();
    await migrate();
    await query('GRANT SELECT ON TABLE public.applicant_sessions TO PUBLIC');
    await assert.rejects(migrate(), /schema mismatch: table and column privileges/);
  });

  test('explicit non-owner column ACL grants are rejected', async () => {
    await reset();
    await migrate();
    await query('GRANT SELECT (session_token_hash) ON TABLE public.applicant_sessions TO PUBLIC');
    await assert.rejects(migrate(), /schema mismatch: table and column privileges/);
  });

  test('unknown and out-of-order history are rejected', async () => {
    for (const rows of [
      [['999_unknown.sql', '0'.repeat(64)]],
      [[MIGRATION_FILES[1], loadMigrations()[1].checksum]],
      [[MIGRATION_FILES[1], loadMigrations()[1].checksum], [MIGRATION_FILES[0], loadMigrations()[0].checksum]]
    ]) {
      await reset();
      await query('CREATE TABLE public.schema_migrations (filename text primary key, checksum text not null, applied_at timestamptz not null default current_timestamp)');
      for (const [filename, checksum] of rows) await query('INSERT INTO public.schema_migrations(filename, checksum) VALUES ($1, $2)', [filename, checksum]);
      await assert.rejects(migrate(), /Migration operation failed/);
      assert.equal((await query("SELECT to_regclass('public.digital_forensics_registrations') AS table_name"))[0].table_name, null);
    }
  });

  test('development adoption accepts exact schema and rejects schema drift', async () => {
    await reset();
    for (const migration of loadMigrations()) for (const statement of migration.statements) await query(statement);
    await migrate({ adoptExisting: true });
    assert.equal((await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count, MIGRATION_FILES.length);
    assert.equal((await query("SELECT to_regclass('public.digital_forensics_registrations') AS table_name"))[0].table_name, 'digital_forensics_registrations');
    await reset();
    for (const migration of loadMigrations()) for (const statement of migration.statements) await query(statement);
    await query('ALTER TABLE public.digital_forensics_registrations ADD COLUMN unexpected text');
    await assert.rejects(migrate({ adoptExisting: true }), /schema adoption failed/);
    assert.equal((await query("SELECT to_regclass('public.schema_migrations') AS table_name"))[0].table_name, null);
  });

  test('development adoption upgrades an exact pre-003 schema transactionally', async () => {
    await reset();
    for (const migration of loadMigrations().slice(0, 2)) {
      for (const statement of migration.statements) await query(statement);
    }

    const result = await migrate({ adoptExisting: true });

    assert.equal(result.upgradedLegacySchema, true);
    const history = await query(
      'SELECT filename FROM public.schema_migrations ORDER BY filename'
    );
    assert.deepEqual(history.map((row) => row.filename), MIGRATION_FILES);
    for (const tableName of [
      'regular_track_applicants',
      'regular_track_payment_attempts',
      'sms_consent_events',
      'sms_notification_outbox'
    ]) {
      assert.equal(
        (await query('SELECT to_regclass($1) AS table_name', [
          `public.${tableName}`
        ]))[0].table_name,
        tableName
      );
    }
  });

  test('development adoption upgrades an exact pre-005 schema transactionally', async () => {
    await reset();
    for (const migration of loadMigrations().slice(0, 4)) {
      for (const statement of migration.statements) await query(statement);
    }
    const result = await migrate({ adoptExisting: true });
    assert.equal(result.upgradedLegacySchema, true);
    assert.equal(
      (await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count,
      MIGRATION_FILES.length
    );
    assert.equal(
      (await query("SELECT to_regclass('public.email_notification_outbox') AS table_name"))[0].table_name,
      'email_notification_outbox'
    );
    assert.equal(
      (await query("SELECT to_regclass('public.sms_consent_events') AS table_name"))[0].table_name,
      'sms_consent_events'
    );
    assert.equal(
      (await query("SELECT to_regclass('public.sms_notification_outbox') AS table_name"))[0].table_name,
      'sms_notification_outbox'
    );
  });

  test('development adoption upgrades an exact pre-006 schema transactionally', async () => {
    await reset();
    for (const migration of loadMigrations().slice(0, 5)) {
      for (const statement of migration.statements) await query(statement);
    }

    const result = await migrate({ adoptExisting: true });
    assert.equal(result.upgradedLegacySchema, true);
    const history = await query('SELECT filename FROM public.schema_migrations ORDER BY filename');
    assert.deepEqual(history.map((row) => row.filename), MIGRATION_FILES);
    assert.equal(
      (await query("SELECT to_regclass('public.sms_notification_outbox') AS table_name"))[0].table_name,
      'sms_notification_outbox'
    );
  });

  test('malformed migration-history structure is rejected safely', async () => {
    await reset();
    await query('CREATE TABLE public.schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL)');
    await assert.rejects(migrate(), /Migration operation failed/);
    assert.equal((await query("SELECT to_regclass('public.digital_forensics_registrations') AS table_name"))[0].table_name, null);
  });

  test('failing migration DDL rolls back history and all migration objects', async () => {
    await reset();
    await installPre006Schema();
    const failingStatement = loadMigrations()[5].statements[0];
    await assert.rejects(migrate({
      createClient: () => clientFactory(injectMigrationExecutionFailure(
        failingStatement,
        'SELECT cybanext_missing_migration_test_function()'
      ))
    }), /Migration operation failed/);
    await assertPre006SchemaIntact();
    await assertSmsOutboxObjectsAbsent();
  });

  test('failure in migration 006 rolls back the SMS outbox and prior migration DDL', async () => {
    await reset();
    await installPre006Schema();
    const failingStatement = loadMigrations()[5].statements[1];
    await assert.rejects(migrate({
      createClient: () => clientFactory(injectMigrationExecutionFailure(
        failingStatement,
        'CREATE INDEX IF NOT EXISTS sms_notification_outbox_regular_registration_idx ON sms_notification_outbox (missing_test_column)'
      ))
    }), /Migration operation failed/);
    await assertPre006SchemaIntact();
    await assertSmsOutboxObjectsAbsent();
  });

  test('concurrent migration processes serialize on PostgreSQL advisory lock', async () => {
    await reset();
    const results = await Promise.all([migrate(), migrate()]);
    assert.equal(results.length, 2);
    assert.equal((await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count, MIGRATION_FILES.length);
  });

  test('regular-track payment attempts serialize per applicant and allow safe retries', async () => {
    await migrate();
    const database = require('../lib/digital-forensics-database');
    const regularTrackStore = require('../lib/regular-track-payment-store');
    const originalQuery = database.query;
    const registrationIds = [];
    const makeReference = () =>
      `CYB-IT-${Date.now()}-${require('node:crypto').randomBytes(6).toString('hex')}`;
    database.query = (strings, ...values) => {
      const statement = strings.reduce(
        (sql, part, index) =>
          sql + part + (index < values.length ? `$${index + 1}` : ''),
        ''
      );
      return query(statement, values);
    };

    try {
      const firstApplicant = await regularTrackStore.createApplicant({
        fullName: 'Concurrency Applicant One',
        email: `${makeReference().toLowerCase()}@example.com`,
        phone: '',
        track: 'incident_response'
      });
      registrationIds.push(firstApplicant.id);
      const secondApplicant = await regularTrackStore.createApplicant({
        fullName: 'Concurrency Applicant Two',
        email: `${makeReference().toLowerCase()}@example.com`,
        phone: '',
        track: 'soc_analyst'
      });
      registrationIds.push(secondApplicant.id);

      const attemptDetails = (registrationId) => ({
        registrationId,
        reference: makeReference(),
        referenceAmount: 30,
        expectedAmount: 34650,
        expectedCurrency: 'GHS'
      });
      const firstRace = attemptDetails(firstApplicant.id);
      const secondRace = attemptDetails(firstApplicant.id);
      const independentApplicantAttempt = attemptDetails(secondApplicant.id);
      const [firstResult, secondResult, independentResult] = await Promise.all([
        regularTrackStore.createPaymentAttempt(firstRace),
        regularTrackStore.createPaymentAttempt(secondRace),
        regularTrackStore.createPaymentAttempt(independentApplicantAttempt)
      ]);

      const sameApplicantResults = [firstResult, secondResult];
      assert.equal(sameApplicantResults.filter(Boolean).length, 1);
      assert.equal(sameApplicantResults.filter((result) => result === null).length, 1);
      assert.ok(independentResult, 'a separate applicant should initialize independently');

      const activeAttempts = await query(`
        SELECT registration_id, count(*)::int AS count
        FROM public.regular_track_payment_attempts
        WHERE registration_id = ANY($1::text[])
          AND status IN ('initializing', 'payment_initiated')
        GROUP BY registration_id
      `, [registrationIds]);
      assert.deepEqual(
        Object.fromEntries(activeAttempts.map((row) => [row.registration_id, row.count])),
        {
          [firstApplicant.id]: 1,
          [secondApplicant.id]: 1
        }
      );

      const winningAttempt = sameApplicantResults.find(Boolean);
      assert.ok(await regularTrackStore.markPaymentAttemptFailed(winningAttempt.reference));
      const retryAttempt = await regularTrackStore.createPaymentAttempt(
        attemptDetails(firstApplicant.id)
      );
      assert.ok(retryAttempt, 'a terminal failed attempt should permit a retry');

      const finalAttempts = await query(`
        SELECT registration_id,
               count(*) FILTER (
                 WHERE status IN ('initializing', 'payment_initiated')
               )::int AS active_count,
               count(*) FILTER (WHERE status = 'failed')::int AS failed_count
        FROM public.regular_track_payment_attempts
        WHERE registration_id = ANY($1::text[])
        GROUP BY registration_id
      `, [registrationIds]);
      assert.deepEqual(
        Object.fromEntries(finalAttempts.map((row) => [
          row.registration_id,
          { active: row.active_count, failed: row.failed_count }
        ])),
        {
          [firstApplicant.id]: { active: 1, failed: 1 },
          [secondApplicant.id]: { active: 1, failed: 0 }
        }
      );
    } finally {
      try {
        if (registrationIds.length) {
          await query(
            'DELETE FROM public.regular_track_applicants WHERE registration_id = ANY($1::text[])',
            [registrationIds]
          );
        }
      } finally {
        database.query = originalQuery;
      }
    }
  });

  test('regular-track verification transitions serialize without downgrading a verified payment', async () => {
    await reset();
    await migrate();
    const database = require('../lib/digital-forensics-database');
    const regularTrackStore = require('../lib/regular-track-payment-store');
    const originalQuery = database.query;
    const originalTransaction = database.transaction;
    const registrationIds = [];
    let successfulClient;
    let failedClient;
    const reference =
      `CYB-IT-CONCURRENT-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    database.query = (strings, ...values) => {
      const statement = strings.reduce(
        (sql, part, index) =>
          sql + part + (index < values.length ? `$${index + 1}` : ''),
        ''
      );
      return query(statement, values);
    };

    try {
      const applicant = await regularTrackStore.createApplicant({
        fullName: 'Concurrent Verification Applicant',
        email: `${reference.toLowerCase()}@example.com`,
        phone: '',
        track: 'incident_response'
      });
      registrationIds.push(applicant.id);
      const attempt = await regularTrackStore.createPaymentAttempt({
        registrationId: applicant.id,
        reference,
        referenceAmount: 30,
        expectedAmount: 34650,
        expectedCurrency: 'GHS'
      });
      assert.ok(attempt);

      successfulClient = new Client({ connectionString });
      failedClient = new Client({ connectionString });
      await successfulClient.connect();
      await failedClient.connect();
      await successfulClient.query(
        "SET application_name = 'cybanext-successful-verification'"
      );
      await failedClient.query(
        "SET application_name = 'cybanext-failed-verification'"
      );
      await successfulClient.query('BEGIN');
      const restoreSuccessfulClient = bindDatabaseClient(
        database, successfulClient, { manageTransaction: false }
      );
      const verifiedResult = await regularTrackStore.markPaymentAttemptVerified(
        reference,
        'tx-concurrent'
      );
      restoreSuccessfulClient();
      assert.ok(verifiedResult, 'Successful verification should update the payment');

      await failedClient.query('BEGIN');
      const failedBackendPid = (
        await failedClient.query('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      const restoreFailedClient = bindDatabaseClient(
        database, failedClient, { manageTransaction: false }
      );
      const failedTransition = regularTrackStore.markPaymentAttemptFailed(reference);

      let failedTransitionBlocked = false;
      for (let poll = 0; poll < 100; poll += 1) {

        const waits = await query(`
  SELECT 1
  FROM pg_stat_activity
  WHERE pid = $1
    AND state = 'active'
    AND cardinality(pg_blocking_pids(pid)) > 0
`, [failedBackendPid]);

        if (waits.length) {
          failedTransitionBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(failedTransitionBlocked, true);
      await successfulClient.query('COMMIT');
      const failedResult = await failedTransition;
      restoreFailedClient();
      await failedClient.query('COMMIT');
      assert.equal(failedResult, null);

      const rows = await query(`
        SELECT payment.status AS payment_status,
               applicant.status AS applicant_status
        FROM public.regular_track_payment_attempts AS payment
        JOIN public.regular_track_applicants AS applicant
          ON applicant.registration_id = payment.registration_id
        WHERE payment.payment_reference = $1
      `, [reference]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].payment_status, 'payment_verified');
      assert.equal(rows[0].applicant_status, 'payment_verified');
      const notifications = await query(`
        SELECT count(*)::int AS count
        FROM public.email_notification_outbox
        WHERE event_key = $1
      `, [`regular-track-payment-failure:${applicant.id}:${reference}`]);
      assert.equal(notifications[0].count, 0);
    } finally {
      try {
        if (successfulClient) await successfulClient.end();
        if (failedClient) await failedClient.end();
        if (registrationIds.length) {
          await query(
            'DELETE FROM public.regular_track_applicants WHERE registration_id = ANY($1::text[])',
            [registrationIds]
          );
        }
      } finally {
        database.query = originalQuery;
        database.transaction = originalTransaction;
      }
    }
  });

    test('dry run does not connect; errors are sanitized; remote targets are refused', async () => {
    let created = false;
    const dry = await runTestMigrations({ connectionUrl: connectionString, apply: false, createClient() { created = true; }, logger: { log() {} } });
    assert.equal(dry.applied, false); assert.equal(created, false);
    assert.doesNotMatch(sanitizeError(new Error(`password ${new URL(connectionString).password} postgresql://private`)), /password|postgresql|private/);
    await assert.rejects(runTestMigrations({ connectionUrl: 'postgresql://u:p@db.example.com/neondb', createClient: clientFactory }), /loopback/);
    });
  });
}
