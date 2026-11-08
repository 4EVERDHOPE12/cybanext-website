const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  EXPECTED_TABLES, MIGRATION_FILES, loadMigrations, runTestMigrations, sanitizeError
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

function verifyDisposableHarnessContainer(connectionString, harnessId, containerId, inspection) {
  const parsed = validateLoopbackConnectionUrl(connectionString);
  if (typeof harnessId !== 'string' || !/^[a-f0-9]{32}$/i.test(harnessId) ||
      typeof containerId !== 'string' || !/^[a-f0-9]{64}$/i.test(containerId)) {
    throw new Error('Integration tests require a disposable Docker container identity.');
  }
  if (!inspection || inspection.Id?.toLowerCase() !== containerId.toLowerCase() ||
      inspection.Config?.Image !== 'postgres:16-alpine' || inspection.State?.Running !== true ||
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
}) {
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
  verifyDisposableHarnessContainer(connectionString, harnessId, containerId, inspection);
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
  assert.ok(connectionString, 'Harness must provide CYBANEXT_TEST_DATABASE_URL.');
  validateLoopbackConnectionUrl(connectionString);
  const { Client } = require('pg');
  const harnessToken = process.env.CYBANEXT_TEST_HARNESS_TOKEN;
  const harnessId = process.env.CYBANEXT_TEST_HARNESS_ID;
  const containerId = process.env.CYBANEXT_TEST_CONTAINER_ID;
  assert.ok(/^[A-Za-z0-9]{32,}$/.test(harnessToken || ''), 'Disposable harness authorization is required.');
  assert.ok(/^[a-f0-9]{32}$/i.test(harnessId || ''), 'Disposable harness identity is required.');
  assert.ok(/^[a-f0-9]{64}$/i.test(containerId || ''), 'Disposable container identity is required.');
  const clientFactory = () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    let connected = false;
    const ensureConnected = async () => { if (!connected) { await client.connect(); connected = true; } };
    return {
      async query(statement) { await ensureConnected(); return (await client.query(statement)).rows; },
      async transaction(queries) {
        await ensureConnected();
        await client.query('BEGIN');
        try {
          for (const query of queries) await client.query(query.statement);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { await client.end(); connected = false; }
      },
      async withTransaction(callback) {
        await ensureConnected(); await client.query('BEGIN');
        try { const result = await callback({ query: async (statement) => (await client.query(statement)).rows }); await client.query('COMMIT'); return result; }
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
      }, connectionString, harnessToken, harnessId, containerId);
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

  test('fresh migrations 001 through 005 create expected tables and checksummed history', async () => {
    await reset(); await migrate();
    const tables = await query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    for (const name of [...EXPECTED_TABLES, 'schema_migrations']) assert.ok(tables.some((row) => row.tablename === name), `Missing ${name}`);
    const history = await query('SELECT filename, checksum FROM public.schema_migrations ORDER BY filename');
    assert.deepEqual(history.map((row) => row.filename), MIGRATION_FILES);
    assert.deepEqual(history.map((row) => row.checksum), loadMigrations().map((row) => row.checksum));
    const version = await query('SELECT version() AS version');
    assert.match(version[0].version, /PostgreSQL 16\./);
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
      await client.query('ROLLBACK');

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
        VALUES ($1, 'Outbox Integration', 'outbox-digital@example.com', 'pending', 1200, 'GHS')
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

  test('registration stores atomically enqueue notifications and production outbox queries claim due events', async (t) => {
    await reset();
    await migrate();
    const suffix = crypto.randomUUID();
    const database = require('../lib/digital-forensics-database');
    const digitalStore = require('../lib/digital-forensics-store');
    const regularStore = require('../lib/regular-track-payment-store');
    const { claimDueEvents } = require('../lib/email-notification-outbox');
    const originalQuery = database.query;
    const client = new Client({ connectionString });
    await client.connect();
    const registrationIds = [];
    database.query = async (strings, ...values) => {
      const statement = strings.reduce((sql, part, index) =>
        sql + (index === 0 ? '' : `$${index}`) + part, '');
      return (await client.query(statement, values)).rows;
    };
    t.after(async () => {
      database.query = originalQuery;
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
    assert.equal(records.rows.length, 5);
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
    assert.equal((await query("SELECT count(*)::int AS count FROM public.schema_migrations"))[0].count, 4);
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
    `, [EXPECTED_TABLES]);
    assert.equal(aclDefaults.length, EXPECTED_TABLES.length);
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
    assert.equal((await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count, 4);
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
      'regular_track_payment_attempts'
    ]) {
      assert.equal(
        (await query('SELECT to_regclass($1) AS table_name', [
          `public.${tableName}`
        ]))[0].table_name,
        tableName
      );
    }
  });

  test('development adoption upgrades an exact pre-004 schema transactionally', async () => {
    await reset();
    for (const migration of loadMigrations().slice(0, 3)) {
      for (const statement of migration.statements) await query(statement);
    }
    const result = await migrate({ adoptExisting: true });
    assert.equal(result.upgradedLegacySchema, true);
    assert.equal(
      (await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count,
      4
    );
    assert.equal(
      (await query("SELECT to_regclass('public.email_notification_outbox') AS table_name"))[0].table_name,
      'email_notification_outbox'
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
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os'); const path = require('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'cybanext-failing-migration-'));
    try {
      writeFileSync(path.join(dir, MIGRATION_FILES[0]), 'CREATE TABLE IF NOT EXISTS rollback_probe (id integer); CREATE TABLE IF NOT EXISTS rollback_probe_early_failure (id cybanext_missing_type);');
      writeFileSync(path.join(dir, MIGRATION_FILES[1]), 'CREATE TABLE IF NOT EXISTS rollback_probe_2 (id integer);');
      writeFileSync(path.join(dir, MIGRATION_FILES[2]), 'CREATE TABLE IF NOT EXISTS rollback_probe_3 (id integer);');
      writeFileSync(path.join(dir, MIGRATION_FILES[3]), 'CREATE TABLE IF NOT EXISTS rollback_probe_4 (id integer);');
      await assert.rejects(migrate({ migrationsDirectory: dir }), /Migration operation failed/);
      assert.equal((await query("SELECT to_regclass('public.rollback_probe') AS table_name"))[0].table_name, null);
      assert.equal((await query("SELECT to_regclass('public.schema_migrations') AS table_name"))[0].table_name, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('concurrent migration processes serialize on PostgreSQL advisory lock', async () => {
    await reset();
    const results = await Promise.all([migrate(), migrate()]);
    assert.equal(results.length, 2);
    assert.equal((await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count, 4);
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

  test('dry run does not connect; errors are sanitized; remote targets are refused', async () => {
    let created = false;
    const dry = await runTestMigrations({ connectionUrl: connectionString, apply: false, createClient() { created = true; }, logger: { log() {} } });
    assert.equal(dry.applied, false); assert.equal(created, false);
    assert.doesNotMatch(sanitizeError(new Error(`password ${new URL(connectionString).password} postgresql://private`)), /password|postgresql|private/);
    await assert.rejects(runTestMigrations({ connectionUrl: 'postgresql://u:p@db.example.com/neondb', createClient: clientFactory }), /loopback/);
  });
}
