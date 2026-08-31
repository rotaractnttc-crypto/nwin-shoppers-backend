const { Pool } = require("pg");

// Using a connection pool + parameterized queries everywhere (see routes/*.js)
// is what keeps this app immune to SQL injection — we never string-concat
// user input into SQL text.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});

module.exports = { pool };
