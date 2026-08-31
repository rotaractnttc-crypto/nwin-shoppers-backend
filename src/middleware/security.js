const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const hpp = require("hpp");
const mongoSanitize = require("express-mongo-sanitize");

// ---- CORS: only your own frontend origins may call this API ----
function corsMiddleware() {
  const allowed = (process.env.CLIENT_URL || "").split(",").map((s) => s.trim()).filter(Boolean);
  return cors({
    origin(origin, cb) {
      // allow same-origin / server-to-server (no Origin header) and whitelisted origins
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  });
}

// ---- General API rate limit (blunt brute-force / scraping / DoS attempts) ----
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.GLOBAL_RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

// ---- Stricter limit on auth endpoints (login/register/password reset) ----
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 8),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait 15 minutes before trying again." },
});

// ---- Force HTTPS in production (behind a proxy like Render/Railway/NGINX) ----
function enforceHttps(req, res, next) {
  if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
}

function applySecurity(app) {
  app.set("trust proxy", 1); // needed for correct client IPs / secure cookies behind a proxy
  app.use(enforceHttps);
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === "production" ? undefined : false,
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );
  app.use(corsMiddleware());
  app.use(hpp()); // strips duplicate/polluted query params (e.g. ?price=1&price=DROP...)
  app.use(mongoSanitize()); // strips $ / . operator-injection attempts from bodies & query
  app.use(globalLimiter);
}

module.exports = { applySecurity, authLimiter };
