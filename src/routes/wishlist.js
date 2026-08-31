const express = require("express");
const { param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.* FROM wishlist_items w JOIN products p ON p.id = w.product_id
     WHERE w.user_id = $1 ORDER BY w.created_at DESC`,
    [req.user.id]
  );
  res.json({ products: rows });
});

router.post("/:productId", requireAuth, [param("productId").isUUID()], handleValidation, async (req, res) => {
  await pool.query(
    `INSERT INTO wishlist_items (user_id, product_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [req.user.id, req.params.productId]
  );
  res.status(201).json({ ok: true });
});

router.delete("/:productId", requireAuth, [param("productId").isUUID()], handleValidation, async (req, res) => {
  await pool.query(`DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2`, [
    req.user.id,
    req.params.productId,
  ]);
  res.json({ ok: true });
});

module.exports = router;
