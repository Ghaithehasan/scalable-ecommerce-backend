# HTTP revalidation for GET /categories

## Files changed for this task

- `src/products/categories.controller.ts`: import Nest's `Header` decorator and apply `@Header('Cache-Control', 'private, no-cache')` to the existing list handler only.
- `test/categories-etag.e2e-spec.ts`: focused conditional GET tests using the real Nest/Express response path and real JWT/roles guards, with mocked users/category repositories.
- `docs/categories-etag.md`: behavior, validation results and local PowerShell instructions.

No service, DTO, adapter setting, Redis implementation, product/order endpoint, Inventory code, schema, migration or dependency was changed for this task.

## Existing framework functionality

Main uses the default Nest Express adapter. The installed Express version is 5.3.0; its default `etag` setting is already `weak`. Neither bootstrap nor the route disables this setting.

Express serializes the returned object to JSON, generates its ETag from that response body using its existing ETag function, then evaluates request freshness. No custom hashing/interceptor or global ETag configuration was added. Other endpoints' pre-existing Express behavior is unchanged.

The selected representation is the existing `PaginatedResponseDto<CategoryResponseDto>`:

```json
{
  "data": [
    {
      "id": 1,
      "name": "Phones",
      "slug": "phones",
      "description": null,
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPreviousPage": false
  }
}
```

Ordering remains `name ASC, id ASC`; `page`, `limit` and `isActive` are processed exactly as before. Body changes, including pagination metadata, affect the validator.

For a successful authenticated GET, a matching `If-None-Match` causes Express to send `304` while retaining ETag and Cache-Control, and removing the response body. Valid quoted weak/strong equivalents use weak comparison; lists of tags and `*` are supported by the existing implementation. A nonmatching validator returns `200` and the current body. Authentication/authorization and query validation run before the response is revalidated.

`private, no-cache` permits a client's private cache to store the response, but requires revalidation before reuse. A client receiving `304` should reuse its previously stored body. This is not Redis caching and does not eliminate the category database read: the service and JSON generation still run to compute the representation's current ETag.

## Representation-specific behavior and limitations

- Updating an item included in the selected page changes its JSON and ETag. Creation/deletion changes the ETag whenever returned data or filtered total changes.
- An update outside the selected page can legitimately leave the ETag unchanged if that page and metadata are identical. An excluded category need not invalidate a filtered representation.
- Restoring the exact original response may restore the original ETag; ETags are not global mutation counters.
- Existing Express behavior can force `200` if the client also sends request `Cache-Control: no-cache`. Do not add that request header when demonstrating the matching-validator `304` flow. The response's `Cache-Control: private, no-cache` is retained.
- This implementation relies on the current Express adapter and ETag setting. Disabling ETag generation or switching adapters requires revisiting these tests.
- The local tests do not cover Azure proxies, compression/CDN configuration, browser cache UX or concurrent database writes. No claim is made that ETags provide a database transaction snapshot or reduce SQL cost.

## Validation actually executed

```powershell
npm.cmd run test:e2e -- --runInBand categories-etag.e2e-spec.ts products.e2e-spec.ts
```

Result: **2 suites, 56 tests passed**. Coverage includes first `200`, original JSON contract/order, quoted weak ETag, matching weak/strong/list/wildcard conditions, empty `304`, retained headers, different tag `200`, successful update/create/delete changing the selected representation, page/filter-specific validators, actual JWT validation, anonymous/invalid JWT `401`, customer writes `403`, invalid queries `400`, and the list-only Cache-Control policy. Category writes in these tests use stateful mocked repositories.

```powershell
node.exe node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.build.json
```

Result: passed without diagnostics.

The Main image was rebuilt and the existing API container recreated locally without starting migration dependencies. A live PowerShell `System.Net.Http.HttpClient` check authenticated through the running API and observed:

| Request | Status | Body |
| --- | --- | --- |
| Initial list | 200 | Existing JSON; 3 categories in this local database |
| Matching weak validator | 304 | Empty |
| Strong equivalent of returned weak validator | 304 | Empty |
| Validator list containing returned tag | 304 | Empty |
| `If-None-Match: *` | 304 | Empty |
| Different validator | 200 | Existing JSON |
| Anonymous request with `If-None-Match: *` | 401 | Error response |

ETag and private/no-cache policy were present on successful `200` and `304` replies. .NET may display the policy as `no-cache, private`, which is equivalent to the wire policy `private, no-cache` asserted in the HTTP tests.

The live check performed **zero database writes**. Mutation-driven ETag changes were verified in the automated tests, not by modifying the live database. No migration, k6 test, Azure action, destructive cleanup or unrelated optimization was performed.

## Local rebuild and manual 200 -> 304 test

Run from the Inventory repository where `compose.local.yaml` lives. The existing PostgreSQL, Inventory and Redis services should already be running.

```powershell
Set-Location -LiteralPath "E:\The Last Year\First Semester\تطبيقات الانترنت\inventory-service"
```

Build the shared Main image and recreate only the API; building `main-migrate` does not execute it:

```powershell
docker compose -f compose.local.yaml build main-migrate
```

```powershell
docker compose -f compose.local.yaml up -d --no-deps --wait api
```

Authenticate using an existing demo RESPONSIBLE user and its current password:

```powershell
$demoPassword = [System.Net.NetworkCredential]::new('', (Read-Host 'Performance manager password' -AsSecureString)).Password; $session = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/auth/login' -ContentType 'application/json' -Body (@{ email = 'perf.v1.manager@example.com'; password = $demoPassword } | ConvertTo-Json); Remove-Variable demoPassword
```

Use HttpClient for conditional requests: Windows PowerShell 5's Invoke-WebRequest can throw on `304`, while HttpClient lets you inspect that status normally. Keeping the ETag as a .NET string also preserves its quotes through Windows command-line parsing.

```powershell
Add-Type -AssemblyName System.Net.Http; $http = [System.Net.Http.HttpClient]::new(); $http.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $session.accessToken); $categoriesUrl = 'http://localhost:3000/categories'
```

First response:

```powershell
$first = $http.GetAsync($categoriesUrl).GetAwaiter().GetResult(); $etag = $first.Headers.ETag.ToString(); [pscustomobject]@{ Status = [int]$first.StatusCode; ETag = $etag; CacheControl = $first.Headers.CacheControl.ToString(); Body = $first.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
```

Expected: `200`, a tag such as `W/"..."`, private/no-cache policy, and the normal JSON.

Second response, with the exact returned validator:

```powershell
$conditional = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $categoriesUrl); [void]$conditional.Headers.TryAddWithoutValidation('If-None-Match', $etag); $second = $http.SendAsync($conditional).GetAwaiter().GetResult(); [pscustomobject]@{ Status = [int]$second.StatusCode; ETag = $second.Headers.ETag.ToString(); CacheControl = $second.Headers.CacheControl.ToString(); BodyCharacters = $second.Content.ReadAsStringAsync().GetAwaiter().GetResult().Length }
```

Expected: `304`, same ETag, private/no-cache policy, `BodyCharacters=0`. Both calls still pass through JWT validation and the category query. A nonmatching condition such as `"different"` instead returns `200`.

## Safe manual category-change check

Create a uniquely named temporary category through the authorized API. This changes the list's total without modifying existing categories. Revalidate using the old ETag, then remove only the temporary category using the ID returned by POST. These commands intentionally write temporary demo data; they were **not** executed during the live read-only verification.

```powershell
$headers = @{ Authorization = "Bearer $($session.accessToken)" }; $createdCategory = $null
```

```powershell
try { $createdCategory = Invoke-RestMethod -Method Post -Uri $categoriesUrl -Headers $headers -ContentType 'application/json' -Body (@{ name = "ETag demo $([guid]::NewGuid().ToString('N'))" } | ConvertTo-Json); $changedRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $categoriesUrl); [void]$changedRequest.Headers.TryAddWithoutValidation('If-None-Match', $etag); $changed = $http.SendAsync($changedRequest).GetAwaiter().GetResult(); [pscustomobject]@{ Status = [int]$changed.StatusCode; PreviousETag = $etag; CurrentETag = $changed.Headers.ETag.ToString(); Body = $changed.Content.ReadAsStringAsync().GetAwaiter().GetResult() } } finally { if ($null -ne $createdCategory) { Invoke-RestMethod -Method Delete -Uri "$categoriesUrl/$($createdCategory.id)" -Headers $headers } }
```

Expected after POST: `200`, a different ETag and the incremented total. The newly created category has no products, so the normal category-delete restriction should allow cleanup. If cleanup fails, keep the returned ID and delete only that fixture later through the same API. Deleting it can restore the exact original representation and original ETag.

Dispose local HTTP resources after testing:

```powershell
$first.Dispose(); $second.Dispose(); $conditional.Dispose(); $http.Dispose()
```

References: [Express implementation of response ETag/freshness handling](https://github.com/expressjs/express/blob/master/lib/response.js), [RFC 9110 If-None-Match semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-none-match).
