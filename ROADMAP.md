# Roadmap

This document captures what has shipped and what is planned next. The detailed threat model, ADRs, and rationale live in [`docs/security-design.md`](./docs/security-design.md); this is the lighter-weight project-status view.

## Shipped (on `main`)

### Core proxy (originally landed in `oh-my-claudecode`, extracted via `git filter-repo`)
- **HTTP proxy** Anthropic-compatible `POST /v1/messages`, `GET /health`, `GET /metrics`. Node `http` + `fetch` only — no framework dependency.
- **Regex DLP lane** — `block` / `redact` / `tokenize` policies. `safe-regex` validates patterns at startup to prevent ReDoS.
- **Dictionary DLP lane** — Aho-Corasick automata (case-sensitive + insensitive). Zero npm deps.
- **SQL DLP lane** (`OMC_PROXY_SQL_DLP=1`) — AST tokenisation via `node-sql-parser`. Re-serialises valid SQL with token substitution.
- **AST DLP lane** (`OMC_PROXY_AST_DLP=1`) — source-code-aware redaction for fenced TS/JS/Python/Java blocks. Built on `@ast-grep/napi`.
- **Token vault** — `InProcessTokenVault` with 24-hour TTL, conversation-scoped namespacing.
- **SSE detokenizer** — buffered streaming with rolling 512-byte hold-back to handle split-token edge cases.
- **Allowlist** — tool name + upstream URL gate. SSRF guard rejects internal/private addresses.
- **Audit log** — fsync'd JSONL per request/response cycle. Hash-chain for tamper detection.
- **HITL bypass** — file-based approval queue for sensitive operations.
- **Agent loop** — internal tool registry with Zod-validated upstream response shapes.

### Auth lane (Phase B — PR #1 merged)
- Multi-token bearer auth with sha256 hash storage (plaintext never persisted).
- Per-token token-bucket rate limit (in-process).
- Scope-based access control.
- Token expiration + rotation chain (`rotatedFrom` metadata).
- File-backed (`auth.tokensFile`) or inline-config (`auth.tokens[]`) modes.
- CLI: `omc-proxy auth issue|list|revoke|rotate`.
- Backward-compat: legacy single-token env-based mode (`auth.tokenEnv`) preserved.

### Deploy artifacts (Phase C — landed in scaffold commit)
- Multi-stage `Dockerfile` (distroless runtime).
- `compose.yml` with caddy auto-HTTPS reverse proxy.
- `Caddyfile` (Let's Encrypt or BYO cert).
- Hardened `systemd/omc-proxy.service` unit.
- `sample-config.jsonc` template.
- `deploy/README.md` covering Docker / systemd / manual binary modes.

## Pending

### v0.2.0 candidates
| Item | Driver | Status |
|---|---|---|
| KMS envelope encryption for vault DEK/KEK | NFR-3 (cryptographic protection at rest) | designed in security-design §8, not implemented |
| Multi-tenant vault isolation | enterprise multi-team deployments | partial schema (`tenantId` on dictionary entries), runtime not wired |
| Upstream-response DLP scan on direct proxy path | currently only agent-loop path runs Zod validation | open gap, see security-design §8 |
| HITL bypass — full implementation | currently file-based queue, no UI | design only |
| `omc-proxy config init` subcommand | bootstrap convenience | not implemented |

### Beyond v0.2.0
- OAuth/OIDC integration (currently bearer only)
- mTLS client cert auth
- Distributed rate-limit (Redis backend) for multi-replica deploys
- K8s manifests / Helm chart
- Admin web UI
- Vietnamese NER lane (`underthesea`-based) — gated on precision/recall ≥ 0.85/0.70 on dev-context dataset
- Per-IP rate-limit (currently per-token only)

## Out of scope (no plans)

- Becoming a production multi-tenant SaaS — this proxy is meant to be self-hosted.
- Bundling Claude Code plugin functionality — that lives at <https://github.com/duongbkak55/oh-my-claudecode>.
- Acting as a generic LLM gateway (OpenAI, Cohere, Bedrock). Anthropic-API-compatibility is a feature, not a launchpad for vendor abstraction.

## Versioning

Pre-1.0: minor versions may include breaking config or API changes; CHANGELOG documents migrations. Post-1.0: semver.
