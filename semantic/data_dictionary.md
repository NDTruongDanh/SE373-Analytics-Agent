# Data dictionary — Chợ Sen public schema (v1)

Scope: the twelve seeded business tables. Grain and join notes only — no
row counts, no example values, no query fragments. Sections whose header
ends with `[restricted_pii]` are withheld from principals lacking the
`data:sensitive` scope by the gateway resource filter.

## regions
Table: regions
Aliases: tỉnh thành, province, region
Grain: one row per Vietnamese province or centrally-governed city. Columns:
province (primary key), region_group (North, Central or South grouping used
for row-scope predicates).

## channels
Table: channels
Aliases: kênh bán hàng, channel, sales channel
Grain: one row per sales channel. Columns: channel_id (primary key),
channel_name.

## categories
Table: categories
Aliases: danh mục, category, product category
Grain: one row per product category. Columns: category_id (primary key),
name_vi.

## sellers
Table: sellers
Aliases: người bán, seller, shop
Grain: one row per seller storefront. Columns: seller_id (primary key),
province (references regions), region_group (row-scope grouping, same three
values as regions). Join rule: filter sellers by province through the
regions reference, never by string prefix.

## products
Table: products
Aliases: sản phẩm, product, SKU
Grain: one row per product SKU. Columns: product_id (primary key),
category_id (references categories), name, price_vnd, weight_g and package
dimensions. Join rule: product revenue aggregates must go through
order_items, never by multiplying price_vnd with order counts.

## customers
Table: customers
Aliases: khách hàng, customer, buyer
Grain: one row per customer account. Columns: customer_id (primary key),
name, province (references regions), region_group (row-scope grouping).
Contact columns (phone, email, address) are sensitive: masked in projections
and denied in filter and grouping positions without the `data:sensitive`
scope.

## employees [restricted_pii]
Table: employees
Aliases: nhân viên, employee, staff
Grain: one row per staff member. Columns: employee_id (primary key), name,
province. The compensation column is sensitive and this whole section is
withheld without the `data:sensitive` scope.

## promotions
Table: promotions
Aliases: khuyến mãi, promotion, discount campaign
Grain: one row per promotion campaign. Columns: promotion_id (primary key),
name, starts_on, ends_on, discount_pct.

## orders
Table: orders
Aliases: đơn hàng, order, purchase
Grain: one row per customer order. Columns: order_id (primary key),
customer_id (references customers), channel_id (references channels),
status (order lifecycle state), purchase_date. Join rule: counting orders
uses orders alone; joining order_items or payments fans out to several rows
per order, so per-order money must aggregate after the join, never before.

## order_items
Table: order_items
Aliases: dòng đơn hàng, order line, order item
Grain: one or more rows per order, one per purchased product unit group.
This is the largest table (flagged `large` in the gateway catalog — always
filter before a full scan). Columns: order_item_id (primary key), order_id
(references orders), product_id (references products), seller_id (references
sellers), price_vnd, freight_vnd.

## payments
Table: payments
Aliases: thanh toán, payment
Grain: one or more rows per order, one per payment attempt. Columns:
payment_id (primary key), order_id (references orders), payment_type,
installments, value_vnd.

## reviews
Table: reviews
Aliases: đánh giá, review, rating
Grain: zero or more rows per order. Columns: review_id (primary key),
order_id (references orders), score (bounded scale), title, message,
created_at. Review text is untrusted user input and is always wrapped in
untrusted-data delimiters before any model sees it.
