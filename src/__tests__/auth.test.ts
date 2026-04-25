/**
 * Auth lane tests: hash, compare, rate limiter, token store, gate.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  hashToken,
  compareToken,
  generateToken,
  RateLimiter,
  TokenStore,
  AuthGate,
  type TokenRecord,
} from "../auth.js";

describe("hashToken / compareToken", () => {
  it("produces stable sha256 hex with prefix", () => {
    const h = hashToken("hello");
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashToken("hello")).toBe(h);
  });

  it("rejects empty plaintext", () => {
    expect(() => hashToken("")).toThrow(/non-empty/);
  });

  it("compareToken returns true for matching plaintext", () => {
    const h = hashToken("secret-token-123");
    expect(compareToken("secret-token-123", h)).toBe(true);
  });

  it("compareToken returns false for wrong plaintext", () => {
    const h = hashToken("secret-token-123");
    expect(compareToken("secret-token-124", h)).toBe(false);
  });

  it("compareToken rejects malformed stored hash", () => {
    expect(compareToken("anything", "not-a-hash")).toBe(false);
    expect(compareToken("anything", "sha256:tooshort")).toBe(false);
  });

  it("compareToken handles non-string inputs without throwing", () => {
    // @ts-expect-error intentional bad input
    expect(compareToken(undefined, hashToken("x"))).toBe(false);
    // @ts-expect-error intentional bad input
    expect(compareToken("x", undefined)).toBe(false);
  });
});

describe("generateToken", () => {
  it("returns plaintext + matching hash", () => {
    const { plaintext, hash } = generateToken();
    expect(plaintext.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(compareToken(plaintext, hash)).toBe(true);
  });

  it("produces distinct tokens on repeat", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("RateLimiter", () => {
  it("allows up to RPM requests in burst at start", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 10; i++) {
      expect(rl.check("client", 10).allowed).toBe(true);
    }
    const next = rl.check("client", 10);
    expect(next.allowed).toBe(false);
  });

  it("returns retryAfterMs proportional to rpm", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 60; i++) rl.check("c", 60);
    const r = rl.check("c", 60) as { allowed: false; retryAfterMs: number };
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(1100); // ~1 sec for rpm=60
  });

  it("refills tokens over time (mock clock)", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(() => now);
    // Drain 60 rpm bucket
    for (let i = 0; i < 60; i++) rl.check("c", 60);
    expect(rl.check("c", 60).allowed).toBe(false);
    // Advance 1 sec → 1 token refill
    now += 1000;
    expect(rl.check("c", 60).allowed).toBe(true);
  });

  it("isolates buckets per id", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 5; i++) rl.check("a", 5);
    expect(rl.check("a", 5).allowed).toBe(false);
    expect(rl.check("b", 5).allowed).toBe(true);
  });

  it("rejects rpm <= 0", () => {
    const rl = new RateLimiter();
    expect(rl.check("c", 0).allowed).toBe(false);
    expect(rl.check("c", -5).allowed).toBe(false);
  });

  it("reset clears bucket", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 5; i++) rl.check("a", 5);
    expect(rl.check("a", 5).allowed).toBe(false);
    rl.reset("a");
    expect(rl.check("a", 5).allowed).toBe(true);
  });
});

describe("TokenStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-test-"));
    path = join(dir, "tokens.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("load returns [] when file missing", async () => {
    const s = new TokenStore(path);
    expect(await s.load()).toEqual([]);
  });

  it("issue persists hash and returns plaintext once", async () => {
    const s = new TokenStore(path);
    const { plaintext, record } = await s.issue({ id: "client-1", rpm: 30 });
    expect(plaintext).toBeTypeOf("string");
    expect(record.hash).toMatch(/^sha256:/);
    expect(record.rateLimit.rpm).toBe(30);
    expect(existsSync(path)).toBe(true);

    const reloaded = await s.load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe("client-1");
    expect(compareToken(plaintext, reloaded[0].hash)).toBe(true);
  });

  it("issue refuses duplicate id", async () => {
    const s = new TokenStore(path);
    await s.issue({ id: "client-1" });
    await expect(s.issue({ id: "client-1" })).rejects.toThrow(/already exists/);
  });

  it("revoke removes existing token", async () => {
    const s = new TokenStore(path);
    await s.issue({ id: "client-1" });
    expect(await s.revoke("client-1")).toBe(true);
    expect(await s.load()).toEqual([]);
  });

  it("revoke returns false for unknown id", async () => {
    const s = new TokenStore(path);
    expect(await s.revoke("ghost")).toBe(false);
  });

  it("rotate creates new token tied to old id", async () => {
    const s = new TokenStore(path);
    await s.issue({ id: "client-1", rpm: 100 });
    const { plaintext, record } = await s.rotate("client-1", "client-1-v2");
    expect(plaintext).toBeTypeOf("string");
    expect(record.rotatedFrom).toBe("client-1");
    expect(record.rateLimit.rpm).toBe(100); // inherited
    const all = await s.load();
    expect(all).toHaveLength(2); // both old and new exist; caller may revoke old
  });

  it("rotate rejects when old id missing", async () => {
    const s = new TokenStore(path);
    await expect(s.rotate("nope", "new")).rejects.toThrow(/not found/);
  });

  it("load throws on malformed file", async () => {
    const fs = await import("fs/promises");
    await fs.writeFile(path, '{"version": 99, "tokens": []}', "utf8");
    const s = new TokenStore(path);
    await expect(s.load()).rejects.toThrow(/malformed/);
  });
});

describe("AuthGate", () => {
  function inlineToken(overrides: Partial<TokenRecord> = {}): TokenRecord {
    const { plaintext, hash } = generateToken();
    return {
      id: overrides.id ?? "test",
      hash: overrides.hash ?? hash,
      scopes: overrides.scopes ?? ["proxy:request"],
      rateLimit: overrides.rateLimit ?? { rpm: 60, perDay: 1000 },
      expiresAt: overrides.expiresAt,
      rotatedFrom: overrides.rotatedFrom,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      _plaintext: plaintext, // not on TokenRecord, but used by tests
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("rejects missing Authorization header (401)", async () => {
    const gate = new AuthGate({ headerName: "Authorization", inlineTokens: [] });
    const r = await gate.validate({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.reason).toMatch(/missing/);
    }
  });

  it("rejects malformed bearer header (401)", async () => {
    const gate = new AuthGate({ headerName: "Authorization", inlineTokens: [] });
    const r = await gate.validate({ authorization: "Basic abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("rejects empty bearer (401)", async () => {
    const gate = new AuthGate({ headerName: "Authorization", inlineTokens: [] });
    const r = await gate.validate({ authorization: "Bearer " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty/);
  });

  it("rejects unknown token (401)", async () => {
    const t = inlineToken();
    const gate = new AuthGate({ headerName: "Authorization", inlineTokens: [t] });
    const r = await gate.validate({ authorization: "Bearer wrong-token" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid/);
  });

  it("accepts valid token and returns id+scopes", async () => {
    const t = inlineToken({ id: "mine", scopes: ["proxy:request", "admin"] });
    const gate = new AuthGate({ headerName: "Authorization", inlineTokens: [t] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plaintext = (t as any)._plaintext as string;
    const r = await gate.validate({ authorization: `Bearer ${plaintext}` });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tokenId).toBe("mine");
      expect(r.scopes).toContain("admin");
    }
  });

  it("rejects expired token", async () => {
    const t = inlineToken({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const gate = new AuthGate({ headerName: "Authorization", inlineTokens: [t] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plaintext = (t as any)._plaintext as string;
    const r = await gate.validate({ authorization: `Bearer ${plaintext}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expired/);
  });

  it("rejects when required scope missing", async () => {
    const t = inlineToken({ scopes: ["proxy:request"] });
    const gate = new AuthGate({
      headerName: "Authorization",
      inlineTokens: [t],
      requiredScope: "admin",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plaintext = (t as any)._plaintext as string;
    const r = await gate.validate({ authorization: `Bearer ${plaintext}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scope/);
  });

  it("returns 429 when rate limit exhausted", async () => {
    const t = inlineToken({ rateLimit: { rpm: 2, perDay: 100 } });
    const gate = new AuthGate({ headerName: "Authorization", inlineTokens: [t] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plaintext = (t as any)._plaintext as string;
    expect((await gate.validate({ authorization: `Bearer ${plaintext}` })).ok).toBe(true);
    expect((await gate.validate({ authorization: `Bearer ${plaintext}` })).ok).toBe(true);
    const third = await gate.validate({ authorization: `Bearer ${plaintext}` });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.status).toBe(429);
      expect(third.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("reads from file-backed store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-gate-"));
    const path = join(dir, "tokens.json");
    try {
      const store = new TokenStore(path);
      const { plaintext } = await store.issue({ id: "filed", rpm: 60 });
      const gate = new AuthGate({
        headerName: "Authorization",
        inlineTokens: [],
        tokensFile: path,
      });
      const r = await gate.validate({ authorization: `Bearer ${plaintext}` });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.tokenId).toBe("filed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies on malformed store file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-gate-bad-"));
    const path = join(dir, "tokens.json");
    try {
      const fs = await import("fs/promises");
      await fs.writeFile(path, '{"version":99}', "utf8");
      const gate = new AuthGate({
        headerName: "Authorization",
        inlineTokens: [],
        tokensFile: path,
      });
      const r = await gate.validate({ authorization: "Bearer x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/backend unavailable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses lowercased custom header name", async () => {
    const t = inlineToken();
    const gate = new AuthGate({ headerName: "X-Auth-Token", inlineTokens: [t] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plaintext = (t as any)._plaintext as string;
    // Node lowercases incoming headers, so test passes the lowercased key
    const r = await gate.validate({ "x-auth-token": `Bearer ${plaintext}` });
    expect(r.ok).toBe(true);
  });
});
