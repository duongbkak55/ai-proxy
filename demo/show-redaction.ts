/**
 * End-to-end demo of the ai-proxy DLP pipeline.
 *
 *   Scenario A — BLOCKED: request contains a hard-block secret (sk-ant-…).
 *                The proxy stops the request; the upstream API is never
 *                contacted.
 *   Scenario B — TOKENISED: request contains PII (email, phone) and codenames
 *                that get tokenised. Upstream sees opaque tokens. Reply is
 *                detokenised back to the original values for the client.
 *
 * Run:  npx tsx demo/show-redaction.ts
 */

import {
  compilePatterns,
  redactAnthropicRequest,
  detokenize,
  type AnthropicRequestBody,
  type DlpRawPattern,
} from "../src/dlp.js";
import { InProcessTokenVault } from "../src/vault.js";
import { Dictionary } from "../src/dictionary.js";

// ─── Common DLP configuration ──────────────────────────────────────────────

const tokenisingPatterns: DlpRawPattern[] = [
  {
    name: "EMAIL",
    regex: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
    policy: "tokenize",
  },
  {
    name: "PHONE_VN",
    regex: "0\\d{9,10}",
    policy: "tokenize",
  },
  {
    name: "GITHUB_PAT",
    regex: "ghp_[a-zA-Z0-9]{36}",
    policy: "redact",
    replacement: "[REDACTED:GITHUB_PAT]",
  },
];

const blockingPatterns: DlpRawPattern[] = [
  ...tokenisingPatterns,
  {
    name: "ANTHROPIC_KEY",
    regex: "sk-ant-[a-zA-Z0-9_-]{20,}",
    policy: "block",
  },
];

const dictionary = new Dictionary([
  { term: "ProjectAlpha", classifier: "CODENAME", policy: "tokenize" },
  { term: "@vng/auth", classifier: "PKG", policy: "tokenize" },
  { term: "vng_user_payments", classifier: "DBTABLE", policy: "tokenize" },
]);

const sep = "─".repeat(72);
function header(title: string) {
  console.log("\n" + sep);
  console.log(title);
  console.log(sep);
}

// ─── Scenario A — Hard block on sk-ant-… ───────────────────────────────────

header("SCENARIO A — request contains an Anthropic API key (policy: block)");

const inboundA: AnthropicRequestBody = {
  model: "claude-sonnet-4-5",
  max_tokens: 256,
  messages: [
    {
      role: "user",
      content:
        "Please test with the live key sk-ant-api03-XYZXYZ_redact_me_please_not_real",
    },
  ],
};

const patternsA = compilePatterns(blockingPatterns);
const vaultA = new InProcessTokenVault({ ttlMs: 60_000 });
const resultA = redactAnthropicRequest(inboundA, patternsA, {
  vault: { convId: "demo-A", vault: vaultA },
});

console.log("INBOUND from client →");
console.log("  " + (inboundA.messages![0].content as string));
console.log();
console.log("DECISION:");
console.log(`  blocked = ${resultA.blocked}`);
console.log(`  blockedReasons = ${JSON.stringify(resultA.blockedReasons)}`);
console.log(`  matches = ${resultA.matches.map((m) => `${m.patternName}(${m.policy})`).join(", ")}`);
console.log();
console.log("UPSTREAM api.anthropic.com → never contacted (server.ts returns 403 to client)");

// ─── Scenario B — Allowed, tokenised ───────────────────────────────────────

header("SCENARIO B — PII + codenames tokenised, upstream sees opaque tokens");

const inboundB: AnthropicRequestBody = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  system: "You are a senior engineer at VNG working on ProjectAlpha.",
  messages: [
    {
      role: "user",
      content:
        "Customer alice@example.com (phone 0912345678) reported a duplicate charge.\n" +
        "The query is `SELECT amount FROM vng_user_payments WHERE user_id = $1`.\n" +
        "We use @vng/auth for token signing. Test PAT: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.\n" +
        "Please send the fix to alice@example.com or call 0912345678.",
    },
  ],
};

const patternsB = compilePatterns(tokenisingPatterns);
const vaultB = new InProcessTokenVault({ ttlMs: 60_000 });
const convB = "demo-B";
const resultB = redactAnthropicRequest(inboundB, patternsB, {
  dictionary,
  vault: { convId: convB, vault: vaultB },
});

console.log("INBOUND from client (system + user message) →");
console.log("  system:  " + inboundB.system);
console.log("  user:    " + (inboundB.messages![0].content as string).split("\n").join("\n           "));

console.log();
console.log("AFTER DLP (what upstream api.anthropic.com sees) ↓");
console.log("  system:  " + resultB.body.system);
console.log("  user:    " + (resultB.body.messages![0].content as string).split("\n").join("\n           "));

console.log();
console.log("DLP DECISION:");
console.log(`  blocked = ${resultB.blocked}`);
console.log(`  matches: ${resultB.matches.length} (regex + dictionary + structural)`);
for (const m of resultB.matches) {
  console.log(`    • ${m.patternName.padEnd(22)} policy=${m.policy.padEnd(9)} sample=${m.sample}`);
}

console.log();
console.log("VAULT entries (token → original, conversation-scoped):");
const tokenRe = /[A-Z]+_\d{2,3}/g;
const tokensInBody = new Set<string>();
for (const m of JSON.stringify(resultB.body).matchAll(tokenRe)) tokensInBody.add(m[0]);
for (const tok of [...tokensInBody].sort()) {
  const original = vaultB.lookup(convB, tok);
  if (original !== undefined) {
    console.log(`  ${tok.padEnd(15)} → ${JSON.stringify(original)}`);
  }
}

// Simulated upstream reply that echoes some of the tokens back.
const reply =
  "I see the issue: ProjectAlpha's CODENAME_01 service signs tokens via PKG_01 but " +
  "the audit table DBTABLE_01 is missing the user_id index. " +
  "I'll email EMAIL_01 (cc PHONE_01) with a patch.";

console.log();
console.log("SIMULATED UPSTREAM REPLY (model echoes tokens, never sees plaintext) →");
console.log("  " + reply);

const clientSees = detokenize(reply, convB, vaultB);
console.log();
console.log("AFTER DETOKENIZE (what the client receives) →");
console.log("  " + clientSees);

console.log("\n" + sep + "\nDONE\n" + sep);
