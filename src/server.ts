/**
 * AI Egress Proxy HTTP server. Anthropic-compatible /v1/messages, DLP-filtered,
 * allowlist-enforced. Node built-in `http` + `fetch` only — no framework dep.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { randomUUID, timingSafeEqual, createHash } from "crypto";
import { once } from "events";
import type { ProxyConfig } from "./config.js";
import { compileConfigPatterns } from "./config.js";
import {
  redactAnthropicRequest,
  SseDetokenizer,
  detokenizeValue,
  type AnthropicRequestBody,
  type VaultContext,
} from "./dlp.js";
import { InProcessTokenVault } from "./vault.js";
import { Dictionary, type DictionaryEntry } from "./dictionary.js";
import { SqlLane } from "./sql-lane.js";
import { AstLane } from "./ast-lane.js";
import { scanRequestForBannedTools, validateUpstreamUrl } from "./allowlist.js";
import { auditEvent, summarizeMatches, auditFilePath } from "./audit.js";
import {
  defaultToolRegistry,
  runAgentLoop,
  parseUpstreamResponse,
  UpstreamShapeError,
  type UpstreamClient,
} from "./agent-loop.js";
import { AuthGate } from "./auth.js";

interface Metrics {
  requests_total: number;
  blocked_total: number;
  redacted_total: number;
  tool_calls_total: number;
  hitl_pending: number;
  errors_total: number;
}

export interface StartedProxy {
  port: number;
  host: string;
  close(): Promise<void>;
  metrics(): Readonly<Metrics>;
}

const MAX_BODY_BYTES_HARD = 5_000_000;

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) {
        reject(new Error(`Request body exceeds ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/**
 * Parse OMC_PROXY_CORS_ORIGIN into a Set. Empty/unset = CORS disabled.
 * Special value "*" enables wildcard (echoed back as the requesting origin
 * when credentials are not used — Anthropic-style usage doesn't need cookies).
 */
function parseCorsOrigins(): { wildcard: boolean; origins: Set<string> } {
  const raw = process.env.OMC_PROXY_CORS_ORIGIN ?? "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const wildcard = list.includes("*");
  return { wildcard, origins: new Set(list) };
}

function applyCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cors: { wildcard: boolean; origins: Set<string> },
  config: ProxyConfig,
): boolean {
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin.length === 0) return false;
  const allowed = cors.wildcard || cors.origins.has(origin);
  if (!allowed) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Authorization, Content-Type, ${config.conversation.headerName}`,
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function clientIp(req: IncomingMessage): string {
  // Only trust X-Forwarded-For when explicitly enabled; otherwise a client
  // can spoof their source IP by setting the header directly.
  if (process.env.OMC_PROXY_TRUST_PROXY === "1") {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(provided, "utf-8");
  if (a.length !== b.length) {
    // Still burn the time so length is not a side channel for the short one.
    const pad = Buffer.alloc(a.length, 0);
    try {
      timingSafeEqual(a, pad);
    } catch {
      /* ignore */
    }
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Enforce bearer-token auth on every non-/health route. Returns either:
 *   - { handled: true, tokenId? }: response already written (401/429/503) or auth passed.
 *     If auth passed, `tokenId` is the matched token id (for audit).
 *   - { handled: false }: this should not happen — every code path writes or returns ok.
 *
 * Two modes:
 *   1. Multi-token (Phase B): if `gate` is provided (config has tokens or tokensFile),
 *      delegates to AuthGate which supports rotation, expiry, scopes, rate-limit.
 *   2. Legacy single-token: env-based check against `process.env[config.auth.tokenEnv]`.
 *      Preserved for backward compatibility with existing deployments.
 */
async function enforceProxyAuth(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  gate: AuthGate | null,
): Promise<{ handled: true; ok: boolean; tokenId?: string }> {
  if (gate) {
    const result = await gate.validate(req.headers);
    if (result.ok) {
      return { handled: true, ok: true, tokenId: result.tokenId };
    }
    if (result.status === 429) {
      const retrySec = Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000));
      res.setHeader("Retry-After", String(retrySec));
      writeJson(res, 429, { error: "rate limit exceeded" });
      return { handled: true, ok: false };
    }
    writeJson(res, 401, { error: "unauthorized" });
    return { handled: true, ok: false };
  }

  // Legacy env-based path.
  const expected = process.env[config.auth.tokenEnv];
  if (!expected || expected.length === 0) {
    writeJson(res, 503, { error: "proxy auth not configured" });
    return { handled: true, ok: false };
  }
  const authHeader = req.headers["authorization"];
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    writeJson(res, 401, { error: "unauthorized" });
    return { handled: true, ok: false };
  }
  const provided = authHeader.slice("Bearer ".length).trim();
  if (!constantTimeTokenMatch(expected, provided)) {
    writeJson(res, 401, { error: "unauthorized" });
    return { handled: true, ok: false };
  }
  return { handled: true, ok: true };
}

export interface StartProxyOptions {
  config: ProxyConfig;
  // allow tests to inject a custom upstream (e.g. a local mock server URL)
  upstreamBaseUrlOverride?: string;
}

export async function startProxy(opts: StartProxyOptions): Promise<StartedProxy> {
  const { config } = opts;
  const upstreamBaseUrl = opts.upstreamBaseUrlOverride ?? config.upstream.baseUrl;

  const host = config.listen.host;
  if (
    (host === "0.0.0.0" || host === "::") &&
    process.env.OMC_PROXY_ALLOW_PUBLIC !== "1"
  ) {
    throw new Error(
      `Refusing to bind to public interface '${host}'. Set OMC_PROXY_ALLOW_PUBLIC=1 to override.`,
    );
  }

  const patterns = compileConfigPatterns(config);
  const tools = defaultToolRegistry();
  const vault = new InProcessTokenVault({
    ttlMs: config.vault.ttlSeconds * 1000,
  });
  const dictionaryEntries: DictionaryEntry[] = [
    ...(config.dictionary.entries ?? []),
  ];
  if (config.dictionary.path && existsSync(config.dictionary.path)) {
    try {
      const raw = readFileSync(config.dictionary.path, "utf-8");
      const extra = JSON.parse(raw) as DictionaryEntry[];
      if (Array.isArray(extra)) {
        for (const e of extra) dictionaryEntries.push(e);
      }
    } catch {
      // Silent: bad dict file shouldn't take the proxy down.
    }
  }
  const dictionary =
    dictionaryEntries.length > 0 ? new Dictionary(dictionaryEntries) : undefined;
  const sqlLane = config.sqlDlp.enabled
    ? new SqlLane({
        enabled: true,
        includeColumns: config.sqlDlp.includeColumns,
        dialect: config.sqlDlp.dialect,
      })
    : undefined;
  const astLane = config.astDlp.enabled
    ? new AstLane({
        enabled: true,
        languages: config.astDlp.languages,
      })
    : undefined;
  // Auth gate: enabled iff multi-token config provided. Otherwise the request
  // path falls back to the legacy env-based single-token check.
  const authGate: AuthGate | null =
    config.auth.tokens.length > 0 || config.auth.tokensFile
      ? new AuthGate({
          headerName: config.auth.headerName,
          inlineTokens: config.auth.tokens,
          tokensFile: config.auth.tokensFile,
        })
      : null;
  const convHeaderLower = config.conversation.headerName.toLowerCase();
  const CONV_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function deriveConversationId(
    req: IncomingMessage,
    body: AnthropicRequestBody,
  ): string {
    const hdr = req.headers[convHeaderLower];
    const headerVal = Array.isArray(hdr) ? hdr[0] : hdr;
    if (typeof headerVal === "string" && CONV_ID_RE.test(headerVal)) {
      return headerVal;
    }
    const auth = req.headers["authorization"];
    const token =
      typeof auth === "string" && auth.startsWith("Bearer ")
        ? auth.slice("Bearer ".length).trim().slice(0, 16)
        : "anon";
    let sys = "";
    if (typeof body.system === "string") sys = body.system;
    else if (Array.isArray(body.system)) {
      for (const b of body.system) {
        if (b && typeof b.text === "string") {
          sys += b.text;
          if (sys.length > 512) break;
        }
      }
    }
    if (token !== "anon" || sys.length > 0) {
      return createHash("sha256")
        .update(token + sys.slice(0, 512))
        .digest("hex")
        .slice(0, 16);
    }
    return randomUUID().replace(/-/g, "").slice(0, 16);
  }

  const metrics: Metrics = {
    requests_total: 0,
    blocked_total: 0,
    redacted_total: 0,
    tool_calls_total: 0,
    hitl_pending: 0,
    errors_total: 0,
  };

  const upstreamClient: UpstreamClient = {
    async createMessage(body) {
      const url = `${upstreamBaseUrl.replace(/\/$/, "")}/v1/messages`;
      const check = validateUpstreamUrl(url, config.allowlist, upstreamBaseUrl);
      if (!check.allowed) {
        throw new Error(`Upstream URL rejected: ${check.reason}`);
      }
      const apiKey = process.env[config.upstream.apiKeyEnv] ?? "";
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Upstream ${resp.status}: ${text.slice(0, 500)}`);
      }
      const raw = (await resp.json()) as unknown;
      return parseUpstreamResponse(raw);
    },
  };

  const cors = parseCorsOrigins();

  const server = createServer(async (req, res) => {
    const reqId = randomUUID();
    const ip = clientIp(req);
    const started = Date.now();
    const url = req.url ?? "/";

    // Apply CORS headers (no-op if origin not in allowlist or CORS disabled).
    applyCorsHeaders(req, res, cors, config);

    // Preflight: respond before auth so browser can negotiate.
    if (req.method === "OPTIONS") {
      const origin = req.headers["origin"];
      const ok =
        typeof origin === "string" &&
        (cors.wildcard || cors.origins.has(origin));
      res.writeHead(ok ? 204 : 403);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && url === "/health") {
        writeJson(res, 200, { status: "ok" });
        return;
      }

      // Vault debug dump — no auth; safe because server binds to 127.0.0.1.
      if (req.method === "GET" && url.split("?")[0] === "/debug/vault") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const convId = params.get("convId") ?? "";
        const tokens = convId ? vault.dumpConv(convId) : [];
        writeJson(res, 200, { convId, tokens });
        return;
      }

      // Debug log stream — no auth; safe because server binds to 127.0.0.1.
      // EventSource API cannot send custom headers, so auth is skipped here.
      if (req.method === "GET" && url.split("?")[0] === "/debug/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.flushHeaders();

        const auditFile = auditFilePath(config.audit.dir);
        let pos = 0;
        try { pos = statSync(auditFile).size; } catch { /* file not yet created */ }

        let lineBuf = "";
        const tick = setInterval(() => {
          try {
            const size = statSync(auditFile).size;
            if (size <= pos) return;
            const fd = openSync(auditFile, "r");
            const chunk = Buffer.alloc(size - pos);
            readSync(fd, chunk, 0, chunk.length, pos);
            closeSync(fd);
            pos = size;
            lineBuf += chunk.toString("utf-8");
            let nl: number;
            while ((nl = lineBuf.indexOf("\n")) >= 0) {
              const line = lineBuf.slice(0, nl).trim();
              lineBuf = lineBuf.slice(nl + 1);
              if (line) res.write(`data: ${line}\n\n`);
            }
          } catch { /* file unavailable */ }
        }, 300);

        req.on("close", () => clearInterval(tick));
        return;
      }

      // All non-/health routes require bearer-token auth.
      const authOutcome = await enforceProxyAuth(req, res, config, authGate);
      if (!authOutcome.ok) {
        return;
      }

      if (req.method === "GET" && url === "/metrics") {
        const lines = [
          `# HELP omc_proxy_requests_total Total requests handled`,
          `# TYPE omc_proxy_requests_total counter`,
          `omc_proxy_requests_total ${metrics.requests_total}`,
          `# HELP omc_proxy_blocked_total Requests or streams blocked by DLP/allowlist`,
          `# TYPE omc_proxy_blocked_total counter`,
          `omc_proxy_blocked_total ${metrics.blocked_total}`,
          `# HELP omc_proxy_redacted_total DLP redaction events`,
          `# TYPE omc_proxy_redacted_total counter`,
          `omc_proxy_redacted_total ${metrics.redacted_total}`,
          `# HELP omc_proxy_tool_calls_total Tool calls processed`,
          `# TYPE omc_proxy_tool_calls_total counter`,
          `omc_proxy_tool_calls_total ${metrics.tool_calls_total}`,
          `# HELP omc_proxy_hitl_pending Current pending HITL approvals`,
          `# TYPE omc_proxy_hitl_pending gauge`,
          `omc_proxy_hitl_pending ${metrics.hitl_pending}`,
          `# HELP omc_proxy_errors_total Internal proxy errors`,
          `# TYPE omc_proxy_errors_total counter`,
          `omc_proxy_errors_total ${metrics.errors_total}`,
          "",
        ];
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(lines.join("\n"));
        return;
      }

      if (req.method === "POST" && url === "/v1/messages") {
        metrics.requests_total += 1;

        const apiKey = process.env[config.upstream.apiKeyEnv];
        if (!apiKey) {
          metrics.errors_total += 1;
          writeJson(res, 500, {
            error: {
              type: "config_error",
              message: `Upstream API key env var '${config.upstream.apiKeyEnv}' is not set`,
            },
          });
          auditEvent(config.audit.dir, {
            reqId,
            clientIp: ip,
            phase: "error",
            error: "missing_api_key",
          });
          return;
        }

        const rawBody = await readBody(
          req,
          Math.min(MAX_BODY_BYTES_HARD, config.audit.maxBodyBytes * 5),
        );
        let parsed: AnthropicRequestBody;
        try {
          parsed = JSON.parse(rawBody.toString("utf-8")) as AnthropicRequestBody;
        } catch (err) {
          metrics.errors_total += 1;
          writeJson(res, 400, {
            error: { type: "invalid_json", message: String(err) },
          });
          return;
        }

        const toolScan = scanRequestForBannedTools(parsed, config.allowlist);
        if (!toolScan.allowed) {
          metrics.blocked_total += 1;
          auditEvent(config.audit.dir, {
            reqId,
            clientIp: ip,
            phase: "block",
            model: parsed.model,
            blocked: true,
            bytesIn: rawBody.length,
            latencyMs: Date.now() - started,
            meta: {
              reason: "banned_tool",
              tools: toolScan.blocked.map((b) => b.name).join(","),
            },
          });
          writeJson(res, 400, {
            error: {
              type: "allowlist_blocked",
              message: "Request contains non-allowlisted tools",
              tools: toolScan.blocked,
            },
          });
          return;
        }

        const convId = deriveConversationId(req, parsed);
        const vaultCtx: VaultContext = { convId, vault };
        const dlp = redactAnthropicRequest(parsed, patterns, {
          vault: vaultCtx,
          dictionary,
          sqlLane,
          astLane,
        });
        if (dlp.blocked) {
          metrics.blocked_total += 1;
          auditEvent(config.audit.dir, {
            reqId,
            clientIp: ip,
            phase: "block",
            model: parsed.model,
            blocked: true,
            bytesIn: rawBody.length,
            dlpMatches: summarizeMatches(dlp.matches),
            latencyMs: Date.now() - started,
            convId,
          });
          writeJson(res, 400, {
            error: {
              type: "dlp_blocked",
              message: "Request contains sensitive content and was blocked",
              matches: dlp.blockedReasons,
            },
          });
          return;
        }

        if (dlp.matches.length > 0) {
          metrics.redacted_total += dlp.matches.length;
        }

        const redactedBody = dlp.body;
        const isStream = redactedBody.stream === true;
        const useAgentLoop =
          config.agentLoop.enabled &&
          typeof redactedBody.metadata === "object" &&
          redactedBody.metadata !== null &&
          (redactedBody.metadata as Record<string, unknown>).agent_loop === true;

        const lastMsg = redactedBody.messages?.at(-1);
        const bodyPreview = (() => {
          const c = lastMsg?.content;
          if (typeof c === "string") return c.slice(0, 300);
          if (Array.isArray(c)) {
            return c
              .filter((b) => (b as { type: string }).type === "text")
              .map((b) => (b as { text: string }).text)
              .join(" ")
              .slice(0, 300);
          }
          return "";
        })();

        auditEvent(config.audit.dir, {
          reqId,
          clientIp: ip,
          phase: "request",
          model: redactedBody.model,
          bytesIn: rawBody.length,
          dlpMatches: summarizeMatches(dlp.matches),
          blocked: false,
          convId,
          bodyPreview: bodyPreview || undefined,
        });

        if (useAgentLoop) {
          const agentAbort = new AbortController();
          const onClose = (): void => agentAbort.abort();
          req.on("close", onClose);
          try {
            const result = await runAgentLoop(redactedBody, {
              config,
              upstream: upstreamClient,
              tools,
              patterns,
              auditDir: config.audit.dir,
              reqId,
              abortSignal: agentAbort.signal,
            });
            metrics.tool_calls_total += 1;
            writeJson(res, 200, result);
            auditEvent(config.audit.dir, {
              reqId,
              phase: "response",
              model: result.model,
              bytesOut: Buffer.byteLength(JSON.stringify(result)),
              latencyMs: Date.now() - started,
            });
          } catch (err) {
            metrics.errors_total += 1;
            const isShapeErr = err instanceof UpstreamShapeError;
            writeJson(res, isShapeErr ? 502 : 502, {
              error: {
                type: isShapeErr ? "upstream_invalid" : "agent_loop_error",
                message: String(err),
              },
            });
            auditEvent(
              config.audit.dir,
              {
                reqId,
                phase: "error",
                error: String(err),
                latencyMs: Date.now() - started,
              },
              patterns,
            );
          } finally {
            req.off("close", onClose);
          }
          return;
        }

        // Forward to real upstream
        const upstreamUrl = `${upstreamBaseUrl.replace(/\/$/, "")}/v1/messages`;
        const upstreamCheck = validateUpstreamUrl(
          upstreamUrl,
          config.allowlist,
          upstreamBaseUrl,
        );
        if (!upstreamCheck.allowed) {
          metrics.errors_total += 1;
          writeJson(res, 500, {
            error: {
              type: "upstream_blocked",
              message: upstreamCheck.reason,
            },
          });
          return;
        }

        const controller = new AbortController();
        // If the client disconnects, abort upstream fetch + reader immediately.
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        const onClientClose = (): void => {
          controller.abort();
          reader?.cancel().catch(() => {});
        };
        req.on("close", onClientClose);

        let upstreamResp: Response;
        try {
          upstreamResp = await fetch(upstreamUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              accept: isStream ? "text/event-stream" : "application/json",
            },
            body: JSON.stringify(redactedBody),
            signal: controller.signal,
          });
        } catch (err) {
          metrics.errors_total += 1;
          writeJson(res, 502, {
            error: { type: "upstream_fetch_error", message: String(err) },
          });
          auditEvent(
            config.audit.dir,
            {
              reqId,
              phase: "error",
              error: String(err),
              latencyMs: Date.now() - started,
            },
            patterns,
          );
          return;
        }

        if (isStream) {
          res.writeHead(upstreamResp.status, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          if (!upstreamResp.body) {
            res.end();
            return;
          }
          reader = upstreamResp.body.getReader();
          const decoder = new TextDecoder();
          let bytesOut = 0;
          let streamRedacted = 0;
          let streamBlocked = false;
          // Outbound (client→upstream) was already redacted/tokenized before
          // the fetch. On the inbound (upstream→client) stream, first
          // detokenize so echoed tokens become originals, then run the
          // redactor as a safety net in case the model emits a brand-new
          // secret (not from vault) that matches a block/redact pattern.
          //
          const sseDetok = new SseDetokenizer(convId, vault);
          const writeWithBackpressure = async (
            chunk: string,
          ): Promise<void> => {
            bytesOut += Buffer.byteLength(chunk);
            if (!res.write(chunk)) {
              await once(res, "drain");
            }
          };
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const decoded = decoder.decode(value, { stream: true });
              const detoked = sseDetok.push(decoded);
              if (detoked.emit.length > 0) {
                await writeWithBackpressure(detoked.emit);
              }
            }
            if (!streamBlocked) {
              const tail = sseDetok.flush();
              if (tail.emit.length > 0) {
                await writeWithBackpressure(tail.emit);
              }
            }
          } catch (err) {
            metrics.errors_total += 1;
            auditEvent(
              config.audit.dir,
              {
                reqId,
                phase: "error",
                error: String(err),
                latencyMs: Date.now() - started,
              },
              patterns,
            );
          } finally {
            req.off("close", onClientClose);
            res.end();
          }
          metrics.redacted_total += streamRedacted;
          if (streamBlocked) metrics.blocked_total += 1;
          auditEvent(config.audit.dir, {
            reqId,
            phase: "response",
            model: redactedBody.model,
            bytesOut,
            latencyMs: Date.now() - started,
            meta: {
              stream: true,
              streamRedacted,
              streamBlocked,
            },
          });
          return;
        }

        req.off("close", onClientClose);
        const respText = await upstreamResp.text();
        const contentType =
          upstreamResp.headers.get("content-type") ?? "application/json";
        let outText = respText;
        if (contentType.includes("application/json")) {
          try {
            const json = JSON.parse(respText) as unknown;
            const detoked = detokenizeValue(json, convId, vault);
            outText = JSON.stringify(detoked);
          } catch {
            // non-JSON or malformed — forward as-is.
          }
        }
        res.writeHead(upstreamResp.status, {
          "content-type": contentType,
        });
        res.end(outText);
        auditEvent(config.audit.dir, {
          reqId,
          phase: "response",
          model: redactedBody.model,
          bytesOut: Buffer.byteLength(outText),
          latencyMs: Date.now() - started,
        });
        return;
      }

      writeJson(res, 404, { error: { type: "not_found" } });
    } catch (err) {
      metrics.errors_total += 1;
      try {
        writeJson(res, 500, {
          error: { type: "internal", message: String(err) },
        });
      } catch {
        // already sent; nothing to do
      }
      auditEvent(config.audit.dir, {
        reqId,
        phase: "error",
        error: String(err),
        latencyMs: Date.now() - started,
      });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Failed to resolve listen port"));
    });
  });

  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    metrics: () => ({ ...metrics }),
  };
}

export type { Server };
