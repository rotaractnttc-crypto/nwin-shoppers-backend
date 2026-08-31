const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// ---------- Products awaiting review ----------
router.get("/products/pending", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, s.business_name AS seller_name
     FROM products p JOIN sellers s ON s.id = p.seller_id
     WHERE p.status = 'pending' ORDER BY p.created_at ASC`
  );
  res.json({ products: rows });
});

// ---------- Approve / reject a product ----------
router.patch(
  "/products/:id/status",
  [param("id").isUUID(), body("status").isIn(["approved", "rejected", "disabled"])],
  handleValidation,
  async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE products SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [req.body.status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found." });

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta)
       VALUES ($1, 'product_status_change', 'product', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ status: req.body.status })]
    );
    res.json({ product: rows[0] });
  }
);

// ---------- Dashboard stats ----------
router.get("/stats", async (_req, res) => {
  const [users, sellers, products, orders, revenue, restaurants, foodOrders] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM users`),
    pool.query(`SELECT count(*)::int AS n FROM sellers WHERE status = 'approved'`),
    pool.query(`SELECT count(*)::int AS n FROM products WHERE status = 'approved'`),
    pool.query(`SELECT count(*)::int AS n FROM orders`),
    pool.query(`SELECT COALESCE(sum(total),0)::float AS n FROM orders WHERE payment_status = 'paid'`),
    pool.query(`SELECT count(*)::int AS n FROM restaurants WHERE status = 'approved'`),
    pool.query(`SELECT count(*)::int AS n FROM food_orders`),
  ]);
  res.json({
    totalUsers: users.rows[0].n,
    approvedSellers: sellers.rows[0].n,
    liveProducts: products.rows[0].n,
    totalOrders: orders.rows[0].n,
    paidRevenue: revenue.rows[0].n,
    approvedRestaurants: restaurants.rows[0].n,
    totalFoodOrders: foodOrders.rows[0].n,
  });
});

module.exports = router;
