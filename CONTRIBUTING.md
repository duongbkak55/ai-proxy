# Contributing

Thanks for your interest in `@duongbkak55/ai-proxy`. This document covers local setup, testing conventions, and the PR workflow.

## Development setup

Requires Node 20+ (CI runs on 20 and 22).

```bash
git clone https://github.com/duongbkak55/ai-proxy
cd ai-proxy
npm install
npm test
npm run typecheck
npm run build
```

## Project layout

```
src/
  server.ts           HTTP server + request pipeline
  dlp.ts              DLP redaction core (regex, dict, vault, SSE handlers)
  ast-lane.ts         Source-code AST DLP lane
  sql-lane.ts         SQL AST DLP lane
  dictionary.ts       Aho-Corasick automata
  vault.ts            In-process token vault
  auth.ts             Multi-token bearer auth + rate-limit
  allowlist.ts        Tool/URL allowlist + SSRF guard
  audit.ts            JSONL audit log with fsync
  agent-loop.ts       Internal tool execution loop
  config.ts           Zod config schema + loader
  cli.ts              Commander entry: start/audit/hitl/auth/config
  index.ts            Public API exports
  types/              Type shims (safe-regex)
  lib/                Vendored helpers (atomic-write, ssrf-guard, jsonc)
  __tests__/          Vitest test files (one per source module)
deploy/               Dockerfile, compose.yml, Caddyfile, systemd unit
docs/                 Design docs (security-design, auth, configuration, api)
.github/workflows/    CI (test + typecheck + build on Node 20/22)
```

## Conventions

### TypeScript
- `strict: true` mandatory. `tsc --noEmit` must be clean before pushing.
- Public API exports go through `src/index.ts`; do not import from internal paths in downstream code.
- Prefer Zod schemas at module boundaries (config, upstream response, auth tokens). Inputs that cross trust boundaries must be parsed, not type-asserted.

### Security-sensitive code
- **Never log plaintext tokens, passwords, or vault contents.** Audit events get `tokenId` only.
- Token comparisons use `crypto.timingSafeEqual`. Length-mismatch paths still burn time to avoid leaking length via timing.
- New regex patterns added to the DLP config must pass `safe-regex` validation at startup.
- Outbound URL handling goes through `validateUpstreamUrl` and the SSRF guard. Don't add new fetch sites without routing them through the same gate.

### Tests
- Vitest. Each `src/foo.ts` has `src/__tests__/foo.test.ts` next door.
- Hit the boundary: real `http.Server` for integration tests, real filesystem (in `mkdtemp`) for vault/store tests. Mock only when crossing a network or external-service edge.
- A new feature without tests is incomplete.

### Commit messages
Follow Conventional Commits. Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`.

For non-trivial changes, append decision-context trailers (this convention is inherited from oh-my-claudecode):

```
Constraint: <active constraint that shaped this decision>
Rejected: <alternative considered> | <reason for rejection>
Confidence: high | medium | low
Scope-risk: narrow | moderate | broad
Directive: <warning for future modifiers>
Not-tested: <edge case not covered>
```

## PR checklist

Before opening a PR:

- [ ] `npm test` — full suite green
- [ ] `npm run typecheck` — clean
- [ ] `npm run build` — succeeds
- [ ] New code has tests in `src/__tests__/`
- [ ] Public API changes (in `src/index.ts` or config schema) noted in `CHANGELOG.md` under `[Unreleased]`
- [ ] Security-relevant changes link to or update `docs/security-design.md`
- [ ] No plaintext secrets, tokens, or PII in commits, comments, or test fixtures

## Reporting security issues

For sensitive vulnerabilities, please open a private security advisory via GitHub instead of a public issue. For non-sensitive bugs, regular issues are fine.

## Code of conduct

Be excellent to each other. Disagreement on technical merits is welcome; personal attacks are not.
