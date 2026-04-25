# Web demo

Visual, interactive demo of the DLP pipeline. Designed for sharing with non-engineers (managers, stakeholders) who want to see what goes in vs. what reaches the upstream API.

## What it shows

- **3-pane flow**: Client → Proxy (DLP) → Upstream
- **Live transformation**: paste any prompt, see tokens being issued and the redacted body the model would receive
- **Vault table**: token → original mapping (conversation-scoped)
- **Audit event**: shape of the JSONL audit entry the proxy would write to disk
- **Round-trip**: simulated upstream reply that echoes tokens, then detokenized for the client

The DLP code running in the page is the **actual** `src/dlp.ts`, `src/dictionary.ts`, and `src/vault.ts` — bundled for the browser via esbuild. SQL/AST lanes (which need native bindings) are not included; everything else matches production behavior.

## Running locally

Build the bundle once after pulling new code:

```bash
node demo/web/build.mjs
```

Then open the page. Any local HTTP server works — for example:

```bash
cd demo/web
python3 -m http.server 8000
# open http://localhost:8000
```

Or, if you have `npx`:

```bash
npx --yes serve demo/web
```

> The demo runs **100% in the browser** — no proxy server, no upstream API call. The DLP transformation is real; the upstream "reply" is simulated for illustration.

## Sample scenarios

The page ships with five built-in samples:

1. **PII (email, phone)** — straightforward tokenization
2. **Codename + internal package** — dictionary lane in action
3. **Secret blocked** — hard-stop on `sk-ant-…` (request never reaches upstream)
4. **Full mix (real-world)** — combination of all of the above plus fenced TS code
5. **Custom…** — paste your own prompt

Click a button to load the sample, then **▶ Run pipeline**. Cmd/Ctrl+Enter from the textarea also runs.

## Layout (for screen-sharing)

The page is optimized for 1400-px wide display. On smaller screens, the panels stack vertically. For a polished demo:

- Use a 1080p+ monitor at 100% zoom
- Maximize the browser window
- Pre-load the **Full mix** scenario before sharing screen
- Walk through the steps top-to-bottom: input → decision → upstream view → vault → audit → reply round-trip

## What this demo does NOT show

- Actual HTTP server (use `omc-proxy start` for the real service)
- SQL DLP lane (fenced ```sql blocks)
- Source-code AST lane (fenced ```ts/py/java identifier extraction)
- Auth lane (bearer token + rate-limit)
- SSE streaming + chunked detokenization
- Allowlist + SSRF guard

These exist in the production proxy — see [`docs/security-design.md`](../../docs/security-design.md) and [`docs/auth.md`](../../docs/auth.md).
