# OCRWell API — full reference

This file extends `SKILL.md` with the full per-endpoint detail, every documented response shape, the complete JSON Schema subset rules, and the full webhook payload catalogue. Read `SKILL.md` first for the high-level workflow and code-generation checklist.

## Host

`https://api.ocrwell.com/v1`

HTTPS only. All responses are JSON. Timestamps are ISO 8601 in UTC, e.g. `2026-03-23T02:15:00Z`.

## Authentication

```
X-API-Key: <key>
```

The server SHA-256-hashes the key and looks the hash up in DynamoDB. Invalid, missing, or disabled keys return `401 unauthorized`. Keys can be disabled in the dashboard without being deleted; a disabled key behaves identically to a missing one. There is no key expiry — rotation is manual (create a new key, swap, delete the old).

## Common response envelope

Every response includes `request_id` (UUID v7). Successful responses also include the resource(s); error responses include an `error` object.

Error shape:
```json
{
  "error": {
    "code": "validation_error",
    "message": "Human-readable explanation",
    "details": [
      {"field": "schema", "reason": "too large"}
    ]
  },
  "request_id": "..."
}
```

`error.code` is the stable contract. `error.message` is human-readable and may change. `error.details` is optional and only present for field-level validation failures.

### Full error catalogue

| HTTP | `error.code` | When |
|------|--------------|------|
| 400 | `bad_request` | Malformed JSON body, missing `Content-Type`, or other shape issues |
| 400 | `validation_error` | A field failed validation (see `details`) |
| 400 | `unsupported_format` | Filename extension is not in the supported list |
| 401 | `unauthorized` | Missing, invalid, or disabled API key |
| 404 | `not_found` | The job/webhook/etc. does not exist or belongs to another organisation |
| 409 | `duplicate_request` | `Idempotency-Key` reused with a different request body |
| 410 | `result_expired` | The job result was deleted after the 5-minute retention window |
| 413 | `file_too_large` | The uploaded file exceeds the 20 MB cap |
| 422 | `invalid_schema` | Structured-mode `schema` is not valid JSON, has a disallowed shape, or exceeds 64 KB |
| 429 | `rate_limited` | Per-org rate limit exceeded — see `Retry-After` |
| 500 | `internal_error` | Unexpected server error — safe to retry with backoff |
| 503 | `service_unavailable` | Temporary capacity issue — safe to retry |

## Rate limiting

Per-org, fixed 1-minute window. Headers on every response:

```
X-RateLimit-Limit:     <requests permitted in the window for this category>
X-RateLimit-Remaining: <requests remaining in the current window>
X-RateLimit-Reset:     <unix timestamp seconds when the window resets>
```

Polling endpoints (`GET /v1/jobs/...`, `GET /v1/webhooks`) get a 3× multiplier on the base limit, so polling traffic does not crowd out submissions.

When exceeded, the response is `429` with body `{"error": {"code": "rate_limited", ...}}` and a `Retry-After: <seconds>` header. Always honour `Retry-After` exactly — the server may extend the window during incidents.

## Idempotency

`POST /v1/documents` accepts an optional `Idempotency-Key` header (string, ≤ 64 characters). The server hashes the request body and stores it alongside the key for 24 hours, scoped to the organisation.

- Same key + same body → original response is returned (same `job.id`).
- Same key + different body → `409 duplicate_request`.
- Different orgs may use the same key independently without collision.

## Endpoint detail

### `GET /v1/health`

No authentication. Always returns `200 OK` with body:

```json
{ "status": "ok" }
```

Useful as a liveness probe; it bypasses auth and rate limiting.

---

### `POST /v1/uploads`

Generate a presigned URL for direct file upload to OCRWell's storage.

**Request:**
```json
{ "filename": "invoice.pdf" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `filename` | string | yes | Must end in a supported extension |

**Response (`200`):**
```json
{
  "upload_id": "019539a6-6c3d-7e5f-a1b2-4d6e8f0a2c3e",
  "upload_url": "https://api.ocrwell.com/uploads/<org>/<upload_id>?...",
  "expires_in": 900,
  "request_id": "..."
}
```

`upload_url` is valid for 15 minutes. The subsequent `PUT` does not include `X-API-Key` (it's authenticated by the presigned URL signature).

**Content-Type mapping for the `PUT`:**

| Extension | Content-Type |
|-----------|--------------|
| `.pdf` | `application/pdf` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.png` | `image/png` |
| `.tiff`, `.tif` | `image/tiff` |
| `.webp` | `image/webp` |
| `.bmp` | `image/bmp` |

Using a mismatched content type causes the file to be stored but rejected at processing time.

**Error responses:**
- `400 bad_request` — malformed JSON
- `400 validation_error` — empty filename
- `400 unsupported_format` — extension not recognised
- `401 unauthorized` — missing/invalid key
- `429 rate_limited` — limit exceeded

---

### `POST /v1/documents`

Submit an uploaded file for processing. Always asynchronous.

**Request:**
```json
{
  "upload_id": "019539a6-6c3d-7e5f-a1b2-4d6e8f0a2c3e",
  "filename": "invoice.pdf",
  "mode": "text",
  "schema": { ... }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `upload_id` | string | yes | From the prior `POST /v1/uploads` |
| `filename` | string | yes | Must match the filename used at upload time |
| `mode` | string | yes | `"text"` or `"structured"` |
| `schema` | object | required when `mode == "structured"` | Template or JSON Schema (see below) |

**Optional headers:**
- `Idempotency-Key: <string ≤ 64 chars>`

**Response (`202 Accepted`):**
```json
{
  "job": {
    "id": "019539a6-6c3d-7e5f-a1b2-4d6e8f0a2c3e",
    "status": "pending",
    "mode": "text",
    "created_at": "2026-03-23T02:15:00Z"
  },
  "request_id": "..."
}
```

**Error responses:**
- `400 bad_request` — malformed JSON
- `400 validation_error` — missing/invalid fields
- `400 unsupported_format` — unsupported file format
- `409 duplicate_request` — idempotency key reused with different body
- `413 file_too_large` — uploaded file exceeds 20 MB
- `422 invalid_schema` — structured-mode schema invalid or > 64 KB
- `429 rate_limited` — limit exceeded

---

### `GET /v1/jobs/{jobId}`

Polling endpoint. **Returns `200` whenever the job exists, regardless of processing outcome** — `job.status` carries the result.

Possible statuses: `pending`, `processing`, `completed`, `failed`.

**Response — pending or processing:**
```json
{
  "job": {
    "id": "...",
    "status": "processing",
    "mode": "text",
    "created_at": "2026-03-23T02:15:00Z"
  },
  "request_id": "..."
}
```

**Response — completed, `mode: "text"`:**
```json
{
  "job": {
    "id": "...",
    "status": "completed",
    "mode": "text",
    "page_count": 3,
    "created_at": "2026-03-23T02:15:00Z",
    "completed_at": "2026-03-23T02:15:04Z"
  },
  "result": {
    "pages": [
      { "page": 1, "text": "INVOICE\n\nInvoice Number: INV-2026-0042..." },
      { "page": 2, "text": "Description          Qty   Unit Price..." },
      { "page": 3, "text": "Subtotal: $450.00\nGST (10%): $45.00..." }
    ]
  },
  "request_id": "..."
}
```

`pages` is always one entry per source page in document order. `page` is 1-indexed.

**Response — completed, `mode: "structured"`:**
```json
{
  "job": {
    "id": "...",
    "status": "completed",
    "mode": "structured",
    "page_count": 1,
    "created_at": "2026-03-23T02:16:00Z",
    "completed_at": "2026-03-23T02:16:02Z"
  },
  "result": {
    "data": {
      "id_number": "D1234567",
      "last_name": "Smith",
      "first_name": "Jane",
      "date_of_birth": "1990-05-14",
      "address": {
        "street": "742 Evergreen Terrace",
        "city": "Springfield",
        "state": "OR",
        "zip_code": "97403"
      }
    }
  },
  "request_id": "..."
}
```

`result.data` matches the shape of the submitted schema.

**Response — failed:**
```json
{
  "job": {
    "id": "...",
    "status": "failed",
    "mode": "text",
    "created_at": "2026-03-23T02:15:00Z",
    "failed_at": "2026-03-23T02:15:06Z",
    "failure_reason": "Document could not be read. The file may be corrupt or password-protected."
  },
  "request_id": "..."
}
```

**Response — `410 Gone` (result expired):**
```json
{
  "error": {
    "code": "result_expired",
    "message": "The result for this job has expired and is no longer available."
  },
  "request_id": "..."
}
```

A `404 not_found` is returned for unknown job IDs **and** for jobs owned by a different organisation — there is no information leak between orgs.

**Polling guidance:** start at ~500ms, double up to a 5-second cap. Polling counts at 3× the base rate-limit allowance, so realistic budgets are generous, but unbounded tight loops will still trigger `429`.

---

### `PUT /v1/webhooks`

Create or replace the organisation's webhook configuration. Each org has at most one webhook.

**Request:**
```json
{ "url": "https://example.com/ocr-callback" }
```

The URL must use HTTPS.

**Response (`200`):**
```json
{
  "webhook": {
    "url": "https://example.com/ocr-callback",
    "secret": "whsec_a1b2c3d4e5f6g7h8i9j0...",
    "created_at": "2026-03-23T03:00:00Z",
    "updated_at": "2026-03-23T03:00:00Z"
  },
  "request_id": "..."
}
```

`secret` is **only present in the response to `PUT`** and is never returned again. Persist it immediately. To rotate the secret, send another `PUT` (the URL can be the same).

---

### `GET /v1/webhooks`

Returns the current webhook configuration without the secret.

**Configured:**
```json
{
  "webhook": {
    "url": "https://example.com/ocr-callback",
    "created_at": "2026-03-20T10:00:00Z",
    "updated_at": "2026-03-22T14:30:00Z"
  },
  "request_id": "..."
}
```

**Not configured:**
```json
{ "webhook": null, "request_id": "..." }
```

---

### `DELETE /v1/webhooks`

Removes the webhook. After deletion, no further callbacks are sent for completing jobs. Returns `204 No Content` with no response body.

## Webhook callbacks

When a job reaches `completed` or `failed` and the org has a webhook configured, OCRWell POSTs to the URL. Delivery is best-effort.

### Headers

```
X-Ocrwell-Signature: sha256=<hex digest>
X-Ocrwell-Timestamp: <unix timestamp seconds>
X-Ocrwell-Event: job.completed | job.failed
Content-Type: application/json
```

### Body — `job.completed`

```json
{
  "event": "job.completed",
  "job": {
    "id": "019539a6-6c3d-7e5f-a1b2-4d6e8f0a2c3e",
    "status": "completed",
    "mode": "text",
    "page_count": 3,
    "created_at": "2026-03-23T02:15:00Z",
    "completed_at": "2026-03-23T02:15:04Z"
  }
}
```

### Body — `job.failed`

```json
{
  "event": "job.failed",
  "job": {
    "id": "019539a6-6c3d-7e5f-a1b2-4d6e8f0a2c3e",
    "status": "failed",
    "mode": "text",
    "created_at": "2026-03-23T02:15:00Z",
    "failed_at": "2026-03-23T02:15:06Z",
    "failure_reason": "Document could not be read..."
  }
}
```

The webhook body **does not include the OCR result**. Receivers must call `GET /v1/jobs/{jobId}` to fetch `result.pages` (text mode) or `result.data` (structured mode), within the 5-minute retention window after first retrieval.

### Signature verification

1. Read `X-Ocrwell-Timestamp`.
2. Reject if it is more than 5 minutes from current server time (replay protection).
3. Construct the signed payload as `{timestamp}.{raw_body}` — concatenate the timestamp string, a literal `.`, and the **raw request body bytes** (do not re-serialise parsed JSON; whitespace and field order matter).
4. Compute `HMAC-SHA256(webhook_secret, payload)` and hex-encode the result.
5. Constant-time compare against the value after `sha256=` in `X-Ocrwell-Signature`.
6. On mismatch, respond `401` and abort.

### Retry policy

- A non-2xx response or a >10 second timeout triggers a retry.
- Retries are scheduled at 30s, 120s, then 480s after the previous attempt (3 retries max).
- After all retries are exhausted, the delivery is abandoned. The job result remains available via the API until it expires.

### Idempotency at the receiver

Because retries are possible, your webhook handler should be idempotent on `job.id`. Treat duplicate deliveries of the same event as a no-op.

## Structured-extraction schemas

When `mode: "structured"`, the `schema` field defines the output shape. Two formats are accepted; the server detects which.

### Detection

The submission is treated as a JSON Schema when the root object contains any of:
- `$schema`
- `$defs`
- `definitions`
- `$ref`
- both `type: "object"` and a `properties` object

Otherwise it is treated as a template. Field names starting with `$` and the literal key `definitions` are reserved at the root and may not appear in template-format schemas.

### Template format

A partially-filled example of the desired output. Sentinel values at the leaves indicate the type:

| Sentinel | Output type |
|----------|-------------|
| `""` | String |
| `0` | Number |
| `true` or `false` | Boolean |

Nested objects are fine. Arrays must contain **exactly one** element describing the shape of every item in the output array. The root must be an object. `null` is not allowed at any depth.

```json
{
  "invoice_number": "",
  "total": 0,
  "paid": false,
  "line_items": [
    {"description": "", "quantity": 0, "amount": 0}
  ]
}
```

### JSON Schema format

Standard JSON Schema (draft-07 or 2020-12). The server converts it to a template internally before submission to the model.

**Supported subset:**
- Types: `object`, `array`, `string`, `number`, `integer`, `boolean`
- `type` as an array (e.g. `["string", "null"]`) — the first non-`null` entry is used
- Nested `properties`
- Single-schema `items` for arrays
- Local `$ref` resolved against `#/$defs/...` or `#/definitions/...`
- `const` and `enum` — sentinel is derived from the JSON type of the (first) value
- `anyOf`, `oneOf`, `allOf` — the first branch that successfully converts is used; other branches are ignored
- Informational keywords (`description`, `required`, `format`, `title`, etc.) are accepted and ignored

**Not supported (will return `422 invalid_schema`):**
- Tuple `items` (arrays of schemas)
- External `$ref` (e.g. `https://...`)
- Circular `$ref` chains
- Empty composition arrays
- Any `type` other than the six listed above

**Size cap:** 64 KB. Both the raw submitted bytes and the converted template must fit; a small JSON Schema can convert into a much larger template if it has many `$ref` expansions.

### Example: equivalent schemas

Template:
```json
{
  "invoice_number": "",
  "total": 0,
  "paid": false,
  "line_items": [
    {"description": "", "quantity": 0, "amount": 0}
  ]
}
```

Equivalent JSON Schema:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["invoice_number", "total", "line_items"],
  "properties": {
    "invoice_number": {"type": "string"},
    "total": {"type": "number"},
    "paid": {"type": "boolean"},
    "line_items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "description": {"type": "string"},
          "quantity": {"type": "integer"},
          "amount": {"type": "number"}
        }
      }
    }
  }
}
```

When in doubt, prefer the template format — it has no edge cases and is easier to debug.

## Limits

| Constraint | Limit |
|------------|-------|
| Maximum file size | 20 MB |
| Maximum pages per document | 1000 |
| Supported formats | PDF, JPEG, PNG, TIFF, WebP, BMP |
| Maximum schema size (raw bytes and converted template) | 64 KB |
| Maximum `Idempotency-Key` length | 64 characters |
| Upload URL validity | 15 minutes |
| Idempotency dedup window | 24 hours |
| Webhook delivery timeout | 10 seconds per attempt |
| Webhook retry attempts | 3 (at 30s, 120s, 480s) |

## Data retention

- **Uploaded documents**: deleted from storage immediately after OCR processing completes.
- **Results**: available for **5 minutes** after the first successful `GET /v1/jobs/{jobId}` retrieval. After that the result is permanently deleted and subsequent fetches return `410 result_expired`.
- **Unread results and orphaned uploads**: a 24-hour storage lifecycle policy catches anything missed by the immediate cleanup.
- **Job metadata** (status, timestamps, page count, `failure_reason`) is retained beyond the result expiry, so polling a long-since-expired job still returns its final status — only `result` is gone.

If you need the OCR output for longer than 5 minutes, fetch it once and persist it on your side.
