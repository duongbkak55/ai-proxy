# Changelog

All notable changes to `@duongbkak55/ai-proxy` are documented in this file. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing pending; tracking via [ROADMAP.md](./ROADMAP.md).

## [0.1.0] — 2026-04-25

Initial extraction from [oh-my-claudecode](https://github.com/duongbkak55/oh-my-claudecode) into a standalone repository, plus the auth lane and deployment artifacts that did not exist in the original implementation.

### Added — extracted from upstream
- Anthropic-compatible HTTP proxy (`server.ts`) with `POST /v1/messages`, `GET /health`, `GET /metrics`.
- DLP pipeline (`dlp.ts`) with regex, dictionary (Aho-Corasick), SQL AST, and source-code AST lanes.
- Token vault (`vault.ts`) for reversible tokenisation, conversation-scoped, 24-hour TTL.
- SSE detokenizer with rolling 512-byte hold-back buffer.
- Allowlist enforcement (`allowlist.ts`) for tool names and upstream URLs.
- SSRF guard rejecting internal/private addresses.
- Audit log (`audit.ts`) with fsync-on-write JSONL entries.
- Agent loop (`agent-loop.ts`) with Zod upstream response validation.
- HITL approval queue (`cli.ts`).
- 144 tests across 10 test files.

### Added — new in this release
- **Auth lane** (`auth.ts`):
  - Multi-token bearer auth with sha256 hash storage; plaintext never persisted.
  - Per-token token-bucket rate limit (in-process).
  - Scope-based access control.
  - Token expiration and rotation chain.
  - File-backed or inline-config storage modes.
  - CLI: `omc-proxy auth issue|list|revoke|rotate`.
  - 33 tests (`auth.test.ts`).
- **Deployment artifacts** (`deploy/`):
  - Multi-stage Dockerfile (distroless runtime).
  - `compose.yml` with caddy reverse-proxy + auto-HTTPS.
  - Hardened systemd unit.
  - Sample config and 3-mode deploy README.
- **Documentation**:
  - `docs/auth.md` — auth lane design and usage.
  - `docs/configuration.md` — full config schema reference.
  - `docs/api.md` — HTTP endpoint reference.
  - `ROADMAP.md` — shipped + planned features.
  - `CONTRIBUTING.md` — developer onboarding.
  - `CHANGELOG.md` — this file.
- **Tooling**:
  - `src/types/safe-regex.d.ts` — type shim for `safe-regex` (the npm package ships no `.d.ts`).
  - GitHub Actions CI workflow (`.github/workflows/ci.yml`) on Node 20 + 22.

### Changed
- Repo moved from `duongbkak55/omc-ai-proxy` (original name during extraction) to `duongbkak55/ai-proxy`.
- Package name changed from `@omc-ai/proxy` to `@duongbkak55/ai-proxy`.
- Helper modules `atomic-write.ts`, `ssrf-guard.ts`, `jsonc.ts` vendored from `oh-my-claudecode/src/{lib,utils}/` into `src/lib/` so the package is self-contained.
- Config schema's `auth` section extended with `headerName`, `tokens[]`, `tokensFile` (additive — `tokenEnv` legacy field preserved).
- `enforceProxyAuth` in `server.ts` now async; supports both the multi-token gate and the legacy env-based path based on configuration.

### Preserved (intentionally)
- CLI binary name `omc-proxy` (kept to avoid breaking muscle memory).
- Config dir `/etc/omc-proxy/` and systemd unit filename `omc-proxy.service`.
- Env var prefix `OMC_PROXY_*`.
- Audit log path `~/.omc/proxy/audit`.

### Status
- 11 test files, 177 tests, all passing on Node 20 and 22.
- Not yet published to npm; install via `git clone` for now.

[Unreleased]: https://github.com/duongbkak55/ai-proxy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/duongbkak55/ai-proxy/releases/tag/v0.1.0
