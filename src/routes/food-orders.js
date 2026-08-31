const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { broadcastOrderStatus } = require("../realtime");
const { computeDeliveryFee } = require("../utils/geo");

const router = express.Router();

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// ---------- Place a food order ----------
router.post(
  "/",
  requireAuth,
  [
    body("restaurant_id").isUUID(),
    body("items").isArray({ min: 1 }),
    body("items.*.menu_item_id").isUUID(),
    body("items.*.quantity").isInt({ min: 1 }),
    body("payment_method").isIn(["cod", "momo", "card"]),
    body("delivery_address").trim().isLength({ min: 5, max: 300 }).escape(),
    body("delivery_phone").trim().isMobilePhone("any"),
    body("delivery_latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("delivery_longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  async (req, res) => {
    const { restaurant_id, items, payment_method, delivery_address, delivery_phone, delivery_latitude, delivery_longitude } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const restRes = await client.query(
        "SELECT id, is_open, avg_prep_minutes, latitude, longitude FROM restaurants WHERE id = $1 AND status = 'approved' FOR UPDATE",
        [restaurant_id]
      );
      if (!restRes.rows.length) throw Object.assign(new Error("Restaurant not found."), { status: 404 });
      if (!restRes.rows[0].is_open) throw Object.assign(new Error("This restaurant is currently closed."), { status: 400 });

      let subtotal = 0;
      const lineItems = [];
      for (const item of items) {
        const { rows } = await client.query(
          `SELECT id, price, available, status, modifiers FROM menu_items WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
          [item.menu_item_id, restaurant_id]
        );
        const menuItem = rows[0];
        if (!menuItem || menuItem.status !== "approved" || !menuItem.available) {
          throw Object.assign(new Error("One of the items is no longer available."), { status: 400 });
        }
        let unitPrice = Number(menuItem.price);
        const selected = item.modifiers_selected || [];
        for (const sel of selected) {
          const match = (menuItem.modifiers || []).find((m) => m.name === sel);
          if (match) unitPrice += Number(match.price_delta || 0);
        }
        subtotal += unitPrice * item.quantity;
        lineItems.push({ ...item, unit_price: unitPrice, modifiers_selected: selected });
      }

      const deliveryCalc = computeDeliveryFee({
        originLat: restRes.rows[0].latitude,
        originLng: restRes.rows[0].longitude,
        destLat: delivery_latitude,
        destLng: delivery_longitude,
      });
      const deliveryFee = deliveryCalc.fee;
      const total = subtotal + deliveryFee;

      const orderRes = await client.query(
        `INSERT INTO food_orders (buyer_id, restaurant_id, payment_method, subtotal, delivery_fee, total, delivery_address, delivery_phone, prep_minutes, delivery_latitude, delivery_longitude, delivery_distance_km)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [req.user.id, restaurant_id, payment_method, subtotal, deliveryFee, total, delivery_address, delivery_phone, restRes.rows[0].avg_prep_minutes, delivery_latitude || null, delivery_longitude || null, deliveryCalc.distanceKm]
      );
      const order = orderRes.rows[0];

      for (const li of lineItems) {
        await client.query(
          `INSERT INTO food_order_items (food_order_id, menu_item_id, quantity, unit_price, modifiers_selected)
           VALUES ($1, $2, $3, $4, $5)`,
          [order.id, li.menu_item_id, li.quantity, li.unit_price, JSON.stringify(li.modifiers_selected)]
        );
      }

      await client.query("COMMIT");
      res.status(201).json({ order, deliveryDistanceKm: deliveryCalc.distanceKm, estimated: deliveryCalc.estimated });
    } catch (err) {
      await client.query("ROLLBACK");
      const status = err.status || 500;
      if (status === 500) console.error("food order error:", err.message);
      res.status(status).json({ error: status === 500 ? "Could not place order." : err.message });
    } finally {
      client.release();
    }
  }
);

// ---------- Estimate delivery fee before placing a food order ----------
router.post(
  "/quote",
  requireAuth,
  [
    body("restaurant_id").isUUID(),
    body("delivery_latitude").optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body("delivery_longitude").optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  async (req, res) => {
    const { restaurant_id, delivery_latitude, delivery_longitude } = req.body;
    const { rows } = await pool.query("SELECT latitude, longitude FROM restaurants WHERE id = $1", [restaurant_id]);
    if (!rows.length) return res.status(404).json({ error: "Restaurant not found." });
    const calc = computeDeliveryFee({
      originLat: rows[0].latitude,
      originLng: rows[0].longitude,
      destLat: delivery_latitude,
      destLng: delivery_longitude,
    });
    res.json(calc);
  }
);

// ---------- Buyer: list own food orders ----------
router.get("/", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fo.*, r.name AS restaurant_name FROM food_orders fo
     JOIN restaurants r ON r.id = fo.restaurant_id WHERE fo.buyer_id = $1 ORDER BY fo.created_at DESC`,
    [req.user.id]
  );
  res.json({ orders: rows });
});

// ---------- Rider: orders ready for pickup, unclaimed ----------
router.get("/available", requireAuth, requireRole("rider", "admin"), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT fo.*, r.name AS restaurant_name, r.location AS restaurant_location
     FROM food_orders fo JOIN restaurants r ON r.id = fo.restaurant_id
     WHERE fo.status = 'ready_for_pickup' AND fo.rider_id IS NULL
     ORDER BY fo.created_at ASC`
  );
  res.json({ orders: rows });
});

// ---------- Rider: orders currently claimed by me ----------
router.get("/mine/claimed", requireAuth, requireRole("rider"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fo.*, r.name AS restaurant_name, r.location AS restaurant_location
     FROM food_orders fo JOIN restaurants r ON r.id = fo.restaurant_id
     WHERE fo.rider_id = $1 AND fo.status IN ('claimed','picked_up')
     ORDER BY fo.created_at ASC`,
    [req.user.id]
  );
  res.json({ orders: rows });
});

// ---------- Restaurant owner: incoming orders for my restaurant ----------
router.get("/restaurant/:restaurantId", requireAuth, [param("restaurantId").isUUID()], handleValidation, async (req, res) => {
  const owns = await pool.query(
    "SELECT 1 FROM restaurants WHERE id = $1 AND (owner_user_id = $2 OR $3 = 'admin')",
    [req.params.restaurantId, req.user.id, req.user.role]
  );
  if (!owns.rows.length) return res.status(403).json({ error: "Not your restaurant." });
  const { rows } = await pool.query(
    "SELECT * FROM food_orders WHERE restaurant_id = $1 ORDER BY created_at DESC",
    [req.params.restaurantId]
  );
  res.json({ orders: rows });
});

// ---------- One order + items + rider's last known position ----------
router.get("/:id", requireAuth, [param("id").isUUID()], handleValidation, async (req, res) => {
  const orderRes = await pool.query(
    `SELECT fo.*, r.name AS restaurant_name, r.location AS restaurant_location
     FROM food_orders fo JOIN restaurants r ON r.id = fo.restaurant_id
     WHERE fo.id = $1 AND (fo.buyer_id = $2 OR fo.rider_id = $2 OR $3 IN ('admin')
        OR EXISTS (SELECT 1 FROM restaurants WHERE id = fo.restaurant_id AND owner_user_id = $2))`,
    [req.params.id, req.user.id, req.user.role]
  );
  if (!orderRes.rows.length) return res.status(404).json({ error: "Order not found." });
  const order = orderRes.rows[0];

  const items = await pool.query(
    `SELECT foi.*, mi.name, mi.image FROM food_order_items foi
     JOIN menu_items mi ON mi.id = foi.menu_item_id WHERE foi.food_order_id = $1`,
    [req.params.id]
  );

  let riderLocation = null;
  if (order.rider_id) {
    const loc = await pool.query("SELECT latitude, longitude, updated_at FROM rider_locations WHERE rider_id = $1", [order.rider_id]);
    riderLocation = loc.rows[0] || null;
  }

  res.json({ order, items: items.rows, riderLocation });
});

// ---------- Restaurant owner/admin: confirm, prep, mark ready ----------
router.patch(
  "/:id/status",
  requireAuth,
  requireRole("seller", "admin", "shopper"), // ownership checked below; any authenticated restaurant owner
  [param("id").isUUID(), body("status").isIn(["confirmed", "preparing", "ready_for_pickup", "cancelled"])],
  handleValidation,
  async (req, res) => {
    const orderRes = await pool.query("SELECT restaurant_id FROM food_orders WHERE id = $1", [req.params.id]);
    if (!orderRes.rows.length) return res.status(404).json({ error: "Order not found." });

    if (req.user.role !== "admin") {
      const owns = await pool.query(
        "SELECT 1 FROM restaurants WHERE id = $1 AND owner_user_id = $2",
        [orderRes.rows[0].restaurant_id, req.user.id]
      );
      if (!owns.rows.length) return res.status(403).json({ error: "Not your restaurant's order." });
    }

    const { rows } = await pool.query(
      "UPDATE food_orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [req.body.status, req.params.id]
    );
    broadcastOrderStatus(req.params.id, req.body.status);
    res.json({ order: rows[0] });
  }
);

// ---------- Rider: claim an order (atomic — first rider to claim wins) ----------
router.post("/:id/claim", requireAuth, requireRole("rider"), [param("id").isUUID()], handleValidation, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE food_orders SET rider_id = $1, status = 'claimed', updated_at = now()
     WHERE id = $2 AND status = 'ready_for_pickup' AND rider_id IS NULL
     RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (!rows.length) {
    return res.status(409).json({ error: "This order was just claimed by another rider, or isn't ready yet." });
  }
  broadcastOrderStatus(req.params.id, "claimed");
  res.json({ order: rows[0] });
});

// ---------- Rider: mark picked up / delivered ----------
router.patch(
  "/:id/rider-status",
  requireAuth,
  requireRole("rider"),
  [param("id").isUUID(), body("status").isIn(["picked_up", "delivered"])],
  handleValidation,
  async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE food_orders SET status = $1, updated_at = now() WHERE id = $2 AND rider_id = $3 RETURNING *`,
      [req.body.status, req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
    broadcastOrderStatus(req.params.id, req.body.status);
    res.json({ order: rows[0] });
  }
);

module.exports = router;
