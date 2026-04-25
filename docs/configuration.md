# Configuration reference

The proxy is configured via a JSONC file plus a small set of environment variables. Defaults are designed for safe local development; production deployments need to set at least `auth`, `audit.dir`, and `upstream.apiKeyEnv`.

> **Schema source of truth**: [`src/config.ts`](../src/config.ts). When this doc disagrees with the schema, the schema wins.

## Resolution order

1. `--config <path>` flag, or
2. `~/.config/omc/proxy.jsonc` (user-scope default), or
3. Built-in defaults if neither file exists.

Env vars override fields per the **Env overrides** column below; `--port` flag overrides `listen.port`.

## Top-level keys

| Key | Type | Default | Env overrides | Notes |
|---|---|---|---|---|
| `listen.host` | string | `127.0.0.1` | — | Set to `0.0.0.0` only behind a reverse proxy or firewall. The server refuses public bind unless `OMC_PROXY_ALLOW_PUBLIC=1`. |
| `listen.port` | int | `11434` | `--port` | Range 1-65535. |
| `upstream.baseUrl` | URL | `https://api.anthropic.com` | — | Validated with the SSRF guard at startup. |
| `upstream.apiKeyEnv` | string | `ANTHROPIC_API_KEY` | — | Name of the env var holding the upstream key. The key value itself stays in the env. |
| `auth.tokenEnv` | string | `OMC_PROXY_CLIENT_TOKEN` | — | Legacy single-token mode. Used iff `auth.tokens[]` and `auth.tokensFile` are both empty. |
| `auth.headerName` | string | `Authorization` | — | The HTTP header that carries `Bearer <token>`. |
| `auth.tokens` | TokenRecord[] | `[]` | — | Inline multi-token list. Activates AuthGate when non-empty. |
| `auth.tokensFile` | path | unset | — | File-backed token store (atomic writes, JSON v1). Activates AuthGate when set. |
| `dlp.patterns` | DlpPattern[] | `[]` | — | Validated with `safe-regex` at startup. |
| `dlp.customDenyTerms` | string[] | `[]` | — | Extra terms unconditionally blocked. |
| `allowlist.mcpTools` | string[] | `[]` | — | Tool names allowed in agent-loop responses. |
| `allowlist.urlDomains` | string[] | `[]` | — | Domains allowed in tool fetches. |
| `allowlist.pathPrefixes` | string[] | `[]` | — | Path prefixes allowed under the upstream baseUrl. |
| `hitl.enabled` | bool | `false` | — | Routes sensitive tools through the file-based approval queue. |
| `hitl.sensitiveTools` | string[] | `[]` | — | Tool names that trigger HITL hold. |
| `hitl.timeoutMs` | int | `60000` | — | How long to wait for human approval before timeout. |
| `audit.dir` | path | `~/.omc/proxy/audit` | — | Each request appends a JSONL entry, fsync'd. |
| `audit.maxBodyBytes` | int | `1_000_000` | — | Body bytes captured per audit event (truncated beyond). |
| `agentLoop.enabled` | bool | `false` | — | Enables internal tool execution loop with Zod-validated upstream responses. |
| `agentLoop.maxIterations` | int | `5` | — | Loop bound; final response forwarded to client. |
| `agentLoop.maxToolOutputBytes` | int | `100_000` | — | Per-tool output cap. |
| `vault.ttlSeconds` | int | `86_400` | — | Token vault entry lifetime. After expiry, detokenization returns the token unchanged. |
| `dictionary.path` | path | unset | — | Optional file with extra `DictionaryEntry[]` to merge with `dictionary.entries`. |
| `dictionary.entries` | DictionaryEntry[] | `[]` | — | Inline term/classifier/policy/(tenantId) records. |
| `conversation.headerName` | string | `X-OMC-Conversation-Id` | — | Header used to scope vault namespace per conversation; falls back to a hash of (token + system prompt prefix). |
| `sqlDlp.enabled` | bool | `false` | `OMC_PROXY_SQL_DLP=1` | Activates the SQL AST lane. |
| `sqlDlp.includeColumns` | bool | `false` | — | Tokenise column names in addition to tables/schemas. |
| `sqlDlp.dialect` | enum | `mysql` | — | One of `mysql\|postgres\|bigquery\|sqlite`. |
| `astDlp.enabled` | bool | `false` | `OMC_PROXY_AST_DLP=1` | Activates the AST source-code lane. |
| `astDlp.languages` | enum[] | all four | — | Subset of `typescript\|javascript\|python\|java`. |

## Composite types

### `DlpPattern`
```jsonc
{
  "name": "anthropic_key",                  // unique key
  "regex": "sk-ant-[a-zA-Z0-9_-]{20,}",     // safe-regex validated at startup
  "policy": "redact",                        // "block" | "redact" | "tokenize"
  "replacement": "***"                       // optional override (default: classifier-driven)
}
```

### `DictionaryEntry`
```jsonc
{
  "term": "ProjectAlpha",
  "classifier": "CODENAME",
  "policy": "tokenize",
  "tenantId": "team-platform"  // optional; reserved for multi-tenant separation
}
```

### `TokenRecord` (auth)
```jsonc
{
  "id": "claude-code-dev",
  "hash": "sha256:abcdef...",                // sha256 of plaintext; never persist plaintext
  "scopes": ["proxy:request"],
  "rateLimit": { "rpm": 60, "perDay": 100000 },
  "expiresAt": "2026-07-23T00:00:00.000Z",   // optional ISO 8601
  "rotatedFrom": "claude-code-dev-v1",       // optional, set by `auth rotate`
  "createdAt": "2026-04-25T07:54:00.000Z"
}
```

The `auth.tokensFile` JSON envelope is `{ "version": 1, "tokens": TokenRecord[] }`.

## Environment variables

In addition to the schema-level overrides above:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Upstream API key (name configurable via `upstream.apiKeyEnv`). |
| `OMC_PROXY_CLIENT_TOKEN` | Legacy single-token bearer (when multi-token mode is off). |
| `OMC_PROXY_SQL_DLP` | `1` enables `sqlDlp.enabled`. |
| `OMC_PROXY_AST_DLP` | `1` enables `astDlp.enabled`. |
| `OMC_PROXY_ALLOW_PUBLIC` | `1` permits binding `0.0.0.0` / `::` (otherwise the server refuses to expose itself directly). |

## Worked examples

### Minimal local-dev config

```jsonc
{
  "listen": { "host": "127.0.0.1", "port": 11434 },
  "auth": { "tokenEnv": "OMC_PROXY_CLIENT_TOKEN" },
  "dlp": {
    "patterns": [
      { "name": "anthropic_key", "regex": "sk-ant-[a-zA-Z0-9_-]{20,}", "policy": "block" }
    ]
  },
  "audit": { "dir": "/tmp/proxy-audit" }
}
```
Run with `OMC_PROXY_CLIENT_TOKEN=$(openssl rand -base64 32) ANTHROPIC_API_KEY=sk-ant-... omc-proxy start --config dev.jsonc`.

### Production config (multi-token + AST + SQL)

```jsonc
{
  "listen": { "host": "0.0.0.0", "port": 11434 },     // behind caddy reverse proxy
  "upstream": { "baseUrl": "https://api.anthropic.com" },
  "auth": {
    "headerName": "Authorization",
    "tokensFile": "/var/lib/omc-proxy/auth.json"
  },
  "dlp": {
    "patterns": [
      { "name": "anthropic_key", "regex": "sk-ant-[a-zA-Z0-9_-]{20,}", "policy": "block" },
      { "name": "github_pat",    "regex": "ghp_[a-zA-Z0-9]{36}",       "policy": "block" },
      { "name": "email",         "regex": "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}", "policy": "tokenize" }
    ],
    "customDenyTerms": ["INTERNAL-CODE-NAME-X"]
  },
  "sqlDlp": { "enabled": true, "dialect": "postgres", "includeColumns": true },
  "astDlp": { "enabled": true, "languages": ["typescript", "python"] },
  "audit": { "dir": "/var/lib/omc-proxy/audit", "maxBodyBytes": 2000000 },
  "vault": { "ttlSeconds": 86400 },
  "dictionary": {
    "path": "/etc/omc-proxy/codenames.json"
  },
  "allowlist": {
    "urlDomains": ["api.anthropic.com"]
  }
}
```

Set `OMC_PROXY_ALLOW_PUBLIC=1` in the systemd `Environment=` so the server accepts the `0.0.0.0` bind, and create the auth tokens with `omc-proxy auth issue --id claude-code --rpm 120 --ttl 90d`.

## Inspecting effective config

```bash
omc-proxy config print --config /etc/omc-proxy/config.jsonc
```

Secrets (env values, hash bytes) are redacted in the output.
