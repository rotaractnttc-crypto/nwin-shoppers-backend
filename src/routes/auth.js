const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { jwtVerify, createRemoteJWKSet } = require("jose");
const { pool } = require("../db/pool");
const { authLimiter } = require("../middleware/security");
const { requireAuth } = require("../middleware/auth");
const { generateOtp, hashOtp } = require("../utils/otp");
const { sendOtpEmail } = require("../utils/email");
const {
  signAccessToken,
  signRefreshToken,
  hashToken,
  refreshCookieOptions,
} = require("../utils/tokens");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

async function issueOtp(userId, email) {
  const code = generateOtp();
  await pool.query(
    `INSERT INTO otp_codes (user_id, code_hash, purpose, expires_at)
     VALUES ($1, $2, 'email_verify', now() + interval '15 minutes')`,
    [userId, hashOtp(code)]
  );
  await sendOtpEmail(email, code);
}

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
}

// ---------- REGISTER ----------
router.post(
  "/register",
  authLimiter,
  [
    body("name").trim().isLength({ min: 2, max: 120 }).escape(),
    body("email").trim().isEmail().normalizeEmail(),
    body("phone").optional({ checkFalsy: true }).trim().isMobilePhone("any"),
    // Strong password policy: min 8 chars, at least one letter and one number
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters.")
      .matches(/[A-Za-z]/)
      .withMessage("Password must include a letter.")
      .matches(/[0-9]/)
      .withMessage("Password must include a number."),
    body("role").optional().isIn(["shopper", "seller", "rider"]),
  ],
  handleValidation,
  async (req, res) => {
    const { name, email, phone, password, role } = req.body;
    try {
      const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length) {
        return res.status(409).json({ error: "An account with that email already exists." });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const referralCode = `NW${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

      const { rows } = await pool.query(
        `INSERT INTO users (name, email, phone, password_hash, role, referral_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, email, phone, role, points, referral_code, created_at`,
        [name, email, phone || null, passwordHash, role || "shopper", referralCode]
      );
      const user = rows[0];

      // If they registered as a seller, create a pending seller profile right away
      if (user.role === "seller") {
        await pool.query(
          `INSERT INTO sellers (user_id, business_name, status) VALUES ($1, $2, 'pending')`,
          [user.id, `${name}'s Store`]
        );
      }

      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [user.id, hashToken(refreshToken)]
      );

      issueOtp(user.id, user.email).catch((e) => console.error("otp email failed:", e.message));

      res.cookie("refreshToken", refreshToken, refreshCookieOptions());
      res.status(201).json({ user, accessToken, refreshToken, note: "Check your email for a 6-digit verification code." });
    } catch (err) {
      console.error("register error:", err.message);
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  }
);

// ---------- LOGIN ----------
router.post(
  "/login",
  authLimiter,
  [body("email").trim().isEmail().normalizeEmail(), body("password").notEmpty()],
  handleValidation,
  async (req, res) => {
    const { email, password } = req.body;
    try {
      const { rows } = await pool.query(
        `SELECT id, name, email, phone, role, password_hash, points, referral_code, is_active, email_verified
         FROM users WHERE email = $1`,
        [email]
      );
      // Deliberately generic error — never reveal whether the email exists (prevents user enumeration)
      const genericError = { error: "Invalid email or password." };
      if (!rows.length) return res.status(401).json(genericError);

      const user = rows[0];
      if (!user.is_active) return res.status(403).json({ error: "This account has been disabled." });
      if (!user.password_hash) {
        return res.status(400).json({ error: "This account uses Google or Apple sign-in. Use that instead." });
      }

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json(genericError);

      delete user.password_hash;
      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [user.id, hashToken(refreshToken)]
      );

      res.cookie("refreshToken", refreshToken, refreshCookieOptions());
      res.json({ user, accessToken, refreshToken });
    } catch (err) {
      console.error("login error:", err.message);
      res.status(500).json({ error: "Login failed. Please try again." });
    }
  }
);

// ---------- REFRESH ----------
// Web: reads the httpOnly refresh cookie automatically. Mobile apps don't
// have cookies, so they send the refresh token explicitly in the body
// instead — accept either, cookie takes priority if both are present.
router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) return res.status(401).json({ error: "No session found." });

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const tokenHash = hashToken(token);

    const { rows } = await pool.query(
      `SELECT rt.id, rt.revoked, u.id as user_id, u.role, u.is_active
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.user_id = $1 AND rt.token_hash = $2 AND rt.expires_at > now()`,
      [payload.sub, tokenHash]
    );
    const record = rows[0];
    if (!record || record.revoked || !record.is_active) {
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }

    const accessToken = signAccessToken({ id: record.user_id, role: record.role });
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: "Session expired. Please log in again." });
  }
});

// ---------- LOGOUT ----------
router.post("/logout", requireAuth, asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (token) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND token_hash = $2`,
      [req.user.id, hashToken(token)]
    );
  }
  res.clearCookie("refreshToken", { path: "/api/auth" });
  res.json({ ok: true });
}));

// ---------- CURRENT USER ----------
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, role, points, referral_code, email_verified, created_at FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found." });
  res.json({ user: rows[0] });
}));

// ---------- VERIFY EMAIL (OTP) ----------
router.post(
  "/verify-otp",
  authLimiter,
  [body("email").trim().isEmail().normalizeEmail(), body("code").trim().isLength({ min: 6, max: 6 })],
  handleValidation,
  async (req, res) => {
    const { email, code } = req.body;
    try {
      const userRes = await pool.query("SELECT id, email_verified FROM users WHERE email = $1", [email]);
      if (!userRes.rows.length) return res.status(400).json({ error: "Invalid code." });
      const user = userRes.rows[0];
      if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

      const otpRes = await pool.query(
        `SELECT id FROM otp_codes WHERE user_id = $1 AND purpose = 'email_verify'
           AND code_hash = $2 AND consumed = FALSE AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [user.id, hashOtp(code)]
      );
      if (!otpRes.rows.length) return res.status(400).json({ error: "Invalid or expired code." });

      await pool.query("UPDATE otp_codes SET consumed = TRUE WHERE id = $1", [otpRes.rows[0].id]);
      await pool.query("UPDATE users SET email_verified = TRUE WHERE id = $1", [user.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error("verify-otp error:", err.message);
      res.status(500).json({ error: "Could not verify code." });
    }
  }
);

// ---------- RESEND VERIFICATION CODE ----------
router.post(
  "/resend-otp",
  authLimiter,
  [body("email").trim().isEmail().normalizeEmail()],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query("SELECT id, email, email_verified FROM users WHERE email = $1", [req.body.email]);
    // Same response either way — don't reveal whether the email exists.
    if (rows.length && !rows[0].email_verified) {
      await issueOtp(rows[0].id, rows[0].email).catch((e) => console.error("otp email failed:", e.message));
    }
    res.json({ ok: true, note: "If that email exists and isn't verified yet, a new code was sent." });
  })
);

// ---------- GOOGLE SIGN-IN ----------
// Frontend gets an ID token from Google Identity Services and sends it here.
// We verify it against Google's servers — we never trust a token we didn't check.
router.post("/google", authLimiter, [body("idToken").notEmpty()], handleValidation, async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "Google Sign-In isn't configured on the server yet." });
  }
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: req.body.idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) return res.status(400).json({ error: "Google account has no email." });

    let userRes = await pool.query("SELECT * FROM users WHERE google_id = $1 OR email = $2", [payload.sub, payload.email]);
    let user;
    if (userRes.rows.length) {
      user = userRes.rows[0];
      if (!user.google_id) {
        await pool.query("UPDATE users SET google_id = $1, email_verified = TRUE WHERE id = $2", [payload.sub, user.id]);
      }
    } else {
      const referralCode = `NW${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const created = await pool.query(
        `INSERT INTO users (name, email, google_id, role, email_verified, referral_code)
         VALUES ($1, $2, $3, 'shopper', TRUE, $4) RETURNING *`,
        [payload.name || payload.email.split("@")[0], payload.email, payload.sub, referralCode]
      );
      user = created.rows[0];
    }

    delete user.password_hash;
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
      [user.id, hashToken(refreshToken)]
    );
    res.cookie("refreshToken", refreshToken, refreshCookieOptions());
    res.json({ user, accessToken, refreshToken });
  } catch (err) {
    console.error("google sign-in error:", err.message);
    res.status(401).json({ error: "Could not verify Google sign-in." });
  }
});

// ---------- APPLE SIGN-IN ----------
// Requires an active Apple Developer Program enrollment ($99/yr) plus a
// registered Services ID and domain association before it'll work end to
// end — see the backend README for setup. The verification logic itself is
// ready; APPLE_CLIENT_ID just needs to be set once you have that Services ID.
router.post("/apple", authLimiter, [body("identityToken").notEmpty()], handleValidation, async (req, res) => {
  if (!process.env.APPLE_CLIENT_ID) {
    return res.status(503).json({ error: "Sign in with Apple isn't configured yet." });
  }
  try {
    const { payload } = await jwtVerify(req.body.identityToken, appleJwks, {
      issuer: "https://appleid.apple.com",
      audience: process.env.APPLE_CLIENT_ID,
    });
    if (!payload.email) return res.status(400).json({ error: "Apple account has no email." });

    let userRes = await pool.query("SELECT * FROM users WHERE apple_id = $1 OR email = $2", [payload.sub, payload.email]);
    let user;
    if (userRes.rows.length) {
      user = userRes.rows[0];
      if (!user.apple_id) {
        await pool.query("UPDATE users SET apple_id = $1, email_verified = TRUE WHERE id = $2", [payload.sub, user.id]);
      }
    } else {
      const referralCode = `NW${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const created = await pool.query(
        `INSERT INTO users (name, email, apple_id, role, email_verified, referral_code)
         VALUES ($1, $2, $3, 'shopper', TRUE, $4) RETURNING *`,
        [req.body.name || payload.email.split("@")[0], payload.email, payload.sub, referralCode]
      );
      user = created.rows[0];
    }

    delete user.password_hash;
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
      [user.id, hashToken(refreshToken)]
    );
    res.cookie("refreshToken", refreshToken, refreshCookieOptions());
    res.json({ user, accessToken, refreshToken });
  } catch (err) {
    console.error("apple sign-in error:", err.message);
    res.status(401).json({ error: "Could not verify Apple sign-in." });
  }
});

module.exports = router;
