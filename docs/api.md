# Catalogue and orders API

This document covers the endpoints added for requirement 1 alongside the
authentication layer described in [auth.md](auth.md). Interactive documentation
is served by the running application at `http://localhost:3000/docs`
(OpenAPI/Swagger). Authorize once there with a Bearer token and the UI sends it
on every request.

Every endpoint below requires authentication. Roles are `CUSTOMER` (the
default) and `RESPONSIBLE`.

## Conventions

### Pagination

List endpoints accept `page` (minimum 1, default 1) and `limit` (1–100,
default 20) and return:

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0,
    "hasNextPage": false,
    "hasPreviousPage": false
  }
}
```

Filtering and paging are performed by the database, never in application
memory. Results are ordered by `created_at DESC, id DESC`; the id breaks ties so
the same row never appears on two pages.

### Errors

Every failure uses the same shape:

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Product with id 42 not found",
  "path": "/products/42",
  "timestamp": "2026-10-28T12:00:00.000Z"
}
```

`message` is an array when request validation produced several problems.
Unexpected errors are logged on the server and reported as a plain HTTP 500.

| Status | Meaning in this API                                                      |
| ------ | ------------------------------------------------------------------------ |
| 400    | Invalid body, query string or path parameter                             |
| 401    | Missing, expired or invalid access token                                 |
| 403    | Authenticated, but the role or the record owner forbids the operation    |
| 404    | The record, or a record referenced by the request, does not exist        |
| 409    | The request conflicts with the stored state (duplicate, or still in use) |
| 429    | Rate limit exceeded                                                      |

## Categories

| Method | Route             | Access      |
| ------ | ----------------- | ----------- |
| GET    | `/categories`     | Any user    |
| GET    | `/categories/:id` | Any user    |
| POST   | `/categories`     | RESPONSIBLE |
| PATCH  | `/categories/:id` | RESPONSIBLE |
| DELETE | `/categories/:id` | RESPONSIBLE |

Query parameters on `GET /categories`: `page`, `limit`, `isActive`.

`slug` is derived from `name` when it is not supplied (`Home & Kitchen` becomes
`home-kitchen`). A duplicate slug returns HTTP 409. Deleting a category that
still classifies products returns HTTP 409 rather than orphaning them.

```json
POST /categories
{ "name": "Phones", "description": "Smartphones and accessories" }
```

## Products

| Method | Route           | Access      |
| ------ | --------------- | ----------- |
| GET    | `/products`     | Any user    |
| GET    | `/products/:id` | Any user    |
| POST   | `/products`     | RESPONSIBLE |
| PATCH  | `/products/:id` | RESPONSIBLE |
| DELETE | `/products/:id` | RESPONSIBLE |

Query parameters on `GET /products`:

| Parameter    | Notes                                                           |
| ------------ | --------------------------------------------------------------- |
| `page`       | Default 1                                                        |
| `limit`      | Default 20, maximum 100                                          |
| `categoryId` | Filters by category; an unknown category returns HTTP 404        |
| `isActive`   | RESPONSIBLE only; customers always receive active products       |

A deactivated product is reported as HTTP 404 to a customer, so the catalogue
never reveals withdrawn items.

```json
POST /products
{
  "name": "Wireless Headphones",
  "description": "Over-ear, 30h battery",
  "price": 249.99,
  "categoryId": 1,
  "images": [
    { "imageUrl": "https://cdn.example.com/headphones-front.jpg", "isPrimary": true },
    { "imageUrl": "https://cdn.example.com/headphones-side.jpg", "sortOrder": 1 }
  ]
}
```

A product carries no stock quantity: inventory belongs to the warehouse service
of requirement 2, and storing it here as well would create two sources of truth.

Image rules: at most 10 images, `imageUrl` must be an `http(s)` URL, and at most
one image may be marked primary. When none is marked, the first becomes the
primary one. Sending `images` on `PATCH` replaces the whole set in a single
transaction.

`DELETE /products/:id` returns HTTP 409 once the product appears in an order,
because removing it would rewrite order history. Withdraw it from sale with
`PATCH /products/:id` and `{ "isActive": false }` instead.

## Orders

| Method | Route                 | Access                           |
| ------ | --------------------- | -------------------------------- |
| POST   | `/orders`             | Any user; the order is their own |
| GET    | `/orders`             | Own orders; RESPONSIBLE sees all |
| GET    | `/orders/:id`         | Order owner or RESPONSIBLE       |
| PATCH  | `/orders/:id/status`  | RESPONSIBLE                      |
| DELETE | `/orders/:id`         | RESPONSIBLE                      |

Query parameters on `GET /orders`: `page`, `limit`, `status`, and `userId`
(RESPONSIBLE only).

```json
POST /orders
{
  "items": [
    { "productId": 1, "quantity": 2 },
    { "productId": 4, "quantity": 1 }
  ]
}
```

The request carries product references and quantities only. The server reads
each price from the catalogue, copies it into `unit_price` on the order line and
sums the lines into `total_amount`, so a client cannot choose what it pays and a
later price change never rewrites a past order. The order header and its lines
are written in one transaction. An order starts as `PENDING`.

Rejections: a product that does not exist returns HTTP 404, a deactivated
product HTTP 400, the same product listed twice HTTP 400, and an empty `items`
array HTTP 400.

Order numbers look like `ORD-20261028-9F3K2Q`.

### Status transitions

```
PENDING ──▶ CONFIRMED ──▶ SHIPPED ──▶ DELIVERED
   │             │
   └─────────────┴──────▶ CANCELLED
```

`DELIVERED` and `CANCELLED` are final. Any other move returns HTTP 409. Only a
RESPONSIBLE user may change the status; a customer receives HTTP 403 even for
their own order.

## Ownership and access rules

Ownership exists at two levels, and both are enforced.

**In the database.** `orders.user_id` records who placed each order.
`order_items.order_id` is `ON DELETE CASCADE`, so lines never outlive their
order. `order_items.product_id` and `products.category_id` are
`ON DELETE RESTRICT`, so a product that has been ordered and a category that
still classifies products cannot be deleted. `product_images.product_id` is
`ON DELETE CASCADE`. A reference to a row that does not exist is rejected before
anything is written.

**In the application.** The rules live in
[`src/common/authorization/resource-ownership.ts`](../src/common/authorization/resource-ownership.ts)
rather than being repeated in each controller:

- `assertOwnership` guards reading a single record: a customer reading another
  customer's order receives HTTP 403.
- `resolveOwnerFilter` guards list endpoints: a customer's query is always
  narrowed to their own `user_id`, and asking for another `userId` is refused
  with HTTP 403 instead of silently returning their own orders.
- A RESPONSIBLE user passes both and may additionally narrow a list by
  `userId`.

The owner of a new order is always taken from the access token, never from the
request body.

### Checks to demonstrate

| Attempt                                                     | Result |
| ----------------------------------------------------------- | ------ |
| Customer A reads `GET /orders/<order of customer B>`         | 403    |
| Customer A calls `GET /orders?userId=<B>`                    | 403    |
| Customer calls `PATCH /orders/:id/status` on their own order | 403    |
| Customer calls `POST /products`                              | 403    |
| Any request without a Bearer token                           | 401    |
| `DELETE /products/:id` for a product inside an order         | 409    |
| `PATCH /orders/:id/status` from `PENDING` to `DELIVERED`     | 409    |
