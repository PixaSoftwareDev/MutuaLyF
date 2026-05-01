(function () {
  "use strict";

  // Read configuration from the script tag's data attributes
  var scriptTag = document.currentScript || (function () {
    var scripts = document.querySelectorAll("script[data-token]");
    return scripts[scripts.length - 1];
  })();

  var WIDGET_TOKEN = scriptTag ? scriptTag.getAttribute("data-token") : null;
  var API_BASE = scriptTag ? (scriptTag.getAttribute("data-api-url") || "") : "";
  var PLACEHOLDER = scriptTag ? (scriptTag.getAttribute("data-placeholder") || "Hacé una pregunta...") : "Hacé una pregunta...";
  var TITLE = scriptTag ? (scriptTag.getAttribute("data-title") || "Asistente") : "Asistente";

  if (!WIDGET_TOKEN) {
    console.error("[IA Widget] data-token is required");
    return;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "#ia-widget-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#2563eb;color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:9998;display:flex;align-items:center;justify-content:center;}",
    "#ia-widget-panel{position:fixed;bottom:92px;right:24px;width:360px;max-height:520px;border-radius:12px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.15);z-index:9999;display:none;flex-direction:column;font-family:system-ui,sans-serif;}",
    "#ia-widget-panel.open{display:flex;}",
    "#ia-widget-header{padding:12px 16px;background:#2563eb;color:#fff;border-radius:12px 12px 0 0;font-weight:600;font-size:15px;display:flex;align-items:center;justify-content:space-between;}",
    "#ia-widget-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;}",
    "#ia-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;}",
    ".ia-msg{max-width:85%;padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.5;}",
    ".ia-msg.user{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:2px;}",
    ".ia-msg.bot{align-self:flex-start;background:#f1f5f9;color:#1e293b;border-bottom-left-radius:2px;}",
    ".ia-msg.error{background:#fee2e2;color:#b91c1c;}",
    "#ia-widget-form{padding:8px 12px;border-top:1px solid #e2e8f0;display:flex;gap:8px;}",
    "#ia-widget-input{flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:8px 10px;font-size:14px;outline:none;}",
    "#ia-widget-input:focus{border-color:#2563eb;}",
    "#ia-widget-send{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;cursor:pointer;font-size:14px;}",
    "#ia-widget-send:disabled{opacity:.5;cursor:not-allowed;}",
  ].join("");
  document.head.appendChild(style);

  // ── DOM ────────────────────────────────────────────────────────────────────
  var btn = document.createElement("button");
  btn.id = "ia-widget-btn";
  btn.setAttribute("aria-label", "Abrir asistente");
  btn.textContent = "💬";

  var panel = document.createElement("div");
  panel.id = "ia-widget-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TITLE);
  panel.innerHTML = [
    '<div id="ia-widget-header">',
    '  <span>' + _escape(TITLE) + '</span>',
    '  <button id="ia-widget-close" aria-label="Cerrar">&times;</button>',
    '</div>',
    '<div id="ia-widget-messages" aria-live="polite"></div>',
    '<form id="ia-widget-form">',
    '  <input id="ia-widget-input" type="text" placeholder="' + _escape(PLACEHOLDER) + '" autocomplete="off" />',
    '  <button id="ia-widget-send" type="submit">Enviar</button>',
    '</form>',
  ].join("");

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var messagesEl = document.getElementById("ia-widget-messages");
  var inputEl = document.getElementById("ia-widget-input");
  var sendBtn = document.getElementById("ia-widget-send");

  // ── Events ─────────────────────────────────────────────────────────────────
  btn.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) inputEl.focus();
  });

  document.getElementById("ia-widget-close").addEventListener("click", function () {
    panel.classList.remove("open");
  });

  document.getElementById("ia-widget-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var question = inputEl.value.trim();
    if (!question) return;
    inputEl.value = "";
    _sendMessage(question);
  });

  // ── Message handling ───────────────────────────────────────────────────────
  function _sendMessage(question) {
    _appendMessage("user", question);
    sendBtn.disabled = true;
    inputEl.disabled = true;

    var endpoint = API_BASE + "/api/v1/query/widget";

    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + WIDGET_TOKEN,
      },
      body: JSON.stringify({ question: question }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        _appendMessage("bot", data.answer || "Sin respuesta");
      })
      .catch(function (err) {
        _appendMessage("error", "Error al contactar el asistente. Intentá de nuevo.");
        console.error("[IA Widget] Error:", err);
      })
      .finally(function () {
        sendBtn.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
      });
  }

  function _appendMessage(role, text) {
    var el = document.createElement("div");
    el.className = "ia-msg " + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function _escape(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
