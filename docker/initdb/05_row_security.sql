-- 05_row_security.sql — engine row-level security for agent_ro (H-02 Layer 4).
--
-- Defense in depth under the gateway's AST row-scope policy: even a query that
-- bypassed sqlGuard/AccessPolicy only sees rows of its principal's region.
-- The MCP executor sets these per transaction (set_config(..., true)):
--   app.row_scope  region value ('Nam', 'Bắc', 'Trung'), or '*' when unscoped
--   app.role       principal role, for audit and future per-role policies
-- A connection that never sets app.row_scope sees no rows (fail closed).
--
-- Lineage mirrors policies/row_scope.yaml: orders follow the buyer's region;
-- order_items, payments and reviews follow their order; employees follow their
-- province. products, categories, channels and promotions are global lookups.
--
-- Policies use uncorrelated IN (SELECT ...) rather than a correlated EXISTS: the
-- planner hashes the subquery once instead of probing it per row (order_items
-- count under a region scope: ~0.4 s vs ~1 s, ~0.6 s vs ~4 s behind the gateway's
-- own row-scope predicate).
--
-- Table owner (the loader) bypasses RLS by default; no FORCE ROW LEVEL SECURITY.
-- Existing volumes: apply once with
--   docker exec -i <db> psql -U <superuser> -d chosen < docker/initdb/05_row_security.sql
-- (idempotent), or `pnpm db:reset` and reload data.

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.customers;
CREATE POLICY agent_ro_row_scope ON public.customers FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR region_group = current_setting('app.row_scope', true)
  );

ALTER TABLE public.sellers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.sellers;
CREATE POLICY agent_ro_row_scope ON public.sellers FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR region_group = current_setting('app.row_scope', true)
  );

ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.regions;
CREATE POLICY agent_ro_row_scope ON public.regions FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR region_group = current_setting('app.row_scope', true)
  );

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.orders;
CREATE POLICY agent_ro_row_scope ON public.orders FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR customer_id IN (
      SELECT c.customer_id FROM public.customers c
      WHERE c.region_group = current_setting('app.row_scope', true)
    )
  );

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.order_items;
CREATE POLICY agent_ro_row_scope ON public.order_items FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR order_id IN (
      SELECT o.order_id FROM public.orders o
      JOIN public.customers c ON c.customer_id = o.customer_id
      WHERE c.region_group = current_setting('app.row_scope', true)
    )
  );

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.payments;
CREATE POLICY agent_ro_row_scope ON public.payments FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR order_id IN (
      SELECT o.order_id FROM public.orders o
      JOIN public.customers c ON c.customer_id = o.customer_id
      WHERE c.region_group = current_setting('app.row_scope', true)
    )
  );

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.reviews;
CREATE POLICY agent_ro_row_scope ON public.reviews FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR order_id IN (
      SELECT o.order_id FROM public.orders o
      JOIN public.customers c ON c.customer_id = o.customer_id
      WHERE c.region_group = current_setting('app.row_scope', true)
    )
  );

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_ro_row_scope ON public.employees;
CREATE POLICY agent_ro_row_scope ON public.employees FOR SELECT TO agent_ro
  USING (
    current_setting('app.row_scope', true) = '*'
    OR province IN (
      SELECT r.province FROM public.regions r
      WHERE r.region_group = current_setting('app.row_scope', true)
    )
  );
