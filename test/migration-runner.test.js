const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EXPECTED_TARGET,
  MIGRATION_FILES,
  loadMigrations,
  parseArguments,
  runMigrations,
  splitSqlStatements
} = require('../scripts/run-db-migrations');

function createLogger() {
  const messages = [];
  return {
    messages,
    log: (message) => messages.push(message),
    error: (message) => messages.push(message)
  };
}

test('SQL splitter preserves semicolons inside literals and comments', () => {
  assert.deepEqual(
    splitSqlStatements(
      "SELECT ';'; -- ignored ;\nSELECT \"semi;colon\"; /* outer ; /* inner ; */ */ SELECT $$body;value$$;"
    ),
    [
      "SELECT ';'",
      '-- ignored ;\nSELECT "semi;colon"',
      '/* outer ; /* inner ; */ */ SELECT $$body;value$$'
    ]
  );
});

test('migration files are ordered 001 then 002 and contain supported statements', () => {
  const migrations = loadMigrations();
  assert.deepEqual(
    migrations.map(({ filename }) => filename),
    MIGRATION_FILES
  );
  assert.equal(migrations[0].statements.length, 3);
  assert.equal(migrations[1].statements.length, 6);
});

test('dry-run reports migration order and never creates a database client', async () => {
  const logger = createLogger();
  let clientCreated = false;

  const result = await runMigrations({
    args: [],
    logger,
    createClient() {
      clientCreated = true;
      throw new Error('Database client should not be created during dry-run.');
    }
  });

  assert.equal(result.applied, false);
  assert.equal(clientCreated, false);
  assert.deepEqual(
    logger.messages.filter((message) => message.startsWith('- ')),
    MIGRATION_FILES.map((filename) => `- ${filename}`)
  );
});

test('apply is refused without explicit non-production target confirmation', () => {
  assert.throws(
    () => parseArguments(['--apply']),
    new RegExp(`--confirm-non-production=${EXPECTED_TARGET.replaceAll('/', '\\/')}`)
  );
});

test('migrations execute in ordered per-file transactions and stop on failure', async () => {
  const logger = createLogger();
  const transactions = [];

  const sql = {
    query(statement) {
      return { statement };
    },
    async transaction(queries) {
      const batch = queries.map(({ statement }) => statement);
      transactions.push(batch);
      if (transactions.length === 2) {
        throw Object.assign(new Error('sanitized by runner'), { code: 'XX000' });
      }
    }
  };

  await assert.rejects(
    runMigrations({
      args: [
        '--apply',
        `--confirm-non-production=${EXPECTED_TARGET}`
      ],
      environment: { DATABASE_URL: 'test-url-not-printed' },
      createClient: () => sql,
      logger
    }),
    (error) => error.migrationFile === MIGRATION_FILES[1]
  );

  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].length, 3);
  assert.equal(transactions[1].length, 6);
  assert.match(logger.messages.at(-1), /Stopped at 002_/);
  assert.equal(logger.messages.some((message) =>
    message.includes('test-url-not-printed')), false);
});

test('apply without DATABASE_URL is refused before creating a database client', async () => {
  let clientCreated = false;

  await assert.rejects(
    runMigrations({
      args: [
        '--apply',
        `--confirm-non-production=${EXPECTED_TARGET}`
      ],
      environment: {},
      createClient() {
        clientCreated = true;
      },
      logger: createLogger()
    }),
    /DATABASE_URL is required/
  );
  assert.equal(clientCreated, false);
});
