/* ai-proxy live chat — talks to a running ai-proxy via /v1/messages SSE.
 * Defaults from window.AI_PROXY_DEMO_CONFIG (env-injected at build time);
 * runtime overrides persisted in localStorage under "ai-proxy-chat-cfg".
 */
(() => {
  "use strict";

  const STORAGE_KEY = "ai-proxy-chat-cfg";
  const CHAT_KEY = "ai-proxy-chat-history";
  const MAX_TEXT_FILE_BYTES = 256 * 1024;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const PRESET_MODELS = [
    { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B :free" },
    { id: "openai/gpt-oss-120b:free",               label: "GPT-OSS 120B :free" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 120B :free" },
    { id: "google/gemma-3-27b-it:free",             label: "Gemma 3 27B :free" },
    { id: "google/gemma-3-12b-it:free",             label: "Gemma 3 12B :free" },
    { id: "qwen/qwen3-coder:free",                  label: "Qwen3 Coder :free" },
    { id: "claude-sonnet-4-6",                      label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001",              label: "Claude Haiku 4.5" },
    { id: "brain",                                  label: "brain (9router)" },
  ];

  const TEXT_LIKE_EXT = new Set([
    "txt", "md", "json", "js", "jsx", "ts", "tsx",
    "py", "java", "go", "rs", "sh", "bash", "yaml", "yml",
    "sql", "css", "html", "xml", "toml", "ini", "csv",
  ]);

  const defaults = (window.AI_PROXY_DEMO_CONFIG ?? {});
  const initialCfg = {
    proxyUrl: defaults.proxyUrl ?? "http://127.0.0.1:11500",
    bearerToken: defaults.bearerToken ?? "",
    model: defaults.model ?? "claude-sonnet-4-5",
    maxTokens: defaults.defaultMaxTokens ?? 1024,
    system: defaults.system ?? "",
  };

  function loadCfg() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...initialCfg };
      const parsed = JSON.parse(raw);
      return { ...initialCfg, ...parsed };
    } catch {
      return { ...initialCfg };
    }
  }

  function saveCfg(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveHistory(history) {
    // Clip large attachments before persisting (keep under ~1MB total).
    const clipped = history.map((m) => ({
      ...m,
      attachments: (m.attachments ?? []).map((a) => ({
        ...a,
        // Strip base64 from persisted history — re-attaching is fine, page reload won't restore them.
        data: a.kind === "image" ? "" : a.data,
      })),
    }));
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(clipped));
    } catch {
      // quota exceeded — drop history silently
    }
  }

  // ── DOM ────────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const quickModelSel = $("quick-model");
  const logToggleBtn = $("log-toggle");
  const logPanel = $("log-panel");
  const logEntries = $("log-entries");
  const logConn = $("log-conn");
  const logClearBtn = $("log-clear");
  const messagesEl = $("messages");
  const composerForm = $("composer");
  const composerInput = $("composer-input");
  const fileInput = $("file-input");
  const attachmentsEl = $("attachments");
  const sendBtn = $("send-btn");
  const statusLine = $("status-line");
  const proxyInfo = $("proxy-info");
  const settingsToggle = $("settings-toggle");
  const settingsPanel = $("settings-panel");
  const cfgProxy = $("cfg-proxy");
  const cfgToken = $("cfg-token");
  const cfgModel = $("cfg-model");
  const cfgMaxtok = $("cfg-maxtok");
  const cfgSystem = $("cfg-system");
  const cfgSave = $("cfg-save");
  const cfgClear = $("cfg-clear");
  const cfgStatus = $("cfg-status");

  // ── State ─────────────────────────────────────────────────────────────────
  const SESSION_CONV_ID = crypto.randomUUID().replace(/-/g, "");

  let cfg = loadCfg();
  let history = loadHistory();
  let pendingAttachments = []; // [{kind:"image"|"text", name, mimeType, data, size}]
  let inflight = false;
  let abortCtrl = null;

  // ── Render ────────────────────────────────────────────────────────────────
  function setStatus(text, mode) {
    statusLine.textContent = text;
    statusLine.classList.remove("streaming", "error");
    if (mode === "streaming") statusLine.classList.add("streaming");
    if (mode === "error") statusLine.classList.add("error");
  }

  function updateProxyInfo() {
    const tokenSuffix = cfg.bearerToken
      ? "•••" + cfg.bearerToken.slice(-4)
      : "(no token)";
    proxyInfo.textContent = `${cfg.proxyUrl} ${tokenSuffix} · ${cfg.model}`;
  }

  function initModelSelector() {
    quickModelSel.innerHTML = "";
    const currentId = cfg.model;
    const inList = PRESET_MODELS.some((m) => m.id === currentId);
    if (!inList && currentId) {
      const opt = document.createElement("option");
      opt.value = currentId;
      opt.textContent = currentId;
      quickModelSel.appendChild(opt);
    }
    for (const m of PRESET_MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      quickModelSel.appendChild(opt);
    }
    quickModelSel.value = currentId;
  }

  function renderEmptyState() {
    if (history.length === 0) {
      messagesEl.innerHTML = `<div class="msg-empty"><p>Bắt đầu chat đi. File đính kèm: image (jpg/png/webp/gif) gửi dạng image block, text/code gửi inline.</p></div>`;
    }
  }

  function renderHistory() {
    messagesEl.innerHTML = "";
    if (history.length === 0) {
      renderEmptyState();
      return;
    }
    for (const m of history) {
      messagesEl.appendChild(renderMessage(m));
    }
    scrollToBottom();
  }

  function renderMessage(m) {
    const div = document.createElement("div");
    div.className = `msg msg-${m.role}`;
    if (m.id) div.dataset.id = m.id;

    const role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = m.role;
    div.appendChild(role);

    const content = document.createElement("p");
    content.className = "msg-content";
    content.textContent = m.text ?? "";
    div.appendChild(content);

    if (m.attachments && m.attachments.length > 0) {
      const wrap = document.createElement("div");
      wrap.className = "msg-attachments";
      for (const a of m.attachments) {
        const chip = document.createElement("span");
        chip.className = "msg-attach-chip";
        if (a.kind === "image" && a.data) {
          const img = document.createElement("img");
          img.src = `data:${a.mimeType};base64,${a.data}`;
          img.alt = a.name;
          chip.appendChild(img);
        }
        const label = document.createElement("span");
        label.textContent = a.name + (a.size ? ` (${formatBytes(a.size)})` : "");
        chip.appendChild(label);
        wrap.appendChild(chip);
      }
      div.appendChild(wrap);
    }
    return div;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  function renderPendingAttachments() {
    attachmentsEl.innerHTML = "";
    pendingAttachments.forEach((a, idx) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      if (a.kind === "image") {
        const img = document.createElement("img");
        img.src = `data:${a.mimeType};base64,${a.data}`;
        img.alt = a.name;
        chip.appendChild(img);
      } else {
        const tag = document.createElement("span");
        tag.textContent = "📄";
        chip.appendChild(tag);
      }
      const label = document.createElement("span");
      label.textContent = `${a.name} · ${formatBytes(a.size)}`;
      chip.appendChild(label);
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = "remove";
      x.addEventListener("click", () => {
        pendingAttachments.splice(idx, 1);
        renderPendingAttachments();
      });
      chip.appendChild(x);
      attachmentsEl.appendChild(chip);
    });
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result; // "data:mime;base64,XXX"
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function handleFiles(files) {
    for (const file of files) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const isImage = file.type.startsWith("image/");
      if (isImage) {
        if (file.size > MAX_IMAGE_BYTES) {
          alert(`${file.name}: image > ${formatBytes(MAX_IMAGE_BYTES)}`);
          continue;
        }
        const data = await readFileAsBase64(file);
        pendingAttachments.push({
          kind: "image",
          name: file.name,
          mimeType: file.type,
          data,
          size: file.size,
        });
      } else if (TEXT_LIKE_EXT.has(ext) || file.type.startsWith("text/")) {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          alert(`${file.name}: text > ${formatBytes(MAX_TEXT_FILE_BYTES)}`);
          continue;
        }
        const data = await readFileAsText(file);
        pendingAttachments.push({
          kind: "text",
          name: file.name,
          mimeType: file.type || "text/plain",
          data,
          size: file.size,
        });
      } else {
        alert(`${file.name}: unsupported (only images + text/code files)`);
      }
    }
    renderPendingAttachments();
  }

  // ── Build Anthropic content blocks from text + attachments ────────────────
  function buildContentBlocks(text, attachments) {
    const blocks = [];
    // Text-file attachments rendered inline as fenced code blocks before user text.
    let prefix = "";
    for (const a of attachments) {
      if (a.kind === "text") {
        const lang = a.name.split(".").pop()?.toLowerCase() ?? "";
        prefix += `\n--- file: ${a.name} ---\n\`\`\`${lang}\n${a.data}\n\`\`\`\n`;
      }
    }
    for (const a of attachments) {
      if (a.kind === "image") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: a.mimeType,
            data: a.data,
          },
        });
      }
    }
    const merged = (prefix + (text ?? "")).trim();
    if (merged.length > 0) {
      blocks.push({ type: "text", text: merged });
    }
    return blocks;
  }

  // ── Send / SSE ────────────────────────────────────────────────────────────
  async function sendMessage(text) {
    if (inflight) return;
    if (!cfg.bearerToken) {
      setStatus("missing bearer token (Settings)", "error");
      settingsPanel.hidden = false;
      return;
    }
    const userMsg = {
      role: "user",
      text: text ?? "",
      attachments: pendingAttachments.slice(),
      id: crypto.randomUUID(),
    };
    history.push(userMsg);
    if (history.length === 1) renderEmptyState();
    messagesEl.querySelector(".msg-empty")?.remove();
    messagesEl.appendChild(renderMessage(userMsg));
    saveHistory(history);
    pendingAttachments = [];
    renderPendingAttachments();

    const assistantMsg = {
      role: "assistant",
      text: "",
      id: crypto.randomUUID(),
    };
    history.push(assistantMsg);
    const assistantEl = renderMessage(assistantMsg);
    const contentEl = assistantEl.querySelector(".msg-content");
    contentEl.classList.add("msg-streaming");
    messagesEl.appendChild(assistantEl);
    scrollToBottom();

    inflight = true;
    sendBtn.disabled = true;
    setStatus("streaming…", "streaming");
    abortCtrl = new AbortController();

    // Build request body. We send the FULL chat history so the model has context;
    // strip ids/local fields before serialising.
    const apiMessages = history
      .filter((m, i) => i < history.length - 1) // exclude in-progress assistant
      .map((m) => ({
        role: m.role,
        content: buildContentBlocks(m.text, m.attachments ?? []),
      }))
      .filter((m) => m.content.length > 0);

    const body = {
      model: cfg.model,
      max_tokens: Number(cfg.maxTokens) || 1024,
      messages: apiMessages,
      stream: true,
    };
    if (cfg.system && cfg.system.trim().length > 0) {
      body.system = cfg.system;
    }

    try {
      const resp = await fetch(`${cfg.proxyUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${cfg.bearerToken}`,
          "x-omc-conversation-id": SESSION_CONV_ID,
        },
        body: JSON.stringify(body),
        signal: abortCtrl.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 500)}`);
      }
      if (!resp.body) throw new Error("no response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleSseEvent(event, contentEl, assistantMsg);
        }
      }
      contentEl.classList.remove("msg-streaming");
      setStatus("ready");
      saveHistory(history);
    } catch (err) {
      contentEl.classList.remove("msg-streaming");
      const errMsg = err.name === "AbortError" ? "aborted" : String(err.message ?? err);
      // Replace assistant message with error variant
      assistantEl.classList.remove("msg-assistant");
      assistantEl.classList.add("msg-error");
      contentEl.textContent = `Error: ${errMsg}`;
      assistantMsg.text = `[error] ${errMsg}`;
      setStatus(errMsg.length > 80 ? errMsg.slice(0, 80) + "…" : errMsg, "error");
      saveHistory(history);
    } finally {
      inflight = false;
      sendBtn.disabled = false;
      abortCtrl = null;
    }
  }

  function handleSseEvent(event, contentEl, assistantMsg) {
    // Anthropic SSE: each event has "event: <type>\ndata: {json}\n"
    let dataLine = "";
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        dataLine = line.slice("data:".length).trim();
        break;
      }
    }
    if (!dataLine) return;
    if (dataLine === "[DONE]") return;
    let payload;
    try {
      payload = JSON.parse(dataLine);
    } catch {
      return;
    }
    if (payload.type === "content_block_delta") {
      const d = payload.delta;
      if (d?.type === "text_delta" && typeof d.text === "string") {
        assistantMsg.text += d.text;
        contentEl.textContent = assistantMsg.text;
        scrollToBottom();
      }
    } else if (payload.type === "message_delta") {
      // stop_reason / usage — ignore for now
    } else if (payload.type === "error") {
      const msg = payload.error?.message ?? "stream error";
      assistantMsg.text += `\n[error] ${msg}`;
      contentEl.textContent = assistantMsg.text;
    }
  }

  // ── Settings panel ────────────────────────────────────────────────────────
  function syncSettingsForm() {
    cfgProxy.value = cfg.proxyUrl;
    cfgToken.value = cfg.bearerToken;
    cfgModel.value = cfg.model;
    cfgMaxtok.value = cfg.maxTokens;
    cfgSystem.value = cfg.system ?? "";
  }

  quickModelSel.addEventListener("change", () => {
    cfg = { ...cfg, model: quickModelSel.value };
    saveCfg(cfg);
    updateProxyInfo();
    syncSettingsForm();
  });

  settingsToggle.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    if (!settingsPanel.hidden) syncSettingsForm();
  });

  cfgSave.addEventListener("click", () => {
    cfg = {
      proxyUrl: cfgProxy.value.trim() || initialCfg.proxyUrl,
      bearerToken: cfgToken.value.trim(),
      model: cfgModel.value.trim() || initialCfg.model,
      maxTokens: parseInt(cfgMaxtok.value, 10) || initialCfg.maxTokens,
      system: cfgSystem.value,
    };
    saveCfg(cfg);
    updateProxyInfo();
    initModelSelector();
    cfgStatus.textContent = "saved";
    cfgStatus.classList.remove("error");
    setTimeout(() => (cfgStatus.textContent = ""), 2000);
  });

  cfgClear.addEventListener("click", () => {
    if (!confirm("Clear all chat history?")) return;
    history = [];
    localStorage.removeItem(CHAT_KEY);
    renderHistory();
  });

  // ── Composer wiring ───────────────────────────────────────────────────────
  fileInput.addEventListener("change", async (e) => {
    const target = e.target;
    if (!target.files) return;
    await handleFiles(Array.from(target.files));
    target.value = "";
  });

  composerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = composerInput.value.trim();
    if (!text && pendingAttachments.length === 0) return;
    composerInput.value = "";
    sendMessage(text);
  });

  composerInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      composerForm.requestSubmit();
    }
  });

  // ── Debug log panel ───────────────────────────────────────────────────────
  let logEs = null;

  function fmtTs(iso) {
    try {
      const d = new Date(iso);
      return d.toTimeString().slice(0, 8);
    } catch { return "??:??:??"; }
  }

  function appendLogEntry(ev) {
    const phase = ev.phase ?? "?";
    const ts = fmtTs(ev.ts);
    const badgeClass =
      ev.blocked ? "log-badge--dlp"
      : phase === "request"  ? "log-badge--req"
      : phase === "response" ? "log-badge--res"
      : "log-badge--err";
    const badgeText = ev.blocked ? "BLOCK" : phase.slice(0, 3).toUpperCase();

    const bodyParts = [];
    if (ev.model) bodyParts.push(`<span class="log-model">${ev.model.split("/").pop()}</span>`);
    if (ev.blocked) bodyParts.push(`<span class="log-blocked">BLOCKED</span>`);
    if (ev.dlpMatches && ev.dlpMatches.length > 0) {
      const summary = ev.dlpMatches.map((m) => `${m.name}×${m.count}`).join(", ");
      bodyParts.push(`<span class="log-dlp">DLP: ${summary}</span>`);
    }
    if (ev.bytesIn  != null) bodyParts.push(`→${ev.bytesIn}B`);
    if (ev.bytesOut != null) bodyParts.push(`←${ev.bytesOut}B`);
    if (ev.latencyMs != null) bodyParts.push(`<span class="log-lat">${ev.latencyMs}ms</span>`);
    if (ev.error) bodyParts.push(`<span class="log-blocked">${ev.error}</span>`);

    const wrap = document.createElement("div");
    wrap.className = "log-entry-wrap";

    const row = document.createElement("div");
    row.className = "log-entry";
    row.innerHTML =
      `<span class="log-ts">${ts}</span>` +
      `<span class="log-badge ${badgeClass}">${badgeText}</span>` +
      `<span class="log-body">${bodyParts.join(" · ")}</span>`;
    wrap.appendChild(row);

    // Message preview (post-DLP — tokens replace originals)
    if (ev.bodyPreview) {
      const pre = document.createElement("div");
      pre.className = "log-preview";
      pre.textContent = ev.bodyPreview;
      wrap.appendChild(pre);
    }

    // Vault token map for redacted requests
    const hasRedact = ev.dlpMatches && ev.dlpMatches.some((m) => m.policy === "redact");
    if (hasRedact && ev.convId) {
      const vaultRow = document.createElement("div");
      vaultRow.className = "log-vault";
      vaultRow.textContent = "loading tokens…";
      wrap.appendChild(vaultRow);
      fetch(`${cfg.proxyUrl.replace(/\/$/, "")}/debug/vault?convId=${ev.convId}`)
        .then((r) => r.json())
        .then((d) => {
          if (!d.tokens || d.tokens.length === 0) {
            vaultRow.textContent = "(no tokens in vault)";
            return;
          }
          vaultRow.innerHTML = d.tokens
            .map((t) => `<span class="vault-token">${t.token}</span> → <span class="vault-orig">${t.original}</span>`)
            .join("  ");
        })
        .catch(() => { vaultRow.textContent = "vault fetch failed"; });
    }

    logEntries.appendChild(wrap);
    logEntries.scrollTop = logEntries.scrollHeight;
  }

  function startLogStream() {
    if (logEs) { logEs.close(); logEs = null; }
    const url = `${cfg.proxyUrl.replace(/\/$/, "")}/debug/stream`;
    logEs = new EventSource(url, { withCredentials: false });
    // EventSource doesn't support custom headers; we rely on the proxy
    // being configured to not require auth on /debug/stream, OR we pass
    // the token as a query param — for simplicity the proxy auth guard
    // already passed since we set the token via Authorization header in
    // fetch, but EventSource can't. We use a workaround: include token in URL.
    logEs.onopen = () => {
      logConn.textContent = "● connected";
      logConn.className = "log-conn log-conn--on";
    };
    logEs.onmessage = (e) => {
      try { appendLogEntry(JSON.parse(e.data)); } catch { /* malformed */ }
    };
    logEs.onerror = () => {
      logConn.textContent = "● disconnected";
      logConn.className = "log-conn log-conn--off";
    };
  }

  function stopLogStream() {
    if (logEs) { logEs.close(); logEs = null; }
    logConn.textContent = "● disconnected";
    logConn.className = "log-conn log-conn--off";
  }

  logToggleBtn.addEventListener("click", () => {
    const hidden = logPanel.hidden;
    logPanel.hidden = !hidden;
    logToggleBtn.classList.toggle("btn-active", hidden);
    if (hidden) startLogStream(); else stopLogStream();
  });

  logClearBtn.addEventListener("click", () => { logEntries.innerHTML = ""; });

  // ── Init ──────────────────────────────────────────────────────────────────
  initModelSelector();
  updateProxyInfo();
  renderHistory();
  setStatus(cfg.bearerToken ? "ready" : "set bearer token in Settings", cfg.bearerToken ? undefined : "error");
})();
