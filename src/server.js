require("dotenv").config();
const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const path = require("path");

const { applySecurity } = require("./middleware/security");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { initRealtime } = require("./realtime");
const { pool } = require("./db/pool");

const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const sellerRoutes = require("./routes/sellers");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const uploadRoutes = require("./routes/uploads");
const reviewRoutes = require("./routes/reviews");
const wishlistRoutes = require("./routes/wishlist");
const restaurantRoutes = require("./routes/restaurants");
const menuRoutes = require("./routes/menu");
const foodOrderRoutes = require("./routes/food-orders");

const app = express();

applySecurity(app);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Serve uploaded product images (swap for Cloudinary/S3 before production — see middleware/upload.js)
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// A process that's "up" but can't reach its database is not actually
// healthy — this checks both, so Render's health monitoring (and you,
// manually) can tell the difference between "server running" and
// "server actually able to serve requests."
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected", time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, database: "unreachable", error: err.message, time: new Date().toISOString() });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/sellers", sellerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/restaurants", restaurantRoutes);
app.use("/api/menu-items", menuRoutes);
app.use("/api/food-orders", foodOrderRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);
const allowedOrigins = (process.env.CLIENT_URL || "").split(",").map((s) => s.trim()).filter(Boolean);
initRealtime(server, allowedOrigins);

server.listen(PORT, () => {
  console.log(`🛒 Nwin Shoppers API running on port ${PORT} (${process.env.NODE_ENV || "development"})`);
});

// Defense in depth: every route is now wrapped in asyncHandler (see
// middleware/asyncHandler.js), so this should never fire from a route.
// It's here in case something outside Express's request cycle — a
// background timer, a library callback — ever throws unexpectedly. We log
// and keep running rather than let Node's default behavior kill the whole
// server over one bad promise.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server kept running):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server kept running):", err);
});
