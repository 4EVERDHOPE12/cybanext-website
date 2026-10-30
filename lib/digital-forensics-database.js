const { neon } = require('@neondatabase/serverless');

let sql;

function query(strings, ...values) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for registration storage.');
  }

  if (!sql) {
    sql = neon(databaseUrl);
  }

  return sql(strings, ...values);
}

module.exports = { query };
