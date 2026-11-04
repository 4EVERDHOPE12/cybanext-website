const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TARGETS = {
  development: {
    branchName: 'dev/cybanext-phase2c-test',
    endpointHostVariable: 'MIGRATION_DEV_ENDPOINT_HOST'
  },
  production: {
    confirmationText: 'I-UNDERSTAND-THIS-IS-PRODUCTION',
    endpointHostVariable: 'MIGRATION_PRODUCTION_ENDPOINT_HOST'
  }
};
const EXPECTED_DATABASE = 'neondb';
const MIGRATION_FILES = [
  '001_create_digital_forensics_registrations.sql',
  '002_create_applicant_magic_link_auth.sql'
];
const EXPECTED_TABLES = [
  'digital_forensics_registrations',
  'applicant_magic_link_tokens',
  'applicant_sessions',
  'applicant_login_rate_limits'
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
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") state = 'normal';
      else if (character === '\\') index += 1;
      continue;
    }
    if (state === 'double-quoted') {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') state = 'normal';
      continue;
    }
    if (state === 'line-comment') {
      if (character === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '/' && next === '*') { blockCommentDepth += 1; index += 1; }
      else if (character === '*' && next === '/') {
        blockCommentDepth -= 1; index += 1;
        if (blockCommentDepth === 0) state = 'normal';
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
    if (character === "'") state = 'single-quoted';
    else if (character === '"') state = 'double-quoted';
    else if (character === '-' && next === '-') { state = 'line-comment'; index += 1; }
    else if (character === '/' && next === '*') { state = 'block-comment'; blockCommentDepth = 1; index += 1; }
    else if (character === '$') {
      const match = script.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; state = 'dollar-quoted'; index += dollarTag.length - 1; }
    } else if (character === ';') {
      const statement = script.slice(statementStart, index).trim();
      if (statement) statements.push(statement);
      statementStart = index + 1;
    }
  }
  if (state !== 'normal' && state !== 'line-comment') {
    throw new Error('Migration contains an unterminated SQL literal or comment.');
  }
  const remaining = script.slice(statementStart).trim();
  if (remaining) statements.push(remaining);
  return statements;
}

function loadMigrations(migrationsDirectory = path.join(__dirname, '..', 'db', 'migrations')) {
  return MIGRATION_FILES.map((filename) => {
    const content = fs.readFileSync(path.join(migrationsDirectory, filename), 'utf8');
    const statements = splitSqlStatements(content);
    if (statements.length === 0 || statements.some((statement) =>
      !/^CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement))) {
      throw new Error(`Migration ${filename} contains an unsupported statement.`);
    }
    return { filename, statements, checksum: crypto.createHash('sha256').update(content, 'utf8').digest('hex') };
  });
}

function parseArguments(args) {
  let apply = false;
  let target = null;
  let developmentConfirmation = null;
  let productionConfirmation = null;
  let adoptExisting = false;
  for (const argument of args) {
    if (argument === '--apply') apply = true;
    else if (argument.startsWith('--target=')) {
      if (target !== null) throw new Error('--target may be specified only once.');
      target = argument.slice('--target='.length);
    } else if (argument.startsWith('--confirm-development=')) {
      if (developmentConfirmation !== null) throw new Error('Development confirmation may be specified only once.');
      developmentConfirmation = argument.slice('--confirm-development='.length);
    } else if (argument.startsWith('--confirm-production=')) {
      if (productionConfirmation !== null) throw new Error('Production confirmation may be specified only once.');
      productionConfirmation = argument.slice('--confirm-production='.length);
    } else if (argument === '--adopt-existing') adoptExisting = true;
    else throw new Error('Unsupported migration runner argument.');
  }
  if (!target) throw new Error('--target=development or --target=production is required.');
  if (!Object.hasOwn(TARGETS, target)) throw new Error('Migration target must be development or production.');
  if (apply && target === 'development' && developmentConfirmation !== TARGETS.development.branchName) {
    throw new Error(`Development apply requires --confirm-development=${TARGETS.development.branchName}.`);
  }
  if (apply && target === 'production' && productionConfirmation !== TARGETS.production.confirmationText) {
    throw new Error(`Production apply requires --confirm-production=${TARGETS.production.confirmationText}.`);
  }
  if (developmentConfirmation && target !== 'development') throw new Error('Development confirmation can only be used with --target=development.');
  if (productionConfirmation && target !== 'production') throw new Error('Production confirmation can only be used with --target=production.');
  if (!apply && (developmentConfirmation || productionConfirmation || adoptExisting)) {
    throw new Error('Confirmations and --adopt-existing require --apply.');
  }
  if (adoptExisting && target !== 'development') throw new Error('--adopt-existing is only supported for the development target.');
  return { apply, target, adoptExisting };
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validateEndpointConfiguration(target, environment) {
  const hostFor = (name) => {
    const variable = TARGETS[name].endpointHostVariable;
    const value = environment[variable];
    const labels = typeof value === 'string' ? value.toLowerCase().split('.') : [];
    if (typeof value !== 'string' || !value || value !== value.trim() ||
        !value.toLowerCase().endsWith('.neon.tech') ||
        labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`${variable} is missing or malformed; use the hostname from the verified Neon Connect details.`);
    }
    return value.toLowerCase();
  };
  const developmentHost = hostFor('development');
  const productionHost = hostFor('production');
  if (developmentHost === productionHost) {
    throw new Error('Development and production endpoint host configuration is ambiguous.');
  }
  const selectedHost = target === 'development' ? developmentHost : productionHost;
  let connectionUrl;
  try { connectionUrl = new URL(environment.DATABASE_URL); }
  catch { throw new Error('DATABASE_URL is not a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  if (connectionUrl.hostname.toLowerCase() !== selectedHost) {
    throw new Error('DATABASE_URL endpoint does not match the selected migration target.');
  }
}

async function verifyConnectionTarget(sql, target, environment) {
  validateEndpointConfiguration(target, environment);
  let rows;
  try { rows = await sql.query('SELECT current_database() AS database_name'); }
  catch { throw new Error('Could not verify the database name for the selected target.'); }
  if (!rows[0] || rows[0].database_name !== EXPECTED_DATABASE) {
    throw new Error('Connected database does not match the expected database for this project.');
  }
}

function normalizeDefinition(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

function normalizePredicate(value) {
  return stripEnclosingParentheses(normalizeDefinition(value));
}

function stripEnclosingParentheses(value) {
  let result = value.trim();
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let enclosed = true;
    let quote = false;
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index];
      if (character === "'") {
        if (quote && result[index + 1] === "'") { index += 1; continue; }
        quote = !quote;
      } else if (!quote && character === '(') depth += 1;
      else if (!quote && character === ')') {
        depth -= 1;
        if (depth === 0 && index !== result.length - 1) { enclosed = false; break; }
      }
    }
    if (!enclosed || depth !== 0) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function normalizeConstraintDefinition(value) {
  const normalized = String(value).trim();
  const match = normalized.match(/^check\s*\((.*)\)$/is);
  if (!match) return normalized;
  return `check(${canonicalizeCheckExpression(match[1])})`;
}

function canonicalizeCheckExpression(expression) {
  let result = stripEnclosingParentheses(expression);
  let changed = true;
  while (changed) {
    changed = false;
    let quote = null;
    const removals = [];
    for (let start = 0; start < result.length; start += 1) {
      const character = result[start];
      if (quote) {
        if (character === quote && result[start + 1] === quote) start += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"') { quote = character; continue; }
      if (character !== '(') continue;

      let depth = 1;
      let innerQuote = null;
      let end = start + 1;
      for (; end < result.length && depth > 0; end += 1) {
        const innerCharacter = result[end];
        if (innerQuote) {
          if (innerCharacter === innerQuote && result[end + 1] === innerQuote) end += 1;
          else if (innerCharacter === innerQuote) innerQuote = null;
        } else if (innerCharacter === "'" || innerCharacter === '"') innerQuote = innerCharacter;
        else if (innerCharacter === '(') depth += 1;
        else if (innerCharacter === ')') depth -= 1;
      }
      if (depth !== 0) continue;
      const close = end - 1;
      const content = result.slice(start + 1, close);
      if (hasTopLevelBooleanOperator(content)) continue;
      if (hasTopLevelPredicateOperator(content) || isNumericLiteral(content)) {
        removals.push([start, close]);
        start = close;
      }
    }
    if (removals.length) {
      for (let index = removals.length - 1; index >= 0; index -= 1) {
        const [start, close] = removals[index];
        const inner = result.slice(start + 1, close);
        const before = result[start - 1] || '';
        const after = result[close + 1] || '';
        const leadingSpace = /[A-Za-z0-9_$]/.test(before) && /[A-Za-z0-9_$]/.test(inner[0] || '') ? ' ' : '';
        const trailingSpace = /[A-Za-z0-9_$]/.test(inner.at(-1) || '') && /[A-Za-z0-9_$]/.test(after) ? ' ' : '';
        result = result.slice(0, start) + leadingSpace + inner + trailingSpace + result.slice(close + 1);
      }
      changed = true;
    }
  }
  return canonicalizeSqlTokens(result);
}

function isNumericLiteral(value) {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(stripEnclosingParentheses(value).trim());
}

function canonicalizeSqlTokens(expression) {
  const tokens = [];
  for (let index = 0; index < expression.length;) {
    const character = expression[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === "'" || character === '"') {
      const quote = character;
      let token = character;
      index += 1;
      while (index < expression.length) {
        const next = expression[index];
        token += next;
        index += 1;
        if (next === quote) {
          if (expression[index] === quote) { token += expression[index]; index += 1; }
          else break;
        }
      }
      tokens.push({ value: token, quoted: true });
      continue;
    }
    const word = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*|^\d+(?:\.\d+)?/);
    if (word) {
      tokens.push({ value: word[0].toLowerCase(), quoted: false });
      index += word[0].length;
      continue;
    }
    const operator = expression.slice(index).match(/^(?:::|!~\*|!~|~\*|<=|>=|<>|!=|=|<|>|~)/);
    if (operator) {
      tokens.push({ value: operator[0], quoted: false });
      index += operator[0].length;
      continue;
    }
    tokens.push({ value: character, quoted: false });
    index += 1;
  }

  let output = '';
  let previous = null;
  for (const token of tokens) {
    const value = token.value;
    const upper = token.quoted ? '' : value.toUpperCase();
    if (upper === 'AND' || upper === 'OR') {
      output = `${output.trimEnd()} ${value} `;
    } else if (['=', '>=', '<=', '<>', '!=', '<', '>', '~', '~*', '!~', '!~*'].includes(value)) {
      output = `${output.trimEnd()}${value}`;
    } else if (value === '::') {
      output = `${output.trimEnd()}::`;
    } else if ([')', ']', ','].includes(value)) {
      output = `${output.trimEnd()}${value}`;
    } else if (['(', '['].includes(value)) {
      output = `${output.trimEnd()}${value}`;
    } else {
      const previousValue = previous && previous.value;
      const needsSpace = Boolean(previous) &&
        !['(', '[', ',', '::'].includes(previousValue) &&
        !['::'].includes(value) &&
        !['=', '>=', '<=', '<>', '!=', '<', '>', '~', '~*', '!~', '!~*'].includes(previousValue);
      output += `${needsSpace && !output.endsWith(' ') ? ' ' : ''}${value}`;
    }
    previous = token;
  }
  return output.trim();
}

function topLevelTokens(expression) {
  const tokens = [];
  let depth = 0;
  let quote = null;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === quote && expression[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '(' || character === '[') { depth += 1; continue; }
    if (character === ')' || character === ']') { depth -= 1; continue; }
    if (depth !== 0) continue;
    const rest = expression.slice(index);
    const keyword = rest.match(/^(AND|OR|IS|IN|LIKE|ILIKE|BETWEEN)\b/i);
    const operator = rest.match(/^(?:!~\*|!~|~\*|~|<=|>=|<>|!=|=|<|>)/);
    if (keyword) {
      tokens.push(keyword[1].toUpperCase());
      index += keyword[0].length - 1;
    } else if (operator) {
      tokens.push('PREDICATE');
      index += operator[0].length - 1;
    }
  }
  return tokens;
}

function hasTopLevelBooleanOperator(expression) {
  return topLevelTokens(expression).some((token) => token === 'AND' || token === 'OR');
}

function hasTopLevelPredicateOperator(expression) {
  return topLevelTokens(expression).some((token) =>
    token === 'PREDICATE' || token === 'IS' || token === 'IN' || token === 'LIKE' || token === 'ILIKE' || token === 'BETWEEN');
}

function expectedSchema() {
  const columns = {
    digital_forensics_registrations: {
      registration_id: ['text', true, null], full_name: ['text', true, null], email: ['text', true, null],
      phone: ['text', true, "''::text"], course: ['text', true, "'digital_forensics'::text"], status: ['text', true, null],
      pricing_option: ['text', false, null], expected_amount: ['numeric(12,2)', true, null],
      expected_currency: ['text', true, null], payment_reference: ['text', false, null],
      verified_transaction_id: ['text', false, null], payment_verification_timestamp: ['timestamp with time zone', false, null],
      email_notification_status: ['text', true, "'pending'::text"], sms_notification_status: ['text', true, "'pending'::text"],
      created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'], updated_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    applicant_magic_link_tokens: {
      token_hash: ['text', true, null], registration_id: ['text', true, null], expires_at: ['timestamp with time zone', true, null],
      used_at: ['timestamp with time zone', false, null], created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    applicant_sessions: {
      session_token_hash: ['text', true, null], registration_id: ['text', true, null], expires_at: ['timestamp with time zone', true, null],
      revoked_at: ['timestamp with time zone', false, null], created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    applicant_login_rate_limits: {
      scope: ['text', true, null], key_hash: ['text', true, null], window_started_at: ['timestamp with time zone', true, null],
      request_count: ['integer', true, null]
    }
  };
  const constraint = (table, type, columnsList, definition = null, references = null) => ({
    table, type, columns: columnsList, definition: definition === null ? null : normalizeConstraintDefinition(definition),
    references, validated: true, deferrable: false, deferred: false,
   noInherit: type !== 'c', nullsNotDistinct: false
  });
  const constraints = [
    constraint('digital_forensics_registrations', 'p', ['registration_id']),
    constraint('digital_forensics_registrations', 'u', ['payment_reference']),
    constraint('digital_forensics_registrations', 'u', ['verified_transaction_id']),
    constraint('digital_forensics_registrations', 'c', [], 'CHECK ((char_length(full_name) >= 1) AND (char_length(full_name) <= 120))'),
    constraint('digital_forensics_registrations', 'c', [], 'CHECK ((email = lower(email)))'),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((course = 'digital_forensics'::text))"),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((status = ANY (ARRAY['pending'::text, 'payment_initiated'::text, 'payment_verified'::text, 'paid'::text])))"),
    constraint('digital_forensics_registrations', 'c', [], "CHECK (((pricing_option IS NULL) OR (pricing_option = ANY (ARRAY['GHS'::text, 'USD_REFERENCE'::text]))))"),
    constraint('digital_forensics_registrations', 'c', [], 'CHECK ((expected_amount > (0)::numeric))'),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((expected_currency = 'GHS'::text))"),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((email_notification_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))"),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((sms_notification_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))"),
    constraint('applicant_magic_link_tokens', 'p', ['token_hash']),
    constraint('applicant_magic_link_tokens', 'f', ['registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
    constraint('applicant_magic_link_tokens', 'c', [], "CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))"),
    constraint('applicant_sessions', 'p', ['session_token_hash']),
    constraint('applicant_sessions', 'f', ['registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
    constraint('applicant_sessions', 'c', [], "CHECK ((session_token_hash ~ '^[a-f0-9]{64}$'::text))"),
    constraint('applicant_login_rate_limits', 'p', ['scope', 'key_hash']),
    constraint('applicant_login_rate_limits', 'c', [], "CHECK ((scope = ANY (ARRAY['email'::text, 'ip'::text])))"),
    constraint('applicant_login_rate_limits', 'c', [], "CHECK ((key_hash ~ '^[a-f0-9]{64}$'::text))"),
    constraint('applicant_login_rate_limits', 'c', [], 'CHECK ((request_count > 0))')
  ];

  const indexes = [
    ['digital_forensics_registrations_pkey', 'digital_forensics_registrations', ['registration_id'], true, true, null],
    ['digital_forensics_registrations_payment_reference_key', 'digital_forensics_registrations', ['payment_reference'], true, false, null],
    ['digital_forensics_registrations_verified_transaction_id_key', 'digital_forensics_registrations', ['verified_transaction_id'], true, false, null],
    ['digital_forensics_registrations_email_idx', 'digital_forensics_registrations', ['email'], false, false, null],
    ['digital_forensics_registrations_status_idx', 'digital_forensics_registrations', ['status'], false, false, null],
    ['applicant_magic_link_tokens_pkey', 'applicant_magic_link_tokens', ['token_hash'], true, true, null],
    ['applicant_magic_link_tokens_expiry_idx', 'applicant_magic_link_tokens', ['expires_at'], false, false, '(used_at IS NULL)'],
    ['applicant_sessions_pkey', 'applicant_sessions', ['session_token_hash'], true, true, null],
    ['applicant_sessions_registration_idx', 'applicant_sessions', ['registration_id'], false, false, null],
    ['applicant_sessions_expiry_idx', 'applicant_sessions', ['expires_at'], false, false, '(revoked_at IS NULL)'],
    ['applicant_login_rate_limits_pkey', 'applicant_login_rate_limits', ['scope', 'key_hash'], true, true, null]
  ].map(([name, table, columnsList, unique, primary, predicate]) => ({
    name, table, columns: columnsList, unique, primary, method: 'btree', predicate: predicate && normalizePredicate(predicate),
    valid: true, ready: true, live: true, nullsNotDistinct: false
  }));
  return { columns, constraints, indexes };
}

function throwSchemaMismatch(category, expected, actual, testOnly) {
  const error = new Error(`Existing development schema does not exactly match the migrations (${category}).`);
  if (testOnly) error.schemaDiagnostic = { category, expected, actual };
  throw error;
}

async function inspectExistingSchema(sql, { testOnly = false } = {}) {
  const expected = expectedSchema();
  const safeQuery = async (statement) => {
    try { return await sql.query(statement); }
    catch { throw new Error('Could not inspect the existing development schema.'); }
  };
  const columns = await safeQuery(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) AS column_default,
           a.attgenerated AS generated, a.attidentity AS identity
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname IN (${EXPECTED_TABLES.map(quoteLiteral).join(', ')})
      AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  `);
  const actualColumns = new Map(columns.map((column) => [
    `${column.table_name}.${column.column_name}`,
    [column.data_type.toLowerCase(), column.not_null, column.column_default === null ? null : normalizeDefinition(column.column_default), column.generated || '', column.identity || '']
  ]));
  const expectedColumnKeys = new Set();
  for (const [table, tableColumns] of Object.entries(expected.columns)) {
    for (const [column, [type, notNull, defaultValue]] of Object.entries(tableColumns)) {
      const key = `${table}.${column}`;
      expectedColumnKeys.add(key);
      const actual = actualColumns.get(key);
      const normalizedDefault = defaultValue === null ? null : normalizeDefinition(defaultValue);
      if (!actual || actual[0] !== type || actual[1] !== notNull || actual[2] !== normalizedDefault || actual[3] !== '' || actual[4] !== '') {
        throwSchemaMismatch('columns', { [key]: [type, notNull, normalizedDefault, '', ''] }, { [key]: actual || null }, testOnly);
      }
    }
  }
  if (actualColumns.size !== expectedColumnKeys.size) {
    throwSchemaMismatch('unexpected or missing columns', [...expectedColumnKeys], [...actualColumns.keys()], testOnly);
  }

  const constraints = await safeQuery(`
    SELECT rel.relname AS table_name, con.contype AS constraint_type,
           pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
           con.convalidated AS validated, con.condeferrable AS deferrable, con.condeferred AS deferred,
           con.connoinherit AS no_inherit,
           COALESCE((pg_catalog.to_jsonb(con)->>'connullsnotdistinct')::boolean, false) AS nulls_not_distinct,
           to_json(ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord)) AS columns,
           ref.relname AS referenced_table,
           to_json(ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord)) AS referenced_columns,
           con.confdeltype AS delete_action, con.confupdtype AS update_action,
           con.confmatchtype AS match_type
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
    LEFT JOIN pg_catalog.pg_class ref ON ref.oid = con.confrelid
    WHERE ns.nspname = 'public' AND rel.relname IN (${EXPECTED_TABLES.map(quoteLiteral).join(', ')})
  `);
  const actualConstraintKeys = constraints.map((row) => {
    const item = {
      table: row.table_name, type: row.constraint_type,
      columns: row.constraint_type === 'c' ? [] : (row.columns || []),
      definition: row.constraint_type === 'c' ? normalizeConstraintDefinition(row.definition) : null,
      references: row.constraint_type === 'f' ? {
        table: row.referenced_table, columns: row.referenced_columns || [], deleteAction: row.delete_action,
        updateAction: row.update_action, matchType: row.match_type
      } : null,
      validated: row.validated, deferrable: row.deferrable, deferred: row.deferred,
      noInherit: row.no_inherit,
      nullsNotDistinct: row.nulls_not_distinct
    };
    return JSON.stringify(item);
  }).sort();
  const expectedConstraintKeys = expected.constraints.map((item) => JSON.stringify(item)).sort();
  if (JSON.stringify(actualConstraintKeys) !== JSON.stringify(expectedConstraintKeys)) {
    throwSchemaMismatch('constraints and relationships', expectedConstraintKeys.map(JSON.parse), actualConstraintKeys.map(JSON.parse), testOnly);
  }

  const indexes = await safeQuery(`
    SELECT idx.relname AS index_name, tbl.relname AS table_name,
           i.indisunique AS is_unique, i.indisprimary AS is_primary,
           i.indisvalid AS is_valid, i.indisready AS is_ready, i.indislive AS is_live,
           COALESCE((pg_catalog.to_jsonb(i)->>'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct,
           i.indnatts = i.indnkeyatts AS no_included_columns, am.amname AS method,
           ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid, keynum, true)
                 FROM generate_series(1, i.indnkeyatts) AS keynum ORDER BY keynum) AS columns,
           pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = idx.relam
    WHERE ns.nspname = 'public' AND tbl.relname IN (${EXPECTED_TABLES.map(quoteLiteral).join(', ')})
  `);
  const actualIndexes = indexes.map((row) => JSON.stringify({
    name: row.index_name, table: row.table_name, columns: row.columns || [], unique: row.is_unique,
    primary: row.is_primary, method: row.method, predicate: row.predicate === null ? null : normalizePredicate(row.predicate),
    noIncludedColumns: row.no_included_columns, valid: row.is_valid, ready: row.is_ready,
    live: row.is_live, nullsNotDistinct: row.nulls_not_distinct
  })).sort();
  const expectedIndexes = expected.indexes.map((item) => JSON.stringify({
    name: item.name, table: item.table, columns: item.columns, unique: item.unique,
    primary: item.primary, method: item.method, predicate: item.predicate,
    noIncludedColumns: true, valid: item.valid, ready: item.ready,
    live: item.live, nullsNotDistinct: item.nullsNotDistinct
  })).sort();
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    throwSchemaMismatch('indexes', expectedIndexes.map(JSON.parse), actualIndexes.map(JSON.parse), testOnly);
  }
}

function historyValidationBlock(migrations, adoptExisting = false) {
  const names = `ARRAY[${migrations.map(({ filename }) => quoteLiteral(filename)).join(', ')}]::text[]`;
  const checksums = `ARRAY[${migrations.map(({ checksum }) => quoteLiteral(checksum)).join(', ')}]::text[]`;
  const historyGuard = `
    IF (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schema_migrations') <> 3
       OR EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'schema_migrations'
           AND NOT (
             (column_name = 'filename' AND data_type = 'text' AND is_nullable = 'NO' AND column_default IS NULL) OR
             (column_name = 'checksum' AND data_type = 'text' AND is_nullable = 'NO' AND column_default IS NULL) OR
             (column_name = 'applied_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO' AND column_default LIKE 'CURRENT_TIMESTAMP%')
           )
       )
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
             AND con.contype = 'p' AND pg_catalog.pg_get_constraintdef(con.oid) = 'PRIMARY KEY (filename)'
             AND con.convalidated) <> 1
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND con.contype = 'c'
             AND pg_catalog.pg_get_constraintdef(con.oid, true) = 'CHECK (checksum ~ ''^[a-f0-9]{64}$''::text)'
             AND con.convalidated) <> 1
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND con.contype = 'c') <> 1
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND con.contype NOT IN ('p', 'c'))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND NOT i.indisprimary)
    THEN RAISE EXCEPTION 'migration history table schema is invalid'; END IF;
  `;
  const body = adoptExisting ? `
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('cybanext_schema_migrations'));
      ${historyGuard}
    IF EXISTS (SELECT 1 FROM public.schema_migrations) THEN
      RAISE EXCEPTION 'existing migration history prevents adoption';
    END IF;
    ${migrations.map((migration) => `INSERT INTO public.schema_migrations (filename, checksum) VALUES (${quoteLiteral(migration.filename)}, ${quoteLiteral(migration.checksum)});`).join('\n')}
    END;
  ` : `
    DECLARE expected_names text[] := ${names}; expected_checksums text[] := ${checksums};
            recorded_count integer; idx integer; recorded_checksum text;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('cybanext_schema_migrations'));
      ${historyGuard}
      IF (SELECT count(*) FROM public.schema_migrations) > cardinality(expected_names) THEN
        RAISE EXCEPTION 'migration history has extra records';
      END IF;
      IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE NOT (filename = ANY(expected_names))) THEN
        RAISE EXCEPTION 'migration history contains an unknown filename';
      END IF;
      SELECT count(*) INTO recorded_count FROM public.schema_migrations;
      IF recorded_count > 0 THEN
        FOR idx IN 1..recorded_count LOOP
          SELECT checksum INTO recorded_checksum FROM public.schema_migrations WHERE filename = expected_names[idx];
          IF NOT FOUND THEN RAISE EXCEPTION 'migration history is not an ordered prefix'; END IF;
          IF recorded_checksum <> expected_checksums[idx] THEN RAISE EXCEPTION 'migration checksum mismatch'; END IF;
        END LOOP;
      END IF;
      IF recorded_count = 0 AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[${EXPECTED_TABLES.map(quoteLiteral).join(', ')}]::text[]) AS app_table(name)
        WHERE to_regclass('public.' || app_table.name) IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'application tables exist without migration history';
      END IF;
      FOR idx IN (recorded_count + 1)..cardinality(expected_names) LOOP
        CASE idx
          ${migrations.map((migration, index) => `WHEN ${index + 1} THEN ${migration.statements.map((statement) => `EXECUTE ${quoteLiteral(statement)};`).join('\n')}`).join('\n')}
        END CASE;
        INSERT INTO public.schema_migrations (filename, checksum) VALUES (expected_names[idx], expected_checksums[idx]);
      END LOOP;
    END;
  `;
  return `DO $cybanext_migration$ ${body} $cybanext_migration$`;
}

function historyTableDefinition() {
  return `CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
}

function advisoryLockStatement() {
  return "SELECT pg_advisory_xact_lock(hashtext('cybanext_schema_migrations'))";
}

function historyStructureValidationStatement(testOnly = false) {
  const invalid = (category) => testOnly
    ? `migration history table schema is invalid: ${category}`
    : 'migration history table schema is invalid';
  const expectedMetadata = {
    columns: [
      { name: 'filename', dataType: 'text', nullable: 'NO', default: null },
      { name: 'checksum', dataType: 'text', nullable: 'NO', default: null },
      { name: 'applied_at', dataType: 'timestamp with time zone', nullable: 'NO', default: 'CURRENT_TIMESTAMP' }
    ],
    primaryKey: { definition: 'PRIMARY KEY (filename)', validated: true },
    checkConstraint: { definition: "CHECK (checksum ~ '^[a-f0-9]{64}$'::text)", validated: true },
    extraConstraints: [], extraIndexes: []
  };
  const diagnosticDeclaration = testOnly ? 'DECLARE actual_catalog jsonb;' : '';
  const diagnosticQuery = testOnly ? `
      SELECT jsonb_build_object(
        'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', column_name, 'dataType', data_type,
          'nullable', is_nullable, 'default', column_default) ORDER BY ordinal_position)
          FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations'), '[]'::jsonb),
        'constraints', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', con.conname, 'type', con.contype,
          'definition', pg_catalog.pg_get_constraintdef(con.oid, true), 'validated', con.convalidated)
          ORDER BY con.conname) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations'), '[]'::jsonb),
        'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', idx.relname, 'primary', i.indisprimary,
          'unique', i.indisunique, 'valid', i.indisvalid, 'definition', pg_catalog.pg_get_indexdef(i.indexrelid))
          ORDER BY idx.relname) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
          JOIN pg_catalog.pg_class tbl ON tbl.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=tbl.relnamespace
          WHERE n.nspname='public' AND tbl.relname='schema_migrations'), '[]'::jsonb)
      ) INTO actual_catalog;
  ` : '';
  const raise = (category) => testOnly
    ? `RAISE EXCEPTION USING MESSAGE = ${quoteLiteral(invalid(category))}, DETAIL = jsonb_build_object('expected', ${quoteLiteral(JSON.stringify(expectedMetadata))}::jsonb, 'actual', actual_catalog)::text;`
    : `RAISE EXCEPTION ${quoteLiteral(invalid(category))};`;
  return `DO $cybanext_history_structure$
  ${diagnosticDeclaration}
  BEGIN
    ${diagnosticQuery}
    IF to_regclass('public.schema_migrations') IS NULL THEN RETURN; END IF;
    IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations') <> 3
       OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations'
         AND NOT ((column_name='filename' AND data_type='text' AND is_nullable='NO' AND column_default IS NULL)
           OR (column_name='checksum' AND data_type='text' AND is_nullable='NO' AND column_default IS NULL)
           OR (column_name='applied_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default LIKE 'CURRENT_TIMESTAMP%')))
    THEN ${raise('columns')} END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype='p'
         AND pg_catalog.pg_get_constraintdef(con.oid)='PRIMARY KEY (filename)' AND con.convalidated) <> 1
    THEN ${raise('primary key')} END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype='c'
         AND pg_catalog.pg_get_constraintdef(con.oid, true)='CHECK (checksum ~ ''^[a-f0-9]{64}$''::text)'
         AND con.convalidated) <> 1
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype='c') <> 1
    THEN ${raise('checksum constraint')} END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype NOT IN ('p','c'))
    THEN ${raise('unexpected constraint')} END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND NOT i.indisprimary)
    THEN ${raise('unexpected index')} END IF;
  END $cybanext_history_structure$`;
}

function testDatabaseDiagnostic(error) {
  const redact = (value) => typeof value === 'string'
    ? value.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted connection string]')
      .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    : undefined;
  return {
    message: redact(error?.message),
    sqlstate: typeof error?.code === 'string' ? error.code : undefined,
    detail: redact(error?.detail),
    hint: redact(error?.hint),
    context: redact(error?.where),
    ...(error?.schemaDiagnostic ? { schema: error.schemaDiagnostic } : {})
  };
}

function reportTestDatabaseDiagnostic(error, options) {
  if (options.testOnly === true && typeof options.onTestDiagnostic === 'function') {
    options.onTestDiagnostic(testDatabaseDiagnostic(error));
  }
}

function createNeonMigrationClient(connectionString) {
  const { Pool } = require('@neondatabase/serverless');
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });
  return {
    async query(statement) {
      return (await pool.query(statement)).rows;
    },
    async withTransaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback({
          query: async (statement) => (await client.query(statement)).rows
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

async function runMigrations(options = {}) {
  const args = options.args || [];
  const logger = options.logger || console;
  const migrationsDirectory = options.migrationsDirectory || path.join(__dirname, '..', 'db', 'migrations');
  const migrations = loadMigrations(migrationsDirectory);
  const { apply, target, adoptExisting } = parseArguments(args);
  if (!apply) {
    logger.log('Dry run only. No database connection or SQL execution.');
    logger.log(`Selected target: ${target}.`);
    logger.log('Migration order:');
    for (const migration of migrations) logger.log(`- ${migration.filename}`);
    return { applied: false, migrations: migrations.map(({ filename }) => filename) };
  }
  const environment = options.environment || process.env;
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required to apply migrations.');
  const testOnly = options.testOnly === true;
  if (testOnly) {
    if (options.testOnlyToken !== TEST_ONLY_TOKEN || options.testTarget !== 'loopback-postgres') {
      throw new Error('Test-only migration entry point is unavailable.');
    }
    validateLoopbackTestTarget(environment.DATABASE_URL);
  } else {
    validateEndpointConfiguration(target, environment);
  }
  let sql;
  try {
    const createClient = options.createClient || (() => {
      return createNeonMigrationClient(environment.DATABASE_URL);
    });
    sql = createClient();
  } catch {
    throw new Error('Could not initialize the database client.');
  }
  try {
    if (typeof sql.withTransaction !== 'function') {
      throw new Error('Migration database client must support interactive transactions.');
    }
    if (testOnly) await verifyLoopbackTestConnection(sql, environment.DATABASE_URL);
    else await verifyConnectionTarget(sql, target, environment);
    logger.log(testOnly ? 'Verified loopback PostgreSQL test target.' : `Verified ${target} endpoint host and ${EXPECTED_DATABASE} database name.`);

    if (adoptExisting) {
      try {
        await sql.withTransaction(async (tx) => {
          await tx.query(advisoryLockStatement());
          await inspectExistingSchema(tx, { testOnly });
          await tx.query(historyTableDefinition());
          await tx.query(historyStructureValidationStatement(testOnly));
          await tx.query('SELECT filename, checksum FROM public.schema_migrations');
          await tx.query(historyValidationBlock(migrations, true));
        });
      } catch (error) {
        reportTestDatabaseDiagnostic(error, { ...options, testOnly });
        throw new Error('Development schema adoption failed; no raw database details are available.');
      }
      logger.log('Existing development schema verified and adopted; migration DDL was not rerun.');
      return { applied: true, adopted: true, migrations: migrations.map(({ filename }) => filename) };
    }

    try {
      await sql.withTransaction(async (tx) => {
        await tx.query(advisoryLockStatement());
        await tx.query(historyTableDefinition());
        await tx.query(historyStructureValidationStatement(testOnly));
        await tx.query('SELECT filename, checksum FROM public.schema_migrations');
        await tx.query(historyValidationBlock(migrations, false));
      });
    } catch (error) {
      reportTestDatabaseDiagnostic(error, { ...options, testOnly });
      const code = error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
      logger.error(`Migration transaction failed; no raw database details are available (code: ${code}).`);
      throw Object.assign(new Error('Migration operation failed.'), { safeMigrationError: true, code });
    }
    logger.log('All listed migrations completed or were already applied with matching checksums.');
    return { applied: true, migrations: migrations.map(({ filename }) => filename) };
  } finally {
    if (typeof sql.close === 'function') {
      try { await sql.close(); } catch { /* Do not replace the migration result with a pool-close error. */ }
    }
  }
}

const TEST_ONLY_TOKEN = Symbol('migration-test-only-entry-point');

function validateLoopbackTestTarget(connectionUrl) {
  let parsed;
  try { parsed = new URL(connectionUrl); } catch { throw new Error('Test database URL is invalid.'); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !['localhost', '127.0.0.1', '::1'].includes(host) ||
      parsed.searchParams.has('host') || parsed.searchParams.has('hostaddr') ||
      parsed.username === '' || parsed.password === '' || parsed.pathname.length < 2) {
    throw new Error('Test database must use an explicit loopback PostgreSQL URL with credentials and a database name.');
  }
  return parsed;
}

async function verifyLoopbackTestConnection(sql, connectionUrl) {
  validateLoopbackTestTarget(connectionUrl);
  let rows;
  try { rows = await sql.query('SELECT current_database() AS database_name'); }
  catch { throw new Error('Could not verify the loopback PostgreSQL test target.'); }
  if (!rows[0] || rows[0].database_name !== decodeURIComponent(new URL(connectionUrl).pathname.slice(1))) {
    throw new Error('Connected database is not the requested loopback PostgreSQL test target.');
  }
}

async function runTestMigrations(options = {}) {
  const connectionUrl = options.connectionUrl;
  validateLoopbackTestTarget(connectionUrl);
  const { apply = true, adoptExisting = false, logger = console, createClient } = options;
  if (!apply) {
    logger.log('Dry run only. No database connection or SQL execution.');
    logger.log('Selected target: isolated PostgreSQL test database.');
    logger.log('Migration order:');
    for (const migration of loadMigrations()) logger.log(`- ${migration.filename}`);
    return { applied: false, migrations: loadMigrations().map(({ filename }) => filename) };
  }
  if (typeof createClient !== 'function') throw new Error('A test-only PostgreSQL client factory is required.');
  return runMigrations({
    args: ['--target=development', '--apply', '--confirm-development=dev/cybanext-phase2c-test', ...(adoptExisting ? ['--adopt-existing'] : [])],
    environment: { DATABASE_URL: connectionUrl }, logger, createClient,
    migrationsDirectory: options.migrationsDirectory,
    testOnly: true, testOnlyToken: TEST_ONLY_TOKEN, testTarget: 'loopback-postgres',
    onTestDiagnostic: options.onTestDiagnostic
  });
}

function sanitizeError(error) {
  const code = error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
  return `Migration operation failed. (code: ${code})`;
}

if (require.main === module) {
  runMigrations({ args: process.argv.slice(2) }).catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_DATABASE,
  EXPECTED_TABLES,
  MIGRATION_FILES,
  expectedSchema,
  historyValidationBlock,
  inspectExistingSchema,
  loadMigrations,
  parseArguments,
  runMigrations,
  runTestMigrations,
  sanitizeError,
  splitSqlStatements,
  validateEndpointConfiguration,
  verifyConnectionTarget
};
