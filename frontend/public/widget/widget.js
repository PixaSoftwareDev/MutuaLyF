(function () {
  "use strict";

  var scriptTag = document.currentScript || (function () {
    var scripts = document.querySelectorAll("script[data-token]");
    return scripts[scripts.length - 1];
  })();

  var WIDGET_TOKEN = scriptTag ? scriptTag.getAttribute("data-token") : null;
  var API_BASE     = scriptTag ? (scriptTag.getAttribute("data-api-url") || "") : "";
  var PLACEHOLDER  = scriptTag ? (scriptTag.getAttribute("data-placeholder") || "Hacé una pregunta...") : "Hacé una pregunta...";
  var TITLE        = scriptTag ? (scriptTag.getAttribute("data-title") || "MutualBot") : "MutualBot";

  // Lucide-style Bot icon (inline SVG, currentColor stroke)
  var BOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

  if (!WIDGET_TOKEN) { console.error("[IA Widget] data-token is required"); return; }

  var SESSION_KEY = "ia_widget_session_" + WIDGET_TOKEN.slice(-8);
  var widgetSessionId = localStorage.getItem(SESSION_KEY);
  if (!widgetSessionId) {
    widgetSessionId = "ws_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem(SESSION_KEY, widgetSessionId);
  }

  // Remembered sector from previous session
  var SECTOR_KEY       = "ia_widget_sector_" + WIDGET_TOKEN.slice(-8);
  var rememberedSector = null;
  try { rememberedSector = JSON.parse(localStorage.getItem(SECTOR_KEY) || "null"); } catch(e) {}

  var conversationId  = null;
  var lastMessageId   = null;
  var pollAlive       = false;
  var pollTimeout     = null;
  var convStatus      = "bot_active";
  var sectors         = [];
  var selectedSector  = null;
  var sectorPhase     = true; // true = showing sector picker, false = in chat

  // ── Styles ─────────────────────────────────────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "#ia-widget-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#99323D;color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:9998;display:flex;align-items:center;justify-content:center;transition:transform .2s;}",
    "#ia-widget-btn:hover{transform:scale(1.05);}",
    "#ia-widget-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;display:none;align-items:center;justify-content:center;font-weight:700;}",
    "#ia-widget-panel{position:fixed;bottom:92px;right:24px;width:360px;max-height:560px;border-radius:12px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.15);z-index:9999;display:none;flex-direction:column;font-family:system-ui,sans-serif;overflow:hidden;}",
    "#ia-widget-panel.open{display:flex;}",
    // Header
    "#ia-widget-header{padding:12px 16px;background:#99323D;color:#fff;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;gap:8px;}",
    "#ia-widget-title{font-weight:600;font-size:15px;flex:1;}",
    "#ia-widget-status{font-size:11px;opacity:.85;background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;white-space:nowrap;}",
    "#ia-widget-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;padding:0;}",
    // Sector picker
    "#ia-sector-picker{flex:1;display:flex;flex-direction:column;overflow:hidden;}",
    "#ia-sector-intro{padding:16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;}",
    "#ia-sector-intro p{margin:0;font-size:13px;color:#475569;}",
    "#ia-sector-intro strong{color:#1e293b;}",
    "#ia-sector-list{flex:1;overflow-y:auto;padding:8px;}",
    ".ia-sector-btn{width:100%;text-align:left;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;margin-bottom:6px;transition:all .15s;display:flex;align-items:center;justify-content:space-between;}",
    ".ia-sector-btn:hover{border-color:#99323D;background:#FBEEF0;}",
    ".ia-sector-btn .ia-sector-name{font-size:14px;font-weight:500;color:#1e293b;}",
    ".ia-sector-btn .ia-sector-desc{font-size:12px;color:#64748b;margin-top:2px;}",
    ".ia-sector-btn .ia-sector-default{font-size:11px;color:#94a3b8;margin-left:6px;}",
    ".ia-sector-btn .ia-sector-arrow{color:#cbd5e1;font-size:16px;}",
    ".ia-sector-btn:hover .ia-sector-arrow{color:#99323D;}",
    "#ia-sector-input-wrap{padding:10px 8px 8px;border-top:1px solid #e2e8f0;}",
    "#ia-sector-direct{width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;}",
    "#ia-sector-direct:focus{border-color:#99323D;}",
    "#ia-sector-hint{text-align:center;font-size:11px;color:#94a3b8;padding:4px 8px 8px;}",
    // Chat
    "#ia-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;min-height:200px;}",
    ".ia-msg{max-width:85%;padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.5;word-break:break-word;}",
    ".ia-msg.user{align-self:flex-end;background:#99323D;color:#fff;border-bottom-right-radius:2px;}",
    ".ia-msg.bot,.ia-msg.operator{align-self:flex-start;background:#f1f5f9;color:#1e293b;border-bottom-left-radius:2px;}",
    ".ia-msg.operator{background:#ecfdf5;border-left:3px solid #10b981;}",
    ".ia-msg.system{align-self:center;background:#fef9c3;color:#854d0e;font-size:12px;border-radius:20px;padding:4px 12px;max-width:90%;text-align:center;}",
    ".ia-msg.error{background:#fee2e2;color:#b91c1c;}",
    ".ia-typing{align-self:flex-start;color:#64748b;font-size:13px;padding:4px 8px;}",
    "#ia-widget-handoff-bar{padding:8px 12px;background:#fff7ed;border-top:1px solid #fed7aa;display:none;gap:8px;align-items:center;font-size:13px;color:#92400e;}",
    "#ia-widget-handoff-bar button{background:#f97316;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:13px;white-space:nowrap;}",
    "#ia-widget-identify-form{padding:10px 12px;background:#fff7ed;border-top:1px solid #fed7aa;display:none;flex-direction:column;gap:8px;font-size:13px;color:#92400e;}",
    "#ia-widget-identify-form .ia-identify-title{font-weight:600;font-size:13px;color:#7c2d12;}",
    "#ia-widget-identify-form .ia-identify-hint{font-size:11px;color:#a16207;line-height:1.4;}",
    "#ia-widget-identify-form input{padding:6px 10px;border:1px solid #fed7aa;border-radius:6px;font-size:13px;width:100%;box-sizing:border-box;}",
    "#ia-widget-identify-form input:focus{outline:none;border-color:#f97316;box-shadow:0 0 0 2px rgba(249,115,22,0.15);}",
    "#ia-widget-identify-form .ia-identify-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;}",
    "#ia-widget-identify-form .ia-identify-submit{background:#f97316;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px;font-weight:500;}",
    "#ia-widget-identify-form .ia-identify-submit:disabled{opacity:0.5;cursor:not-allowed;}",
    "#ia-widget-identify-form .ia-identify-skip{background:none;border:none;cursor:pointer;color:#92400e;font-size:12px;text-decoration:underline;padding:0;}",
    "#ia-widget-identify-form .ia-identify-error{font-size:11px;color:#b91c1c;margin-top:-2px;}",
    "#ia-widget-human-btn{padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;color:#475569;white-space:nowrap;}",
    "#ia-widget-human-btn:hover{background:#f8fafc;}",
    "#ia-sector-change{padding:4px 8px;border:1px solid rgba(255,255,255,.4);border-radius:6px;background:none;color:rgba(255,255,255,.8);cursor:pointer;font-size:11px;white-space:nowrap;}",
    "#ia-sector-change:hover{background:rgba(255,255,255,.15);}",
    "#ia-widget-form{padding:8px 12px;border-top:1px solid #e2e8f0;display:flex;gap:8px;align-items:flex-end;}",
    "#ia-widget-input{flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:8px 10px;font-size:14px;outline:none;resize:none;min-height:36px;max-height:80px;font-family:inherit;}",
    "#ia-widget-input:focus{border-color:#99323D;}",
    "#ia-widget-send{background:#99323D;color:#fff;border:none;border-radius:6px;padding:8px 12px;cursor:pointer;font-size:14px;white-space:nowrap;}",
    "#ia-widget-send:disabled{opacity:.5;cursor:not-allowed;}",
  ].join("");
  document.head.appendChild(style);

  // ── DOM ─────────────────────────────────────────────────────────────────────
  var btn = document.createElement("button");
  btn.id = "ia-widget-btn";
  btn.setAttribute("aria-label", "Abrir asistente");
  btn.innerHTML = BOT_SVG + "<span id='ia-widget-badge'></span>";

  var panel = document.createElement("div");
  panel.id = "ia-widget-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TITLE);
  panel.innerHTML = [
    '<div id="ia-widget-header">',
    '  <span id="ia-widget-title">' + _escape(TITLE) + '</span>',
    '  <span id="ia-widget-status" style="display:none">Bot IA</span>',
    '  <button id="ia-sector-change" style="display:none">Cambiar área</button>',
    '  <button id="ia-widget-close" aria-label="Cerrar">&times;</button>',
    '</div>',
    // Sector picker
    '<div id="ia-sector-picker">',
    '  <div id="ia-sector-intro"><p><strong>¿En qué área necesitás ayuda?</strong><br>Elegí un sector o escribí tu consulta directamente.</p></div>',
    '  <div id="ia-sector-list"><div style="padding:20px;text-align:center;color:#94a3b8;font-size:13px;">Cargando…</div></div>',
    '  <div id="ia-sector-input-wrap">',
    '    <input id="ia-sector-direct" type="text" placeholder="O escribí tu consulta y te asignamos automáticamente…" />',
    '    <div id="ia-sector-hint"></div>',
    '  </div>',
    '</div>',
    // Chat
    '<div id="ia-widget-messages" style="display:none" aria-live="polite"></div>',
    '<div id="ia-widget-handoff-bar">',
    '  <span style="flex:1">¿Querés hablar con un operador?</span>',
    '  <button id="ia-handoff-yes">Sí, conectar</button>',
    '  <button id="ia-handoff-no" style="background:none;border:none;cursor:pointer;color:#92400e">Ahora no</button>',
    '</div>',
    // Form de identificación just-in-time — aparece al confirmar handoff,
    // antes de derivar realmente. Permite al operador ver nombre + DNI.
    '<form id="ia-widget-identify-form" autocomplete="off">',
    '  <div class="ia-identify-title">Antes de conectarte con un operador</div>',
    '  <div class="ia-identify-hint">Para una mejor atención, decinos tu nombre y DNI:</div>',
    '  <input id="ia-identify-nombre" type="text" placeholder="Nombre y apellido" maxlength="200" />',
    '  <input id="ia-identify-dni" type="text" inputmode="numeric" placeholder="DNI (sin puntos)" maxlength="20" />',
    '  <div id="ia-identify-error" class="ia-identify-error" style="display:none"></div>',
    '  <div class="ia-identify-actions">',
    '    <button type="button" class="ia-identify-skip" id="ia-identify-skip-btn">Prefiero no decir</button>',
    '    <button type="submit" class="ia-identify-submit" id="ia-identify-submit-btn">Continuar</button>',
    '  </div>',
    '</form>',
    '<form id="ia-widget-form" style="display:none">',
    '  <textarea id="ia-widget-input" rows="1" placeholder="' + _escape(PLACEHOLDER) + '" autocomplete="off"></textarea>',
    '  <button id="ia-widget-human-btn" type="button" title="Hablar con un operador">👤</button>',
    '  <button id="ia-widget-send" type="submit">Enviar</button>',
    '</form>',
  ].join("");

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var sectorPicker   = document.getElementById("ia-sector-picker");
  var sectorList     = document.getElementById("ia-sector-list");
  var sectorDirect   = document.getElementById("ia-sector-direct");
  var sectorHint     = document.getElementById("ia-sector-hint");
  var messagesEl     = document.getElementById("ia-widget-messages");
  var inputEl        = document.getElementById("ia-widget-input");
  var sendBtn        = document.getElementById("ia-widget-send");
  var widgetForm     = document.getElementById("ia-widget-form");
  var statusEl       = document.getElementById("ia-widget-status");
  var handoffBar     = document.getElementById("ia-widget-handoff-bar");
  var identifyForm   = document.getElementById("ia-widget-identify-form");
  var identifyNombre = document.getElementById("ia-identify-nombre");
  var identifyDni    = document.getElementById("ia-identify-dni");
  var identifyError  = document.getElementById("ia-identify-error");
  var identifyBtn    = document.getElementById("ia-identify-submit-btn");
  var identifySkip   = document.getElementById("ia-identify-skip-btn");
  var badge          = document.getElementById("ia-widget-badge");
  var sectorChange   = document.getElementById("ia-sector-change");

  // ── Events ──────────────────────────────────────────────────────────────────
  btn.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      badge.style.display = "none";
      if (!sectors.length) _loadSectors();
      if (conversationId) {
        // Already in chat
      } else if (rememberedSector) {
        // Skip picker — use remembered sector
        _enterChat(rememberedSector);
      } else {
        sectorDirect.focus();
      }
    }
  });

  document.getElementById("ia-widget-close").addEventListener("click", function () {
    panel.classList.remove("open");
  });

  sectorChange.addEventListener("click", function () {
    // Allow changing sector only if conversation hasn't started yet
    sectorPhase = true;
    conversationId = null;
    selectedSector = null;
    localStorage.removeItem(SECTOR_KEY);
    _showSectorPicker();
  });

  sectorDirect.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && sectorDirect.value.trim()) {
      var def = sectors.find(function(s) { return s.is_default; }) || sectors[0];
      if (def) _enterChat(def, sectorDirect.value.trim());
    }
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
      widgetForm.dispatchEvent(new Event("submit"));
    }
  });

  document.getElementById("ia-widget-human-btn").addEventListener("click", function () {
    if (!conversationId) return;
    _requestHuman();
  });

  document.getElementById("ia-handoff-yes").addEventListener("click", function () {
    handoffBar.style.display = "none";
    // Antes de derivar, pedimos identificación just-in-time
    _showIdentifyForm();
  });

  document.getElementById("ia-handoff-no").addEventListener("click", function () {
    handoffBar.style.display = "none";
  });

  // Identify form: submit con datos
  identifyForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var nombre = identifyNombre.value.trim();
    var dni    = identifyDni.value.trim();
    if (!nombre) { _identifyShowError("Decinos tu nombre, por favor."); return; }
    if (!dni)    { _identifyShowError("Decinos tu DNI, por favor.");    return; }
    if (dni.length < 4) { _identifyShowError("El DNI parece muy corto."); return; }
    identifyBtn.disabled = true;
    identifySkip.disabled = true;
    _confirmHandoff({ afiliado_nombre: nombre, afiliado_dni: dni });
  });

  // Skip: deriva sin datos (degraded mode)
  identifySkip.addEventListener("click", function () {
    identifyBtn.disabled = true;
    identifySkip.disabled = true;
    _confirmHandoff(null);
  });

  function _showIdentifyForm() {
    identifyNombre.value = "";
    identifyDni.value    = "";
    identifyError.style.display = "none";
    identifyBtn.disabled  = false;
    identifySkip.disabled = false;
    identifyForm.style.display = "flex";
    identifyNombre.focus();
  }

  function _hideIdentifyForm() {
    identifyForm.style.display = "none";
  }

  function _identifyShowError(msg) {
    identifyError.textContent = msg;
    identifyError.style.display = "block";
  }

  // ── Sector logic ────────────────────────────────────────────────────────────
  function _loadSectors() {
    fetch(API_BASE + "/api/v1/widget/sectors", { headers: _headers() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        sectors = data;
        _renderSectorList();
        var def = sectors.find(function(s) { return s.is_default; }) || sectors[0];
        if (def) sectorHint.textContent = "Si no elegís, te asignamos a «" + def.nombre + "»";
      })
      .catch(function() {
        sectorList.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:13px;">Error al cargar sectores.</div>';
      });
  }

  function _renderSectorList() {
    sectorList.innerHTML = "";
    sectors.forEach(function(s) {
      var btn = document.createElement("button");
      btn.className = "ia-sector-btn";
      btn.innerHTML =
        '<div><div class="ia-sector-name">' + _escape(s.nombre) +
        (s.is_default ? '<span class="ia-sector-default">(predeterminado)</span>' : '') +
        '</div>' +
        (s.descripcion ? '<div class="ia-sector-desc">' + _escape(s.descripcion) + '</div>' : '') +
        '</div><span class="ia-sector-arrow">→</span>';
      btn.addEventListener("click", function() { _enterChat(s); });
      sectorList.appendChild(btn);
    });
  }

  function _enterChat(sector, pendingMessage) {
    selectedSector  = sector;
    sectorPhase     = false;
    localStorage.setItem(SECTOR_KEY, JSON.stringify(sector));
    _showChatView(sector);
    _startConversation(sector.id, pendingMessage);
  }

  function _showSectorPicker() {
    sectorPicker.style.display = "flex";
    sectorPicker.style.flexDirection = "column";
    messagesEl.style.display = "none";
    handoffBar.style.display = "none";
    widgetForm.style.display = "none";
    statusEl.style.display = "none";
    sectorChange.style.display = "none";
    document.getElementById("ia-widget-title").textContent = TITLE;
    if (sectors.length) _renderSectorList();
    else _loadSectors();
  }

  function _showChatView(sector) {
    sectorPicker.style.display = "none";
    messagesEl.style.display = "flex";
    widgetForm.style.display = "flex";
    statusEl.style.display = "block";
    sectorChange.style.display = "block";
    document.getElementById("ia-widget-title").textContent = sector.nombre;
    inputEl.focus();
  }

  // ── API helpers ──────────────────────────────────────────────────────────────
  function _headers() {
    return { "Content-Type": "application/json", "Authorization": "Bearer " + WIDGET_TOKEN };
  }

  function _startConversation(sectorId, pendingMessage) {
    fetch(API_BASE + "/api/v1/widget/conversation/start", {
      method: "POST",
      headers: _headers(),
      body: JSON.stringify({ widget_session_id: widgetSessionId, sector_id: sectorId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        conversationId = data.conversation_id;
        convStatus     = data.status;
        _updateStatus();
        if (data.resumed) {
          _loadHistory();
        } else {
          _appendMessage("system", "¡Hola! Soy " + _escape(TITLE) + ", asistente de " + _escape(selectedSector ? selectedSector.nombre : TITLE) + ". ¿En qué te puedo ayudar?");
          if (pendingMessage) _sendMessage(pendingMessage);
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
        // Mutuamente excluyentes: si el sistema auto-activo el handoff, mostramos
        // el mensaje en linea y nunca la barra. Si solo es oferta, mostramos la
        // barra y el polling siguiente la persiste leyendo is_handoff_offer.
        if (data.handoff_activated && data.handoff_message) {
          handoffBar.style.display = "none";
          _appendMessage("system", data.handoff_message);
        } else if (data.handoff_offered && data.handoff_message) {
          _showHandoffBar(data.handoff_message);
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
      method: "POST", headers: _headers(),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status;
        _updateStatus();
        if (data.message) _appendMessage("system", data.message);
      })
      .catch(function (err) { console.error("[IA Widget] human request error:", err); });
  }

  function _confirmHandoff(identifyData) {
    var fetchOpts = { method: "POST", headers: _headers() };
    if (identifyData && (identifyData.afiliado_nombre || identifyData.afiliado_dni)) {
      fetchOpts.headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(identifyData);
    }
    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/confirm-handoff", fetchOpts)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status;
        _updateStatus();
        _hideIdentifyForm();
      })
      .catch(function (err) {
        console.error("[IA Widget] confirm handoff error:", err);
        identifyBtn.disabled  = false;
        identifySkip.disabled = false;
        _identifyShowError("No pudimos conectarte. Probá de nuevo.");
      });
  }

  // ── Long-polling ─────────────────────────────────────────────────────────────
  // Server holds each request up to ~25s and replies as soon as there's news.
  // We chain the next request right after the previous one finishes, so
  // perceived latency is ~RTT instead of the old 5s interval.
  function _startPolling() {
    if (pollTimeout) clearTimeout(pollTimeout);
    pollAlive = true;
    _pollLoop();
  }

  function _stopPolling() {
    pollAlive = false;
    if (pollTimeout) clearTimeout(pollTimeout);
    pollTimeout = null;
  }

  function _pollLoop() {
    if (!pollAlive || !conversationId) return;
    _poll().finally(function () {
      if (!pollAlive) return;
      // Small breather to avoid hot-looping if the endpoint is degraded.
      pollTimeout = setTimeout(_pollLoop, 250);
    });
  }

  function _poll() {
    if (!conversationId) return Promise.resolve();
    var url = API_BASE + "/api/v1/widget/conversation/" + conversationId + "/poll";
    if (lastMessageId) url += "?last_message_id=" + lastMessageId;

    return fetch(url, { headers: _headers() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status;
        _updateStatus();
        var pendingOffer = null;
        (data.messages || []).forEach(function (m) {
          if (m.is_handoff_offer) pendingOffer = m.content;
          if (lastMessageId === m.id) return;
          _appendMessage(m.sender_type, m.content);
          lastMessageId = m.id;
          if (!panel.classList.contains("open") && (m.sender_type === "operator" || m.sender_type === "system")) {
            badge.style.display = "flex";
            badge.textContent = "!";
          }
        });
        // La oferta solo sigue vigente mientras el bot este activo. Si paso a
        // handoff_requested/human_attending/closed, la barra desaparece sin
        // depender de que el cliente "se acuerde" del estado anterior.
        if (pendingOffer && convStatus === "bot_active") {
          _showHandoffBar(pendingOffer);
        } else {
          handoffBar.style.display = "none";
        }
      })
      .catch(function () {});
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────

  // Regex global para detectar URLs http(s) en el texto del mensaje.
  // Strip de puntuacion final (".,;:!?") porque es comun que el LLM diga
  // "visita https://example.com." y no queremos que el punto entre al link.
  var URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

  // Renderiza texto con URLs convertidas en <a> clickables.
  // Usa createTextNode + createElement (NO innerHTML) para evitar inyeccion
  // de HTML desde respuestas del bot. URLs van con target="_blank" + rel.
  function _renderTextWithLinks(text, parentEl) {
    URL_REGEX.lastIndex = 0;
    var last = 0;
    var match;
    while ((match = URL_REGEX.exec(text)) !== null) {
      // Texto antes del link
      if (match.index > last) {
        parentEl.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      // Strip puntuacion final
      var url = match[0].replace(/[.,;:!?]+$/, "");
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = url;
      anchor.style.color = "inherit";
      anchor.style.textDecoration = "underline";
      anchor.style.textUnderlineOffset = "2px";
      anchor.style.wordBreak = "break-all";
      parentEl.appendChild(anchor);
      last = match.index + url.length;
    }
    // Texto despues del ultimo link
    if (last < text.length) {
      parentEl.appendChild(document.createTextNode(text.slice(last)));
    }
    // Si no hubo matches, igual hay que poner el texto entero
    if (last === 0) {
      parentEl.textContent = text;
    }
  }

  function _appendMessage(senderType, text) {
    var el = document.createElement("div");
    el.className = "ia-msg " + senderType;
    _renderTextWithLinks(text, el);
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
      "bot_active":        "#99323D",
      "handoff_requested": "#d97706",
      "human_attending":   "#059669",
      "closed":            "#64748b",
    };
    document.getElementById("ia-widget-header").style.background = colors[convStatus] || "#99323D";
    var closed = convStatus === "closed";
    inputEl.disabled = closed;
    sendBtn.disabled = closed;
    document.getElementById("ia-widget-human-btn").style.display =
      (convStatus === "bot_active") ? "block" : "none";
  }

  function _escape(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
