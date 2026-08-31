const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

router.post(
  "/",
  requireAuth,
  [
    body("product_id").isUUID(),
    body("order_id").isUUID(),
    body("rating").isInt({ min: 1, max: 5 }),
    body("text").optional().trim().isLength({ max: 1000 }).escape(),
  ],
  handleValidation,
  async (req, res) => {
    const { product_id, order_id, rating, text } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Verify this buyer actually received this product in a delivered order —
      // prevents fake/incentivized reviews from non-purchasers.
      const check = await client.query(
        `SELECT 1 FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.order_id = $1 AND oi.product_id = $2 AND o.buyer_id = $3 AND o.status = 'delivered'`,
        [order_id, product_id, req.user.id]
      );
      if (!check.rows.length) {
        throw Object.assign(new Error("You can only review products from your delivered orders."), { status: 403 });
      }

      const { rows } = await client.query(
        `INSERT INTO reviews (product_id, user_id, order_id, rating, text)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, user_id, order_id) DO UPDATE SET rating = $4, text = $5
         RETURNING *`,
        [product_id, req.user.id, order_id, rating, text || null]
      );

      const agg = await client.query(
        `SELECT avg(rating)::numeric(2,1) AS avg, count(*)::int AS n FROM reviews WHERE product_id = $1`,
        [product_id]
      );
      await client.query(`UPDATE products SET rating_avg = $1, rating_count = $2 WHERE id = $3`, [
        agg.rows[0].avg,
        agg.rows[0].n,
        product_id,
      ]);

      await client.query("COMMIT");
      res.status(201).json({ review: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      const status = err.status || 500;
      if (status === 500) console.error("review error:", err.message);
      res.status(status).json({ error: status === 500 ? "Could not submit review." : err.message });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
