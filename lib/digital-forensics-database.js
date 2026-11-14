const { neon } = require('@neondatabase/serverless');

let sql;

function getSql() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for registration storage.');
  }

  if (!sql) {
    sql = neon(databaseUrl);
  }

  return sql;
}

function query(strings, ...values) {
  return getSql()(strings, ...values);
}

function transaction(queriesOrBuilder, options) {
  return getSql().transaction(queriesOrBuilder, options);
}

module.exports = { query, transaction };
