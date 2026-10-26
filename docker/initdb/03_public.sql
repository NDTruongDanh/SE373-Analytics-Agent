-- 03_public.sql — D-08 business DDL (ported from v1 03_business.sql with
-- s/business/public/ throughout, per D-08): the same 12 FK-linked
-- "Cho Sen" tables. Versioned and reviewable here; the loader in
-- packages/data (01-07) only loads data and never writes schema. Runs after
-- 01_roles.sql / 02_schemas.sql, so the ALTER DEFAULT PRIVILEGES set there
-- already cover these tables.
--
-- Conventions: TEXT ids (Olist ids are hex strings), INT for VND amounts,
-- TIMESTAMPTZ for event dates. PII columns (customers.phone/email/address,
-- employees.salary) match policies/sensitive_columns.yaml.
-- Data-free: no INSERTs — the 01-01 tracer seed rows are superseded and the
-- 01-07 loader owns all data.

SET ROLE owner;
SET search_path TO public;

CREATE TABLE regions (
  province TEXT PRIMARY KEY,
  region_group TEXT NOT NULL CHECK (region_group IN ('Bắc', 'Trung', 'Nam'))
);

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL UNIQUE
);

CREATE TABLE categories (
  category_id TEXT PRIMARY KEY,
  name_vi TEXT NOT NULL UNIQUE
);

CREATE TABLE sellers (
  seller_id TEXT PRIMARY KEY,
  province TEXT REFERENCES regions (province),
  region_group TEXT NOT NULL CHECK (region_group IN ('Bắc', 'Trung', 'Nam'))
);
CREATE INDEX sellers_province_idx ON sellers (province);

CREATE TABLE products (
  product_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories (category_id),
  name TEXT NOT NULL,
  price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
  weight_g INTEGER,
  length_cm INTEGER,
  height_cm INTEGER,
  width_cm INTEGER
);
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE customers (
  customer_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  province TEXT REFERENCES regions (province),
  region_group TEXT NOT NULL CHECK (region_group IN ('Bắc', 'Trung', 'Nam'))
);
CREATE INDEX customers_province_idx ON customers (province);

CREATE TABLE employees (
  employee_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  salary INTEGER NOT NULL CHECK (salary >= 0),
  province TEXT REFERENCES regions (province)
);
CREATE INDEX employees_province_idx ON employees (province);

CREATE TABLE promotions (
  promotion_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL CHECK (ends_on >= starts_on),
  discount_pct INTEGER NOT NULL CHECK (discount_pct >= 0 AND discount_pct <= 100)
);

CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (customer_id),
  channel_id TEXT NOT NULL REFERENCES channels (channel_id),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'shipped', 'canceled', 'returned')),
  purchase_date TIMESTAMPTZ NOT NULL
);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX orders_channel_idx ON orders (channel_id);
CREATE INDEX orders_purchase_date_idx ON orders (purchase_date);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
  order_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (order_id),
  product_id TEXT NOT NULL REFERENCES products (product_id),
  seller_id TEXT NOT NULL REFERENCES sellers (seller_id),
  price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
  freight_vnd INTEGER NOT NULL CHECK (freight_vnd >= 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);
CREATE INDEX order_items_seller_idx ON order_items (seller_id);

-- Fan-out trap (UC-02/UC-06): several rows per order are normal.
CREATE TABLE payments (
  payment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (order_id),
  payment_type TEXT NOT NULL,
  installments INTEGER NOT NULL CHECK (installments >= 1),
  value_vnd INTEGER NOT NULL CHECK (value_vnd >= 0)
);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (order_id),
  score INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX reviews_order_idx ON reviews (order_id);

RESET ROLE;

-- Explicit grant for the tables just created (belt and braces alongside the
-- ALTER DEFAULT PRIVILEGES in 02_schemas.sql). agent_ro only — indexer
-- holds zero rights on public by D-08.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_ro;
