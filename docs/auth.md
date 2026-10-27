# Authentication

Authentication uses short-lived JWT access tokens sent in the Authorization
header. The default lifetime is 900 seconds (15 minutes). Log in again after
the token expires.

## Configuration

Use `.env.example` as a configuration reference. The local `.env` is ignored by
Git. Set `JWT_SECRET` to a cryptographically random value; the application refuses
to start when it is missing or shorter than 32 bytes.

Generate a value for a new environment with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

| Variable                 | Default / meaning                               |
| ------------------------ | ----------------------------------------------- |
| `JWT_SECRET`             | Required signing key, unique to the environment |
| `JWT_ACCESS_TTL_SECONDS` | `900`; accepted range: 60–3600 seconds          |
| `JWT_ISSUER`             | `ecommerce-api`                                 |
| `JWT_AUDIENCE`           | `ecommerce-client`                              |

Changing the signing key invalidates existing access tokens. Use HTTPS when
deploying the API. Keep tokens out of URLs and logs; the client sends them in the
Authorization header.

## Endpoints

| Method | Route            | Access                                  |
| ------ | ---------------- | --------------------------------------- |
| POST   | `/auth/register` | Public; creates a CUSTOMER account      |
| POST   | `/auth/login`    | Public                                  |
| GET    | `/auth/me`       | Authenticated user                      |
| GET    | `/users`         | RESPONSIBLE                             |
| GET    | `/users/:id`     | Account owner or RESPONSIBLE            |
| POST   | `/users`         | RESPONSIBLE; creates a CUSTOMER account |

Registration uses the existing `CreateUserDto`:

```json
{
  "name": "Example User",
  "email": "example.user@example.com",
  "gender": "MALE",
  "password": "ExamplePassword123!"
}
```

Login accepts:

```json
{
  "email": "example.user@example.com",
  "password": "ExamplePassword123!"
}
```

Both return `accessToken`, `tokenType: "Bearer"`, `expiresIn` (seconds), and the
public user fields. Registration returns HTTP 201; login returns HTTP 200. Send
the returned token on protected requests:

```http
GET /auth/me HTTP/1.1
Host: localhost:3000
Authorization: Bearer <accessToken>
```

The public registration endpoint rejects a supplied `role` field. Provision the
first RESPONSIBLE account explicitly in the local database using its actual
email, after registering that account:

```sql
UPDATE users SET role = 'RESPONSIBLE' WHERE email = 'your-admin@example.com';
```

## Request flow and security choices

- `ThrottlerGuard` limits requests per client IP and route: 60 per minute by
  default and 5 per minute for login and registration. Exceeding the limit
  returns HTTP 429. The storage is in process memory; multiple application
  replicas need a shared throttler storage. Configure trusted proxy addresses
  explicitly when deploying behind a proxy.
- `JwtAuthGuard` protects routes by default. Mark intentionally public routes
  with `@Public()`.
- JWT signing and verification pin HS256, issuer, and audience. Verification
  enforces expiry, maximum age, token use, and a valid subject.
- The JWT contains the user ID in `sub` and `tokenUse: "access"`, alongside its
  standard time/issuer/audience claims. Account details and roles are read from
  the database on protected requests, so role changes apply immediately and a
  deleted user's token is rejected.
- `RolesGuard` enforces `@Roles(...)`. Ownership checks protect individual user
  records separately from role checks.
- Login explicitly fetches the hidden bcrypt hash through UsersService. Other
  user lookups keep the hash excluded. Public responses use UserResponseDto.
- Incorrect passwords and unknown email addresses produce the same HTTP 401
  message. An unknown account also performs a bcrypt comparison against a dummy
  hash to reduce differences in password-check work.
- Authentication responses use `Cache-Control: no-store`. Helmet sets the
  application's security headers.

The original three sample users were inserted for email lookups before bcrypt
was added. Their generated passwords were not provided; register a new account
with a known password to try login.
