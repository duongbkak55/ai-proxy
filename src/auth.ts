/**
 * AI Egress Proxy — auth lane.
 *
 * Multi-token bearer auth with rotation, expiration, and per-token rate-limit
 * (token bucket, in-process). Coexists with the legacy env-based single token:
 * if `auth.tokens` is empty and `auth.tokensFile` is unset, callers fall back
 * to the env-based path in `server.ts` for backward compatibility.
 *
 * Plaintext tokens are NEVER stored or logged. Storage holds sha256 hashes.
 */

import { timingSafeEqual, createHash, randomBytes } from "crypto";
import { existsSync } from "fs";
import { z } from "zod";
import { atomicWriteJsonSync, safeReadJson } from "./lib/atomic-write.js";

// ─── Schemas ──────────────────────────────────────────────────────────────

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

export const TokenRecordSchema = z.object({
  id: z.string().min(1).max(128),
  hash: z.string().regex(HASH_RE),
  scopes: z.array(z.string().min(1)).default(["proxy:request"]),
  rateLimit: z
    .object({
      rpm: z.number().int().positive().default(60),
      perDay: z.number().int().positive().default(100_000),
    })
    .default({ rpm: 60, perDay: 100_000 }),
  expiresAt: z.string().datetime().optional(),
  rotatedFrom: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type TokenRecord = z.infer<typeof TokenRecordSchema>;

export const TokenStoreFileSchema = z.object({
  version: z.literal(1),
  tokens: z.array(TokenRecordSchema),
});

export type TokenStoreFile = z.infer<typeof TokenStoreFileSchema>;

// ─── Hashing ──────────────────────────────────────────────────────────────

export function hashToken(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("hashToken: plaintext must be non-empty string");
  }
  return "sha256:" + createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function compareToken(plaintext: string, storedHash: string): boolean {
  if (
    typeof plaintext !== "string" ||
    typeof storedHash !== "string" ||
    !HASH_RE.test(storedHash)
  ) {
    return false;
  }
  const computed = hashToken(plaintext);
  if (computed.length !== storedHash.length) {
    return false;
  }
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return timingSafeEqual(a, b);
}

/**
 * Generate a new bearer token.
 * Returns the plaintext (~43 chars, base64url of 32 random bytes) and its hash.
 * Plaintext is shown to the user ONCE; only the hash is stored.
 */
export function generateToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("base64url");
  return { plaintext, hash: hashToken(plaintext) };
}

// ─── Rate limiter (token bucket) ──────────────────────────────────────────

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /**
   * Attempt to consume 1 token from the bucket for `id`.
   * `rpm` is the bucket capacity AND refill rate per minute.
   */
  check(id: string, rpm: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    if (rpm <= 0) {
      return { allowed: false, retryAfterMs: 60_000 };
    }
    const now = this.clock();
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = { tokens: rpm, lastRefill: now };
      this.buckets.set(id, bucket);
    }
    const elapsed = Math.max(0, now - bucket.lastRefill);
    const refill = (elapsed / 60_000) * rpm;
    bucket.tokens = Math.min(rpm, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    const retryAfterMs = Math.ceil(((1 - bucket.tokens) * 60_000) / rpm);
    return { allowed: false, retryAfterMs };
  }

  reset(id?: string): void {
    if (id !== undefined) {
      this.buckets.delete(id);
    } else {
      this.buckets.clear();
    }
  }
}

// ─── Token store (file-backed) ────────────────────────────────────────────

export class TokenStore {
  constructor(private filePath: string) {}

  async load(): Promise<TokenRecord[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = await safeReadJson<unknown>(this.filePath);
    if (raw === null) {
      return [];
    }
    const parsed = TokenStoreFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `TokenStore: ${this.filePath} is malformed: ${parsed.error.message}`,
      );
    }
    return parsed.data.tokens;
  }

  save(tokens: TokenRecord[]): void {
    const file: TokenStoreFile = { version: 1, tokens };
    atomicWriteJsonSync(this.filePath, file);
  }

  async issue(opts: {
    id: string;
    scopes?: string[];
    rpm?: number;
    perDay?: number;
    ttlSeconds?: number;
  }): Promise<{ plaintext: string; record: TokenRecord }> {
    const tokens = await this.load();
    if (tokens.some((t) => t.id === opts.id)) {
      throw new Error(`token id '${opts.id}' already exists`);
    }
    const { plaintext, hash } = generateToken();
    const record: TokenRecord = {
      id: opts.id,
      hash,
      scopes: opts.scopes && opts.scopes.length > 0 ? opts.scopes : ["proxy:request"],
      rateLimit: { rpm: opts.rpm ?? 60, perDay: opts.perDay ?? 100_000 },
      expiresAt: opts.ttlSeconds
        ? new Date(Date.now() + opts.ttlSeconds * 1000).toISOString()
        : undefined,
      createdAt: new Date().toISOString(),
    };
    tokens.push(record);
    this.save(tokens);
    return { plaintext, record };
  }

  async revoke(id: string): Promise<boolean> {
    const tokens = await this.load();
    const idx = tokens.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    tokens.splice(idx, 1);
    this.save(tokens);
    return true;
  }

  async rotate(oldId: string, newId: string): Promise<{ plaintext: string; record: TokenRecord }> {
    const tokens = await this.load();
    const old = tokens.find((t) => t.id === oldId);
    if (!old) {
      throw new Error(`token id '${oldId}' not found`);
    }
    if (tokens.some((t) => t.id === newId)) {
      throw new Error(`token id '${newId}' already exists`);
    }
    const { plaintext, hash } = generateToken();
    const record: TokenRecord = {
      id: newId,
      hash,
      scopes: old.scopes,
      rateLimit: old.rateLimit,
      expiresAt: old.expiresAt,
      rotatedFrom: oldId,
      createdAt: new Date().toISOString(),
    };
    tokens.push(record);
    this.save(tokens);
    return { plaintext, record };
  }
}

// ─── Gate (combines store + limiter, validates an HTTP request) ────────────

export interface AuthSuccess {
  ok: true;
  tokenId: string;
  scopes: string[];
}
export interface AuthFailure {
  ok: false;
  status: 401 | 429;
  reason: string;
  retryAfterMs?: number;
}
export type AuthResult = AuthSuccess | AuthFailure;

export interface AuthGateConfig {
  headerName: string;
  inlineTokens: TokenRecord[];
  tokensFile?: string;
  requiredScope?: string;
}

export class AuthGate {
  private headerName: string;
  private requiredScope: string | undefined;
  private store: TokenStore | undefined;
  private inlineTokens: TokenRecord[];

  constructor(
    config: AuthGateConfig,
    public readonly limiter: RateLimiter = new RateLimiter(),
  ) {
    this.headerName = config.headerName.toLowerCase();
    this.requiredScope = config.requiredScope;
    this.inlineTokens = config.inlineTokens;
    this.store = config.tokensFile ? new TokenStore(config.tokensFile) : undefined;
  }

  /**
   * Validate the bearer token attached to an inbound request.
   * Returns either success (with tokenId for audit) or failure (with status+reason).
   */
  async validate(headers: Record<string, string | string[] | undefined>): Promise<AuthResult> {
    const raw = headers[this.headerName];
    const headerVal = Array.isArray(raw) ? raw[0] : raw;
    if (typeof headerVal !== "string" || !headerVal.startsWith("Bearer ")) {
      return { ok: false, status: 401, reason: "missing or malformed bearer header" };
    }
    const plaintext = headerVal.slice("Bearer ".length).trim();
    if (plaintext.length === 0) {
      return { ok: false, status: 401, reason: "empty bearer token" };
    }

    // Build candidate set: inline + file-backed.
    const candidates: TokenRecord[] = [...this.inlineTokens];
    if (this.store) {
      try {
        const fileTokens = await this.store.load();
        candidates.push(...fileTokens);
      } catch {
        // Don't leak storage errors to clients; deny by default.
        return { ok: false, status: 401, reason: "auth backend unavailable" };
      }
    }

    for (const t of candidates) {
      if (!compareToken(plaintext, t.hash)) continue;

      // Hash matched — check expiry.
      if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) {
        return { ok: false, status: 401, reason: "token expired" };
      }
      // Check scope.
      if (this.requiredScope && !t.scopes.includes(this.requiredScope)) {
        return { ok: false, status: 401, reason: "insufficient scope" };
      }
      // Check rate limit.
      const rl = this.limiter.check(t.id, t.rateLimit.rpm);
      if (!rl.allowed) {
        return {
          ok: false,
          status: 429,
          reason: "rate limit exceeded",
          retryAfterMs: rl.retryAfterMs,
        };
      }
      return { ok: true, tokenId: t.id, scopes: t.scopes };
    }

    return { ok: false, status: 401, reason: "invalid token" };
  }
}
