-- ============================================================
-- NWIN SHOPPERS — PostgreSQL schema
-- Run with: npm run migrate
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------- USERS ----------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(180) UNIQUE NOT NULL,
  phone         VARCHAR(30) UNIQUE,
  password_hash TEXT,
  role          VARCHAR(20) NOT NULL DEFAULT 'shopper'
                  CHECK (role IN ('shopper','seller','rider','admin')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  google_id     VARCHAR(80) UNIQUE,
  apple_id      VARCHAR(80) UNIQUE,
  points        INTEGER NOT NULL DEFAULT 0,
  referral_code VARCHAR(20) UNIQUE,
  referred_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time codes for email verification (and reusable later for password reset)
CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  purpose     VARCHAR(30) NOT NULL DEFAULT 'email_verify',
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_codes(user_id);

-- Safe to re-run on an existing database: adds the new auth columns without
-- touching anything already there.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(80) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id VARCHAR(80) UNIQUE;

-- Refresh tokens stored server-side so they can be revoked (logout / theft response)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ---------- SELLERS ----------
CREATE TABLE IF NOT EXISTS sellers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  business_name  VARCHAR(150) NOT NULL,
  description    TEXT,
  location       VARCHAR(150),
  made_in_nwin   BOOLEAN NOT NULL DEFAULT FALSE,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','suspended')),
  id_doc_url     TEXT,          -- optional KYC / national ID photo for verification
  reviewed_by    UUID REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- CATEGORIES ----------
CREATE TABLE IF NOT EXISTS categories (
  id    SERIAL PRIMARY KEY,
  slug  VARCHAR(60) UNIQUE NOT NULL,
  name  VARCHAR(100) NOT NULL,
  icon  VARCHAR(10)
);

-- ---------- PRODUCTS ----------
CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  category_id  INTEGER REFERENCES categories(id),
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  price        NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  was_price    NUMERIC(12,2) CHECK (was_price IS NULL OR was_price >= 0),
  stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  images       JSONB NOT NULL DEFAULT '[]',
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','disabled')),
  is_deal      BOOLEAN NOT NULL DEFAULT FALSE,
  is_special   BOOLEAN NOT NULL DEFAULT FALSE,
  rating_avg   NUMERIC(2,1) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (to_tsvector('english', name));

-- ---------- ORDERS ----------
CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          UUID NOT NULL REFERENCES users(id),
  status            VARCHAR(20) NOT NULL DEFAULT 'placed'
                      CHECK (status IN ('placed','confirmed','out_for_delivery','delivered','cancelled')),
  payment_method    VARCHAR(20) NOT NULL CHECK (payment_method IN ('cod','momo','card')),
  payment_status    VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (payment_status IN ('pending','paid','failed','refunded')),
  subtotal          NUMERIC(12,2) NOT NULL,
  delivery_fee      NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  total             NUMERIC(12,2) NOT NULL,
  delivery_address  TEXT NOT NULL,
  delivery_phone    VARCHAR(30) NOT NULL,
  rider_id          UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id),
  seller_id   UUID NOT NULL REFERENCES sellers(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_seller ON order_items(seller_id);

-- ---------- REVIEWS ----------
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  order_id    UUID REFERENCES orders(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id, order_id)
);

-- ---------- WISHLIST ----------
CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- ---------- COUPONS ----------
CREATE TABLE IF NOT EXISTS coupons (
  code            VARCHAR(30) PRIMARY KEY,
  discount_pct    SMALLINT CHECK (discount_pct BETWEEN 1 AND 100),
  discount_flat   NUMERIC(12,2),
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,
  uses            INTEGER NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- AUDIT LOG (security: who approved/rejected what) ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR(80) NOT NULL,
  target_type VARCHAR(40),
  target_id   UUID,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed base categories (safe to re-run)
INSERT INTO categories (slug, name, icon) VALUES
  ('electronics','Electronics','📱'),
  ('fashion','Fashion','👗'),
  ('home','Home & Living','🏠'),
  ('grocery','Grocery','🥦'),
  ('beauty','Beauty','💄'),
  ('phones','Phones & Tabs','☎️'),
  ('shoes','Shoes','👟'),
  ('baby','Baby Products','🍼'),
  ('auto','Auto & Motorcycles','🏍️'),
  ('building','Building Materials','🧱'),
  ('sports','Sports','⚽'),
  ('services','Services','🛠️')
ON CONFLICT (slug) DO NOTHING;

-- Demo coupons (safe to re-run) — feel free to change or add more via SQL
INSERT INTO coupons (code, discount_pct, active) VALUES
  ('NWIN10', 10, TRUE),
  ('WELCOME5', 5, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- FOOD DELIVERY (Nwin Plus)
-- ============================================================

-- ---------- RESTAURANTS ----------
-- Supports both admin-direct-add (owner_user_id NULL, status set straight
-- to 'approved') and self-service application (owner_user_id set, status
-- starts 'pending' like sellers) — same table, two onboarding paths.
CREATE TABLE IF NOT EXISTS restaurants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  name           VARCHAR(150) NOT NULL,
  description    TEXT,
  location       VARCHAR(150),
  cuisine_type   VARCHAR(80),
  phone          VARCHAR(30),
  image          TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','suspended')),
  is_open        BOOLEAN NOT NULL DEFAULT TRUE,
  avg_prep_minutes INTEGER NOT NULL DEFAULT 20,
  reviewed_by    UUID REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurants_status ON restaurants(status);

-- ---------- MENU ITEMS ----------
CREATE TABLE IF NOT EXISTS menu_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          VARCHAR(150) NOT NULL,
  description   TEXT,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  image         TEXT,
  category      VARCHAR(40) NOT NULL DEFAULT 'main'
                  CHECK (category IN ('starter','main','drink','dessert','other')),
  modifiers     JSONB NOT NULL DEFAULT '[]', -- e.g. [{"name":"Extra cheese","price_delta":2000}]
  available     BOOLEAN NOT NULL DEFAULT TRUE,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_status ON menu_items(status);

-- ---------- FOOD ORDERS ----------
CREATE TABLE IF NOT EXISTS food_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          UUID NOT NULL REFERENCES users(id),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id),
  rider_id          UUID REFERENCES users(id),
  status            VARCHAR(24) NOT NULL DEFAULT 'placed'
                       CHECK (status IN ('placed','confirmed','preparing','ready_for_pickup','claimed','picked_up','delivered','cancelled')),
  payment_method    VARCHAR(20) NOT NULL CHECK (payment_method IN ('cod','momo','card')),
  payment_status    VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (payment_status IN ('pending','paid','failed','refunded')),
  subtotal          NUMERIC(12,2) NOT NULL,
  delivery_fee      NUMERIC(12,2) NOT NULL DEFAULT 0,
  total             NUMERIC(12,2) NOT NULL,
  delivery_address  TEXT NOT NULL,
  delivery_phone    VARCHAR(30) NOT NULL,
  prep_minutes      INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_food_orders_buyer ON food_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_food_orders_restaurant ON food_orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_food_orders_status ON food_orders(status);

CREATE TABLE IF NOT EXISTS food_order_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  food_order_id  UUID NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  menu_item_id   UUID NOT NULL REFERENCES menu_items(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  unit_price     NUMERIC(12,2) NOT NULL,
  modifiers_selected JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_food_order_items_order ON food_order_items(food_order_id);

-- ---------- LIVE RIDER LOCATION ----------
-- One row per rider, overwritten on every location ping — we only need the
-- latest position, not a full history, to draw a moving dot on the map.
CREATE TABLE IF NOT EXISTS rider_locations (
  rider_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- DELIVERY DISTANCE PRICING (SafeBoda/Bolt-style) ----------
-- Origin coordinates (where the rider starts from) live on the seller and
-- restaurant records; destination coordinates are captured per-order from
-- the buyer's device GPS at checkout. Both are optional — orders still work
-- with the flat fallback fee if either side hasn't set coordinates yet.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_latitude DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_longitude DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(6,2);
ALTER TABLE food_orders ADD COLUMN IF NOT EXISTS delivery_latitude DOUBLE PRECISION;
ALTER TABLE food_orders ADD COLUMN IF NOT EXISTS delivery_longitude DOUBLE PRECISION;
ALTER TABLE food_orders ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(6,2);

-- Lets an admin invite someone to manage a restaurant they added directly,
-- by email, without needing that person's account to exist yet — whoever
-- logs in with this email later gets ownership access automatically.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS manager_email VARCHAR(180);
