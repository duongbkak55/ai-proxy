# Deploy `@duongbkak55/ai-proxy`

Three supported deployment modes:

1. **Docker Compose** (recommended) — proxy + caddy + auto-HTTPS, single host
2. **systemd + reverse proxy** — bare-metal Linux server
3. **Manual binary** — quick test or non-Linux host

## Mode 1 — Docker Compose

```bash
# 1. Clone or fetch deploy/ from the repo
curl -L https://github.com/duongbkak55/ai-proxy/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 ai-proxy-main/deploy

cd deploy

# 2. Customize config
cp sample-config.jsonc config.jsonc
# edit config.jsonc — set auth tokens, allowlist, etc.

# 3. Set env
cat > .env <<EOF
DOMAIN=proxy.your-domain.com
ACME_EMAIL=ops@your-domain.com
ANTHROPIC_API_KEY=sk-ant-...
EOF

# 4. Boot
docker compose up -d

# 5. Verify
curl https://proxy.your-domain.com/healthz
```

DNS: point `DOMAIN` A/AAAA records at the host before starting (caddy needs reachability for ACME challenge).

## Mode 2 — systemd + reverse proxy (bare metal)

```bash
# 1. Install Node 20+
sudo apt-get install -y nodejs npm   # or your distro equivalent

# 2. Install proxy (when published)
sudo npm install -g @duongbkak55/ai-proxy
# Or, build from source:
git clone https://github.com/duongbkak55/ai-proxy /opt/omc-proxy
cd /opt/omc-proxy && npm ci && npm run build

# 3. Create user + dirs
sudo useradd --system --shell /usr/sbin/nologin omc-proxy
sudo mkdir -p /etc/omc-proxy /var/lib/omc-proxy/audit /var/log/omc-proxy
sudo chown -R omc-proxy:omc-proxy /var/lib/omc-proxy /var/log/omc-proxy

# 4. Place config
sudo cp deploy/sample-config.jsonc /etc/omc-proxy/config.jsonc
sudo chmod 640 /etc/omc-proxy/config.jsonc
sudo chown root:omc-proxy /etc/omc-proxy/config.jsonc

# 5. Env file
sudo tee /etc/omc-proxy/env <<EOF
ANTHROPIC_API_KEY=sk-ant-...
EOF
sudo chmod 600 /etc/omc-proxy/env

# 6. Install systemd unit
sudo cp deploy/systemd/omc-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now omc-proxy

# 7. Verify
sudo systemctl status omc-proxy
journalctl -u omc-proxy -f
```

Front with caddy/nginx/traefik for TLS — bind config to `127.0.0.1:11434` and reverse-proxy from edge.

## Mode 3 — Manual binary (testing)

```bash
git clone https://github.com/duongbkak55/ai-proxy
cd ai-proxy
npm ci && npm run build
ANTHROPIC_API_KEY=sk-ant-... node dist/cli.js start --config deploy/sample-config.jsonc
```

## Env vars reference

| Variable | Purpose | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | Upstream API key for `api.anthropic.com` | yes |
| `OMC_PROXY_SQL_DLP` | Enable SQL DLP lane (`1` to enable) | no, default off |
| `OMC_PROXY_AST_DLP` | Enable AST DLP lane (`1` to enable) | no, default off |
| `DOMAIN` (compose only) | TLS domain caddy serves | for compose |
| `ACME_EMAIL` (compose only) | Let's Encrypt notification email | for compose |

## Token rotation (Phase B)

```bash
# Issue a new token (returns plaintext once, hash is stored)
omc-proxy auth issue --id new-client --rpm 60 --ttl 90d

# List tokens
omc-proxy auth list

# Rotate (issue replacement, mark old as rotatedFrom)
omc-proxy auth rotate <id>

# Revoke
omc-proxy auth revoke <id>
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EACCES` on bind | Port < 1024 needs root | Use port ≥ 1024 or grant `CAP_NET_BIND_SERVICE` |
| `502` from caddy | proxy container not ready | `docker compose logs omc-proxy` |
| `401` on every request | Auth enabled, missing/wrong header | Check `Authorization: Bearer <token>` |
| `429` immediately | Rate-limit too low for client traffic | Raise `tokens[].rateLimit.rpm` |
| Audit directory growing | No rotation | Add cron `find /var/lib/omc-proxy/audit -mtime +30 -delete` |

## TLS

Default: caddy auto-renews via Let's Encrypt.

Bring-your-own-cert: edit `Caddyfile` to use the `tls /path/to/cert.pem /path/to/key.pem` directive instead of relying on auto-HTTPS.

## Out of scope (this release)

- K8s manifests / Helm chart — track upstream issue for v0.2.
- Horizontal scaling — current rate-limit is in-process; deploy single replica or accept per-replica limit.
- OAuth/OIDC — bearer token only this release.
