# REST Client requests

One `.http` file per controller, one request per endpoint — 21 requests covering
every route the API exposes. Open a file in VS Code and click **Send Request**
above any request.

| File | Controller | Requests |
| --- | --- | --- |
| [auth.http](auth.http) | `AuthController` — `/auth` | 3 |
| [users.http](users.http) | `UsersController` — `/users` | 3 |
| [categories.http](categories.http) | `CategoriesController` — `/categories` | 5 |
| [products.http](products.http) | `ProductsController` — `/products` | 5 |
| [orders.http](orders.http) | `OrdersController` — `/orders` | 5 |

Each request carries the headers, query parameters and body it needs, with the
validation rules and the required role written above it as comments. These are
the happy-path shapes; edit them freely to try error cases.

## Setup

Install the **REST Client** extension (`humao.rest-client`) in VS Code, then
start the API:

```bash
docker compose up --build
```

## Getting a token

Every file begins with two variables:

```
@baseUrl = http://localhost:3000
@token = PASTE_ACCESS_TOKEN_HERE
```

1. Open [auth.http](auth.http) and send **Register a new account** (or **Log in**).
2. Copy `accessToken` from the response.
3. Paste it into `@token` in whichever file you are using.

In `auth.http` you can skip the copying: after sending **Log in**, replace the
`@token` line with `@token = {{login.response.body.accessToken}}`.

A fresh account is always a `CUSTOMER`. To get a `RESPONSIBLE` token, promote
the account in the database and reuse the same token — roles are read from the
database on every request, so the change applies immediately without logging in
again:

```bash
docker compose exec postgres psql -U postgres -d internet_app \
  -c "UPDATE users SET role = 'RESPONSIBLE' WHERE email = 'example.user@example.com';"
```

## Notes

- `@baseUrl` assumes the API is on port 3000. Change it if you set `API_PORT`.
- Registration and login are rate limited to 5 requests per minute; everything
  else to 60. Exceeding the limit returns HTTP 429.
- Path and body ids (`@productId`, `@categoryId`, `@orderId`, `@userId`) default
  to `1`. Point them at rows that exist.
- Create a category before creating a product: a product cannot exist without one.
- Expected status codes and the error format are documented in
  [../docs/api.md](../docs/api.md).

Swagger UI at `http://localhost:3000/docs` covers the same endpoints
interactively; these files are the editable alternative.
