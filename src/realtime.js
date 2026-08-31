const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { pool } = require("./db/pool");

let io = null;

function initRealtime(httpServer, allowedOrigins) {
  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
  });

  // Every socket must present the same JWT access token used for API calls —
  // no anonymous sockets, so we always know who's connecting and as what role.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication required"));
      const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      socket.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      next(new Error("Invalid or expired session"));
    }
  });

  io.on("connection", (socket) => {
    // A customer tracking an order joins that order's room to receive
    // status/location pushes. Ownership is checked before allowing the join.
    socket.on("order:subscribe", async (foodOrderId) => {
      try {
        const { rows } = await pool.query(
          `SELECT id FROM food_orders WHERE id = $1 AND (buyer_id = $2 OR $3 IN ('admin','rider'))`,
          [foodOrderId, socket.user.id, socket.user.role]
        );
        if (rows.length) socket.join(`order:${foodOrderId}`);
      } catch (e) {
        console.error("order:subscribe error:", e.message);
      }
    });

    // Only the rider assigned to an order may broadcast location for it.
    socket.on("rider:location", async ({ foodOrderId, latitude, longitude }) => {
      if (socket.user.role !== "rider") return;
      try {
        const check = await pool.query(
          `SELECT id FROM food_orders WHERE id = $1 AND rider_id = $2 AND status IN ('claimed','picked_up')`,
          [foodOrderId, socket.user.id]
        );
        if (!check.rows.length) return;

        await pool.query(
          `INSERT INTO rider_locations (rider_id, latitude, longitude, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (rider_id) DO UPDATE SET latitude = $2, longitude = $3, updated_at = now()`,
          [socket.user.id, latitude, longitude]
        );

        io.to(`order:${foodOrderId}`).emit("rider:position", { foodOrderId, latitude, longitude });
      } catch (e) {
        console.error("rider:location error:", e.message);
      }
    });
  });

  return io;
}

// Called from the food-orders route whenever status changes, so every
// customer/rider/admin watching that order gets the update instantly.
function broadcastOrderStatus(foodOrderId, status) {
  if (!io) return;
  io.to(`order:${foodOrderId}`).emit("order:status", { foodOrderId, status });
}

module.exports = { initRealtime, broadcastOrderStatus };
