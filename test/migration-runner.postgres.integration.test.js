const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EXPECTED_TABLES, MIGRATION_FILES, loadMigrations, runTestMigrations, sanitizeError
} = require('../scripts/run-db-migrations');

const connectionString = process.env.CYBANEXT_TEST_DATABASE_URL;
const enabled = process.env.CYBANEXT_RUN_POSTGRES_INTEGRATION === '1';
if (!enabled) {
  test('PostgreSQL migration integration tests (run via scripts/run-postgres-integration.ps1)', { skip: 'Disposable PostgreSQL harness not enabled.' }, () => {});
} else {
  const { Client } = require('pg');
  assert.ok(connectionString, 'Harness must provide CYBANEXT_TEST_DATABASE_URL.');
  const parsed = new URL(connectionString);
  assert.ok(['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname), 'Integration tests only accept loopback targets.');
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
    try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); }
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

  test('fresh migrations 001 and 002 create expected tables and checksummed history', async () => {
    await reset(); await migrate();
    const tables = await query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    for (const name of [...EXPECTED_TABLES, 'schema_migrations']) assert.ok(tables.some((row) => row.tablename === name), `Missing ${name}`);
    const history = await query('SELECT filename, checksum FROM public.schema_migrations ORDER BY filename');
    assert.deepEqual(history.map((row) => row.filename), MIGRATION_FILES);
    assert.deepEqual(history.map((row) => row.checksum), loadMigrations().map((row) => row.checksum));
    const version = await query('SELECT version() AS version');
    assert.match(version[0].version, /PostgreSQL 16\./);
  });

  test('repeated apply is idempotent and checksum mismatch is rejected', async () => {
    await reset(); await migrate(); await migrate();
    await query("UPDATE public.schema_migrations SET checksum = repeat('0', 64) WHERE filename = $1", [MIGRATION_FILES[0]]);
    await assert.rejects(migrate(), /Migration operation failed/);
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
    assert.equal((await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count, 2);
    assert.equal((await query("SELECT to_regclass('public.digital_forensics_registrations') AS table_name"))[0].table_name, 'digital_forensics_registrations');
    await reset();
    for (const migration of loadMigrations()) for (const statement of migration.statements) await query(statement);
    await query('ALTER TABLE public.digital_forensics_registrations ADD COLUMN unexpected text');
    await assert.rejects(migrate({ adoptExisting: true }), /schema adoption failed/);
    assert.equal((await query("SELECT to_regclass('public.schema_migrations') AS table_name"))[0].table_name, null);
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
      await assert.rejects(migrate({ migrationsDirectory: dir }), /Migration operation failed/);
      assert.equal((await query("SELECT to_regclass('public.rollback_probe') AS table_name"))[0].table_name, null);
      assert.equal((await query("SELECT to_regclass('public.schema_migrations') AS table_name"))[0].table_name, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('concurrent migration processes serialize on PostgreSQL advisory lock', async () => {
    await reset();
    const results = await Promise.all([migrate(), migrate()]);
    assert.equal(results.length, 2);
    assert.equal((await query('SELECT count(*)::int AS count FROM public.schema_migrations'))[0].count, 2);
  });

  test('dry run does not connect; errors are sanitized; remote targets are refused', async () => {
    let created = false;
    const dry = await runTestMigrations({ connectionUrl: connectionString, apply: false, createClient() { created = true; }, logger: { log() {} } });
    assert.equal(dry.applied, false); assert.equal(created, false);
    assert.doesNotMatch(sanitizeError(new Error(`password ${new URL(connectionString).password} postgresql://private`)), /password|postgresql|private/);
    await assert.rejects(runTestMigrations({ connectionUrl: 'postgresql://u:p@db.example.com/neondb', createClient: clientFactory }), /loopback/);
  });
}
