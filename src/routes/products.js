const express = require("express");
const { body, query, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth, requireRole, optionalAuth } = require("../middleware/auth");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// ---------- PUBLIC: browse / search approved products ----------
router.get(
  "/",
  optionalAuth,
  [
    query("q").optional().trim().escape(),
    query("category").optional().trim().escape(),
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  handleValidation,
  async (req, res) => {
    const { q, category, deal, special } = req.query;
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const offset = (page - 1) * limit;

    // All values are passed as parameters ($1, $2...) — never interpolated into the SQL string.
    const conditions = ["p.status = 'approved'"];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`p.name ILIKE $${params.length}`);
    }
    if (category) {
      params.push(category);
      conditions.push(`c.slug = $${params.length}`);
    }
    if (deal === "true") conditions.push("p.is_deal = TRUE");
    if (special === "true") conditions.push("p.is_special = TRUE");

    params.push(limit, offset);
    const sql = `
      SELECT p.id, p.name, p.description, p.price, p.was_price, p.stock, p.images,
             p.is_deal, p.is_special, p.rating_avg, p.rating_count, p.created_at,
             c.slug AS category, c.name AS category_name,
             s.id AS seller_id, s.business_name AS seller_name, s.made_in_nwin
      FROM products p
      JOIN sellers s ON s.id = p.seller_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await pool.query(sql, params);
    res.json({ products: rows, page, limit });
  }
);

// ---------- SELLER: view own products, any status ----------
router.get("/mine", requireAuth, requireRole("seller", "admin"), async (req, res) => {
  const seller = await pool.query("SELECT id FROM sellers WHERE user_id = $1", [req.user.id]);
  if (!seller.rows.length) return res.json({ products: [] });

  const { rows } = await pool.query(
    `SELECT p.*, c.slug AS category, c.name AS category_name
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.seller_id = $1 ORDER BY p.created_at DESC`,
    [seller.rows[0].id]
  );
  res.json({ products: rows });
});

// ---------- PUBLIC: single product with reviews ----------
router.get("/:id", [param("id").isUUID()], handleValidation, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, s.business_name AS seller_name, s.made_in_nwin, c.slug AS category
     FROM products p
     JOIN sellers s ON s.id = p.seller_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = $1 AND p.status = 'approved'`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Product not found." });

  const reviews = await pool.query(
    `SELECT r.rating, r.text, r.created_at, u.name AS reviewer_name
     FROM reviews r JOIN users u ON u.id = r.user_id
     WHERE r.product_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [req.params.id]
  );
  res.json({ product: rows[0], reviews: reviews.rows });
});

// ---------- SELLER: create a product listing (goes in as 'pending' for admin review) ----------
router.post(
  "/",
  requireAuth,
  requireRole("seller", "admin"),
  [
    body("name").trim().isLength({ min: 3, max: 200 }).escape(),
    body("description").optional().trim().isLength({ max: 3000 }).escape(),
    body("price").isFloat({ min: 0 }),
    body("was_price").optional({ nullable: true }).isFloat({ min: 0 }),
    body("stock").isInt({ min: 0 }),
    body("category_id").optional({ nullable: true }).isInt(),
    body("images").optional().isArray({ max: 6 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const seller = await pool.query("SELECT id, status FROM sellers WHERE user_id = $1", [req.user.id]);
      if (!seller.rows.length) {
        return res.status(403).json({ error: "You need a seller profile first. Apply via /api/sellers/apply." });
      }
      if (seller.rows[0].status !== "approved" && req.user.role !== "admin") {
        return res.status(403).json({ error: "Your seller account is still pending approval." });
      }

      const { name, description, price, was_price, stock, category_id, images } = req.body;
      const { rows } = await pool.query(
        `INSERT INTO products (seller_id, category_id, name, description, price, was_price, stock, images, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING *`,
        [
          seller.rows[0].id,
          category_id || null,
          name,
          description || null,
          price,
          was_price || null,
          stock,
          JSON.stringify(images || []),
        ]
      );
      res.status(201).json({ product: rows[0], note: "Submitted for admin review before it goes live." });
    } catch (err) {
      console.error("create product error:", err.message);
      res.status(500).json({ error: "Could not create product." });
    }
  }
);

// ---------- SELLER: update own product (ownership enforced in the WHERE clause) ----------
router.put(
  "/:id",
  requireAuth,
  requireRole("seller", "admin"),
  [param("id").isUUID()],
  handleValidation,
  async (req, res) => {
    const allowed = ["name", "description", "price", "was_price", "stock", "category_id", "images"];
    const updates = [];
    const params = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        params.push(field === "images" ? JSON.stringify(req.body[field]) : req.body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: "No valid fields to update." });

    params.push(req.params.id);
    // Ownership is enforced via a parameterized subquery below — never string-built.
    let sql;
    if (req.user.role === "admin") {
      sql = `UPDATE products SET ${updates.join(", ")}, updated_at = now(), status = 'pending'
             WHERE id = $${params.length} RETURNING *`;
    } else {
      params.push(req.user.id);
      sql = `UPDATE products SET ${updates.join(", ")}, updated_at = now(), status = 'pending'
             WHERE id = $${params.length - 1}
               AND seller_id = (SELECT id FROM sellers WHERE user_id = $${params.length})
             RETURNING *`;
    }
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: "Product not found or not yours to edit." });
    res.json({ product: rows[0], note: "Changes re-submitted for review." });
  }
);

module.exports = router;
