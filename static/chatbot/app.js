const state = {
  sessionId: null,
  pendingTypingId: null,
  loading: false,
};

const els = {
  panel: document.getElementById("chatPanel"),
  form: document.getElementById("chatForm"),
  input: document.getElementById("userInput"),
  sendBtn: document.getElementById("sendBtn"),
  status: document.getElementById("apiStatus"),
  pdfCount: document.getElementById("pdfCount"),
  lastUpdate: document.getElementById("lastUpdate"),
  reindexBtn: document.getElementById("reindexBtn"),
  tpl: document.getElementById("messageTemplate"),
};

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

  // Clean up excessive spaces and line breaks
  let cleaned = text
    .replace(/\r\n/g, "\n") // Normalize line endings
    .replace(/\n{3,}/g, "\n\n") // Max 2 consecutive line breaks
    .replace(/ {2,}/g, " ") // Replace multiple spaces with single space
    .trim();

  // Parse markdown if marked library is available
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

  // Fallback: convert line breaks to <br>
  return cleaned.replace(/\n/g, "<br>");
}

function ensureCopyButton(msgEl, text) {
  if (!msgEl.classList.contains("assistant")) return;

  const content = (text || "").trim();
  const existing = msgEl.querySelector(".copy-btn");
  if (!content) {
    if (existing) existing.remove();
    return;
  }

  const btn = existing || document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.textContent = "Copier";

  if (!existing) {
    msgEl.appendChild(btn);
  }

  btn.onclick = async () => {
    const copied = await copyTextToClipboard(content);
    const old = btn.textContent;
    btn.textContent = copied ? "Copié" : "Échec";
    setTimeout(() => {
      btn.textContent = old;
    }, 1200);
  };
}

function addMessage(role, text, { isError = false, withTyping = false } = {}) {
  const fragment = els.tpl.content.cloneNode(true);
  const msgEl = fragment.querySelector(".msg");
  const bubbleEl = fragment.querySelector(".bubble");

  msgEl.classList.add(role);
  if (isError) msgEl.classList.add("error");

  if (withTyping) {
    bubbleEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    msgEl.dataset.typing = "1";
    state.pendingTypingId = crypto.randomUUID();
    msgEl.dataset.typingId = state.pendingTypingId;
  } else {
    // Use innerHTML for markdown support
    bubbleEl.innerHTML = parseAndCleanText(text);
    ensureCopyButton(msgEl, text);
  }

  els.panel.appendChild(fragment);
  scrollToBottom();
}

function replaceTypingWithText(text, isError = false) {
  const typingNode = [...els.panel.querySelectorAll(".msg[data-typing='1']")].pop();
  if (!typingNode) {
    addMessage("assistant", text, { isError });
    return;
  }

  typingNode.dataset.typing = "0";
  if (isError) typingNode.classList.add("error");
  const bubble = typingNode.querySelector(".bubble");
  // Use innerHTML for markdown support
  bubble.innerHTML = parseAndCleanText(text);
  ensureCopyButton(typingNode, text);
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

async function fetchHealth() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error("API indisponible");
    const data = await res.json();
    els.status.textContent = data.ok ? "API connectée" : "API indisponible";
  } catch {
    els.status.textContent = "API indisponible";
  }
}

async function fetchKbInfo() {
  try {
    const res = await fetch("/api/kb");
    if (!res.ok) throw new Error("Impossible de charger la base documentaire");
    const data = await res.json();
    els.pdfCount.textContent = `${data.pdf_count} documents indexés`;
    els.lastUpdate.textContent = formatDate(data.latest_update);
  } catch (err) {
    els.pdfCount.textContent = "Erreur de chargement";
    els.lastUpdate.textContent = "Erreur de chargement";
    addMessage("assistant", err.message || "Erreur lors du chargement des métadonnées.", { isError: true });
  }
}

async function reindex() {
  if (state.loading) return;
  setLoading(true);
  addMessage("assistant", "Réindexation en cours...", { withTyping: true });

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

async function sendMessage(message) {
  if (state.loading) return;
  const clean = message.trim();
  if (!clean) return;

  addMessage("user", clean);
  addMessage("assistant", "", { withTyping: true });

  setLoading(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: clean,
        session_id: state.sessionId,
      }),
    });

    if (!res.ok) {
      throw new Error("Le serveur a retourné une erreur. Veuillez réessayer.");
    }

    const data = await res.json();
    state.sessionId = data.session_id;
    replaceTypingWithText(data.reply || "Je n'ai pas pu générer de réponse.");
  } catch (err) {
    replaceTypingWithText(err.message || "Erreur réseau pendant l'envoi du message.", true);
  } finally {
    setLoading(false);
    els.input.focus();
  }
}

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

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.dataset.prompt || "";
      els.input.value = prompt;
      autoResizeInput();
      els.form.requestSubmit();
    });
  });

  els.reindexBtn.addEventListener("click", reindex);
}

async function init() {
  addMessage(
    "assistant",
    "Bonjour. Je suis votre assistant documentaire. Posez votre question, je répondrai à partir de ma base documentaire."
  );

  bindEvents();
  autoResizeInput();
  await Promise.all([fetchHealth(), fetchKbInfo()]);
  els.input.focus();
}

init();
