require("dotenv").config();
const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const path = require("path");

const { applySecurity } = require("./middleware/security");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { initRealtime } = require("./realtime");

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

app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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
