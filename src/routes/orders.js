const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { computeDeliveryFee } = require("../utils/geo");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// ---------- Place an order ----------
// Runs inside a DB transaction so stock checks/decrements and order creation
// either all succeed or all roll back — no partial/oversold orders.
router.post(
  "/",
  requireAuth,
  [
    body("items").isArray({ min: 1 }),
    body("items.*.product_id").isUUID(),
    body("items.*.quantity").isInt({ min: 1 }),
    body("payment_method").isIn(["cod", "momo", "card"]),
    body("delivery_address").trim().isLength({ min: 5, max: 300 }).escape(),
    body("delivery_phone").trim().isMobilePhone("any"),
    body("coupon_code").optional({ checkFalsy: true }).trim().isLength({ max: 30 }).escape(),
    body("delivery_latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("delivery_longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  async (req, res) => {
    const { items, payment_method, delivery_address, delivery_phone, coupon_code, delivery_latitude, delivery_longitude } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let subtotal = 0;
      const lineItems = [];
      for (const item of items) {
        const { rows } = await client.query(
          `SELECT id, seller_id, price, stock, status FROM products WHERE id = $1 FOR UPDATE`,
          [item.product_id]
        );
        const product = rows[0];
        if (!product || product.status !== "approved") {
          throw Object.assign(new Error("One of the items is no longer available."), { status: 400 });
        }
        if (product.stock < item.quantity) {
          throw Object.assign(new Error(`Not enough stock for one of the items.`), { status: 400 });
        }
        subtotal += Number(product.price) * item.quantity;
        lineItems.push({ ...item, unit_price: product.price, seller_id: product.seller_id });
      }

      // Distance-based pricing only works cleanly when the whole order ships
      // from one seller — a mixed-seller cart falls back to the flat fee
      // rather than guessing how to combine multiple pickup points.
      const distinctSellers = [...new Set(lineItems.map((li) => li.seller_id))];
      let deliveryCalc = { fee: subtotal > 100000 ? 0 : Number(process.env.DELIVERY_FALLBACK_FEE || 5000), distanceKm: null, estimated: false };
      if (distinctSellers.length === 1) {
        const sellerGeo = await client.query("SELECT latitude, longitude FROM sellers WHERE id = $1", [distinctSellers[0]]);
        if (sellerGeo.rows.length) {
          deliveryCalc = computeDeliveryFee({
            originLat: sellerGeo.rows[0].latitude,
            originLng: sellerGeo.rows[0].longitude,
            destLat: delivery_latitude,
            destLng: delivery_longitude,
          });
          if (subtotal > 100000 && !deliveryCalc.estimated) deliveryCalc.fee = 0; // preserve the free-delivery-over-100k perk when we can't measure distance
        }
      }

      let discount = 0;
      if (coupon_code) {
        const { rows } = await client.query(
          `SELECT * FROM coupons WHERE code = $1 AND active = TRUE
             AND (expires_at IS NULL OR expires_at > now())
             AND (max_uses IS NULL OR uses < max_uses)`,
          [coupon_code]
        );
        if (rows.length) {
          const c = rows[0];
          discount = c.discount_pct ? (subtotal * c.discount_pct) / 100 : Number(c.discount_flat || 0);
          await client.query(`UPDATE coupons SET uses = uses + 1 WHERE code = $1`, [coupon_code]);
        }
      }

      const deliveryFee = deliveryCalc.fee;
      const total = Math.max(subtotal - discount, 0) + deliveryFee;

      const orderResult = await client.query(
        `INSERT INTO orders (buyer_id, payment_method, subtotal, delivery_fee, discount, total, delivery_address, delivery_phone, delivery_latitude, delivery_longitude, delivery_distance_km)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [req.user.id, payment_method, subtotal, deliveryFee, discount, total, delivery_address, delivery_phone, delivery_latitude || null, delivery_longitude || null, deliveryCalc.distanceKm]
      );
      const order = orderResult.rows[0];

      for (const li of lineItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, seller_id, quantity, unit_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [order.id, li.product_id, li.seller_id, li.quantity, li.unit_price]
        );
        await client.query(`UPDATE products SET stock = stock - $1 WHERE id = $2`, [li.quantity, li.product_id]);
      }

      // Award simple loyalty points: 1 point per 1000 UGX spent
      const pointsEarned = Math.floor(total / 1000);
      await client.query(`UPDATE users SET points = points + $1 WHERE id = $2`, [pointsEarned, req.user.id]);

      await client.query("COMMIT");
      res.status(201).json({ order, pointsEarned });
    } catch (err) {
      await client.query("ROLLBACK");
      const status = err.status || 500;
      if (status === 500) console.error("order error:", err.message);
      res.status(status).json({ error: status === 500 ? "Could not place order." : err.message });
    } finally {
      client.release();
    }
  }
);

// ---------- Estimate delivery fee before placing an order ----------
router.post(
  "/quote",
  requireAuth,
  [
    body("items").isArray({ min: 1 }),
    body("items.*.product_id").isUUID(),
    body("delivery_latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("delivery_longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { items, delivery_latitude, delivery_longitude } = req.body;
    const productIds = items.map((i) => i.product_id);
    const { rows } = await pool.query(
      `SELECT id, seller_id FROM products WHERE id = ANY($1::uuid[])`,
      [productIds]
    );
    const distinctSellers = [...new Set(rows.map((r) => r.seller_id))];
    if (distinctSellers.length !== 1) {
      return res.json({ fee: Number(process.env.DELIVERY_FALLBACK_FEE || 5000), distanceKm: null, estimated: false, note: "Flat fee — items from multiple sellers." });
    }
    const sellerGeo = await pool.query("SELECT latitude, longitude FROM sellers WHERE id = $1", [distinctSellers[0]]);
    const calc = computeDeliveryFee({
      originLat: sellerGeo.rows[0]?.latitude,
      originLng: sellerGeo.rows[0]?.longitude,
      destLat: delivery_latitude,
      destLng: delivery_longitude,
    });
    res.json(calc);
  })
);

// ---------- Buyer: list own orders ----------
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE buyer_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ orders: rows });
}));

// ---------- Buyer: single order with items ----------
router.get("/:id", requireAuth, [param("id").isUUID()], handleValidation, asyncHandler(async (req, res) => {
  const orderRes = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND (buyer_id = $2 OR $3 IN ('admin','rider'))`,
    [req.params.id, req.user.id, req.user.role]
  );
  if (!orderRes.rows.length) return res.status(404).json({ error: "Order not found." });

  const items = await pool.query(
    `SELECT oi.*, p.name, p.images FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
    [req.params.id]
  );
  res.json({ order: orderRes.rows[0], items: items.rows });
}));

// ---------- Seller/rider/admin: update order status ----------
router.patch(
  "/:id/status",
  requireAuth,
  requireRole("seller", "rider", "admin"),
  [param("id").isUUID(), body("status").isIn(["confirmed", "out_for_delivery", "delivered", "cancelled"])],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [req.body.status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found." });
    res.json({ order: rows[0] });
  })
);

module.exports = router;
