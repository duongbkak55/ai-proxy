# HTTP API reference

The proxy exposes three HTTP endpoints. Routes other than `/health` require a valid bearer token (legacy env or multi-token AuthGate, depending on configuration — see [`auth.md`](./auth.md)).

## `POST /v1/messages`

Anthropic-compatible message endpoint. Drop-in replacement for `https://api.anthropic.com/v1/messages`. The proxy mediates between client and upstream:

```
client ──▶ [auth ▶ rate-limit ▶ allowlist ▶ DLP] ──▶ api.anthropic.com
client ◀── [SSE detokenize ◀ vault detokenize] ◀── api.anthropic.com
```

### Request

Headers:
- `Authorization: Bearer <token>` — required (or custom header name if configured).
- `X-OMC-Conversation-Id: <opaque>` — optional. Scopes vault namespace per conversation. If absent, derived from `(token, system_prompt_prefix)` hash.
- `Content-Type: application/json` — required.
- `anthropic-version: 2023-06-01` — set by upstream client; proxy forwards it as-is.

Body shape: standard Anthropic `MessagesCreate` payload (`model`, `messages`, `system`, `max_tokens`, `tools`, `stream`, etc.). The proxy mutates the body to redact sensitive content before forwarding upstream.

### Response

Same shape as `api.anthropic.com`. When `stream: true`, responses are SSE; the proxy detokenizes vault tokens in chunks before emitting them downstream.

### Status codes

| Code | When |
|---|---|
| `200` | Successful proxy + DLP + upstream forward. |
| `400` | Malformed JSON body or invalid Anthropic request shape. |
| `401` | Missing / invalid / expired bearer token. |
| `403` | Tool not on allowlist (`scanRequestForBannedTools`). |
| `429` | Per-token rate limit exhausted. Includes `Retry-After: <seconds>` header. |
| `500` | Internal proxy error or missing `ANTHROPIC_API_KEY`. |
| `502` | Upstream returned non-2xx; proxy includes a sliced error body. |

### Body redaction events

When DLP redacts content, the proxy logs an `audit` event (see [`security-design.md`](./security-design.md) §4.6) with summarised match counts. The upstream sees only redacted/tokenised content; the audit log records what was matched (classifier counts) but not the plaintext.

## `GET /health`

Liveness probe. Always returns 200 without auth, intended for load balancers and container orchestration:

```
GET /health  →  200 { "status": "ok" }
```

This is the only un-auth route.

## `GET /metrics`

Prometheus text format (version `0.0.4`). Requires bearer auth.

```
omc_proxy_requests_total <n>
omc_proxy_blocked_total  <n>
omc_proxy_redacted_total <n>
omc_proxy_tool_calls_total <n>
omc_proxy_hitl_pending <n>
omc_proxy_errors_total <n>
```

| Metric | Type | Meaning |
|---|---|---|
| `omc_proxy_requests_total` | counter | All `/v1/messages` calls accepted. |
| `omc_proxy_blocked_total` | counter | Requests/streams stopped by DLP `block` policy or allowlist. |
| `omc_proxy_redacted_total` | counter | DLP redact / tokenize events on inbound bodies. |
| `omc_proxy_tool_calls_total` | counter | Internal agent-loop tool executions. |
| `omc_proxy_hitl_pending` | gauge | Items currently awaiting HITL approval. |
| `omc_proxy_errors_total` | counter | Internal proxy errors (5xx-emitting paths). |

These are in-process counters; aggregate across replicas via your scrape pipeline (Prometheus / VictoriaMetrics / etc.).

## Conversation scoping

Every `/v1/messages` request is associated with a conversation id, used for vault key namespacing so tokens issued in one conversation cannot leak into another via response detokenization. Resolution order:

1. `X-OMC-Conversation-Id` header (regex `^[A-Za-z0-9_-]{1,64}$`)
2. SHA-256 hash of `(bearer_token_prefix_16_chars, system_prompt_first_512_chars)` — first 16 hex chars
3. Random UUID (anonymous fallback) — first 16 hex chars

Clients that batch multiple semantically distinct conversations through a shared token should send the explicit header to keep vaults isolated.

## Worked example

```bash
TOKEN=$(omc-proxy auth issue --id curl-test --rpm 60 | tail -1)

curl -sS -X POST http://127.0.0.1:11434/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-OMC-Conversation-Id: my-session-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Refactor src/proxy/dlp.ts"}]
  }'
```

If `dlp.ts` matches a tokenised dictionary entry, the upstream sees an opaque token (e.g. `PKG_03`); the response stream replaces it back to `dlp.ts` before reaching curl.

## Not exposed

- Admin API for token management — handled via local CLI (`omc-proxy auth ...`) only. There is no remote admin surface.
- Direct vault inspection — by design, vault contents are not retrievable over HTTP.
- Audit log retrieval — read locally via `omc-proxy audit tail` or filesystem.

## Versioning

All HTTP paths and metric names are stable. Adding new metrics or new optional fields is non-breaking. Removing or renaming either is breaking and gets a CHANGELOG entry under a major version bump.
