const jwt = require("jsonwebtoken");
const crypto = require("crypto");

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES || "15m",
  });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES || "30d",
  });
}

// We never store the raw refresh token in the DB — only its hash, so a DB
// leak alone can't be used to forge sessions.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function refreshCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    // Render serves the website and backend on different subdomains of
    // onrender.com, which browsers treat as separate "sites" (onrender.com
    // is on the public suffix list). A Strict or Lax cookie is silently
    // dropped on those cross-site requests, which is what was causing
    // people to get logged out every ~15 minutes once the short-lived
    // access token expired and the refresh cookie never arrived. SameSite
    // "none" is required for cross-site cookies and is safe here because
    // it's paired with Secure (HTTPS-only) and httpOnly. Locally, both run
    // on localhost (same site), so "lax" is fine and slightly safer.
    sameSite: isProd ? "none" : "lax",
    path: "/api/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };
}

module.exports = { signAccessToken, signRefreshToken, hashToken, refreshCookieOptions };
