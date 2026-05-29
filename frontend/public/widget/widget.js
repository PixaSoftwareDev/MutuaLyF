(function () {
  "use strict";

  var scriptTag = document.currentScript || (function () {
    var scripts = document.querySelectorAll("script[data-token]");
    return scripts[scripts.length - 1];
  })();

  var WIDGET_TOKEN = scriptTag ? scriptTag.getAttribute("data-token") : null;
  // API_BASE: si no se especifica data-api-url, lo inferimos del origin del
  // propio src del script. Sin esto, fetch("/api/v1/...") va a una URL relativa
  // al sitio donde se embebio el widget — falla con "Error al cargar sectores"
  // si el sitio no es el propio servidor del bot.
  var API_BASE = "";
  if (scriptTag) {
    API_BASE = scriptTag.getAttribute("data-api-url") || "";
    if (!API_BASE && scriptTag.src) {
      try { API_BASE = new URL(scriptTag.src).origin; } catch (_e) { API_BASE = ""; }
    }
  }
  var PLACEHOLDER  = scriptTag ? (scriptTag.getAttribute("data-placeholder") || "Hacé una pregunta...") : "Hacé una pregunta...";
  // TITLE y PRIMARY_COLOR son defaults; se sobreescriben con el branding del
  // tenant que cargamos abajo (bot_name / primary_color de /public/tenant-branding).
  // Asi el widget toma identidad del cliente sin que el admin tenga que
  // configurar nada en el snippet.
  var TITLE        = scriptTag ? (scriptTag.getAttribute("data-title") || "Asistente") : "Asistente";
  var PRIMARY_COLOR = "#99323D"; // default; se overridea por branding del tenant
  var LOGO_URL    = null;
  var GREETING    = null;        // saludo inicial del tenant si esta configurado
  // Tamaño del panel — overridable por data-attrs. Default subido de
  // 360x560 a 400x640 para que se vea mas comodo en pantallas modernas.
  var PANEL_WIDTH  = scriptTag ? (scriptTag.getAttribute("data-width")  || "400") : "400";
  var PANEL_HEIGHT = scriptTag ? (scriptTag.getAttribute("data-height") || "640") : "640";

  // Decodificar el JWT (sin verificar firma, solo para leer el claim tenant_id).
  // El widget no verifica firmas — eso lo hace el backend cuando recibe el token
  // en cada request. Aca solo necesitamos el tenant_id para cargar el branding.
  function _decodeTenantFromToken(token) {
    try {
      var payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload && payload.tenant_id ? payload.tenant_id : null;
    } catch (_e) { return null; }
  }
  var TENANT_ID = WIDGET_TOKEN ? _decodeTenantFromToken(WIDGET_TOKEN) : null;

  // Lucide-style Bot icon (inline SVG, currentColor stroke)
  var BOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
  // Version pequeña para el header (igual icono, menor tamaño)
  var BOT_SVG_SMALL = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

  // Helper para shade hex (oscurecer/aclarar). Usado para generar variantes
  // del color primario (--ia-w-primary-dark, --ia-w-primary-light) que el
  // gradient del header consume.
  function _shadeColor(hex, percent) {
    hex = hex.replace("#", "");
    if (hex.length !== 6) return hex;
    var num = parseInt(hex, 16);
    var r = Math.max(0, Math.min(255, (num >> 16) + Math.round(2.55 * percent)));
    var g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + Math.round(2.55 * percent)));
    var b = Math.max(0, Math.min(255, (num & 0xff) + Math.round(2.55 * percent)));
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  function _applyPrimaryColor(hex) {
    document.documentElement.style.setProperty("--ia-w-primary", hex);
    document.documentElement.style.setProperty("--ia-w-primary-dark", _shadeColor(hex, -20));
    document.documentElement.style.setProperty("--ia-w-primary-light", _shadeColor(hex, 18));
  }

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
    "#ia-widget-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:var(--ia-w-primary, #99323D);color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:9998;display:flex;align-items:center;justify-content:center;transition:transform .2s;}",
    "#ia-widget-btn:hover{transform:scale(1.05);}",
    "#ia-widget-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;display:none;align-items:center;justify-content:center;font-weight:700;}",
    // Importar Inter (la misma fuente que usa /chat) directo de Google Fonts.
    // 'swap' permite render inmediato con system-ui hasta que Inter cargue.
    "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');",
    "#ia-widget-panel{position:fixed;bottom:92px;right:24px;width:" + PANEL_WIDTH + "px;max-width:calc(100vw - 32px);height:" + PANEL_HEIGHT + "px;max-height:calc(100vh - 120px);border-radius:12px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.15);z-index:9999;display:none;flex-direction:column;font-family:'Inter',system-ui,-apple-system,sans-serif;overflow:hidden;}",
    "#ia-widget-panel.open{display:flex;animation:ia-slideup .25s cubic-bezier(.16,1,.3,1);}",
    "@keyframes ia-slideup{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}",
    // Mobile fullscreen: en pantallas <640px (telefonos en portrait), el widget
    // ocupa toda la pantalla. Sin esto quedaba un panel chico en la esquina
    // que era incomodo de usar con el teclado virtual abierto.
    "@media (max-width:640px){#ia-widget-panel{bottom:0;right:0;left:0;top:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;border-radius:0;}#ia-widget-btn{bottom:16px;right:16px;}#ia-widget-panel.open ~ #ia-widget-btn{display:none;}#ia-widget-header{border-radius:0;}}",
    // Header con gradient (igual look que el chat publico)
    "#ia-widget-header{padding:14px 16px;background:linear-gradient(135deg, var(--ia-w-primary-dark, #6e2330) 0%, var(--ia-w-primary, #99323D) 50%, var(--ia-w-primary-light, #b84656) 100%);color:#fff;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:10px;box-shadow:0 2px 8px rgba(0,0,0,.15);}",
    "#ia-widget-header.handoff{background:linear-gradient(135deg, #b45309 0%, #d97706 50%, #f59e0b 100%);}",
    "#ia-widget-header.attending{background:linear-gradient(135deg, #047857 0%, #059669 50%, #10b981 100%);}",
    "#ia-widget-bot-avatar{width:36px;height:36px;border-radius:12px;background:rgba(255,255,255,.2);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;}",
    "#ia-widget-bot-avatar img{width:100%;height:100%;object-fit:cover;}",
    "#ia-widget-titlewrap{flex:1;min-width:0;}",
    "#ia-widget-title{font-weight:600;font-size:15px;line-height:1.2;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    "#ia-widget-substatus{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12px;color:rgba(255,255,255,.85);}",
    ".ia-status-dot{width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 0 rgba(74,222,128,.6);animation:ia-pulse 2s infinite;}",
    ".ia-status-dot.amber{background:#fbbf24;}",
    ".ia-status-dot.gray{background:#94a3b8;animation:none;}",
    "@keyframes ia-pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.6);}70%{box-shadow:0 0 0 6px rgba(74,222,128,0);}100%{box-shadow:0 0 0 0 rgba(74,222,128,0);}}",
    "#ia-widget-close{background:none;border:none;color:#fff;cursor:pointer;font-size:22px;line-height:1;padding:4px 6px;border-radius:6px;opacity:.8;}",
    "#ia-widget-close:hover{opacity:1;background:rgba(255,255,255,.15);}",
    // Sector picker
    "#ia-sector-picker{flex:1;display:flex;flex-direction:column;overflow:hidden;}",
    "#ia-sector-intro{padding:16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;}",
    "#ia-sector-intro p{margin:0;font-size:13px;color:#475569;}",
    "#ia-sector-intro strong{color:#1e293b;}",
    "#ia-sector-list{flex:1;overflow-y:auto;padding:8px;}",
    ".ia-sector-btn{width:100%;text-align:left;padding:12px 16px;border-radius:14px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;margin-bottom:8px;transition:all .2s;display:flex;align-items:center;justify-content:space-between;box-shadow:0 1px 2px rgba(0,0,0,.04);}",
    ".ia-sector-btn:hover{border-color:var(--ia-w-primary, #99323D);background:#fafbfc;box-shadow:0 4px 12px rgba(0,0,0,.08);transform:translateY(-1px);}",
    ".ia-sector-btn:active{transform:translateY(0);}",
    ".ia-sector-btn .ia-sector-name{font-size:14px;font-weight:600;color:#1e293b;}",
    ".ia-sector-btn .ia-sector-desc{font-size:12px;color:#64748b;margin-top:3px;line-height:1.4;}",
    ".ia-sector-btn .ia-sector-default{font-size:11px;color:#94a3b8;margin-left:6px;font-weight:500;}",
    ".ia-sector-btn .ia-sector-arrow{color:#cbd5e1;font-size:18px;transition:transform .15s;}",
    ".ia-sector-btn:hover .ia-sector-arrow{color:var(--ia-w-primary, #99323D);transform:translateX(2px);}",
    "#ia-sector-input-wrap{padding:12px 10px 10px;border-top:1px solid #e2e8f0;}",
    "#ia-sector-direct{width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:12px;font-size:14px;outline:none;font-family:inherit;box-sizing:border-box;transition:all .15s;}",
    "#ia-sector-direct:focus{border-color:var(--ia-w-primary, #99323D);box-shadow:0 0 0 3px rgba(153,50,61,.12);}",
    "#ia-sector-hint{text-align:center;font-size:12px;color:#94a3b8;padding:6px 8px 10px;}",
    // Chat — burbujas con mismo look-and-feel que /chat (rounded-2xl + shadow + padding generoso)
    "#ia-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px;min-height:200px;background:#fafbfc;}",
    ".ia-msg{max-width:85%;padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.5;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.06);}",
    ".ia-msg.user{align-self:flex-end;background:var(--ia-w-primary, #99323D);color:#fff;border-bottom-right-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.12);}",
    ".ia-msg.bot,.ia-msg.operator{align-self:flex-start;background:#fff;color:#1e293b;border:1px solid #e2e8f0;border-bottom-left-radius:4px;}",
    ".ia-msg.operator{background:#ecfdf5;border-color:#a7f3d0;border-left:3px solid #10b981;}",
    ".ia-msg.system{align-self:center;background:#fef9c3;color:#854d0e;font-size:12px;border-radius:9999px;padding:5px 14px;max-width:90%;text-align:center;border:1px solid #fde047;box-shadow:none;}",
    ".ia-msg.error{background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;}",
    // Typing indicator con 3 dots animados (mismo estilo que /chat)
    ".ia-typing{align-self:flex-start;display:flex;gap:4px;padding:10px 14px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;border-bottom-left-radius:4px;}",
    ".ia-typing span{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:ia-typing-bounce 1.4s infinite ease-in-out;}",
    ".ia-typing span:nth-child(2){animation-delay:.16s;}",
    ".ia-typing span:nth-child(3){animation-delay:.32s;}",
    "@keyframes ia-typing-bounce{0%,80%,100%{transform:translateY(0);opacity:.4;}40%{transform:translateY(-4px);opacity:1;}}",
    "#ia-widget-handoff-bar{padding:12px 14px;background:#fffbeb;border-top:1px solid #fde68a;display:none;gap:10px;align-items:center;font-size:13px;color:#854d0e;}",
    "#ia-widget-handoff-bar button{background:#f59e0b;color:#fff;border:none;border-radius:10px;padding:8px 16px;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap;transition:transform .15s,box-shadow .15s;box-shadow:0 2px 6px rgba(245,158,11,.3);}",
    "#ia-widget-handoff-bar button:hover{transform:scale(1.03);box-shadow:0 4px 10px rgba(245,158,11,.4);}",
    "#ia-widget-identify-form{padding:14px;background:#fffbeb;border-top:1px solid #fde68a;display:none;flex-direction:column;gap:10px;font-size:13px;color:#854d0e;}",
    "#ia-widget-identify-form .ia-identify-title{font-weight:600;font-size:13px;color:#78350f;}",
    "#ia-widget-identify-form .ia-identify-hint{font-size:12px;color:#a16207;line-height:1.5;}",
    "#ia-widget-identify-form input{padding:10px 12px;border:1px solid #fde68a;border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;background:#fff;transition:all .15s;}",
    "#ia-widget-identify-form input:focus{outline:none;border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.18);}",
    "#ia-widget-identify-form .ia-identify-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;}",
    "#ia-widget-identify-form .ia-identify-submit{background:#f59e0b;color:#fff;border:none;border-radius:10px;padding:10px 18px;cursor:pointer;font-size:13px;font-weight:600;transition:transform .15s,box-shadow .15s;box-shadow:0 2px 6px rgba(245,158,11,.3);}",
    "#ia-widget-identify-form .ia-identify-submit:hover:not(:disabled){transform:scale(1.03);box-shadow:0 4px 10px rgba(245,158,11,.4);}",
    "#ia-widget-identify-form .ia-identify-submit:disabled{opacity:0.5;cursor:not-allowed;}",
    "#ia-widget-identify-form .ia-identify-skip{background:none;border:none;cursor:pointer;color:#92400e;font-size:12px;text-decoration:underline;padding:4px 8px;}",
    "#ia-widget-identify-form .ia-identify-error{font-size:12px;color:#b91c1c;margin-top:-2px;}",
    "#ia-sector-change{padding:4px 8px;border:1px solid rgba(255,255,255,.4);border-radius:6px;background:none;color:rgba(255,255,255,.8);cursor:pointer;font-size:11px;white-space:nowrap;}",
    "#ia-sector-change:hover{background:rgba(255,255,255,.15);}",
    "#ia-widget-form{padding:12px 14px;border-top:1px solid #e2e8f0;display:flex;gap:10px;align-items:flex-end;background:#fff;}",
    "#ia-widget-input{flex:1;border:1px solid #cbd5e1;border-radius:14px;padding:10px 14px;font-size:14px;outline:none;resize:none;min-height:40px;max-height:96px;font-family:inherit;line-height:1.4;background:#f8fafc;transition:all .15s;}",
    "#ia-widget-input:focus{border-color:var(--ia-w-primary, #99323D);background:#fff;box-shadow:0 0 0 3px rgba(153,50,61,.12);}",
    "#ia-widget-send{background:var(--ia-w-primary, #99323D);color:#fff;border:none;border-radius:12px;padding:0;cursor:pointer;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.12);transition:transform .15s,box-shadow .15s;}",
    "#ia-widget-send:hover:not(:disabled){transform:scale(1.05);box-shadow:0 4px 12px rgba(0,0,0,.18);}",
    "#ia-widget-send:active:not(:disabled){transform:scale(.95);}",
    "#ia-widget-send:disabled{opacity:.4;cursor:not-allowed;}",
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
    '  <div id="ia-widget-bot-avatar">' + BOT_SVG_SMALL + '</div>',
    '  <div id="ia-widget-titlewrap">',
    '    <span id="ia-widget-title">' + _escape(TITLE) + '</span>',
    '    <div id="ia-widget-substatus"><span class="ia-status-dot" id="ia-widget-status-dot"></span><span id="ia-widget-substatus-text">En línea</span></div>',
    '  </div>',
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
    '  <button id="ia-widget-send" type="submit" aria-label="Enviar mensaje">',
    '    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>',
    '  </button>',
    '</form>',
  ].join("");

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  // ── Cargar branding del tenant (color, logo, bot_name) ──────────────────────
  // Async: no bloquea el render del widget. Cuando llega, hace override de
  // CSS variables y del titulo. Si falla, el widget queda con los defaults.
  function _loadBranding() {
    if (!TENANT_ID) return;
    fetch(API_BASE + "/api/v1/public/tenant-branding?tenant_id=" + encodeURIComponent(TENANT_ID))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(b) {
        if (!b) return;
        if (b.primary_color) {
          _applyPrimaryColor(b.primary_color);
        }
        if (b.bot_name) {
          var titleEl = document.getElementById("ia-widget-title");
          if (titleEl) titleEl.textContent = b.bot_name;
          TITLE = b.bot_name;
        }
        if (b.greeting_message) GREETING = b.greeting_message;
        if (b.logo_url) {
          LOGO_URL = b.logo_url.indexOf("http") === 0 ? b.logo_url : (API_BASE + b.logo_url);
          // Logo en el boton flotante
          var btnEl = document.getElementById("ia-widget-btn");
          if (btnEl) {
            btnEl.innerHTML = '<img src="' + LOGO_URL + '" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" />';
          }
          // Logo tambien en el avatar del header (reemplaza el icono SVG)
          var avatarEl = document.getElementById("ia-widget-bot-avatar");
          if (avatarEl) {
            avatarEl.innerHTML = '<img src="' + LOGO_URL + '" alt="" />';
          }
        }
      })
      .catch(function(err) {
        console.warn("[IA Widget] no se pudo cargar branding:", err);
      });
  }
  _loadBranding();

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
      .then(function(r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function(data) {
        // El endpoint devuelve {sectors: [...], greeting_message: "..."}.
        // Backward compat: si todavía devuelve un array plano lo aceptamos.
        if (Array.isArray(data)) {
          sectors = data;
        } else {
          sectors = (data && Array.isArray(data.sectors)) ? data.sectors : [];
          if (data && data.greeting_message) GREETING = data.greeting_message;
        }
        _renderSectorList();
        var def = sectors.find(function(s) { return s.is_default; }) || sectors[0];
        if (def) sectorHint.textContent = "Si no elegís, te asignamos a «" + def.nombre + "»";
      })
      .catch(function(err) {
        console.error("[IA Widget] error al cargar sectores:", err);
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
          // Saludo: usar el greeting_message del tenant si existe; sino fallback
          // generico con el bot_name + sector elegido.
          var greeting = GREETING || ("¡Hola! Soy " + _escape(TITLE) + ", asistente de " + _escape(selectedSector ? selectedSector.nombre : TITLE) + ". ¿En qué te puedo ayudar?");
          _appendMessage("system", greeting);
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
    typing.setAttribute("aria-label", "Escribiendo");
    typing.innerHTML = "<span></span><span></span><span></span>";
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
      "bot_active":        "En línea",
      "handoff_requested": "Esperando operador…",
      "human_attending":   "Operador conectado",
      "closed":            "Conversación cerrada",
    };
    statusEl.textContent = labels[convStatus] || convStatus;

    // Header: clases CSS por status (el gradient esta en CSS, no inline).
    var header = document.getElementById("ia-widget-header");
    header.classList.remove("handoff", "attending");
    if (convStatus === "handoff_requested") header.classList.add("handoff");
    else if (convStatus === "human_attending") header.classList.add("attending");

    // Substatus text + status dot (mismo estilo que chat publico)
    var subEl = document.getElementById("ia-widget-substatus-text");
    var dotEl = document.getElementById("ia-widget-status-dot");
    if (subEl) subEl.textContent = labels[convStatus] || convStatus;
    if (dotEl) {
      dotEl.className = "ia-status-dot";
      if (convStatus === "handoff_requested") dotEl.classList.add("amber");
      else if (convStatus === "closed") dotEl.classList.add("gray");
    }

    var closed = convStatus === "closed";
    inputEl.disabled = closed;
    sendBtn.disabled = closed;
  }

  function _escape(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
