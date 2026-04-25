# Auth lane

The proxy supports two bearer-token authentication modes. Both are off by default — the request to the proxy must always have an `Authorization: Bearer <token>` header, but how the token is validated depends on configuration.

## Mode 1 — Legacy single-token (env-based)

Backward-compatible default. Set the env var declared in config (`OMC_PROXY_CLIENT_TOKEN` by default) to a static plaintext token. Every inbound request's bearer is compared against this env value with `timingSafeEqual`.

```jsonc
{
  "auth": {
    "tokenEnv": "OMC_PROXY_CLIENT_TOKEN"
  }
}
```

```bash
export OMC_PROXY_CLIENT_TOKEN=$(openssl rand -base64 32)
omc-proxy start
```

Limitations: single token, manual rotation, no rate-limit, no per-client quota.

## Mode 2 — Multi-token store (Phase B)

Activated when `auth.tokens` is non-empty OR `auth.tokensFile` is set. Tokens are stored as sha256 hashes (plaintext is never persisted). Each token has its own scope set, expiration, and rate limit (token bucket per id).

```jsonc
{
  "auth": {
    "headerName": "Authorization",
    "tokensFile": "/var/lib/omc-proxy/auth.json"
  }
}
```

### Token lifecycle

```bash
# Issue a new token (plaintext printed once)
omc-proxy auth issue --id claude-code-dev --rpm 60 --ttl 90d

# List tokens (only metadata)
omc-proxy auth list

# Rotate (creates new token with same scopes/limits, marked rotatedFrom)
omc-proxy auth rotate claude-code-dev claude-code-dev-v2

# Revoke
omc-proxy auth revoke claude-code-dev
```

### Storage format

`auth.json` (atomic write):

```jsonc
{
  "version": 1,
  "tokens": [
    {
      "id": "claude-code-dev",
      "hash": "sha256:abcdef...",
      "scopes": ["proxy:request"],
      "rateLimit": { "rpm": 60, "perDay": 100000 },
      "expiresAt": "2026-07-23T00:00:00.000Z",
      "createdAt": "2026-04-25T07:54:00.000Z"
    }
  ]
}
```

### Pipeline order

```
[client] → TLS termination (caddy)
        → parse headers + body
        → auth.validate         ← 401/429 fast-path
        → allowlist + DLP        ← regex / dictionary / SQL / AST
        → upstream (api.anthropic.com)
        → SSE detokenize on stream back
```

The auth lane runs **before** any DLP work, so unauthorized requests cost negligible CPU and never expose token vault state.

### Audit

Every request after auth includes `auth.tokenId` in the audit JSONL. Plaintext is never logged.

## Limitations (this release)

- Rate limit is in-process only — single replica or per-replica budget.
- No OAuth/OIDC, no mTLS — bearer only.
- Token bucket refills smoothly but doesn't enforce strict per-second cadence (acceptable for human-driven coding agents).
- Token id is opaque — there's no audit-side mapping to org/team yet (planned).

## Migration from legacy

Legacy and multi-token modes can coexist during migration:

1. Add `tokensFile` to config but keep clients using env-token initially.
2. Issue tokens for clients via `omc-proxy auth issue`.
3. Switch clients one at a time to new tokens.
4. Once all migrated, remove `tokenEnv` from clients (gate auto-switches based on header).
5. Eventually drop `tokenEnv` from config (will be a future major version).
