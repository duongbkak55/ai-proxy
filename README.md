# @duongbkak55/ai-proxy

AI egress proxy with DLP (Data Loss Prevention), allowlist enforcement, and audit logging. Designed to sit between AI-coding agents (e.g. Claude Code) and the upstream Anthropic API, redacting source code identifiers — package names, class names, internal imports, secrets — before they leave your network.

Originally extracted from [oh-my-claudecode](https://github.com/duongbkak55/oh-my-claudecode).

## Features

- **Anthropic-compatible** `POST /v1/messages` endpoint (drop-in replacement for `api.anthropic.com`).
- **Multi-lane DLP**:
  - **Regex lane** — pattern-based redaction (secrets, tokens, custom rules).
  - **Dictionary lane** — reversible token vault for stable identifiers (Aho-Corasick).
  - **SQL lane** (`OMC_PROXY_SQL_DLP=1`) — AST-aware redaction for fenced SQL blocks.
  - **AST lane** (`OMC_PROXY_AST_DLP=1`) — source-code-aware redaction for fenced TS/JS/Python/Java code (internal package paths, class names, imports).
- **Auth lane** — bearer token (legacy single-token via env, or multi-token store with rotation + per-token rate-limit). See [docs/auth.md](./docs/auth.md).
- **Allowlist enforcement** — only whitelisted upstream URLs accepted.
- **Audit log** — hash-chained JSONL events for tamper detection.
- **SSE streaming** — token detokenization on response stream for client transparency.
- **Deploy artifacts** — Docker, caddy auto-HTTPS, systemd unit. See [deploy/README.md](./deploy/README.md).

## Install

```bash
# When published to npm:
npm install -g @duongbkak55/ai-proxy
omc-proxy --help

# Or run directly from source:
git clone https://github.com/duongbkak55/ai-proxy
cd ai-proxy && npm ci && npm run build
node dist/cli.js --help
```

## Quickstart

```bash
# 1. Generate a config
omc-proxy config print > proxy.jsonc

# 2. Issue an auth token (multi-token mode)
omc-proxy auth issue --id my-client --rpm 60 --ttl 90d

# 3. Start the proxy (default 127.0.0.1:11434)
ANTHROPIC_API_KEY=sk-ant-... omc-proxy start --config proxy.jsonc

# 4. Point your client at the proxy
export ANTHROPIC_BASE_URL=http://127.0.0.1:11434
# Use the issued token as Bearer auth from the client.
```

## CLI

```
omc-proxy start [--config <path>] [--port <n>]
omc-proxy auth issue --id <id> [--scope s] [--rpm 60] [--ttl 90d]
omc-proxy auth list | revoke <id> | rotate <oldId> <newId>
omc-proxy audit tail [--date YYYY-MM-DD] [--n N]
omc-proxy hitl list | approve <id> | deny <id>
omc-proxy config print [--config <path>]
```

## Documentation

| File | Audience |
|---|---|
| [README.md](./README.md) | First read |
| [docs/security-design.md](./docs/security-design.md) | Threat model, DLP architecture, ADRs, compliance |
| [docs/auth.md](./docs/auth.md) | Bearer-token auth lane, rotation, rate-limit |
| [docs/configuration.md](./docs/configuration.md) | Full config schema reference |
| [docs/api.md](./docs/api.md) | HTTP endpoint reference |
| [deploy/README.md](./deploy/README.md) | Docker / systemd / manual deploy |
| [ROADMAP.md](./ROADMAP.md) | Shipped + planned features |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup, conventions |

## Status

**v0.1.0** — pre-publish. Code merged on `main` includes the original DLP pipeline (extracted from `oh-my-claudecode` via `git filter-repo`) plus the new auth lane and deploy artifacts. Not yet pushed to npm; build and tests run in CI on every push.

## License

MIT — see [LICENSE](./LICENSE).
