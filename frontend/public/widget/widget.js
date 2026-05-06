(function () {
  "use strict";

  var scriptTag = document.currentScript || (function () {
    var scripts = document.querySelectorAll("script[data-token]");
    return scripts[scripts.length - 1];
  })();

  var WIDGET_TOKEN = scriptTag ? scriptTag.getAttribute("data-token") : null;
  var API_BASE     = scriptTag ? (scriptTag.getAttribute("data-api-url") || "") : "";
  var PLACEHOLDER  = scriptTag ? (scriptTag.getAttribute("data-placeholder") || "Hacé una pregunta...") : "Hacé una pregunta...";
  var TITLE        = scriptTag ? (scriptTag.getAttribute("data-title") || "Asistente") : "Asistente";

  if (!WIDGET_TOKEN) { console.error("[IA Widget] data-token is required"); return; }

  // ── Session ID (persists across page reloads) ─────────────────────────────
  var SESSION_KEY = "ia_widget_session_" + WIDGET_TOKEN.slice(-8);
  var widgetSessionId = localStorage.getItem(SESSION_KEY);
  if (!widgetSessionId) {
    widgetSessionId = "ws_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem(SESSION_KEY, widgetSessionId);
  }

  var conversationId  = null;
  var lastMessageId   = null;
  var pollingInterval = null;
  var convStatus      = "bot_active"; // bot_active | handoff_requested | human_attending

  // ── Styles ─────────────────────────────────────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "#ia-widget-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#2563eb;color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:9998;display:flex;align-items:center;justify-content:center;transition:transform .2s;}",
    "#ia-widget-btn:hover{transform:scale(1.05);}",
    "#ia-widget-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;display:none;align-items:center;justify-content:center;font-weight:700;}",
    "#ia-widget-panel{position:fixed;bottom:92px;right:24px;width:360px;max-height:540px;border-radius:12px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.15);z-index:9999;display:none;flex-direction:column;font-family:system-ui,sans-serif;}",
    "#ia-widget-panel.open{display:flex;}",
    "#ia-widget-header{padding:12px 16px;background:#2563eb;color:#fff;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;gap:8px;}",
    "#ia-widget-title{font-weight:600;font-size:15px;flex:1;}",
    "#ia-widget-status{font-size:11px;opacity:.85;background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;white-space:nowrap;}",
    "#ia-widget-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;padding:0;}",
    "#ia-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;min-height:200px;}",
    ".ia-msg{max-width:85%;padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.5;word-break:break-word;}",
    ".ia-msg.user{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:2px;}",
    ".ia-msg.bot,.ia-msg.operator{align-self:flex-start;background:#f1f5f9;color:#1e293b;border-bottom-left-radius:2px;}",
    ".ia-msg.operator{background:#ecfdf5;border-left:3px solid #10b981;}",
    ".ia-msg.system{align-self:center;background:#fef9c3;color:#854d0e;font-size:12px;border-radius:20px;padding:4px 12px;max-width:90%;text-align:center;}",
    ".ia-msg.error{background:#fee2e2;color:#b91c1c;}",
    ".ia-typing{align-self:flex-start;color:#64748b;font-size:13px;padding:4px 8px;}",
    "#ia-widget-handoff-bar{padding:8px 12px;background:#fff7ed;border-top:1px solid #fed7aa;display:none;gap:8px;align-items:center;font-size:13px;color:#92400e;}",
    "#ia-widget-handoff-bar button{background:#f97316;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:13px;white-space:nowrap;}",
    "#ia-widget-human-btn{padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;color:#475569;white-space:nowrap;}",
    "#ia-widget-human-btn:hover{background:#f8fafc;}",
    "#ia-widget-form{padding:8px 12px;border-top:1px solid #e2e8f0;display:flex;gap:8px;align-items:flex-end;}",
    "#ia-widget-input{flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:8px 10px;font-size:14px;outline:none;resize:none;min-height:36px;max-height:80px;font-family:inherit;}",
    "#ia-widget-input:focus{border-color:#2563eb;}",
    "#ia-widget-send{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;cursor:pointer;font-size:14px;white-space:nowrap;}",
    "#ia-widget-send:disabled{opacity:.5;cursor:not-allowed;}",
  ].join("");
  document.head.appendChild(style);

  // ── DOM ────────────────────────────────────────────────────────────────────
  var btn = document.createElement("button");
  btn.id = "ia-widget-btn";
  btn.setAttribute("aria-label", "Abrir asistente");
  btn.innerHTML = "💬<span id='ia-widget-badge'></span>";

  var panel = document.createElement("div");
  panel.id = "ia-widget-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TITLE);
  panel.innerHTML = [
    '<div id="ia-widget-header">',
    '  <span id="ia-widget-title">' + _escape(TITLE) + '</span>',
    '  <span id="ia-widget-status">Bot IA</span>',
    '  <button id="ia-widget-close" aria-label="Cerrar">&times;</button>',
    '</div>',
    '<div id="ia-widget-messages" aria-live="polite"></div>',
    '<div id="ia-widget-handoff-bar">',
    '  <span style="flex:1">¿Querés hablar con un operador?</span>',
    '  <button id="ia-handoff-yes">Sí, conectar</button>',
    '  <button id="ia-handoff-no" style="background:none;border:none;cursor:pointer;color:#92400e">Ahora no</button>',
    '</div>',
    '<form id="ia-widget-form">',
    '  <textarea id="ia-widget-input" rows="1" placeholder="' + _escape(PLACEHOLDER) + '" autocomplete="off"></textarea>',
    '  <button id="ia-widget-human-btn" type="button" title="Hablar con un operador">👤</button>',
    '  <button id="ia-widget-send" type="submit">Enviar</button>',
    '</form>',
  ].join("");

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var messagesEl   = document.getElementById("ia-widget-messages");
  var inputEl      = document.getElementById("ia-widget-input");
  var sendBtn      = document.getElementById("ia-widget-send");
  var statusEl     = document.getElementById("ia-widget-status");
  var handoffBar   = document.getElementById("ia-widget-handoff-bar");
  var badge        = document.getElementById("ia-widget-badge");

  // ── Events ─────────────────────────────────────────────────────────────────
  btn.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      badge.style.display = "none";
      inputEl.focus();
      if (!conversationId) _startConversation();
    }
  });

  document.getElementById("ia-widget-close").addEventListener("click", function () {
    panel.classList.remove("open");
  });

  document.getElementById("ia-widget-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var question = inputEl.value.trim();
    if (!question || !conversationId) return;
    inputEl.value = "";
    inputEl.style.height = "auto";
    _sendMessage(question);
  });

  inputEl.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 80) + "px";
  });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("ia-widget-form").dispatchEvent(new Event("submit"));
    }
  });

  document.getElementById("ia-widget-human-btn").addEventListener("click", function () {
    if (!conversationId) return;
    _requestHuman();
  });

  document.getElementById("ia-handoff-yes").addEventListener("click", function () {
    handoffBar.style.display = "none";
    _confirmHandoff();
  });

  document.getElementById("ia-handoff-no").addEventListener("click", function () {
    handoffBar.style.display = "none";
  });

  // ── API helpers ────────────────────────────────────────────────────────────
  function _headers() {
    return { "Content-Type": "application/json", "Authorization": "Bearer " + WIDGET_TOKEN };
  }

  function _startConversation() {
    fetch(API_BASE + "/api/v1/widget/conversation/start", {
      method: "POST",
      headers: _headers(),
      body: JSON.stringify({ widget_session_id: widgetSessionId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        conversationId = data.conversation_id;
        convStatus     = data.status;
        _updateStatus();
        if (data.resumed) {
          _loadHistory();
        } else {
          _appendMessage("system", "¡Hola! Soy el asistente de " + TITLE + ". ¿En qué te puedo ayudar?");
        }
        _startPolling();
      })
      .catch(function (err) {
        console.error("[IA Widget] start error:", err);
        _appendMessage("error", "Error al iniciar la conversación.");
      });
  }

  function _loadHistory() {
    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/poll", {
      headers: _headers(),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.messages || []).forEach(function (m) {
          _appendMessage(m.sender_type, m.content);
          lastMessageId = m.id;
        });
        convStatus = data.status;
        _updateStatus();
      })
      .catch(function (err) { console.error("[IA Widget] load history error:", err); });
  }

  function _sendMessage(question) {
    _appendMessage("user", question);
    sendBtn.disabled = true;
    inputEl.disabled = true;
    var typing = document.createElement("div");
    typing.className = "ia-typing";
    typing.textContent = "Escribiendo…";
    messagesEl.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/message", {
      method: "POST",
      headers: _headers(),
      body: JSON.stringify({ content: question, widget_session_id: widgetSessionId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        if (data.bot_response) _appendMessage("bot", data.bot_response);
        convStatus = data.status;
        _updateStatus();

        if (data.handoff_offered && data.handoff_message) {
          _showHandoffBar(data.handoff_message);
        }
        if (data.handoff_activated && data.handoff_message) {
          _appendMessage("system", data.handoff_message);
        }
      })
      .catch(function (err) {
        typing.remove();
        _appendMessage("error", "Error al enviar. Intentá de nuevo.");
        console.error("[IA Widget] send error:", err);
      })
      .finally(function () {
        sendBtn.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
      });
  }

  function _requestHuman() {
    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/human", {
      method: "POST",
      headers: _headers(),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status;
        _updateStatus();
        if (data.message) _appendMessage("system", data.message);
      })
      .catch(function (err) { console.error("[IA Widget] human request error:", err); });
  }

  function _confirmHandoff() {
    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/confirm-handoff", {
      method: "POST",
      headers: _headers(),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status;
        _updateStatus();
      })
      .catch(function (err) { console.error("[IA Widget] confirm handoff error:", err); });
  }

  // ── Polling ────────────────────────────────────────────────────────────────
  function _startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(_poll, 5000);
  }

  function _poll() {
    if (!conversationId) return;
    var url = API_BASE + "/api/v1/widget/conversation/" + conversationId + "/poll";
    if (lastMessageId) url += "?last_message_id=" + lastMessageId;

    fetch(url, { headers: _headers() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status;
        _updateStatus();
        (data.messages || []).forEach(function (m) {
          _appendMessage(m.sender_type, m.content);
          lastMessageId = m.id;
          // Show badge if panel is closed
          if (!panel.classList.contains("open") && (m.sender_type === "operator" || m.sender_type === "system")) {
            badge.style.display = "flex";
            badge.textContent = "!";
          }
        });
      })
      .catch(function () { /* silent polling errors */ });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function _appendMessage(senderType, text) {
    var el = document.createElement("div");
    el.className = "ia-msg " + senderType;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function _showHandoffBar(message) {
    handoffBar.querySelector("span").textContent = message;
    handoffBar.style.display = "flex";
  }

  function _updateStatus() {
    var labels = {
      "bot_active":        "Bot IA",
      "handoff_requested": "En espera…",
      "human_attending":   "Operador conectado",
      "closed":            "Cerrado",
    };
    statusEl.textContent = labels[convStatus] || convStatus;
    var colors = {
      "bot_active":        "#2563eb",
      "handoff_requested": "#d97706",
      "human_attending":   "#059669",
      "closed":            "#64748b",
    };
    document.getElementById("ia-widget-header").style.background = colors[convStatus] || "#2563eb";
    // Disable input if closed
    var closed = convStatus === "closed";
    inputEl.disabled = closed;
    sendBtn.disabled = closed;
    document.getElementById("ia-widget-human-btn").style.display =
      (convStatus === "bot_active") ? "block" : "none";
  }

  function _escape(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
