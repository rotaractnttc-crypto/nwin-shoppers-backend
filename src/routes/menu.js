const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

async function ownsRestaurant(userId, restaurantId, role) {
  if (role === "admin") return true;
  const { rows } = await pool.query(
    "SELECT 1 FROM restaurants WHERE id = $1 AND owner_user_id = $2",
    [restaurantId, userId]
  );
  return rows.length > 0;
}

// ---------- Owner/admin: add a menu item (goes to pending) ----------
router.post(
  "/",
  requireAuth,
  [
    body("restaurant_id").isUUID(),
    body("name").trim().isLength({ min: 2, max: 150 }).escape(),
    body("description").optional().trim().isLength({ max: 1000 }).escape(),
    body("price").isFloat({ min: 0 }),
    body("category").optional().isIn(["starter", "main", "drink", "dessert", "other"]),
    body("modifiers").optional().isArray({ max: 10 }),
    body("image").optional().trim(),
  ],
  handleValidation,
  async (req, res) => {
    const allowed = await ownsRestaurant(req.user.id, req.body.restaurant_id, req.user.role);
    if (!allowed) return res.status(403).json({ error: "Not your restaurant." });

    const { restaurant_id, name, description, price, category, modifiers, image } = req.body;
    // Admin-added items go live immediately — matches the same pattern as
    // admin-added restaurants and products, since a two-step
    // "admin approves their own submission" flow is pointless friction.
    const status = req.user.role === "admin" ? "approved" : "pending";
    const { rows } = await pool.query(
      `INSERT INTO menu_items (restaurant_id, name, description, price, category, modifiers, image, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [restaurant_id, name, description || null, price, category || "main", JSON.stringify(modifiers || []), image || null, status]
    );
    res.status(201).json({ menuItem: rows[0], note: status === "approved" ? "Added and live." : "Submitted for admin review." });
  }
);

// ---------- Owner/admin: update or toggle availability ----------
router.put(
  "/:id",
  requireAuth,
  [param("id").isUUID()],
  handleValidation,
  async (req, res) => {
    const existing = await pool.query("SELECT restaurant_id FROM menu_items WHERE id = $1", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: "Menu item not found." });
    const allowed = await ownsRestaurant(req.user.id, existing.rows[0].restaurant_id, req.user.role);
    if (!allowed) return res.status(403).json({ error: "Not your restaurant." });

    const fields = ["name", "description", "price", "category", "modifiers", "image", "available"];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(f === "modifiers" ? JSON.stringify(req.body[f]) : req.body[f]);
        updates.push(`${f} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: "No valid fields to update." });
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE menu_items SET ${updates.join(", ")}, updated_at = now(), status = 'pending' WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ menuItem: rows[0], note: "Changes re-submitted for review." });
  }
);

// ---------- Owner: view own restaurant's full menu (any status) ----------
router.get("/mine/:restaurantId", requireAuth, [param("restaurantId").isUUID()], handleValidation, async (req, res) => {
  const allowed = await ownsRestaurant(req.user.id, req.params.restaurantId, req.user.role);
  if (!allowed) return res.status(403).json({ error: "Not your restaurant." });
  const { rows } = await pool.query(
    "SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY created_at DESC",
    [req.params.restaurantId]
  );
  res.json({ menuItems: rows });
});

// ---------- ADMIN: pending menu items ----------
router.get("/admin/pending", requireAuth, requireRole("admin"), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT m.*, r.name AS restaurant_name
     FROM menu_items m JOIN restaurants r ON r.id = m.restaurant_id
     WHERE m.status = 'pending' ORDER BY m.created_at ASC`
  );
  res.json({ menuItems: rows });
});

// ---------- ADMIN: approve/reject ----------
router.patch(
  "/admin/:id/status",
  requireAuth,
  requireRole("admin"),
  [param("id").isUUID(), body("status").isIn(["approved", "rejected", "disabled"])],
  handleValidation,
  async (req, res) => {
    const { rows } = await pool.query(
      "UPDATE menu_items SET status = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [req.body.status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Menu item not found." });
    res.json({ menuItem: rows[0] });
  }
);

module.exports = router;
