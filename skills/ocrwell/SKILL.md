---
name: ocrwell
description: Use when writing or debugging code that calls the OCRWell document OCR API — extracting plain text or structured JSON from PDFs and images, polling job status, or verifying webhook callbacks. Covers authentication, the two-step upload, asynchronous submission, polling, structured-extraction schemas, error handling, rate limiting, and webhook signature verification. Triggers on mentions of OCRWell, ocrwell.com, api.ocrwell.com, or the X-Ocrwell-Signature header.
---

# OCRWell API integration

OCRWell is a B2B SaaS OCR platform. Customers POST a document, and OCRWell returns either plain text (per page) or structured JSON matching a schema the customer supplies. This skill is the reference Claude Code uses when generating client code in any language.

**Base URL:** `https://api.ocrwell.com/v1`

HTTPS only — plaintext HTTP is rejected. All requests and responses are JSON unless stated otherwise. All timestamps are ISO 8601 UTC with a `Z` suffix.

For the full endpoint-by-endpoint specification (every response shape, full JSON Schema subset rules, complete error catalogue), see [reference.md](reference.md). Load it when you need depth beyond the summary below.

## Authentication

Every request to `/v1/...` (except `GET /v1/health`) must include:

```
X-API-Key: <the customer's API key>
```

The header value is the raw key, with no `Bearer ` prefix. Keys are created in the OCRWell dashboard and shown once — they are not retrievable later.

**Never log, print, or echo the API key or the webhook secret.** Treat them like passwords. When generating code, read them from environment variables (e.g. `OCRWELL_API_KEY`) or a secrets manager — never hard-code them.

## Canonical workflow

1. **Get an upload URL** — `POST /v1/uploads` with `{"filename": "..."}`. Returns `upload_id` and a 15-minute pre-signed `upload_url`.
2. **Upload the file** — `PUT` the raw file bytes to `upload_url` with the correct `Content-Type` for the file extension.
3. **Submit for processing** — `POST /v1/documents` with `{"upload_id": "...", "filename": "...", "mode": "text" | "structured", "schema": {...}}`. Returns `202 Accepted` and a `job.id` immediately.
4. **Get the result** — either:
   - **Poll** `GET /v1/jobs/{jobId}` until `job.status` is `completed` or `failed`, or
   - **Receive a webhook** at the URL configured via `PUT /v1/webhooks` (then call `GET /v1/jobs/{jobId}` to fetch the actual result data).

Submission is always asynchronous. There is no synchronous OCR endpoint in the public API.

## Endpoint reference

All paths are under `/v1`. Every authenticated endpoint requires `X-API-Key`. Successful responses always include a `request_id` field — log it for support enquiries.

### `GET /v1/health`

No auth. Returns `{"status": "ok"}`. Use for liveness checks.

### `POST /v1/uploads`

Generate a presigned upload URL.

```bash
curl -X POST https://api.ocrwell.com/v1/uploads \
  -H "X-API-Key: $OCRWELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename": "invoice.pdf"}'
```

Response (`200`):
```json
{
  "upload_id": "019539a6-6c3d-7e5f-a1b2-4d6e8f0a2c3e",
  "upload_url": "https://api.ocrwell.com/uploads/...",
  "expires_in": 900,
  "request_id": "..."
}
```

Then `PUT` the file to `upload_url` using the matching content type:

| Extension | Content-Type |
|-----------|--------------|
| `.pdf` | `application/pdf` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.png` | `image/png` |
| `.tiff`, `.tif` | `image/tiff` |
| `.webp` | `image/webp` |
| `.bmp` | `image/bmp` |

```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @invoice.pdf
```

The `PUT` does not include `X-API-Key` (it goes directly to storage via a presigned URL). Treat a non-2xx response from the `PUT` as a failed upload and start over with a fresh `POST /v1/uploads`.

### `POST /v1/documents`

Submit an uploaded document for processing.

```bash
curl -X POST https://api.ocrwell.com/v1/documents \
  -H "X-API-Key: $OCRWELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "upload_id": "019539a6-6c3d-7e5f-a1b2-4d6e8f0a2c3e",
    "filename": "invoice.pdf",
    "mode": "text"
  }'
```

Required body fields: `upload_id`, `filename`, `mode` (`"text"` or `"structured"`). When `mode` is `"structured"`, also pass `schema` (see [Structured extraction](#structured-extraction)).

Optional headers:
- `Idempotency-Key: <unique string up to 64 chars>` — repeating the same key with the same body within 24 hours returns the original response. The same key with a different body returns `409 duplicate_request`.

Response (`202 Accepted`):
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

### `GET /v1/jobs/{jobId}`

Poll for status and result. **The HTTP status is `200` whenever the job exists** — `job.status` carries the processing outcome. Don't treat a successful `200` with `status: "failed"` as an HTTP failure.

```bash
curl https://api.ocrwell.com/v1/jobs/$JOB_ID \
  -H "X-API-Key: $OCRWELL_API_KEY"
```

Possible job statuses: `pending`, `processing`, `completed`, `failed`.

When `status` is `completed` and `mode` is `"text"`, the response includes:
```json
{
  "job": { "id": "...", "status": "completed", "mode": "text", "page_count": 3, ... },
  "result": {
    "pages": [
      { "page": 1, "text": "..." },
      { "page": 2, "text": "..." },
      { "page": 3, "text": "..." }
    ]
  },
  "request_id": "..."
}
```

When `mode` is `"structured"`, the result is `{"data": { ... }}` matching the submitted schema.

When `status` is `failed`, the job object includes `failed_at` and `failure_reason`.

**Result expiry:** results are deleted **5 minutes after the first successful retrieval**. After that, polling returns `410 Gone` with `error.code: "result_expired"`. Fetch the result once and persist it client-side if you need it longer.

**Polling cadence:** start at ~500ms, exponentially back off to a few seconds. Do not poll faster than the rate limit allows (see below).

### Webhooks: `PUT`, `GET`, `DELETE /v1/webhooks`

Each organisation has at most one webhook URL. `PUT /v1/webhooks` with `{"url": "https://..."}` (HTTPS required) creates or replaces it. The response includes a one-time `secret` like `whsec_...` — store it immediately, it is never returned again. To rotate, send another `PUT`.

`GET /v1/webhooks` returns the current config (without the secret). `DELETE /v1/webhooks` returns `204` and stops further callbacks.

See [Webhook callbacks](#webhook-callbacks) below for delivery semantics and signature verification.

## Structured extraction

When submitting with `mode: "structured"`, the server returns a JSON object matching the shape of the `schema` you provided. Two input formats are accepted; the server detects which you sent.

**Template format** (the simpler option). A partially-filled example with sentinel values at the leaves:

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

Rules:
- Root must be a JSON object.
- Sentinels: `""` for strings, `0` for numbers, `true`/`false` for booleans.
- No `null` values.
- Arrays must contain **exactly one** element describing every item in the output array.
- Field names starting with `$` and the literal key `definitions` are reserved at the root.

**JSON Schema format** (draft-07 or 2020-12). Detected when the root contains any of `$schema`, `$defs`, `definitions`, `$ref`, or both `type: "object"` and `properties`. The server converts it to a template internally. Supported subset: types `object`/`array`/`string`/`number`/`integer`/`boolean`, nested `properties`, single-schema `items`, local `$ref`, `const`/`enum`, and `anyOf`/`oneOf`/`allOf` (first successful branch wins). **Not supported:** tuple `items`, external `$ref`, circular `$ref`, empty composition arrays. Both the raw input and the converted template must be ≤ 64 KB.

When in doubt, prefer the template format — it has no edge cases and is easier to debug. See [reference.md](reference.md) for the full JSON Schema subset table.

## Errors

Every error response has this shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "The 'mode' field is required.",
    "details": [{"field": "mode", "reason": "required"}]
  },
  "request_id": "..."
}
```

Always switch on `error.code`, not on `error.message` (messages are subject to change). The `details` array is optional and only present for field-level validation failures.

| HTTP | `error.code` | Meaning |
|------|--------------|---------|
| 400 | `bad_request` | Malformed body or parameters |
| 400 | `validation_error` | A field failed validation |
| 400 | `unsupported_format` | File extension not in the allowed list |
| 401 | `unauthorized` | Missing, invalid, or disabled API key |
| 404 | `not_found` | Resource doesn't exist or belongs to another org |
| 409 | `duplicate_request` | Idempotency key reused with a different body |
| 410 | `result_expired` | Result was deleted after the 5-minute retention window |
| 413 | `file_too_large` | Document exceeds the 20 MB limit |
| 422 | `invalid_schema` | Structured-mode schema is invalid or > 64 KB |
| 429 | `rate_limited` | Rate limit exceeded — see `Retry-After` |
| 500 | `internal_error` | Unexpected server error — safe to retry with backoff |
| 503 | `service_unavailable` | Temporary capacity issue — safe to retry |

## Rate limits

Limits are per organisation (resolved from the API key) on a fixed 1-minute window. Every response carries:

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 117
X-RateLimit-Reset: 1711180800
```

`X-RateLimit-Reset` is a Unix timestamp (UTC). Polling endpoints (`GET /v1/jobs/...`, `GET /v1/webhooks`) get a 3× multiplier on the base limit, so polling does not eat your transactional budget.

When the limit is hit, the API returns `429` with `Retry-After: <seconds>`. Always honour `Retry-After` rather than guessing — the server may extend the window during incidents.

## Webhook callbacks

When a job reaches `completed` or `failed` and the org has a configured webhook, OCRWell `POST`s to the webhook URL. The body contains job metadata only — **the OCR result is not in the webhook payload.** The receiver must call `GET /v1/jobs/{jobId}` to fetch it (within the 5-minute retention window).

Headers on every callback:

```
X-Ocrwell-Signature: sha256=<hex digest>
X-Ocrwell-Timestamp: <unix timestamp seconds>
X-Ocrwell-Event: job.completed | job.failed
```

### Verifying the signature

1. Read `X-Ocrwell-Timestamp` from the request headers.
2. Reject the request if the timestamp is more than 5 minutes from the current time (replay protection).
3. Build the signed payload as the literal string `"{timestamp}.{raw_body}"` — use the **raw request body bytes**, not a re-serialised version. If your framework parses the body before you can read it raw, configure it not to.
4. Compute `HMAC-SHA256(webhook_secret, signed_payload)` and hex-encode the result.
5. Compare your digest against the value after `sha256=` in `X-Ocrwell-Signature` using a **constant-time** comparison (e.g. `hmac.compare_digest` in Python, `crypto.timingSafeEqual` in Node, `hmac.Equal` in Go). Never use `==` on the strings.
6. On mismatch, respond `401` and do not process the body.

### Retry policy

A non-2xx response or a >10 second timeout triggers retries at 30s, 120s, then 480s. After three failed attempts, delivery is abandoned — the result is still available via `GET /v1/jobs/{jobId}` until it expires.

## Limits and retention

| Constraint | Limit |
|------------|-------|
| Maximum file size | 20 MB |
| Maximum pages per document | 1000 |
| Supported formats | PDF, JPEG, PNG, TIFF, WebP, BMP |
| Maximum schema size | 64 KB (raw bytes and converted template) |
| Maximum `Idempotency-Key` length | 64 characters |
| Upload URL validity | 15 minutes |
| Result retention after first retrieval | 5 minutes |
| Unread-result auto-delete | 24 hours |

Uploaded documents are deleted from storage immediately after OCR processing completes. Files uploaded but never submitted are deleted after 24 hours.

## End-to-end example (curl)

```bash
#!/usr/bin/env bash
set -euo pipefail

API="https://api.ocrwell.com/v1"
KEY="$OCRWELL_API_KEY"

# 1. Get a presigned upload URL.
UPLOAD=$(curl -fsS -X POST "$API/uploads" \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename": "invoice.pdf"}')

UPLOAD_ID=$(echo "$UPLOAD" | jq -r .upload_id)
UPLOAD_URL=$(echo "$UPLOAD" | jq -r .upload_url)

# 2. Upload the file with the matching Content-Type.
curl -fsS -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @invoice.pdf

# 3. Submit for processing.
SUBMIT=$(curl -fsS -X POST "$API/documents" \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"upload_id\": \"$UPLOAD_ID\", \"filename\": \"invoice.pdf\", \"mode\": \"text\"}")

JOB_ID=$(echo "$SUBMIT" | jq -r .job.id)

# 4. Poll until completed or failed (with backoff up to ~5s).
DELAY=1
while true; do
  RESP=$(curl -fsS "$API/jobs/$JOB_ID" -H "X-API-Key: $KEY")
  STATUS=$(echo "$RESP" | jq -r .job.status)
  [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]] && break
  sleep "$DELAY"
  DELAY=$(( DELAY < 5 ? DELAY * 2 : 5 ))
done

if [[ "$STATUS" == "failed" ]]; then
  echo "Job failed: $(echo "$RESP" | jq -r .job.failure_reason)" >&2
  exit 1
fi

echo "$RESP" | jq -r '.result.pages[].text'
```

## When generating client code in any language

Apply this checklist to every OCRWell client you write:

- **Read the API key from the environment** (e.g. `OCRWELL_API_KEY`). Never accept it as a positional CLI arg or hard-code it.
- **Use HTTPS** for both the API base URL and the customer's webhook URL.
- **Send `Content-Type: application/json`** on every JSON-bodied request.
- **Send the upload `PUT` with the exact content type** matching the file extension — using the wrong content type causes silent processing failures downstream.
- **Treat `200` with `job.status: "failed"` as a failure** at the application layer, not as an HTTP error. Surface `job.failure_reason` to the caller.
- **Honour `Retry-After` on `429`** literally — sleep for that many seconds before retrying. Do not implement your own backoff for `429`.
- **Retry `5xx` responses** with exponential backoff (cap around 30 seconds, 3–5 attempts).
- **Switch on `error.code`** for programmatic error handling, not on `error.message` or HTTP status alone.
- **Use the SDK-native HMAC primitive** for webhook verification — `hmac.new(...).hexdigest()` in Python, `crypto.createHmac('sha256', secret)` in Node, `hmac.New(sha256.New, ...)` in Go. Always compare with the constant-time helper for that language.
- **Parse the raw request body once** in webhook handlers — verify the signature before parsing JSON, and pass the same bytes you verified into the JSON parser.
- **Persist the result yourself** if you need it after the 5-minute retention window. Store the `request_id` and `job.id` for support traceability.
- **Never log secrets** — API key, webhook secret, presigned upload URL (it grants 15 minutes of write access).

For deeper detail on any endpoint, response shape, or the JSON Schema subset, read [reference.md](reference.md).
