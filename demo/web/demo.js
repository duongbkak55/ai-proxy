/* Demo orchestration — wires the textarea + buttons to the bundled DLP. */
(() => {
  "use strict";
  const api = globalThis.AiProxyDemo;
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:32px;color:#f85149;font-family:monospace">bundle.js not loaded — run `node demo/web/build.mjs` first</div>';
    return;
  }

  // ─── Sample scenarios ────────────────────────────────────────────────────
  const SAMPLES = {
    pii: {
      title: "PII (email, phone)",
      system: "You are a senior support engineer.",
      user: `Customer alice@example.com (phone 0912345678) reported a duplicate charge.\nPlease send the fix to alice@example.com or call 0912345678.`,
    },
    codename: {
      title: "Codename + internal package",
      system: "You are a senior engineer at VNG working on ProjectAlpha.",
      user: `We use @vng/auth for token signing. The query is:\nSELECT amount FROM vng_user_payments WHERE user_id = $1.\nFix the bug in ProjectAlpha's session signing flow.`,
    },
    secret: {
      title: "Secret blocked",
      system: "You are a helpful coding assistant.",
      user: `Please test with the live key sk-ant-api03-XYZXYZ_redact_me_please_not_real and let me know if billing endpoint works.`,
    },
    full: {
      title: "Full mix (real-world)",
      system: "You are a senior engineer at VNG working on ProjectAlpha.",
      user: `Customer alice@example.com (phone 0912345678) reported a duplicate charge on ProjectAlpha.\n\nThe relevant code:\n\`\`\`typescript\nimport { signSession } from "@vng/auth";\nexport async function processCharge(userId: string) {\n  return await db.query(\n    "SELECT amount FROM vng_user_payments WHERE user_id = $1",\n    [userId]\n  );\n}\n\`\`\`\n\nTest PAT: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nPlease send the fix to alice@example.com or call 0912345678.`,
    },
    custom: {
      title: "Custom",
      system: "You are a helpful coding assistant.",
      user: "",
    },
  };

  // ─── DLP configuration (matches the proxy's defaults + sample dictionary) ─
  const RAW_PATTERNS = [
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
    {
      name: "ANTHROPIC_KEY",
      regex: "sk-ant-[a-zA-Z0-9_-]{20,}",
      policy: "block",
    },
  ];

  const DICT_ENTRIES = [
    { term: "ProjectAlpha", classifier: "CODENAME", policy: "tokenize" },
    { term: "@vng/auth", classifier: "PKG", policy: "tokenize" },
    { term: "vng_user_payments", classifier: "DBTABLE", policy: "tokenize" },
  ];

  // ─── DOM ─────────────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const clientInput = $("#client-input");
  const decision = $("#proxy-decision");
  const matchList = $("#match-list");
  const upstreamOut = $("#upstream-out");
  const vaultBody = $("#vault-table tbody");
  const auditOut = $("#audit-out");
  const replyUpstream = $("#reply-upstream");
  const replyClient = $("#reply-client");
  const runBtn = $("#run");
  const sampleBtns = document.querySelectorAll("[data-sample]");

  // Pre-fill with the "full" sample
  applySample("full");

  sampleBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sample;
      applySample(key);
      sampleBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  runBtn.addEventListener("click", run);
  clientInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
  });

  function applySample(key) {
    const s = SAMPLES[key] ?? SAMPLES.custom;
    clientInput.value = s.user;
    clientInput.dataset.system = s.system;
  }

  // ─── Pipeline ────────────────────────────────────────────────────────────
  function run() {
    const userText = clientInput.value;
    const systemText = clientInput.dataset.system || SAMPLES.full.system;

    // Pulse animation on each pane to signal "the request flows"
    const panes = document.querySelectorAll(".pane");
    panes.forEach((p, i) => {
      setTimeout(() => p.classList.add("pulsing"), i * 200);
      setTimeout(() => p.classList.remove("pulsing"), i * 200 + 800);
    });

    const patterns = api.compilePatterns(RAW_PATTERNS);
    const dictionary = new api.Dictionary(DICT_ENTRIES);
    const vault = new api.InProcessTokenVault({ ttlMs: 60_000 });
    const convId = "demo-" + Math.random().toString(36).slice(2, 8);

    const inboundBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: systemText,
      messages: [{ role: "user", content: userText }],
    };

    const result = api.redactAnthropicRequest(inboundBody, patterns, {
      dictionary,
      vault: { convId, vault },
    });

    renderDecision(result);
    renderMatches(result.matches);
    renderUpstream(result, systemText);
    renderVault(vault, convId, result);
    renderAudit(result, convId);
    renderReplies(result, vault, convId);
  }

  function renderDecision(result) {
    decision.classList.remove("decision-empty", "decision-allow", "decision-block");
    if (result.blocked) {
      decision.classList.add("decision-block");
      const reasons = (result.blockedReasons || []).join(", ");
      decision.querySelector(".decision-text").textContent =
        `BLOCKED — request không được forward. Reason: ${reasons || "policy violation"}`;
    } else {
      decision.classList.add("decision-allow");
      const n = result.matches.length;
      decision.querySelector(".decision-text").textContent =
        n === 0
          ? "ALLOWED — không có match, forward nguyên văn"
          : `ALLOWED — ${n} match được tokenize/redact, upstream chỉ thấy token`;
    }
  }

  function renderMatches(matches) {
    matchList.innerHTML = "";
    if (matches.length === 0) {
      matchList.innerHTML = '<li class="empty">— không có DLP match —</li>';
      return;
    }
    for (const m of matches) {
      const li = document.createElement("li");
      li.className = `policy-${m.policy}`;
      li.innerHTML = `
        <span class="match-pat">${escapeHtml(m.patternName)}</span>
        <span class="match-pol pol-${m.policy}">${m.policy}</span>
        <span class="match-sample">sample: <code>${escapeHtml(m.sample)}</code></span>
      `;
      matchList.appendChild(li);
    }
  }

  function renderUpstream(result, originalSystem) {
    if (result.blocked) {
      upstreamOut.innerHTML =
        '<code class="placeholder" style="color:#f85149">⚠ Request blocked — upstream KHÔNG được gọi.\n\nClient nhận về 403 với reason: ' +
        escapeHtml((result.blockedReasons || []).join(", ")) +
        "</code>";
      return;
    }
    const body = result.body;
    const sys = body.system ?? originalSystem ?? "";
    const userMsg =
      Array.isArray(body.messages) && body.messages[0]
        ? body.messages[0].content
        : "";
    const userText = typeof userMsg === "string" ? userMsg : JSON.stringify(userMsg, null, 2);

    const sysHtml = highlightTokens(escapeHtml(sys));
    const userHtml = highlightTokens(escapeHtml(userText));

    upstreamOut.innerHTML = `<code><span style="color:#8b949e">// system\n</span>${sysHtml}\n\n<span style="color:#8b949e">// messages[0].content (role: user)\n</span>${userHtml}</code>`;
  }

  function highlightTokens(htmlEscapedText) {
    // Wrap CLASSIFIER_NN tokens in mark.token, [REDACTED:...] in mark.redacted
    return htmlEscapedText
      .replace(/\[REDACTED:[A-Z_]+\]/g, (m) => `<mark class="redacted">${m}</mark>`)
      .replace(/\b([A-Z]{2,}(?:_[A-Z]+)*)_(\d{2,3})\b/g, (m) => `<mark class="token">${m}</mark>`);
  }

  function renderVault(vault, convId, result) {
    vaultBody.innerHTML = "";
    if (result.blocked) {
      vaultBody.innerHTML = '<tr class="empty"><td colspan="2">— request blocked, vault không issue token —</td></tr>';
      return;
    }
    // Probe vault contents by scanning the AFTER-DLP body for tokens.
    const bodyStr = JSON.stringify(result.body);
    const seen = new Set();
    const tokens = [];
    for (const m of bodyStr.matchAll(/\b([A-Z]{2,}(?:_[A-Z]+)*)_(\d{2,3})\b/g)) {
      const t = m[0];
      if (seen.has(t)) continue;
      seen.add(t);
      const original = vault.lookup(convId, t);
      if (original !== undefined) tokens.push([t, original]);
    }
    if (tokens.length === 0) {
      vaultBody.innerHTML = '<tr class="empty"><td colspan="2">— không có tokenize match —</td></tr>';
      return;
    }
    tokens.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [tok, orig] of tokens) {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${escapeHtml(tok)}</td><td>${escapeHtml(String(orig))}</td>`;
      vaultBody.appendChild(row);
    }
  }

  function renderAudit(result, convId) {
    const tally = {};
    for (const m of result.matches) {
      const cls = m.patternName.replace(/^dict:/, "");
      tally[cls] = (tally[cls] || 0) + 1;
    }
    const event = {
      ts: new Date().toISOString(),
      conv_id: convId,
      decision: result.blocked ? "blocked" : "allowed",
      blocked_reasons: result.blockedReasons || [],
      classifier_counts: tally,
      total_matches: result.matches.length,
      // hash chain in real audit; demo shows shape only:
      prev_hash: "0".repeat(16),
      this_hash: makePseudoHash(JSON.stringify(tally) + convId),
    };
    auditOut.innerHTML = `<code>${escapeHtml(JSON.stringify(event, null, 2))}</code>`;
  }

  function renderReplies(result, vault, convId) {
    if (result.blocked) {
      replyUpstream.innerHTML = '<code class="placeholder">— request blocked, no upstream reply —</code>';
      replyClient.innerHTML = '<code class="placeholder">— client nhận về 403 —</code>';
      return;
    }
    // Build a reply that echoes some tokens from the upstream body
    const bodyStr = JSON.stringify(result.body);
    const tokens = [...new Set(bodyStr.match(/\b([A-Z]{2,}(?:_[A-Z]+)*)_(\d{2,3})\b/g) ?? [])];
    if (tokens.length === 0) {
      const generic = "Got it. I'll take a look at the issue and propose a fix.";
      replyUpstream.innerHTML = `<code>${escapeHtml(generic)}</code>`;
      replyClient.innerHTML = `<code>${escapeHtml(generic)}</code>`;
      return;
    }
    const reply = buildReply(tokens);
    replyUpstream.innerHTML = `<code>${highlightTokens(escapeHtml(reply))}</code>`;
    const detok = api.detokenize(reply, convId, vault);
    replyClient.innerHTML = `<code>${escapeHtml(detok).replace(/\b([A-Z]{2,}(?:_[A-Z]+)*)_(\d{2,3})\b/g, '<mark class="token">$&</mark>')}</code>`;
  }

  function buildReply(tokens) {
    const t = (i, fallback) => tokens[i] ?? fallback;
    return [
      `I see the issue: ${t(0, "the identifier")} is referenced from ${t(1, "the helper")}.`,
      `The query against ${t(2, "the table")} needs an index on user_id.`,
      `I'll send the patch to ${t(3, "the user")} and notify on ${t(4, "the channel")}.`,
    ].join(" ");
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function makePseudoHash(s) {
    // Tiny non-cryptographic hash for demo audit shape; production uses sha256.
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16).padStart(16, "0").slice(0, 16);
  }

  // Auto-run on load so the boss sees something immediately
  setTimeout(run, 200);
})();
