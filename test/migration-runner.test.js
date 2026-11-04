const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MIGRATION_FILES,
  expectedSchema,
  historyValidationBlock,
  loadMigrations,
  parseArguments,
  runMigrations,
  runTestMigrations,
  sanitizeError,
  splitSqlStatements
} = require('../scripts/run-db-migrations');

const DEV_CONFIRM = '--confirm-development=dev/cybanext-phase2c-test';
const PROD_CONFIRM = '--confirm-production=I-UNDERSTAND-THIS-IS-PRODUCTION';

function createLogger() {
  const messages = [];
  return { messages, log: (message) => messages.push(message), error: (message) => messages.push(message) };
}

function environment(target = 'development') {
  const host = target === 'development' ? 'dev-endpoint.us-east-1.aws.neon.tech' : 'prod-endpoint.us-east-1.aws.neon.tech';
  return {
    DATABASE_URL: `postgresql://redacted@${host}/neondb`,
    MIGRATION_DEV_ENDPOINT_HOST: 'dev-endpoint.us-east-1.aws.neon.tech',
    MIGRATION_PRODUCTION_ENDPOINT_HOST: 'prod-endpoint.us-east-1.aws.neon.tech'
  };
}

function matchingSchemaMetadata() {
  const schema = expectedSchema();
  const columns = Object.entries(schema.columns).flatMap(([table_name, fields]) =>
    Object.entries(fields).map(([column_name, [data_type, not_null, column_default]]) => ({
      table_name, column_name, data_type, not_null, column_default,
      generated: '', identity: ''
    }))
  );
  const constraints = schema.constraints.map((item) => ({
    table_name: item.table, constraint_type: item.type,
    definition: item.definition || `${item.type.toUpperCase()} (${item.columns.join(', ')})`,
    validated: item.validated, deferrable: item.deferrable, deferred: item.deferred,
    no_inherit: item.noInherit, nulls_not_distinct: item.nullsNotDistinct,
    columns: item.columns,
    referenced_table: item.references?.table ?? null,
    referenced_columns: item.references?.columns ?? null,
    delete_action: item.references?.deleteAction ?? null,
    update_action: item.references?.updateAction ?? null,
    match_type: item.references?.matchType ?? null
  }));
  const indexes = schema.indexes.map((item) => ({
    index_name: item.name, table_name: item.table, is_unique: item.unique,
    is_primary: item.primary, no_included_columns: true, method: item.method,
    is_valid: item.valid, is_ready: item.ready, is_live: item.live,
    nulls_not_distinct: item.nullsNotDistinct, columns: item.columns, predicate: item.predicate
  }));
  return { columns, constraints, indexes };
}

function parseArrayLiteral(statement, label) {
  const match = statement.match(new RegExp(`${label}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`, 'i'));
  if (!match) return [];
  return [...match[1].matchAll(/'((?:''|[^'])*)'/g)].map((item) => item[1].replaceAll("''", "'"));
}

function createSql({ historyRows = [], existingObjects = null, databaseName = 'neondb', schemaMetadata = null, beforeTransaction = null, failTransaction = null } = {}) {
  const calls = [];
  const transactions = [];
  const state = { history: historyRows.map((row) => ({ ...row })), executed: [], transactionNumber: 0 };
  let txTail = Promise.resolve();
  const sql = {
    calls,
    transactions,
    state,
    query(statement) {
      calls.push(statement);
      let value = [];
      if (statement.includes('SELECT current_database()')) value = [{ database_name: databaseName }];
      else if (statement.includes('a.attname AS column_name')) value = schemaMetadata?.columns || [];
      else if (statement.includes('pg_get_constraintdef(con.oid, true)')) value = schemaMetadata?.constraints || [];
      else if (statement.includes('pg_catalog.pg_index i')) value = schemaMetadata?.indexes || [];
      return Object.assign(Promise.resolve(value), { statement });
    },
    async transaction(queries) {
      const prior = txTail;
      let release;
      txTail = new Promise((resolve) => { release = resolve; });
      await prior;
      try {
        state.transactionNumber += 1;
        if (beforeTransaction) await beforeTransaction(state, queries);
        transactions.push(queries);
        if (failTransaction === state.transactionNumber) {
          throw Object.assign(new Error('database returned postgresql://user:secret@host with SQL parameters'), {
            code: 'XX000', detail: 'password=secret detail', hint: 'retry safely', where: 'PL/pgSQL context'
          });
        }
        const blockQuery = queries.find((query) => query.statement.includes('DO $cybanext_migration$'));
        assert.ok(blockQuery, 'runner must validate and mutate migration history in one locked transaction block');
        const block = blockQuery.statement;
        assert.ok(queries[0].statement.includes('pg_advisory_xact_lock'), 'advisory lock must be the first transaction statement');
        if (/existing migration history prevents adoption/.test(block)) {
          if (state.history.length) throw Object.assign(new Error('adoption refused'), { code: 'P0001' });
          state.history.push(...loadMigrations().map(({ filename, checksum }) => ({ filename, checksum })));
          return;
        }
        const names = parseArrayLiteral(block, 'expected_names');
        const checksums = parseArrayLiteral(block, 'expected_checksums');
        const known = new Map(names.map((name, index) => [name, checksums[index]]));
        if (state.history.some((row) => !known.has(row.filename))) throw Object.assign(new Error('unknown'), { code: 'P0001' });
        if (state.history.length > names.length) throw Object.assign(new Error('too many'), { code: 'P0001' });
        for (let index = 0; index < state.history.length; index += 1) {
          const row = state.history[index];
          if (row.filename !== names[index]) throw Object.assign(new Error('gap or order'), { code: 'P0001' });
          if (row.checksum !== checksums[index]) throw Object.assign(new Error('checksum'), { code: 'P0001' });
        }
        if (state.history.length === 0 && existingObjects && Object.values(existingObjects).some(Boolean)) {
          throw Object.assign(new Error('preexisting app schema'), { code: 'P0001' });
        }
        const migrations = loadMigrations();
        for (const migration of migrations.slice(state.history.length)) {
          state.executed.push(migration.filename);
          state.history.push({ filename: migration.filename, checksum: migration.checksum });
        }
      } finally {
        release();
      }
    },
    async withTransaction(callback) {
      const statements = [];
      const tx = { query(statement) { statements.push({ statement }); return sql.query(statement); } };
      await callback(tx);
      return sql.transaction(statements);
    }
  };
  return sql;
}

function devArgs(extra = []) { return ['--target=development', '--apply', DEV_CONFIRM, ...extra]; }

test('SQL splitter preserves semicolons inside literals and comments', () => {
  assert.deepEqual(splitSqlStatements("SELECT ';'; -- ignored ;\nSELECT \"semi;colon\"; /* outer ; /* inner ; */ */ SELECT $$body;value$$;"), [
    "SELECT ';'", '-- ignored ;\nSELECT "semi;colon"', '/* outer ; /* inner ; */ */ SELECT $$body;value$$'
  ]);
});

test('migration files remain ordered and carry SHA-256 checksums', () => {
  const migrations = loadMigrations();
  assert.deepEqual(migrations.map(({ filename }) => filename), MIGRATION_FILES);
  assert.deepEqual(migrations.map(({ statements }) => statements.length), [3, 6]);
  assert.ok(migrations.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)));
});

test('dry-run creates no client, connection, or SQL execution', async () => {
  const logger = createLogger();
  let clientCreated = false;
  const result = await runMigrations({ args: ['--target=production'], logger, createClient() {
    clientCreated = true;
    throw new Error('must not create client');
  } });
  assert.equal(result.applied, false);
  assert.equal(clientCreated, false);
  assert.match(logger.messages[0], /No database connection or SQL execution/);
});

test('development and production require their distinct exact confirmations', () => {
  assert.throws(() => parseArguments(['--target=development', '--apply']), /confirm-development=/);
  assert.doesNotThrow(() => parseArguments(devArgs()));
  assert.throws(() => parseArguments(['--target=production', '--apply', DEV_CONFIRM]), /confirm-production=/);
  assert.doesNotThrow(() => parseArguments(['--target=production', '--apply', PROD_CONFIRM]));
  assert.throws(() => parseArguments(['--target=development', '--apply', PROD_CONFIRM]), /confirm-development=/);
});

test('invalid, missing, and identical endpoint allowlists fail before SQL', async () => {
  for (const mutate of [
    (env) => { env.MIGRATION_DEV_ENDPOINT_HOST = ''; },
    (env) => { env.MIGRATION_PRODUCTION_ENDPOINT_HOST = 'https://host.neon.tech/path'; },
    (env) => { env.MIGRATION_PRODUCTION_ENDPOINT_HOST = env.MIGRATION_DEV_ENDPOINT_HOST.toUpperCase(); }
  ]) {
    const env = environment(); mutate(env);
    const sql = createSql();
    await assert.rejects(runMigrations({ args: devArgs(), environment: env, createClient: () => sql, logger: createLogger() }));
    assert.equal(sql.calls.length, 0);
  }
});

test('selected endpoint and current database must match', async () => {
  const wrongHost = { ...environment(), DATABASE_URL: 'postgresql://redacted@prod-endpoint.us-east-1.aws.neon.tech/neondb' };
  const first = createSql();
  await assert.rejects(runMigrations({ args: devArgs(), environment: wrongHost, createClient: () => first, logger: createLogger() }), /endpoint does not match/);
  assert.equal(first.calls.length, 0);
  const second = createSql({ databaseName: 'other_database' });
  await assert.rejects(runMigrations({ args: devArgs(), environment: environment(), createClient: () => second, logger: createLogger() }), /expected database/);
  assert.equal(second.transactions.length, 0);
});

test('test-only loopback target accepts Docker server addresses after host URL validation', async () => {
  let verificationCalls = 0;
  const sql = {
    async query(statement) {
      if (statement.includes('SELECT current_database()')) { verificationCalls += 1; return [{ database_name: 'isolated_db' }]; }
      return [];
    },
    async withTransaction(callback) { return callback({ query: async () => [] }); }
  };
  await assert.rejects(runTestMigrations({ connectionUrl: 'postgresql://u:p@192.168.1.10/isolated_db', createClient: () => sql }), /loopback/);
  assert.equal(verificationCalls, 0);
  await runTestMigrations({ connectionUrl: 'postgresql://u:p@127.0.0.1:54321/isolated_db', createClient: () => sql, logger: createLogger() });
  assert.equal(verificationCalls, 1);
});

test('history is transactionally applied in order and matching checksums prevent duplicates', async () => {
  const sql = createSql();
  const result = await runMigrations({ args: devArgs(), environment: environment(), createClient: () => sql, logger: createLogger() });
  assert.equal(result.applied, true);
  assert.deepEqual(sql.state.executed, MIGRATION_FILES);
  assert.equal(sql.transactions.length, 1);
  await runMigrations({ args: devArgs(), environment: environment(), createClient: () => sql, logger: createLogger() });
  assert.deepEqual(sql.state.executed, MIGRATION_FILES);
  assert.equal(sql.transactions.length, 2);
});

test('a valid migration-history prefix applies only the missing suffix', async () => {
  const first = loadMigrations()[0];
  const sql = createSql({ historyRows: [{ filename: first.filename, checksum: first.checksum }] });
  await runMigrations({ args: devArgs(), environment: environment(), createClient: () => sql, logger: createLogger() });
  assert.deepEqual(sql.state.executed, [MIGRATION_FILES[1]]);
  assert.deepEqual(sql.state.history.map(({ filename }) => filename), MIGRATION_FILES);
});

test('history gaps, out-of-order rows, unknown files, and modified checksums reject before execution', async (t) => {
  const migrations = loadMigrations();
  const invalidCases = [
    [{ filename: migrations[1].filename, checksum: migrations[1].checksum }],
    [
      { filename: migrations[1].filename, checksum: migrations[1].checksum },
      { filename: migrations[0].filename, checksum: migrations[0].checksum }
    ],
    [{ filename: '999_unknown.sql', checksum: '0'.repeat(64) }],
    [{ filename: migrations[0].filename, checksum: '0'.repeat(64) }]
  ];
  for (const [index, historyRows] of invalidCases.entries()) {
    await t.test(`invalid history ${index + 1}`, async () => {
      const sql = createSql({ historyRows });
      await assert.rejects(runMigrations({ args: devArgs(), environment: environment(), createClient: () => sql, logger: createLogger() }));
      assert.deepEqual(sql.state.executed, []);
    });
  }
});

test('history is revalidated under the advisory lock, not from a pre-lock snapshot', async () => {
  const migrations = loadMigrations();
  let injected = false;
  const sql = createSql({ beforeTransaction(state) {
    if (!injected) {
      injected = true;
      state.history.push({ filename: migrations[0].filename, checksum: migrations[0].checksum });
    }
  } });
  await runMigrations({ args: devArgs(), environment: environment(), createClient: () => sql, logger: createLogger() });
  assert.deepEqual(sql.state.executed, [migrations[1].filename]);
  const block = sql.transactions[0].find((query) => query.statement.includes('DO $cybanext_migration$')).statement;
  assert.ok(sql.transactions[0][0].statement.includes('pg_advisory_xact_lock'));
  const statements = sql.transactions[0].map((query) => query.statement);
  const transactionLock = statements.findIndex((statement) => statement.includes('SELECT pg_advisory_xact_lock'));
  const lockedRead = statements.findIndex((statement) => statement === 'SELECT filename, checksum FROM public.schema_migrations');
  const lockedValidation = statements.findIndex((statement) => statement.includes('DO $cybanext_migration$'));
  assert.ok(transactionLock < lockedRead && lockedRead < lockedValidation);
});

test('migration transaction obtains advisory lock before history-table creation and inspection', async () => {
  const sql = createSql();
  await runMigrations({ args: devArgs(), environment: environment(), createClient: () => sql, logger: createLogger() });
  const statements = sql.transactions[0].map((query) => query.statement);
  assert.match(statements[0], /pg_advisory_xact_lock/);
  assert.ok(statements.findIndex((statement) => statement.includes('pg_advisory_xact_lock')) < statements.findIndex((statement) => statement.includes('CREATE TABLE IF NOT EXISTS public.schema_migrations')));
});

test('concurrent mocked executions serialize and do not duplicate migration history', async () => {
  const sql = createSql();
  const options = { args: devArgs(), environment: environment(), createClient: () => sql, logger: createLogger() };
  await Promise.all([runMigrations(options), runMigrations(options)]);
  assert.deepEqual(sql.state.executed, MIGRATION_FILES);
  assert.equal(sql.state.history.length, 2);
});

test('a failed mocked transaction does not change fake history or executed migrations', async () => {
  const sql = createSql({ failTransaction: 1 });
  const logger = createLogger();
  await assert.rejects(runMigrations({ args: devArgs(), environment: environment(), createClient: () => sql, logger }), /Migration operation failed/);
  assert.deepEqual(sql.state.history, []);
  assert.deepEqual(sql.state.executed, []);
  assert.doesNotMatch(logger.messages.join('\n'), /postgresql:|secret|SQL parameters/);
});

test('test-only database diagnostics expose PostgreSQL fields with URL and password redaction', async () => {
  const diagnostics = [];
  const sql = createSql({ databaseName: 'isolated_db', failTransaction: 1 });
  await assert.rejects(runTestMigrations({
    connectionUrl: 'postgresql://u:p@127.0.0.1/isolated_db',
    createClient: () => sql,
    logger: createLogger(),
    onTestDiagnostic: (item) => diagnostics.push(item)
  }), /Migration operation failed/);
  assert.deepEqual(diagnostics, [{
    message: 'database returned [redacted connection string] with SQL parameters',
    sqlstate: 'XX000', detail: 'password=[redacted] detail', hint: 'retry safely', context: 'PL/pgSQL context'
  }]);

  const productionDiagnostics = [];
  const productionSql = createSql({ failTransaction: 1 });
  await assert.rejects(runMigrations({
    args: devArgs(), environment: environment(), createClient: () => productionSql,
    logger: createLogger(), onTestDiagnostic: (item) => productionDiagnostics.push(item)
  }), /Migration operation failed/);
  assert.deepEqual(productionDiagnostics, []);
});

test('development adoption verifies schema and records checksums without migration DDL', async () => {
  const sql = createSql({ schemaMetadata: matchingSchemaMetadata() });
  const result = await runMigrations({ args: devArgs(['--adopt-existing']), environment: environment(), createClient: () => sql, logger: createLogger() });
  assert.equal(result.adopted, true);
  assert.deepEqual(sql.state.history, loadMigrations().map(({ filename, checksum }) => ({ filename, checksum })));
  assert.deepEqual(sql.state.executed, []);
  assert.equal(sql.transactions.length, 1);
  assert.match(sql.transactions[0][0].statement, /pg_advisory_xact_lock/);
  assert.ok(sql.transactions[0].some((query) => query.statement.includes('a.attname AS column_name')));
  assert.ok(!sql.transactions[0].some((query) => /EXECUTE 'CREATE (?:TABLE|INDEX)/.test(query.statement)));
});

test('adoption accepts the expected columns regardless of catalog row order', async () => {
  const metadata = matchingSchemaMetadata();
  metadata.columns.reverse();
  const sql = createSql({ schemaMetadata: metadata });
  const result = await runMigrations({ args: devArgs(['--adopt-existing']), environment: environment(), createClient: () => sql, logger: createLogger() });
  assert.equal(result.adopted, true);
});

test('adoption canonicalizes redundant CHECK parentheses while preserving constraint semantics', async () => {
  const metadata = matchingSchemaMetadata();
  const pricingConstraint = metadata.constraints.find((item) =>
    item.table_name === 'digital_forensics_registrations' && item.constraint_type === 'c' &&
    item.definition.includes('pricing_option'));
  pricingConstraint.definition = "CHECK ((pricing_option IS NULL) OR (pricing_option = ANY (ARRAY['GHS'::text, 'USD_REFERENCE'::text])))";
  const fullNameConstraint = metadata.constraints.find((item) =>
    item.table_name === 'digital_forensics_registrations' && item.constraint_type === 'c' &&
    item.definition.includes('char_length(full_name)'));
  fullNameConstraint.definition = 'CHECK (char_length(full_name) >= 1 AND char_length(full_name) <= 120)';
  const amountConstraint = metadata.constraints.find((item) =>
    item.table_name === 'digital_forensics_registrations' && item.constraint_type === 'c' &&
    item.definition.includes('expected_amount'));
  amountConstraint.definition = 'CHECK (expected_amount > 0::numeric)';
  const schema = expectedSchema();
  assert.equal(schema.constraints.find((item) => item.type === 'c').noInherit, false);
  assert.equal(schema.constraints.find((item) => item.type === 'p').noInherit, true);
  assert.equal(schema.constraints.find((item) => item.type === 'f').noInherit, true);
  const sql = createSql({ schemaMetadata: metadata });
  const result = await runMigrations({ args: devArgs(['--adopt-existing']), environment: environment(), createClient: () => sql, logger: createLogger() });
  assert.equal(result.adopted, true);
});

test('adoption still rejects a genuinely different CHECK expression', async () => {
  const metadata = matchingSchemaMetadata();
  const fullNameConstraint = metadata.constraints.find((item) =>
    item.table_name === 'digital_forensics_registrations' && item.constraint_type === 'c' &&
    item.definition.includes('char_length(full_name)'));
  fullNameConstraint.definition = 'CHECK (char_length(full_name) > 1 AND char_length(full_name) <= 120)';
  const sql = createSql({ schemaMetadata: metadata });
  await assert.rejects(runMigrations({ args: devArgs(['--adopt-existing']), environment: environment(), createClient: () => sql, logger: createLogger() }));
  assert.deepEqual(sql.state.history, []);
});

test('adoption rejects CHECK expressions whose identifier and keyword tokens are concatenated', async () => {
  const metadata = matchingSchemaMetadata();
  const pricingConstraint = metadata.constraints.find((item) =>
    item.table_name === 'digital_forensics_registrations' && item.constraint_type === 'c' &&
    item.definition.includes('pricing_option'));
  pricingConstraint.definition = "CHECK (pricing_optionis NULL OR (pricing_option = ANY (ARRAY['GHS'::text, 'USD_REFERENCE'::text])))";
  const sql = createSql({ schemaMetadata: metadata });
  await assert.rejects(runMigrations({ args: devArgs(['--adopt-existing']), environment: environment(), createClient: () => sql, logger: createLogger() }));
  assert.deepEqual(sql.state.history, []);
});

test('adoption refuses any changed or missing expected schema detail', async (t) => {
  const alterations = [
    ['missing default', (m) => { m.columns.find((x) => x.column_name === 'phone').column_default = null; }],
    ['altered default', (m) => { m.columns.find((x) => x.column_name === 'course').column_default = "'other'::text"; }],
    ['generated column', (m) => { m.columns.find((x) => x.column_name === 'registration_id').generated = 's'; }],
    ['identity column', (m) => { m.columns.find((x) => x.column_name === 'registration_id').identity = 'a'; }],
    ['unvalidated constraint', (m) => { m.constraints.find((x) => x.constraint_type === 'c').validated = false; }],
    ['altered check', (m) => { m.constraints.find((x) => x.constraint_type === 'c').definition = 'CHECK (true)'; }],
    ['changed foreign key', (m) => { m.constraints.find((x) => x.constraint_type === 'f').delete_action = 'a'; }],
    ['changed foreign key reference column', (m) => { m.constraints.find((x) => x.constraint_type === 'f').referenced_columns = ['email']; }],
    ['extra constraint', (m) => { m.constraints.push({ ...m.constraints.find((x) => x.constraint_type === 'c') }); }],
    ['unique index drift', (m) => { m.indexes.find((x) => x.index_name === 'digital_forensics_registrations_email_idx').is_unique = true; }],
    ['invalid index', (m) => { m.indexes.find((x) => x.index_name === 'digital_forensics_registrations_email_idx').is_valid = false; }],
    ['nulls-not-distinct unique index drift', (m) => { m.indexes.find((x) => x.index_name === 'digital_forensics_registrations_payment_reference_key').nulls_not_distinct = true; }],
    ['index column drift', (m) => { m.indexes.find((x) => x.index_name === 'digital_forensics_registrations_email_idx').columns = ['status']; }],
    ['partial predicate drift', (m) => { m.indexes.find((x) => x.index_name === 'applicant_sessions_expiry_idx').predicate = '(true)'; }],
    ['missing index', (m) => { m.indexes.pop(); }],
    ['extra column', (m) => { m.columns.push({ ...m.columns[0], column_name: 'unexpected' }); }]
  ];
  for (const [label, alter] of alterations) {
    await t.test(label, async () => {
      const metadata = structuredClone(matchingSchemaMetadata());
      alter(metadata);
      const sql = createSql({ schemaMetadata: metadata });
      await assert.rejects(runMigrations({ args: devArgs(['--adopt-existing']), environment: environment(), createClient: () => sql, logger: createLogger() }));
      assert.deepEqual(sql.state.history, []);
      assert.equal(sql.transactions.length, 0);
    });
  }
});

test('test-only adoption diagnostics identify expected and actual catalog metadata', async () => {
  const metadata = matchingSchemaMetadata();
  metadata.constraints.find((item) => item.constraint_type === 'f').delete_action = 'a';
  const diagnostics = [];
  const sql = createSql({ databaseName: 'isolated_db', schemaMetadata: metadata });
  await assert.rejects(runTestMigrations({
    connectionUrl: 'postgresql://u:p@127.0.0.1/isolated_db',
    adoptExisting: true,
    createClient: () => sql,
    logger: createLogger(),
    onTestDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  }), /schema adoption failed/);
  assert.equal(diagnostics[0].schema.category, 'constraints and relationships');
  assert.equal(diagnostics[0].schema.expected.find((item) => item.type === 'f').references.deleteAction, 'c');
  assert.equal(diagnostics[0].schema.actual.find((item) => item.type === 'f').references.deleteAction, 'a');
});

test('adoption refuses history that appears before its locked transaction', async () => {
  const migration = loadMigrations()[0];
  const sql = createSql({ schemaMetadata: matchingSchemaMetadata(), beforeTransaction(state) {
    state.history.push({ filename: migration.filename, checksum: migration.checksum });
  } });
  await assert.rejects(runMigrations({ args: devArgs(['--adopt-existing']), environment: environment(), createClient: () => sql, logger: createLogger() }));
  assert.equal(sql.state.history.length, 1);
});

test('top-level error sanitization never includes raw driver details', () => {
  const raw = new Error('connection postgresql://person:password@host/db token=private');
  raw.code = 'XX000';
  const message = sanitizeError(raw);
  assert.match(message, /XX000/);
  assert.doesNotMatch(message, /postgresql|password|private|person|host/);
});

test('generated history block has ordered-prefix checks and migration DDL inside its transaction', () => {
  const block = historyValidationBlock(loadMigrations());
  assert.ok(block.indexOf('pg_advisory_xact_lock') < block.indexOf('FROM public.schema_migrations'));
  assert.match(block, /migration history is not an ordered prefix/);
  assert.match(block, /migration checksum mismatch/);
  for (const filename of MIGRATION_FILES) assert.match(block, new RegExp(filename));
});

test('history structure validation reports the specific catalog category that failed', async () => {
  const sql = createSql({ databaseName: 'isolated_db' });
  await runTestMigrations({
    connectionUrl: 'postgresql://u:p@127.0.0.1/isolated_db',
    createClient: () => sql,
    logger: createLogger()
  });
  const structureCheck = sql.transactions[0].find((query) => query.statement.includes('$cybanext_history_structure$'));
  assert.ok(structureCheck);
  for (const category of ['columns', 'primary key', 'checksum constraint', 'unexpected constraint', 'unexpected index']) {
    assert.ok(structureCheck.statement.includes(`migration history table schema is invalid: ${category}`), category);
  }
  assert.equal((structureCheck.statement.match(/RAISE EXCEPTION/g) || []).length, 5);

  const productionSql = createSql();
  await runMigrations({ args: devArgs(), environment: environment(), createClient: () => productionSql, logger: createLogger() });
  const productionCheck = productionSql.transactions[0].find((query) => query.statement.includes('$cybanext_history_structure$'));
  assert.doesNotMatch(productionCheck.statement, /schema is invalid: (?:columns|primary key|checksum)/);
});
