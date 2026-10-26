-- 02_tracer_seed.sql — TRACER minimal seed. Exactly 5 customers and
-- 12 orders (7 completed / 3 pending / 2 cancelled), the dataset the
-- pnpm demo:tracer proof asserts against. 01-04 owns the full 12-table
-- Olist load; this slice seeds only what the demo needs.
-- PII below is fake (vi_VN-style fixtures), still redacted in traces/audit.

SET ROLE owner;

CREATE TABLE public.customers (
  id integer PRIMARY KEY,
  name text NOT NULL,
  phone text,
  email text,
  address text,
  region_group text NOT NULL
);

CREATE TABLE public.orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES public.customers (id),
  total numeric(10, 2) NOT NULL,
  status text NOT NULL,
  created_at timestamp NOT NULL
);

INSERT INTO public.customers (id, name, phone, email, address, region_group) VALUES
  (1, 'Nguyen Van An', '0901111111', 'an.nguyen@example.vn', 'Quan 1, TP Ho Chi Minh', 'Nam'),
  (2, 'Tran Thi Bich', '0902222222', 'bich.tran@example.vn', 'Quan Hoan Kiem, Ha Noi', 'Bac'),
  (3, 'Le Van Cuong', '0903333333', 'cuong.le@example.vn', 'Quan Hai Chau, Da Nang', 'Nam'),
  (4, 'Pham Thi Dung', '0904444444', 'dung.pham@example.vn', 'Quan Ba Dinh, Ha Noi', 'Bac'),
  (5, 'Hoang Van Em', '0905555555', 'em.hoang@example.vn', 'Quan Ninh Kieu, Can Tho', 'Nam');

INSERT INTO public.orders (id, customer_id, total, status, created_at) VALUES
  (1, 1, 250000.00, 'completed', '2025-06-01 10:00:00'),
  (2, 2, 175000.00, 'completed', '2025-06-03 11:30:00'),
  (3, 3, 320000.00, 'completed', '2025-06-05 09:15:00'),
  (4, 1, 99000.00, 'completed', '2025-06-08 14:45:00'),
  (5, 4, 410000.00, 'completed', '2025-06-10 16:00:00'),
  (6, 5, 135000.00, 'completed', '2025-06-12 08:20:00'),
  (7, 2, 275000.00, 'completed', '2025-06-14 13:10:00'),
  (8, 3, 188000.00, 'pending', '2025-06-16 10:05:00'),
  (9, 4, 220000.00, 'pending', '2025-06-18 15:40:00'),
  (10, 5, 96000.00, 'pending', '2025-06-20 09:55:00'),
  (11, 1, 305000.00, 'cancelled', '2025-06-22 12:25:00'),
  (12, 2, 142000.00, 'cancelled', '2025-06-24 17:35:00');

RESET ROLE;
