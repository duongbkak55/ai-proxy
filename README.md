# @omc-ai/proxy

AI egress proxy with DLP (Data Loss Prevention), allowlist enforcement, and audit logging. Designed to sit between AI-coding agents (e.g. Claude Code) and the upstream Anthropic API, redacting source code identifiers — package names, class names, internal imports, secrets — before they leave your network.

Originally extracted from [oh-my-claudecode](https://github.com/duongbkak55/oh-my-claudecode).

## Features

- **Anthropic-compatible** `POST /v1/messages` endpoint (drop-in replacement for `api.anthropic.com`).
- **Multi-lane DLP**:
  - **Regex lane** — pattern-based redaction (secrets, tokens, custom rules).
  - **Dictionary lane** — reversible token vault for stable identifiers.
  - **SQL lane** (`OMC_PROXY_SQL_DLP=1`) — AST-aware redaction for fenced SQL blocks.
  - **AST lane** (`OMC_PROXY_AST_DLP=1`) — source-code-aware redaction for fenced TS/JS/Python/Java code (internal package paths, class names, imports).
- **Allowlist enforcement** — only whitelisted upstream URLs accepted.
- **Audit log** — hash-chained JSONL events for tamper detection.
- **SSE streaming** — token detokenization on response stream for client transparency.
- **Bring your own** — TLS via reverse proxy, auth via [Phase B](#roadmap), rate-limit, etc.

## Install

```bash
npm install -g @omc-ai/proxy
omc-proxy --help
```

## Quickstart

```bash
# 1. Generate a config
omc-proxy config init > proxy.jsonc

# 2. Start the proxy (default listens on 127.0.0.1:11434)
omc-proxy start --config proxy.jsonc

# 3. Point your client at the proxy
export ANTHROPIC_BASE_URL=http://127.0.0.1:11434
```

## CLI

```
omc-proxy start [--config <path>] [--port <n>]
omc-proxy audit list [--limit N]
omc-proxy hitl list|approve|deny <id>
omc-proxy config print [--config <path>]
```

## Roadmap

- **Phase B** — Auth lane (bearer token + rotation + per-token rate-limit). PR pending.
- **Phase C** — Deployment artifacts (Docker + caddy + systemd). PR pending.

## Architecture

See [docs/security-design.md](./docs/security-design.md) for the full DLP pipeline, threat model, and design rationale.

## Status

Pre-release. v0.1.0-rc1 scaffold from filter-repo extraction. Not yet published to npm.

## License

MIT — see [LICENSE](./LICENSE).
