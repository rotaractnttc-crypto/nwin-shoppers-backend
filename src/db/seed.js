require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool } = require("./pool");

async function seedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before seeding.");
    process.exit(1);
  }
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [ADMIN_EMAIL]);
  if (existing.rows.length) {
    console.log("Admin already exists, skipping.");
    return pool.end();
  }
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
    [ADMIN_NAME || "Admin", ADMIN_EMAIL, hash]
  );
  console.log(`✅ Admin account created for ${ADMIN_EMAIL}. Log in, then change the password.`);
  await pool.end();
}

seedAdmin().catch((err) => {
  console.error(err);
  process.exit(1);
});
