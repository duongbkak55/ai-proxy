# Integrations with code agents and routers

`@duongbkak55/ai-proxy` exposes one HTTP shape: **`POST /v1/messages`** (Anthropic Messages API). It does **not** translate between provider formats and does **not** route across multiple upstreams. This is intentional — the proxy's job is DLP + auth + audit on a single Anthropic-compatible egress, not provider routing.

This page covers how to use ai-proxy with the most common AI coding tools, and how to chain it behind a multi-provider router (e.g. [9router](https://github.com/decolua/9router)) when you need both DLP and provider/quota management.

## Direct compatibility (no router needed)

Tools that natively speak the Anthropic Messages API can point straight at ai-proxy:

| Tool | How to point at ai-proxy |
|---|---|
| **Claude Code** | `export ANTHROPIC_BASE_URL=http://127.0.0.1:11434` and `export ANTHROPIC_API_KEY=<bearer-token-from-omc-proxy-auth>`; restart Claude Code. |
| **OpenClaw** | Same as Claude Code (Anthropic-compatible derivative). |
| **Cursor** (Anthropic mode) | Settings → Models → Anthropic → API Base URL: `http://127.0.0.1:11434`; API Key: token from `omc-proxy auth issue`. |
| **Cline** (VS Code) | Provider: Anthropic → Base URL: `http://127.0.0.1:11434`; API Key: token. |
| **Continue** (VS Code) | `config.json` → `models[].provider: "anthropic"`, `apiBase: "http://127.0.0.1:11434"`, `apiKey: "<token>"`. |
| **Roo Code / Kilo Code** | Same Anthropic-provider configuration as Cline/Continue. |

The bearer token sent by the client is the token issued via `omc-proxy auth issue` (multi-token mode) or whatever value `OMC_PROXY_CLIENT_TOKEN` holds (legacy mode). The proxy then injects the upstream `ANTHROPIC_API_KEY` from its own env when forwarding — clients never see the real upstream key.

## Indirect compatibility (router in front)

Tools that emit OpenAI Chat Completions, OpenAI Responses, or Gemini formats need a translator between them and ai-proxy. ai-proxy will not translate by itself.

| Tool | Native format | Compatible? |
|---|---|---|
| OpenAI Codex CLI | OpenAI Responses / Chat Completions | needs router |
| GitHub Copilot CLI | Microsoft internal | needs bridge (no public router) |
| Gemini CLI | Google Gemini | needs router |
| Antigravity (Google) | Gemini | needs router |

For these, chain a router in front:

```
┌─────────────────┐  client's native shape    ┌─────────────────┐  Anthropic Messages   ┌────────────┐  Anthropic   ┌──────────────────────┐
│  Codex / Cursor │ ───────────────────────▶  │   9router       │ ────────────────────▶ │  ai-proxy  │ ───────────▶ │  api.anthropic.com   │
│  / Cline / ...  │                           │  (route +       │                       │  (DLP +    │              │  (or compatible      │
│                 │                           │  format trans)  │                       │  audit)    │              │  upstream)           │
└─────────────────┘                           └─────────────────┘                       └────────────┘              └──────────────────────┘
```

### Pattern: 9router → ai-proxy → upstream

[9router](https://github.com/decolua/9router) speaks OpenAI Chat Completions on its public side and translates to Anthropic Messages format internally for Anthropic providers. Configure it to point at ai-proxy as a custom Anthropic-compatible upstream:

**Step 1**: Run ai-proxy as usual on `127.0.0.1:11434` with multi-token auth enabled. Issue a token for 9router:
```bash
omc-proxy auth issue --id 9router --rpm 600 --ttl 365d
# copy the printed plaintext for use in 9router
```

**Step 2**: In 9router's dashboard, add a custom Anthropic-compatible provider:
- Type: **Anthropic-compatible**
- Base URL: `http://127.0.0.1:11434`
- API Key: token issued in step 1
- Models: `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5` (or whatever your upstream supports)

**Step 3**: Point your code agent at 9router:
```
Endpoint: http://localhost:20128/v1
API Key: <key from 9router dashboard>
Model:   <model name picked through 9router routing>
```

When 9router forwards an Anthropic-bound request, it goes through ai-proxy's DLP + audit pipeline before hitting upstream. The upstream API key stays in ai-proxy's env, and 9router never sees it.

### Why chain instead of merge

The two projects answer different questions:

- **9router**: "How do I keep coding when my Claude subscription quota expires?" (multi-provider, fallback, format translation, quota tracking)
- **ai-proxy**: "How do I prevent secrets and proprietary code from leaving my network when the AI sees my prompt?" (DLP, token vault, audit, auth)

Chaining keeps each component focused and avoids reinventing the other's value. ai-proxy will not add provider routing or format translation in v0.x — see [ROADMAP.md](../ROADMAP.md).

## Direct (no router) reference configs

### Claude Code

```bash
# Issue a token
TOKEN=$(omc-proxy auth issue --id claude-code --rpm 60 --ttl 90d 2>&1 | tail -1)

# Point Claude Code at the proxy
export ANTHROPIC_BASE_URL=http://127.0.0.1:11434
export ANTHROPIC_API_KEY="$TOKEN"  # the proxy bearer, NOT the upstream sk-ant-...

# Real upstream key stays on the server side, set in ai-proxy's env:
#   export ANTHROPIC_API_KEY_UPSTREAM=sk-ant-...
# and configure proxy.jsonc → upstream.apiKeyEnv = "ANTHROPIC_API_KEY_UPSTREAM"
```

### Cline (VS Code)

```jsonc
// .vscode/settings.json
{
  "cline.apiProvider": "anthropic",
  "cline.anthropicBaseUrl": "http://127.0.0.1:11434",
  "cline.anthropicApiKey": "<token from omc-proxy auth issue>"
}
```

### Continue (VS Code)

```jsonc
// ~/.continue/config.json
{
  "models": [
    {
      "title": "Claude via ai-proxy",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "apiBase": "http://127.0.0.1:11434",
      "apiKey": "<token from omc-proxy auth issue>"
    }
  ]
}
```

### Cursor

Settings → Models → Add → Anthropic
- Custom API Endpoint: `http://127.0.0.1:11434`
- API Key: `<token from omc-proxy auth issue>`
- Model name: choose Anthropic models

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 unauthorized` from every request | Client sending no bearer or wrong token | Re-issue with `omc-proxy auth list` and re-paste; verify it's not the upstream `sk-ant-...` key. |
| `429` immediately on first request | Per-token RPM too low for the agent | `omc-proxy auth rotate` with higher `--rpm`, or config `auth.tokens[].rateLimit.rpm`. |
| `502` from caddy / 500 from proxy | Upstream `ANTHROPIC_API_KEY` not set in proxy env | Set it on the proxy host (not the client). Check `omc-proxy config print`. |
| Tool reports model not found | Some agents send model names the upstream rejects | Pin model in client config or check upstream allowlist. |
| Garbled streaming output | SSE detokenizer split on a vault token boundary | Should self-recover; if persistent, file an issue with a minimal reproducer (no real PII). |

## What ai-proxy will *not* add

- Multi-provider routing (use 9router or LiteLLM in front).
- OpenAI/Gemini format translation (use a router; ai-proxy stays Anthropic-shaped).
- Per-IP rate-limit (auth lane is per-token only — put a reverse proxy in front for per-IP limits).
- OAuth/OIDC client auth (bearer only).

These are deliberate scope choices, not gaps. See [ROADMAP.md](../ROADMAP.md) for the full out-of-scope list.
