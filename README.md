# Nwin Shoppers — Backend API

A real, working backend for the Nwin Shoppers marketplace (buy/sell/market — like Jumia/Jiji),
built to sit behind the `NwinShoppers.jsx` frontend you already have. This replaces the in-memory
mock data with a real PostgreSQL database, real accounts, and a real seller-approval workflow.

## Stack
- Node.js + Express
- PostgreSQL (via `pg`, parameterized queries throughout)
- JWT auth (short-lived access token + rotating httpOnly refresh cookie)
- bcrypt password hashing
- Helmet, rate limiting, input validation/sanitization, HPP protection

## 1. Setup

```bash
cd nwin-shoppers-backend
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — point this at a Postgres instance. For local dev, install Postgres and create
  a database (`createdb nwin_shoppers`). For production, use a hosted Postgres (Render, Railway,
  Supabase all have free/cheap tiers that work fine for a launch).
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — generate two different random strings:
  `openssl rand -base64 48`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your first admin login. **Change the password after first login.**

Then:

```bash
npm run migrate   # creates all tables
npm run seed       # creates your admin account
npm run dev         # starts the API on http://localhost:4000
```

Check it's alive: `curl http://localhost:4000/api/health`

## 2. How the pieces fit together

| Role | What they can do |
|---|---|
| **shopper** (default) | Browse, search, buy, review delivered orders, wishlist |
| **seller** | Apply via `/api/sellers/apply`, then (once approved) list products — each new/edited listing goes to `pending` until an admin approves it |
| **rider** | Update order status (`out_for_delivery`, `delivered`) |
| **admin** | Approve/reject sellers and products, view stats, everything else |

This mirrors what you already sketched in the frontend (the shopper/seller/rider/admin role
switcher) — the difference is these are now real accounts with real permissions enforced
server-side, not a UI toggle.

**The onboarding flow you asked about** ("go talk to guys with products so I can put it in"):
1. You (as admin) or the seller registers an account.
2. They call `POST /api/sellers/apply` with their business name.
3. You approve them in the admin panel (`PATCH /api/sellers/admin/:id/status`).
4. They (or you, on their behalf) add products via `POST /api/products` — each one queues for
   your approval before it's publicly visible.

You can absolutely add products on a seller's behalf while they're not tech-savvy — just do it
from an account with the `seller` or `admin` role.

## 3. New: email verification, Google Sign-In, Apple Sign-In

**Email verification (OTP)** — works out of the box for local testing even without email
configured: if `SMTP_HOST` is blank in `.env`, verification codes print straight to your
backend terminal instead of emailing. To actually send real emails, the easiest free option:
1. Use a Gmail account → Google Account → Security → 2-Step Verification → App Passwords → generate one.
2. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<your gmail>`, `SMTP_PASS=<app password>`.

**Google Sign-In** — free, no waiting period:
1. Go to https://console.cloud.google.com/apis/credentials
2. Create Credentials → OAuth Client ID → Web application.
3. Under "Authorized JavaScript origins" add your site's URL (e.g. `http://localhost:5173`, and
   later your real domain).
4. Copy the Client ID into `GOOGLE_CLIENT_ID` here in the backend `.env`, and also into
   `VITE_GOOGLE_CLIENT_ID` in the website's `.env`.

**Apple Sign-In** — the endpoint and verification logic are ready, but Apple requires:
1. An active Apple Developer Program membership ($99/year).
2. A registered Services ID and a domain association file hosted on your real domain.
Until you have that, the button stays visibly disabled on the site ("coming soon") rather than
pretending to work — worth doing once you're closer to launch, not before.

## 4. Security measures included

- **Passwords**: bcrypt, cost factor 12 — never stored or logged in plain text.
- **Sessions**: short-lived (15 min) JWT access tokens + a separate refresh token stored as an
  httpOnly, `Secure`, `SameSite=Strict` cookie. Refresh tokens are hashed before being stored in
  the DB, and can be revoked (logout, or if you ever suspect a leak).
- **SQL injection**: every query uses parameterized placeholders (`$1, $2...`) — user input is
  never concatenated into SQL strings.
- **Rate limiting**: global limit on all routes, a much stricter limit on login/register to blunt
  brute-force and credential-stuffing attempts.
- **Input validation**: every route validates and sanitizes its inputs with `express-validator`
  (type checks, length limits, HTML-escaping to prevent stored XSS).
- **Role-based access control**: middleware checks the caller's role on every protected route —
  a shopper account can never call seller/admin endpoints even if they guess the URL.
- **Ownership checks**: sellers can only edit their own products (enforced in the SQL `WHERE`
  clause, not just in the UI).
- **File uploads**: restricted to image MIME types, size-capped, filenames regenerated
  server-side (blocks path-traversal tricks).
- **HTTPS enforced** in production; CORS locked to your frontend's origin only.
- **No user enumeration**: login failures return the same generic error whether the email exists
  or not.
- **Audit log**: every seller/product approval or rejection is recorded with who did it and when.

## 5. What's realistic to expect from here

Being straight with you: a marketplace like Jumia/Jiji, done properly, is normally a team project
over months — what you have now is a solid, secure, working foundation you can actually launch
an MVP on, not the finished thing. Here's what's still ahead, roughly in the order I'd tackle it:

1. **Connect the frontend** — swap the mock arrays in `NwinShoppers.jsx` for real `fetch` calls to
   this API (I can do this next — it's a big but mechanical change).
2. **Image hosting** — right now uploaded images save to local disk, which most hosts wipe on
   redeploy. Move to Cloudinary (free tier is generous and easy) before you rely on it.
3. **Payments** — Cash on Delivery works out of the box with no setup. For mobile money (MTN
   MoMo / Airtel Money), the practical route for Uganda is an aggregator like **Flutterwave** or
   **Pesapal** — they handle both networks plus cards through one API. This is worth doing once
   you have real sellers and are ready to take live payments, not before.
4. **Hosting** — Render or Railway for the API + a managed Postgres add-on. Both have a workable
   free/cheap tier for a launch.
5. **Admin dashboard UI** — right now admin actions are API calls; a simple screen to
   approve/reject sellers and products at a glance will make your life much easier once you have
   more than a handful of sellers.

For getting sellers on board *right now*, you don't need payments or hosting finished — you can
run this locally, register sellers, and start listing their products today.

## 6. Project structure

```
nwin-shoppers-backend/
├── src/
│   ├── server.js            # app entry point
│   ├── db/
│   │   ├── schema.sql        # full Postgres schema
│   │   ├── migrate.js        # applies schema.sql
│   │   ├── seed.js           # creates first admin
│   │   └── pool.js           # DB connection pool
│   ├── middleware/
│   │   ├── security.js       # helmet, rate limits, CORS, HTTPS
│   │   ├── auth.js           # JWT verification, role gating
│   │   ├── upload.js         # secure image upload config
│   │   └── errorHandler.js
│   ├── routes/
│   │   ├── auth.js           # register/login/refresh/logout
│   │   ├── products.js       # browse/search/create/edit
│   │   ├── sellers.js        # apply/approve/directory
│   │   ├── orders.js         # place order, track, update status
│   │   ├── admin.js          # approval queues, stats
│   │   ├── reviews.js
│   │   ├── wishlist.js
│   │   └── uploads.js
│   └── utils/tokens.js
├── .env.example
└── package.json
```
