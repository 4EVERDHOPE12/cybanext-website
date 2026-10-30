const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_TARGET = 'dev/cybanext-phase2c-test';
const MIGRATION_FILES = [
  '001_create_digital_forensics_registrations.sql',
  '002_create_applicant_magic_link_auth.sql'
];

function splitSqlStatements(script) {
  const statements = [];
  let statementStart = 0;
  let state = 'normal';
  let dollarTag = '';
  let blockCommentDepth = 0;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    const next = script[index + 1];

    if (state === 'single-quoted') {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        state = 'normal';
      } else if (character === '\\') {
        index += 1;
      }
      continue;
    }

    if (state === 'double-quoted') {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) {
          state = 'normal';
        }
      }
      continue;
    }

    if (state === 'dollar-quoted') {
      if (script.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        state = 'normal';
      }
      continue;
    }

    if (character === "'") {
      state = 'single-quoted';
    } else if (character === '"') {
      state = 'double-quoted';
    } else if (character === '-' && next === '-') {
      state = 'line-comment';
      index += 1;
    } else if (character === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      index += 1;
    } else if (character === '$') {
      const match = script.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        state = 'dollar-quoted';
        index += dollarTag.length - 1;
      }
    } else if (character === ';') {
      const statement = script.slice(statementStart, index).trim();
      if (statement) {
        statements.push(statement);
      }
      statementStart = index + 1;
    }
  }

  if (state !== 'normal' && state !== 'line-comment') {
    throw new Error('Migration contains an unterminated SQL literal or comment.');
  }

  const remaining = script.slice(statementStart).trim();
  if (remaining) {
    statements.push(remaining);
  }

  return statements;
}

function loadMigrations(
  migrationsDirectory = path.join(__dirname, '..', 'db', 'migrations')
) {
  return MIGRATION_FILES.map((filename) => {
    const filePath = path.join(migrationsDirectory, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    const statements = splitSqlStatements(content);

    if (
      statements.length === 0 ||
      statements.some((statement) =>
        !/^CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement)
      )
    ) {
      throw new Error(`Migration ${filename} contains an unsupported statement.`);
    }

    return { filename, statements };
  });
}

function parseArguments(args) {
  let apply = false;
  let targetConfirmation = null;

  for (const argument of args) {
    if (argument === '--apply') {
      apply = true;
    } else if (argument.startsWith('--confirm-non-production=')) {
      targetConfirmation = argument.slice('--confirm-non-production='.length);
    } else {
      throw new Error('Unsupported migration runner argument.');
    }
  }

  if (apply && targetConfirmation !== EXPECTED_TARGET) {
    throw new Error(
      `Execution requires --confirm-non-production=${EXPECTED_TARGET}.`
    );
  }

  if (!apply && targetConfirmation) {
    throw new Error('--confirm-non-production can only be used with --apply.');
  }

  return { apply, targetConfirmation };
}

async function runMigrations(options = {}) {
  const args = options.args || [];
  const logger = options.logger || console;
  const migrationsDirectory =
    options.migrationsDirectory || path.join(__dirname, '..', 'db', 'migrations');
  const migrations = loadMigrations(migrationsDirectory);
  const { apply } = parseArguments(args);

  if (!apply) {
    logger.log('Dry run only. No database connection or SQL execution.');
    logger.log('Migration order:');
    for (const migration of migrations) {
      logger.log(`- ${migration.filename}`);
    }
    return { applied: false, migrations: migrations.map(({ filename }) => filename) };
  }

  const environment = options.environment || process.env;
  if (!environment.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to apply migrations.');
  }

  const createClient = options.createClient || (() => {
    const { neon } = require('@neondatabase/serverless');
    return neon(environment.DATABASE_URL);
  });
  const sql = createClient();

  for (const migration of migrations) {
    logger.log(`Applying ${migration.filename} in a transaction.`);
    try {
      const queries = migration.statements.map((statement) =>
        sql.query(statement)
      );
      await sql.transaction(queries);
    } catch (error) {
      const code = error && typeof error.code === 'string' &&
        /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : 'unknown';
      logger.error(
        `Stopped at ${migration.filename}; inspect the database before recovery (error code: ${code}).`
      );
      throw Object.assign(new Error('Migration execution failed.'), {
        migrationFile: migration.filename,
        code
      });
    }
  }

  logger.log('All listed migrations completed.');
  return { applied: true, migrations: migrations.map(({ filename }) => filename) };
}

if (require.main === module) {
  runMigrations({ args: process.argv.slice(2) }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_TARGET,
  MIGRATION_FILES,
  loadMigrations,
  parseArguments,
  runMigrations,
  splitSqlStatements
};
