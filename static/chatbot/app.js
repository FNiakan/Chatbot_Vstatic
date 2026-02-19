const state = {
  sessionId: null,
  pendingTypingId: null,
  loading: false,
  chatStarted: false,
  lastUserPrompt: null,
};

const els = {
  panel: document.getElementById("chatPanel"),
  panelInner: document.querySelector(".chat-panel-inner"),
  form: document.getElementById("chatForm"),
  input: document.getElementById("userInput"),
  sendBtn: document.getElementById("sendBtn"),
  status: document.getElementById("apiStatus"),
  statusDot: document.getElementById("statusDot"),
  pdfCount: document.getElementById("pdfCount"),
  lastUpdate: document.getElementById("lastUpdate"),
  reindexBtn: document.getElementById("reindexBtn"),
  tpl: document.getElementById("messageTemplate"),
  emptyState: document.getElementById("emptyState"),
  sidebar: document.getElementById("sidebar"),
  sidebarOverlay: document.getElementById("sidebarOverlay"),
  menuBtn: document.getElementById("menuBtn"),
  newChatBtn: document.getElementById("newChatBtn"),
};

/* ---------- Helpers ---------- */

function autoResizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    els.panel.scrollTop = els.panel.scrollHeight;
  });
}

async function copyTextToClipboard(text) {
  const content = (text || "").trim();
  if (!content) return false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch {
      return false;
    }
  }

  const probe = document.createElement("textarea");
  probe.value = content;
  probe.setAttribute("readonly", "");
  probe.style.position = "fixed";
  probe.style.top = "-9999px";
  document.body.appendChild(probe);
  probe.select();

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(probe);
  return ok;
}

function parseAndCleanText(text) {
  if (!text) return "";

  let cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();

  if (typeof marked !== "undefined") {
    try {
      return marked.parse(cleaned, {
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false
      });
    } catch (e) {
      console.error("Markdown parsing error:", e);
      return cleaned.replace(/\n/g, "<br>");
    }
  }

  return cleaned.replace(/\n/g, "<br>");
}

/* ---------- Sidebar ---------- */

function openSidebar() {
  els.sidebar.classList.add("open");
  els.sidebarOverlay.classList.add("active");
}

function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.sidebarOverlay.classList.remove("active");
}

/* ---------- Empty State ---------- */

function hideEmptyState() {
  if (!state.chatStarted && els.emptyState) {
    els.emptyState.classList.add("hidden");
    state.chatStarted = true;
  }
}

function showEmptyState() {
  if (els.emptyState) {
    els.emptyState.classList.remove("hidden");
    state.chatStarted = false;
  }
}

/* ---------- Messages ---------- */

const COPY_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
const CHECK_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const RETRY_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>';

function ensureActionButtons(msgEl, text) {
  if (!msgEl.classList.contains("assistant")) return;

  const content = (text || "").trim();
  let actions = msgEl.querySelector(".msg-actions");
  if (!content) {
    if (actions) actions.remove();
    return;
  }

  if (!actions) {
    actions = document.createElement("div");
    actions.className = "msg-actions";
    msgEl.appendChild(actions);
  }

  // Copy button
  let copyBtn = actions.querySelector(".copy-btn");
  if (!copyBtn) {
    copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.title = "Copier";
    copyBtn.innerHTML = COPY_ICON_SVG;
    actions.appendChild(copyBtn);
  }

  copyBtn.onclick = async () => {
    const copied = await copyTextToClipboard(content);
    copyBtn.innerHTML = copied ? CHECK_ICON_SVG : COPY_ICON_SVG;
    if (copied) copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.innerHTML = COPY_ICON_SVG;
      copyBtn.classList.remove("copied");
    }, 1500);
  };

  // Retry button
  let retryBtn = actions.querySelector(".retry-btn");
  if (!retryBtn) {
    retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "retry-btn";
    retryBtn.title = "Réessayer";
    retryBtn.innerHTML = RETRY_ICON_SVG;
    actions.appendChild(retryBtn);
  }

  retryBtn.onclick = () => {
    if (state.loading || !state.lastUserPrompt) return;
    retryAnswer(msgEl);
  };
}

function addMessage(role, text, { isError = false, withTyping = false } = {}) {
  hideEmptyState();

  const fragment = els.tpl.content.cloneNode(true);
  const msgEl = fragment.querySelector(".msg");
  const bubbleEl = fragment.querySelector(".bubble");
  const avatarEl = fragment.querySelector(".avatar");

  msgEl.classList.add(role);
  if (isError) msgEl.classList.add("error");

  // Set avatar content
  if (role === "assistant") {
    avatarEl.innerHTML = '<img src="/static/chatbot/franprix.png" alt="Assistant" />';
  } else if (role === "user") {
    avatarEl.textContent = "VOUS";
  }

  if (withTyping) {
    bubbleEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    msgEl.dataset.typing = "1";
    state.pendingTypingId = crypto.randomUUID();
    msgEl.dataset.typingId = state.pendingTypingId;
  } else {
    bubbleEl.innerHTML = parseAndCleanText(text);
    ensureActionButtons(msgEl, text);
  }

  els.panelInner.appendChild(fragment);
  scrollToBottom();
}

function replaceTypingWithText(text, isError = false) {
  const typingNode = [...els.panelInner.querySelectorAll(".msg[data-typing='1']")].pop();
  if (!typingNode) {
    addMessage("assistant", text, { isError });
    return;
  }

  typingNode.dataset.typing = "0";
  if (isError) typingNode.classList.add("error");
  const bubble = typingNode.querySelector(".bubble");
  bubble.innerHTML = parseAndCleanText(text);
  ensureActionButtons(typingNode, text);
  scrollToBottom();
}

function setLoading(loading) {
  state.loading = loading;
  els.sendBtn.disabled = loading;
  els.reindexBtn.disabled = loading;
}

function formatDate(value) {
  if (!value) return "Non disponible";
  try {
    return new Date(value).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

/* ---------- API Calls ---------- */

async function fetchHealth() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error("API indisponible");
    const data = await res.json();
    const isOnline = !!data.ok;
    els.status.textContent = isOnline ? "API connectée" : "API indisponible";
    els.statusDot.classList.toggle("online", isOnline);
    els.statusDot.classList.toggle("offline", !isOnline);
  } catch {
    els.status.textContent = "API indisponible";
    els.statusDot.classList.remove("online");
    els.statusDot.classList.add("offline");
  }
}

async function fetchKbInfo() {
  try {
    const res = await fetch("/api/kb");
    if (!res.ok) throw new Error("Impossible de charger la base documentaire");
    const data = await res.json();
    els.pdfCount.textContent = `${data.pdf_count} documents`;
    els.lastUpdate.textContent = formatDate(data.latest_update);
  } catch (err) {
    els.pdfCount.textContent = "Erreur";
    els.lastUpdate.textContent = "Erreur";
    addMessage("assistant", err.message || "Erreur lors du chargement des métadonnées.", { isError: true });
  }
}

async function reindex() {
  if (state.loading) return;
  setLoading(true);
  addMessage("assistant", "Réindexation en cours…", { withTyping: true });

  try {
    const res = await fetch("/api/reindex", { method: "POST" });
    if (!res.ok) throw new Error("Échec de la réindexation.");
    const data = await res.json();
    replaceTypingWithText(data.status || "Réindexation terminée.");
    await fetchKbInfo();
  } catch (err) {
    replaceTypingWithText(err.message || "Erreur technique pendant la réindexation.", true);
  } finally {
    setLoading(false);
  }
}

async function streamFromSSE(message, sessionId, bubbleEl, msgEl) {
  /**
   * Shared helper: streams text deltas from /api/chat/stream into bubbleEl.
   * Returns the full accumulated text when done.
   */
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, session_id: sessionId }),
  });

  if (!res.ok) {
    throw new Error("Le serveur a retourné une erreur. Veuillez réessayer.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;

      const payload = trimmed.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const data = JSON.parse(payload);

        // Session ID event
        if (data.type === "session" && data.session_id) {
          state.sessionId = data.session_id;
          continue;
        }

        // Error event
        if (data.error) {
          throw new Error(data.error);
        }

        // Text delta — append to bubble
        if (data.delta) {
          accumulated += data.delta;

          // Show raw text during streaming (fast, no re-parse lag)
          // Remove typing indicator on first delta
          if (msgEl.dataset.typing === "1") {
            msgEl.dataset.typing = "0";
          }
          bubbleEl.innerHTML = parseAndCleanText(accumulated);
          scrollToBottom();
        }
      } catch (parseErr) {
        if (parseErr.message && !parseErr.message.includes("JSON")) {
          throw parseErr; // Re-throw error events
        }
      }
    }
  }

  return accumulated;
}

async function sendMessage(message) {
  if (state.loading) return;
  const clean = message.trim();
  if (!clean) return;

  state.lastUserPrompt = clean;

  addMessage("user", clean);
  addMessage("assistant", "", { withTyping: true });

  setLoading(true);

  // Find the typing message bubble
  const typingNode = [...els.panelInner.querySelectorAll(".msg[data-typing='1']")].pop();
  const bubble = typingNode ? typingNode.querySelector(".bubble") : null;

  try {
    if (typingNode && bubble) {
      const fullText = await streamFromSSE(clean, state.sessionId, bubble, typingNode);
      // Final markdown re-render + action buttons
      const finalText = fullText || "Je n'ai pas pu générer de réponse.";
      bubble.innerHTML = parseAndCleanText(finalText);
      ensureActionButtons(typingNode, finalText);
    } else {
      // Fallback to non-streaming
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: clean, session_id: state.sessionId }),
      });
      if (!res.ok) throw new Error("Le serveur a retourné une erreur.");
      const data = await res.json();
      state.sessionId = data.session_id;
      replaceTypingWithText(data.reply || "Je n'ai pas pu générer de réponse.");
    }
  } catch (err) {
    const errMsg = err.message || "Erreur réseau pendant l'envoi du message.";
    if (typingNode) {
      typingNode.dataset.typing = "0";
      typingNode.classList.add("error");
      bubble.innerHTML = parseAndCleanText(errMsg);
      ensureActionButtons(typingNode, errMsg);
    } else {
      replaceTypingWithText(errMsg, true);
    }
  } finally {
    setLoading(false);
    scrollToBottom();
    els.input.focus();
  }
}

async function retryAnswer(assistantMsgEl) {
  if (state.loading || !state.lastUserPrompt) return;

  // Replace the current assistant message content with typing indicator
  const bubble = assistantMsgEl.querySelector(".bubble");
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  assistantMsgEl.dataset.typing = "1";
  assistantMsgEl.classList.remove("error");

  // Remove existing action buttons during retry
  const actions = assistantMsgEl.querySelector(".msg-actions");
  if (actions) actions.remove();

  setLoading(true);

  try {
    const fullText = await streamFromSSE(state.lastUserPrompt, state.sessionId, bubble, assistantMsgEl);
    const reply = fullText || "Je n'ai pas pu générer de réponse.";

    assistantMsgEl.dataset.typing = "0";
    bubble.innerHTML = parseAndCleanText(reply);
    ensureActionButtons(assistantMsgEl, reply);
  } catch (err) {
    assistantMsgEl.dataset.typing = "0";
    assistantMsgEl.classList.add("error");
    const errMsg = err.message || "Erreur réseau pendant l'envoi du message.";
    bubble.innerHTML = parseAndCleanText(errMsg);
    ensureActionButtons(assistantMsgEl, errMsg);
  } finally {
    setLoading(false);
    scrollToBottom();
    els.input.focus();
  }
}

/* ---------- New Chat ---------- */

function startNewChat() {
  state.sessionId = null;
  state.chatStarted = false;
  state.lastUserPrompt = null;

  // Clear all messages
  const msgs = els.panelInner.querySelectorAll(".msg");
  msgs.forEach((m) => m.remove());

  // Show empty state
  showEmptyState();

  closeSidebar();
  els.input.focus();
}

/* ---------- Event Binding ---------- */

function bindEvents() {
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = els.input.value;
    els.input.value = "";
    autoResizeInput();
    els.input.focus();
    sendMessage(message);
  });

  els.input.addEventListener("input", autoResizeInput);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });

  // Suggestion cards
  document.querySelectorAll(".suggestion-card").forEach((card) => {
    card.addEventListener("click", () => {
      const prompt = card.dataset.prompt || "";
      els.input.value = prompt;
      autoResizeInput();
      els.form.requestSubmit();
    });
  });

  // Reindex
  els.reindexBtn.addEventListener("click", reindex);

  // Sidebar toggle (mobile)
  if (els.menuBtn) {
    els.menuBtn.addEventListener("click", openSidebar);
  }
  if (els.sidebarOverlay) {
    els.sidebarOverlay.addEventListener("click", closeSidebar);
  }

  // New chat
  if (els.newChatBtn) {
    els.newChatBtn.addEventListener("click", startNewChat);
  }
}

/* ---------- Init ---------- */

async function init() {
  bindEvents();
  autoResizeInput();
  await Promise.all([fetchHealth(), fetchKbInfo()]);
  els.input.focus();
}

init();
