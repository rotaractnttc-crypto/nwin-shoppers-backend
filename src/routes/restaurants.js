const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth, requireRole, optionalAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// ---------- PUBLIC: browse approved, open restaurants ----------
router.get("/", optionalAuth, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, location, cuisine_type, image, is_open, avg_prep_minutes
     FROM restaurants WHERE status = 'approved' ORDER BY created_at DESC`
  );
  res.json({ restaurants: rows });
}));

// ---------- PUBLIC: one restaurant + its approved, available menu ----------
router.get("/:id", [param("id").isUUID()], handleValidation, asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: "Restaurant not found." });

  const menu = await pool.query(
    `SELECT * FROM menu_items WHERE restaurant_id = $1 AND status = 'approved' AND available = TRUE
     ORDER BY category, name`,
    [req.params.id]
  );
  res.json({ restaurant: r.rows[0], menu: menu.rows });
}));

// ---------- ADMIN: add a restaurant directly (goes live immediately) ----------
router.post(
  "/",
  requireAuth,
  requireRole("admin"),
  [
    body("name").trim().isLength({ min: 2, max: 150 }).escape(),
    body("description").optional().trim().isLength({ max: 1000 }).escape(),
    body("location").optional().trim().isLength({ max: 150 }).escape(),
    body("cuisine_type").optional().trim().isLength({ max: 80 }).escape(),
    body("phone").optional().trim().isMobilePhone("any"),
    body("avg_prep_minutes").optional().isInt({ min: 1, max: 180 }),
    body("latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
    body("image").optional({ nullable: true }).trim(),
    body("manager_email").optional({ nullable: true, checkFalsy: true }).trim().isEmail().normalizeEmail(),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { name, description, location, cuisine_type, phone, avg_prep_minutes, latitude, longitude, image, manager_email } = req.body;

    let ownerUserId = null;
    if (manager_email) {
      const existingUser = await pool.query("SELECT id FROM users WHERE email = $1", [manager_email]);
      if (existingUser.rows.length) ownerUserId = existingUser.rows[0].id;
    }

    const { rows } = await pool.query(
      `INSERT INTO restaurants (name, description, location, cuisine_type, phone, avg_prep_minutes, latitude, longitude, image, manager_email, owner_user_id, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'approved', $12, now()) RETURNING *`,
      [name, description || null, location || null, cuisine_type || null, phone || null, avg_prep_minutes || 20, latitude || null, longitude || null, image || null, manager_email || null, ownerUserId, req.user.id]
    );
    if (ownerUserId) await pool.query("UPDATE users SET role = 'seller' WHERE id = $1 AND role = 'shopper'", [ownerUserId]);
    res.status(201).json({ restaurant: rows[0] });
  })
);

// ---------- Claim a restaurant an admin invited you to manage by email ----------
router.post("/claim", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE restaurants SET owner_user_id = $1
     WHERE manager_email = (SELECT email FROM users WHERE id = $1) AND owner_user_id IS NULL
     RETURNING *`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "No restaurant invitation found for your account." });
  await pool.query("UPDATE users SET role = 'seller' WHERE id = $1 AND role = 'shopper'", [req.user.id]);
  res.json({ restaurant: rows[0] });
}));

// ---------- SELF-SERVICE: apply to add your own restaurant (goes to pending) ----------
router.post(
  "/apply",
  requireAuth,
  [
    body("name").trim().isLength({ min: 2, max: 150 }).escape(),
    body("description").optional().trim().isLength({ max: 1000 }).escape(),
    body("location").optional().trim().isLength({ max: 150 }).escape(),
    body("cuisine_type").optional().trim().isLength({ max: 80 }).escape(),
    body("phone").optional().trim().isMobilePhone("any"),
    body("latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
    body("image").optional({ nullable: true }).trim(),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const existing = await pool.query("SELECT id FROM restaurants WHERE owner_user_id = $1", [req.user.id]);
    if (existing.rows.length) {
      return res.status(409).json({ error: "You've already applied. Check status at GET /api/restaurants/mine/status." });
    }
    const { name, description, location, cuisine_type, phone, latitude, longitude, image } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO restaurants (owner_user_id, name, description, location, cuisine_type, phone, latitude, longitude, image, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') RETURNING *`,
      [req.user.id, name, description || null, location || null, cuisine_type || null, phone || null, latitude || null, longitude || null, image || null]
    );
    res.status(201).json({ restaurant: rows[0], note: "Submitted for admin review." });
  })
);

// ---------- Restaurant owner: view own restaurant ----------
// Returns 404 when the account has no restaurant yet — that's the expected,
// correct response (not an error state); the frontend uses it to decide
// whether to show the "apply" form.
router.get("/mine/status", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM restaurants WHERE owner_user_id = $1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "No restaurant found for this account." });
  res.json({ restaurant: rows[0] });
}));

// ---------- Restaurant owner or admin: update details, toggle open/closed ----------
router.patch(
  "/:id",
  requireAuth,
  requireRole("seller", "admin", "shopper"),
  [
    param("id").isUUID(),
    body("is_open").optional().isBoolean(),
    body("avg_prep_minutes").optional().isInt({ min: 1, max: 180 }),
    body("latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
    body("image").optional({ nullable: true }).trim(),
    body("location").optional({ nullable: true }).trim().isLength({ max: 150 }).escape(),
    body("cuisine_type").optional({ nullable: true }).trim().isLength({ max: 80 }).escape(),
    body("phone").optional({ nullable: true }).trim().isMobilePhone("any"),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const allowed = ["is_open", "avg_prep_minutes", "latitude", "longitude", "image", "location", "cuisine_type", "phone"];
    const fields = [];
    const params = [];
    for (const f of allowed) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); fields.push(`${f} = $${params.length}`); }
    }
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update." });

    params.push(req.params.id);
    let sql, result;
    if (req.user.role === "admin") {
      sql = `UPDATE restaurants SET ${fields.join(", ")} WHERE id = $${params.length} RETURNING *`;
      result = await pool.query(sql, params);
    } else {
      params.push(req.user.id);
      sql = `UPDATE restaurants SET ${fields.join(", ")} WHERE id = $${params.length - 1} AND owner_user_id = $${params.length} RETURNING *`;
      result = await pool.query(sql, params);
    }
    if (!result.rows.length) return res.status(404).json({ error: "Restaurant not found or not yours to edit." });
    res.json({ restaurant: result.rows[0] });
  })
);

// ---------- ADMIN: pending restaurant applications ----------
router.get("/admin/pending", requireAuth, requireRole("admin"), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS applicant_name, u.email
     FROM restaurants r LEFT JOIN users u ON u.id = r.owner_user_id
     WHERE r.status = 'pending' ORDER BY r.created_at ASC`
  );
  res.json({ restaurants: rows });
}));

// ---------- ADMIN: approve / reject / suspend ----------
router.patch(
  "/admin/:id/status",
  requireAuth,
  requireRole("admin"),
  [param("id").isUUID(), body("status").isIn(["approved", "rejected", "suspended", "pending"])],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE restaurants SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3 RETURNING *`,
      [req.body.status, req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Restaurant not found." });
    res.json({ restaurant: rows[0] });
  })
);

module.exports = router;
