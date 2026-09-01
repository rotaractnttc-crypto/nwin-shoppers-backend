const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// ---------- Apply to become a seller (any logged-in shopper) ----------
router.post(
  "/apply",
  requireAuth,
  [
    body("business_name").trim().isLength({ min: 2, max: 150 }).escape(),
    body("description").optional().trim().isLength({ max: 1000 }).escape(),
    body("location").optional().trim().isLength({ max: 150 }).escape(),
    body("latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  async (req, res) => {
    const { business_name, description, location, latitude, longitude } = req.body;
    try {
      const existing = await pool.query("SELECT id FROM sellers WHERE user_id = $1", [req.user.id]);
      if (existing.rows.length) {
        return res.status(409).json({ error: "You've already applied. Check your status at GET /api/sellers/me." });
      }
      const { rows } = await pool.query(
        `INSERT INTO sellers (user_id, business_name, description, location, latitude, longitude, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
        [req.user.id, business_name, description || null, location || null, latitude || null, longitude || null]
      );
      await pool.query("UPDATE users SET role = 'seller' WHERE id = $1", [req.user.id]);
      res.status(201).json({ seller: rows[0], note: "Application submitted. An admin will review it." });
    } catch (err) {
      console.error("seller apply error:", err.message);
      res.status(500).json({ error: "Could not submit application." });
    }
  }
);

// ---------- Seller: view own profile/status ----------
router.get("/me", requireAuth, requireRole("seller", "admin"), asyncHandler(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM sellers WHERE user_id = $1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "No seller profile found." });
  res.json({ seller: rows[0] });
}));

// ---------- Public: verified/approved sellers directory ----------
router.get("/", asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, business_name, description, location, made_in_nwin, created_at
     FROM sellers WHERE status = 'approved' ORDER BY created_at DESC`
  );
  res.json({ sellers: rows });
}));

// ---------- ADMIN: list pending sellers ----------
router.get("/admin/pending", requireAuth, requireRole("admin"), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, u.name AS applicant_name, u.email, u.phone
     FROM sellers s JOIN users u ON u.id = s.user_id
     WHERE s.status = 'pending' ORDER BY s.created_at ASC`
  );
  res.json({ sellers: rows });
}));

// ---------- Seller: update own location/profile details ----------
router.patch(
  "/me",
  requireAuth,
  requireRole("seller", "admin"),
  [
    body("latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
    body("location").optional({ nullable: true }).trim().isLength({ max: 150 }).escape(),
    body("description").optional({ nullable: true }).trim().isLength({ max: 1000 }).escape(),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const allowed = ["latitude", "longitude", "location", "description"];
    const fields = [];
    const params = [];
    for (const f of allowed) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); fields.push(`${f} = $${params.length}`); }
    }
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update." });
    params.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE sellers SET ${fields.join(", ")} WHERE user_id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "No seller profile found." });
    res.json({ seller: rows[0] });
  })
);

// ---------- ADMIN: approve / reject / suspend a seller ----------
router.patch(
  "/admin/:id/status",
  requireAuth,
  requireRole("admin"),
  [param("id").isUUID(), body("status").isIn(["approved", "rejected", "suspended", "pending"])],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE sellers SET status = $1, reviewed_by = $2, reviewed_at = now()
       WHERE id = $3 RETURNING *`,
      [req.body.status, req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Seller not found." });

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta)
       VALUES ($1, 'seller_status_change', 'seller', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ status: req.body.status })]
    );
    res.json({ seller: rows[0] });
  })
);

module.exports = router;
