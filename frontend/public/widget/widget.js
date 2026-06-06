(function () {
  "use strict";

  // ════════════════════════════════════════════════════════════════════════════
  // IA Widget — embebible. Replica 1:1 el diseño del chat público (/chat):
  // header con gradiente que cambia segun estado, hero con avatar + greeting,
  // sector pills, burbujas con avatar, typing indicator, handoff inline con
  // formulario de identificacion, e input bar con boton gradiente.
  // El branding (color/logo/nombre/greeting) se toma del tenant del token.
  // ════════════════════════════════════════════════════════════════════════════

  var scriptTag = document.currentScript || (function () {
    var scripts = document.querySelectorAll("script[data-token]");
    return scripts[scripts.length - 1];
  })();

  var WIDGET_TOKEN = scriptTag ? scriptTag.getAttribute("data-token") : null;
  // API_BASE: si no se especifica data-api-url, lo inferimos del origin del
  // propio src del script. Sin esto, fetch("/api/v1/...") va a una URL relativa
  // al sitio donde se embebio el widget.
  var API_BASE = "";
  if (scriptTag) {
    API_BASE = scriptTag.getAttribute("data-api-url") || "";
    if (!API_BASE && scriptTag.src) {
      try { API_BASE = new URL(scriptTag.src).origin; } catch (_e) { API_BASE = ""; }
    }
  }
  var PLACEHOLDER   = scriptTag ? (scriptTag.getAttribute("data-placeholder") || "Escribí tu mensaje…") : "Escribí tu mensaje…";
  // TITLE y branding son defaults; se sobreescriben con el branding del tenant.
  var TITLE         = scriptTag ? (scriptTag.getAttribute("data-title") || "Asistente") : "Asistente";
  var DEFAULT_PRIMARY = "#99323D";
  var LOGO_URL      = null;
  var GREETING      = null;  // saludo del tenant si esta configurado
  var PANEL_WIDTH   = scriptTag ? (scriptTag.getAttribute("data-width")  || "400") : "400";
  var PANEL_HEIGHT  = scriptTag ? (scriptTag.getAttribute("data-height") || "640") : "640";

  if (!WIDGET_TOKEN) { console.error("[IA Widget] data-token is required"); return; }

  // ── Color helpers (mismos que use-tenant-branding.ts: shade ±15) ─────────────
  function _shade(hex, pct) {
    var h = hex.replace("#", "");
    if (h.length !== 6) return hex;
    var num = parseInt(h, 16);
    var r = Math.max(0, Math.min(255, (num >> 16) + Math.round(2.55 * pct)));
    var g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + Math.round(2.55 * pct)));
    var b = Math.max(0, Math.min(255, (num & 0xff) + Math.round(2.55 * pct)));
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  function _relLuminance(hex) {
    var h = hex.replace("#", ""); if (h.length !== 6) return 1;
    var ch = function (c) { var s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(parseInt(h.slice(0, 2), 16)) + 0.7152 * ch(parseInt(h.slice(2, 4), 16)) + 0.0722 * ch(parseInt(h.slice(4, 6), 16));
  }
  function _contrast(a, b) { var L1 = _relLuminance(a), L2 = _relLuminance(b); var hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); }
  function _readableText(primary) { return _contrast(primary, "#ffffff") >= _contrast(primary, "#0f172a") ? "#ffffff" : "#0f172a"; }

  function _rgba(hex, alpha) {
    var h = hex.replace("#", ""); if (h.length !== 6) return hex;
    var num = parseInt(h, 16);
    return "rgba(" + (num >> 16) + "," + ((num >> 8) & 0xff) + "," + (num & 0xff) + "," + alpha + ")";
  }
  function _applyBrand(hex) {
    var root = document.documentElement;
    root.style.setProperty("--ia-brand", hex);
    root.style.setProperty("--ia-brand-dark", _shade(hex, -15));
    root.style.setProperty("--ia-brand-light", _shade(hex, 15));
    root.style.setProperty("--ia-brand-fg", _readableText(hex));
    // Variantes con alpha (sin color-mix, para compat con navegadores viejos)
    root.style.setProperty("--ia-brand-30", _rgba(hex, 0.3));
    root.style.setProperty("--ia-brand-25", _rgba(hex, 0.25));
  }
  _applyBrand(DEFAULT_PRIMARY);

  // Decodificar tenant_id del JWT (solo lectura del claim, el backend verifica firma).
  function _decodeTenantFromToken(token) {
    try {
      var payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload && payload.tenant_id ? payload.tenant_id : null;
    } catch (_e) { return null; }
  }
  var TENANT_ID = _decodeTenantFromToken(WIDGET_TOKEN);

  // ── SVG icons (lucide, igual que el chat) ────────────────────────────────────
  var ICON_BOT       = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
  var ICON_SEND      = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>';
  var ICON_BACK      = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
  var ICON_USERCHECK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>';
  var ICON_SPINNER   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ia-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  var ICON_CLIP      = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 1 1-2.83-2.83l8.49-8.48"/></svg>';

  // ── Session + remembered sector ──────────────────────────────────────────────
  var SESSION_KEY = "ia_widget_session_" + WIDGET_TOKEN.slice(-8);
  var widgetSessionId = localStorage.getItem(SESSION_KEY);
  if (!widgetSessionId) {
    widgetSessionId = "ws_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem(SESSION_KEY, widgetSessionId);
  }
  var SECTOR_KEY = "ia_widget_sector_" + WIDGET_TOKEN.slice(-8);
  var rememberedSector = null;
  try { rememberedSector = JSON.parse(localStorage.getItem(SECTOR_KEY) || "null"); } catch (e) {}

  // ── State ─────────────────────────────────────────────────────────────────────
  var conversationId = null;
  var lastMessageId  = null;
  var pollAlive      = false;
  var pollTimeout    = null;
  var convStatus     = "bot_active";
  var operatorName   = null;
  var operatorsOnline = null;  // { count, names }
  var sectors        = [];
  var selectedSector = null;
  var handoffBubble  = null;   // referencia al bubble de oferta de handoff activo
  var handoffConfirmed = false;
  var afiliadoIdentified = false;  // true si la conv ya tiene nombre + DNI

  // ── Styles ─────────────────────────────────────────────────────────────────────
  var SLATE_50 = "#f8fafc", SLATE_100 = "#f1f5f9", SLATE_200 = "#e2e8f0",
      SLATE_300 = "#cbd5e1", SLATE_400 = "#94a3b8", SLATE_600 = "#475569", SLATE_800 = "#1e293b";

  var style = document.createElement("style");
  style.textContent = [
    "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');",

    // FAB
    "#ia-w-btn{position:fixed;bottom:24px;right:24px;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--ia-brand-light),var(--ia-brand-dark));color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s;}",
    "#ia-w-btn svg{width:28px;height:28px;}",
    "#ia-w-btn:hover{transform:scale(1.08);box-shadow:0 8px 28px rgba(0,0,0,.3);}",
    "#ia-w-btn img{width:34px;height:34px;border-radius:50%;object-fit:cover;}",
    "#ia-w-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:50%;width:20px;height:20px;font-size:11px;display:none;align-items:center;justify-content:center;font-weight:700;border:2px solid #fff;}",

    // Panel
    "#ia-w-panel{position:fixed;bottom:100px;right:24px;width:" + PANEL_WIDTH + "px;max-width:calc(100vw - 32px);height:" + PANEL_HEIGHT + "px;max-height:calc(100vh - 130px);border-radius:16px;background:" + SLATE_50 + ";color:" + SLATE_800 + ";color-scheme:light;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:2147483000;display:none;flex-direction:column;font-family:'Inter',system-ui,-apple-system,sans-serif;overflow:hidden;}",
    "#ia-w-panel *,#ia-w-panel *::before,#ia-w-panel *::after{box-sizing:border-box;color-scheme:light;}",
    "#ia-w-panel.open{display:flex;animation:ia-slideup .25s cubic-bezier(.16,1,.3,1);}",
    "@keyframes ia-slideup{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}",
    "#ia-w-panel input,#ia-w-panel textarea{color:" + SLATE_800 + ";caret-color:var(--ia-brand);-webkit-text-fill-color:" + SLATE_800 + ";}",
    // Scrollbar sutil
    "#ia-w-panel ::-webkit-scrollbar{width:8px;height:8px;}",
    "#ia-w-panel ::-webkit-scrollbar-track{background:transparent;}",
    "#ia-w-panel ::-webkit-scrollbar-thumb{background:" + SLATE_300 + ";border-radius:8px;border:2px solid transparent;background-clip:content-box;}",
    "#ia-w-panel{scrollbar-width:thin;scrollbar-color:" + SLATE_300 + " transparent;}",
    // Responsive
    "@media (max-width:640px){#ia-w-panel{bottom:0;right:0;left:0;top:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;border-radius:0;}#ia-w-btn{bottom:16px;right:16px;width:56px;height:56px;}#ia-w-panel.open ~ #ia-w-btn{display:none;}}",
    "@media (min-width:1441px){#ia-w-panel{width:440px;height:700px;bottom:110px;right:32px;}#ia-w-btn{width:72px;height:72px;bottom:32px;right:32px;}}",

    // Header — gradiente que cambia por estado (igual que /chat)
    "#ia-w-header{flex-shrink:0;padding:0 16px;height:64px;display:flex;align-items:center;gap:12px;background:linear-gradient(to right,var(--ia-brand-dark),var(--ia-brand),var(--ia-brand-light));box-shadow:0 4px 12px rgba(0,0,0,.18);transition:background .5s;z-index:10;}",
    "#ia-w-header.handoff{background:linear-gradient(to right,#d97706,#f59e0b,#f97316);}",
    "#ia-w-header.attending{background:linear-gradient(to right,#047857,#059669,#0d9488);}",
    "#ia-w-back{display:none;background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;padding:4px;margin-left:-4px;border-radius:8px;align-items:center;justify-content:center;transition:color .2s,background .2s;}",
    "#ia-w-back svg{width:20px;height:20px;}",
    "#ia-w-back:hover{color:#fff;background:rgba(255,255,255,.1);}",
    "#ia-w-avatar{width:36px;height:36px;border-radius:12px;background:rgba(255,255,255,.2);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.1);}",
    "#ia-w-avatar svg{width:20px;height:20px;color:#fff;}",
    "#ia-w-avatar img{width:100%;height:100%;object-fit:cover;}",
    "#ia-w-titlewrap{flex:1;min-width:0;}",
    "#ia-w-title{color:#fff;font-weight:600;font-size:14px;line-height:1.1;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    "#ia-w-substatus{display:flex;align-items:center;gap:6px;margin-top:5px;}",
    "#ia-w-dot{width:6px;height:6px;border-radius:50%;background:#4ade80;flex-shrink:0;}",
    "#ia-w-dot.pulse{animation:ia-pulse 2s infinite;}",
    "#ia-w-dot.amber{background:#fbbf24;}",
    "#ia-w-dot.gray{background:#94a3b8;}",
    "@keyframes ia-pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.6);}70%{box-shadow:0 0 0 5px rgba(74,222,128,0);}100%{box-shadow:0 0 0 0 rgba(74,222,128,0);}}",
    "#ia-w-substatus-text{font-size:12px;color:rgba(255,255,255,.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    "#ia-w-close{background:none;border:none;color:rgba(255,255,255,.8);cursor:pointer;font-size:22px;line-height:1;padding:4px 6px;border-radius:6px;flex-shrink:0;}",
    "#ia-w-close:hover{color:#fff;background:rgba(255,255,255,.15);}",

    // Body scrollable
    "#ia-w-body{flex:1;overflow-y:auto;background:" + SLATE_50 + ";}",
    "#ia-w-body-inner{min-height:100%;display:flex;flex-direction:column;padding:20px 16px;gap:14px;}",

    // Hero de seleccion (igual que /chat phase selecting)
    "#ia-w-hero{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:28px;padding:8px 0;}",
    "#ia-w-hero-top{text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px;}",
    "#ia-w-hero-avatar{width:76px;height:76px;border-radius:24px;background:linear-gradient(135deg,var(--ia-brand-light),var(--ia-brand-dark));display:flex;align-items:center;justify-content:center;box-shadow:0 12px 28px rgba(0,0,0,.18);overflow:hidden;}",
    "#ia-w-hero-avatar svg{width:38px;height:38px;color:#fff;}",
    "#ia-w-hero-avatar img{width:100%;height:100%;object-fit:cover;}",
    "#ia-w-hero-greeting{color:" + SLATE_600 + ";font-size:14px;line-height:1.5;white-space:pre-line;max-width:300px;margin:0;}",
    "#ia-w-pills{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:340px;}",
    ".ia-w-pill{background:#fff;border:2px solid var(--ia-brand-30);color:var(--ia-brand);font-weight:500;font-size:13px;border-radius:9999px;padding:9px 18px;cursor:pointer;transition:all .2s;box-shadow:0 1px 2px rgba(0,0,0,.05);font-family:inherit;}",
    ".ia-w-pill:hover{background:linear-gradient(135deg,var(--ia-brand),var(--ia-brand-dark));border-color:transparent;color:#fff;box-shadow:0 6px 16px rgba(0,0,0,.18);transform:translateY(-1px);}",
    ".ia-w-pill:active{transform:translateY(0);}",
    ".ia-w-skel{height:38px;width:96px;border-radius:9999px;background:" + SLATE_200 + ";animation:ia-pulse-bg 1.4s infinite;}",
    "@keyframes ia-pulse-bg{0%,100%{opacity:1;}50%{opacity:.5;}}",
    "#ia-w-divider{display:flex;align-items:center;gap:12px;width:100%;max-width:280px;}",
    "#ia-w-divider .ln{flex:1;height:1px;background:" + SLATE_200 + ";}",
    "#ia-w-divider .tx{font-size:11px;color:" + SLATE_400 + ";white-space:nowrap;}",

    // Burbujas (igual que /chat)
    ".ia-w-row{display:flex;gap:10px;align-items:flex-end;}",
    ".ia-w-row.user{justify-content:flex-end;}",
    ".ia-w-row.center{justify-content:center;padding:2px 0;}",
    ".ia-w-bavatar{width:30px;height:30px;border-radius:11px;flex-shrink:0;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.15);}",
    ".ia-w-bavatar.bot{background:linear-gradient(135deg,var(--ia-brand-light),var(--ia-brand-dark));}",
    ".ia-w-bavatar.op{background:linear-gradient(135deg,#34d399,#0d9488);}",
    ".ia-w-bavatar svg{width:15px;height:15px;color:#fff;}",
    ".ia-w-bavatar img{width:100%;height:100%;border-radius:11px;object-fit:cover;}",
    ".ia-w-bubble{max-width:80%;padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.5;word-break:break-word;}",
    ".ia-w-bubble.bot{background:#fff;color:" + SLATE_800 + ";border:1px solid " + SLATE_100 + ";border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06);}",
    ".ia-w-bubble.op{background:#ecfdf5;color:" + SLATE_800 + ";border:1px solid #a7f3d0;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06);}",
    ".ia-w-bubble.user{background:linear-gradient(135deg,var(--ia-brand),var(--ia-brand-dark));color:#fff;border-bottom-right-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.15);}",
    ".ia-w-bubble.user a{color:#fff;}",
    ".ia-w-opname{font-size:11px;color:#059669;margin-top:4px;margin-left:2px;font-weight:500;}",
    ".ia-w-sys{align-self:center;background:" + SLATE_100 + ";color:" + SLATE_400 + ";font-size:12px;border-radius:9999px;padding:5px 16px;max-width:90%;text-align:center;}",
    ".ia-w-bubble a,.ia-w-sys a{color:inherit;text-decoration:underline;text-underline-offset:2px;word-break:break-all;}",

    // Typing
    ".ia-w-typing{display:flex;gap:5px;align-items:center;padding:12px 16px;background:#fff;border:1px solid " + SLATE_100 + ";border-radius:16px;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06);}",
    ".ia-w-typing span{width:7px;height:7px;border-radius:50%;background:var(--ia-brand-light);animation:ia-bounce 1.4s infinite ease-in-out;}",
    ".ia-w-typing span:nth-child(2){animation-delay:.16s;}",
    ".ia-w-typing span:nth-child(3){animation-delay:.32s;}",
    "@keyframes ia-bounce{0%,80%,100%{transform:translateY(0);opacity:.4;}40%{transform:translateY(-5px);opacity:1;}}",

    // Handoff inline (igual que /chat HandoffOfferBubble)
    ".ia-w-handoff{align-self:center;max-width:90%;background:#fffbeb;border:1px solid #fde68a;border-radius:16px;padding:14px 16px;text-align:center;display:flex;flex-direction:column;gap:12px;}",
    ".ia-w-handoff .ia-w-hf-text{font-size:13px;color:#92400e;line-height:1.5;margin:0;}",
    ".ia-w-hf-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:#f59e0b;color:#fff;border:none;border-radius:12px;padding:9px 16px;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;font-family:inherit;align-self:center;}",
    ".ia-w-hf-btn svg{width:16px;height:16px;}",
    ".ia-w-hf-btn:hover{background:#d97706;}",
    ".ia-w-hf-btn:active{transform:scale(.95);}",
    ".ia-w-hf-loader{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#d97706;font-weight:500;justify-content:center;}",
    ".ia-w-hf-loader svg{width:13px;height:13px;}",
    ".ia-w-hf-form{text-align:left;display:flex;flex-direction:column;gap:8px;}",
    ".ia-w-hf-form .t{font-size:12px;font-weight:600;color:#78350f;}",
    ".ia-w-hf-form .h{font-size:11px;color:#a16207;line-height:1.5;}",
    ".ia-w-hf-form input{padding:9px 12px;border:1px solid #fde68a;border-radius:10px;font-size:14px;width:100%;background:#fff;font-family:inherit;}",
    ".ia-w-hf-form input:focus{outline:none;border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.18);}",
    ".ia-w-hf-form .err{font-size:11px;color:#dc2626;}",
    ".ia-w-hf-form .actions{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:2px;}",
    ".ia-w-hf-skip{background:none;border:none;cursor:pointer;color:#92400e;font-size:12px;text-decoration:underline;font-family:inherit;}",

    // Input bar (igual que /chat)
    "#ia-w-inputbar{flex-shrink:0;border-top:1px solid " + SLATE_200 + ";background:rgba(255,255,255,.85);backdrop-filter:blur(8px);padding:12px 14px;}",
    "#ia-w-inputrow{display:flex;gap:10px;align-items:center;}",
    "#ia-w-input{flex:1;background:" + SLATE_100 + ";border:1px solid transparent;border-radius:16px;padding:11px 16px;font-size:14px;outline:none;resize:none;min-height:42px;max-height:96px;font-family:inherit;line-height:1.4;transition:all .15s;}",
    "#ia-w-input::placeholder{color:" + SLATE_400 + ";}",
    "#ia-w-input:hover{background:#fefefe;}",
    "#ia-w-input:focus{background:#fff;border-color:var(--ia-brand);box-shadow:0 0 0 3px var(--ia-brand-25);}",
    "#ia-w-clip{flex-shrink:0;width:38px;height:38px;border:none;background:none;color:" + SLATE_400 + ";cursor:pointer;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:all .15s;}",
    "#ia-w-clip:hover{background:" + SLATE_100 + ";color:var(--ia-brand);}",
    "#ia-w-clip svg{width:20px;height:20px;}",
    "#ia-w-clip:disabled{opacity:.45;cursor:default;}",
    ".ia-w-attach-img{max-width:210px;max-height:210px;border-radius:10px;margin-top:4px;cursor:pointer;display:block;border:1px solid " + SLATE_200 + ";}",
    ".ia-w-attach-file{display:inline-flex;align-items:center;gap:6px;margin-top:4px;padding:8px 12px;background:rgba(0,0,0,.05);border-radius:10px;text-decoration:none;color:inherit;font-size:13px;word-break:break-all;}",
    ".ia-w-attach-file svg{width:16px;height:16px;flex-shrink:0;}",
    ".ia-w-attach-file:hover{background:rgba(0,0,0,.09);}",
    "#ia-w-send{width:46px;height:46px;flex-shrink:0;border-radius:14px;background:linear-gradient(135deg,var(--ia-brand),var(--ia-brand-dark));color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.15);transition:transform .15s,box-shadow .15s,opacity .15s;}",
    "#ia-w-send svg{width:18px;height:18px;}",
    "#ia-w-send:hover:not(:disabled){transform:scale(1.05);box-shadow:0 4px 12px rgba(0,0,0,.22);}",
    "#ia-w-send:active:not(:disabled){transform:scale(.95);}",
    "#ia-w-send:disabled{opacity:.4;cursor:not-allowed;}",
    ".ia-spin{animation:ia-rotate 1s linear infinite;}",
    "@keyframes ia-rotate{to{transform:rotate(360deg);}}",
  ].join("");
  document.head.appendChild(style);

  // ── DOM ─────────────────────────────────────────────────────────────────────
  var btn = document.createElement("button");
  btn.id = "ia-w-btn";
  btn.setAttribute("aria-label", "Abrir asistente");
  btn.innerHTML = ICON_BOT + "<span id='ia-w-badge'></span>";

  var panel = document.createElement("div");
  panel.id = "ia-w-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TITLE);
  panel.innerHTML = [
    '<div id="ia-w-header">',
    '  <button id="ia-w-back" aria-label="Cambiar área">' + ICON_BACK + '</button>',
    '  <div id="ia-w-avatar">' + ICON_BOT + '</div>',
    '  <div id="ia-w-titlewrap">',
    '    <span id="ia-w-title">' + _escape(TITLE) + '</span>',
    '    <div id="ia-w-substatus"><span id="ia-w-dot" class="pulse"></span><span id="ia-w-substatus-text">En línea</span></div>',
    '  </div>',
    '  <button id="ia-w-close" aria-label="Cerrar">&times;</button>',
    '</div>',
    '<div id="ia-w-body"><div id="ia-w-body-inner"></div></div>',
    '<div id="ia-w-inputbar">',
    '  <div id="ia-w-inputrow">',
    '    <button id="ia-w-clip" type="button" aria-label="Adjuntar archivo">' + ICON_CLIP + '</button>',
    '    <textarea id="ia-w-input" rows="1" placeholder="' + _escape(PLACEHOLDER) + '" autocomplete="off"></textarea>',
    '    <button id="ia-w-send" type="button" aria-label="Enviar">' + ICON_SEND + '</button>',
    '  </div>',
    '  <input id="ia-w-file" type="file" accept="image/png,image/jpeg,image/jpg,image/webp,application/pdf" style="display:none" />',
    '</div>',
  ].join("");

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var headerEl   = document.getElementById("ia-w-header");
  var backBtn    = document.getElementById("ia-w-back");
  var avatarEl   = document.getElementById("ia-w-avatar");
  var titleEl    = document.getElementById("ia-w-title");
  var dotEl      = document.getElementById("ia-w-dot");
  var substatusEl = document.getElementById("ia-w-substatus-text");
  var bodyEl     = document.getElementById("ia-w-body");
  var bodyInner  = document.getElementById("ia-w-body-inner");
  var inputEl    = document.getElementById("ia-w-input");
  var sendBtn    = document.getElementById("ia-w-send");
  var clipBtn    = document.getElementById("ia-w-clip");
  var fileInput  = document.getElementById("ia-w-file");
  var badge      = document.getElementById("ia-w-badge");

  // ── Branding del tenant ───────────────────────────────────────────────────────
  function _loadBranding() {
    if (!TENANT_ID) return;
    fetch(API_BASE + "/api/v1/public/tenant-branding?tenant_id=" + encodeURIComponent(TENANT_ID))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) {
        if (!b) return;
        if (b.primary_color) _applyBrand(b.primary_color);
        if (b.bot_name) { TITLE = b.bot_name; titleEl.textContent = b.bot_name; panel.setAttribute("aria-label", b.bot_name); }
        if (b.greeting_message) GREETING = b.greeting_message;
        if (b.logo_url) {
          LOGO_URL = b.logo_url.indexOf("http") === 0 ? b.logo_url : (API_BASE + b.logo_url);
          btn.innerHTML = '<img src="' + LOGO_URL + '" alt="" /><span id="ia-w-badge"></span>';
          badge = document.getElementById("ia-w-badge");
          avatarEl.innerHTML = '<img src="' + LOGO_URL + '" alt="" />';
        }
      })
      .catch(function (err) { console.warn("[IA Widget] branding:", err); });
  }
  _loadBranding();

  // ── Events ──────────────────────────────────────────────────────────────────
  btn.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      badge.style.display = "none";
      if (conversationId) { /* ya en chat */ }
      else if (rememberedSector) { _enterChat(rememberedSector); }
      else { _showHero(); inputEl.focus(); }
    }
  });

  document.getElementById("ia-w-close").addEventListener("click", function () {
    panel.classList.remove("open");
  });

  backBtn.addEventListener("click", function () {
    _stopPolling();
    conversationId = null; lastMessageId = null; selectedSector = null;
    handoffBubble = null; handoffConfirmed = false;
    convStatus = "bot_active";
    localStorage.removeItem(SECTOR_KEY);
    _showHero();
    _updateHeader();
  });

  sendBtn.addEventListener("click", _onSubmit);
  clipBtn.addEventListener("click", function () { if (!fileInput.disabled) fileInput.click(); });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) _uploadAttachment(fileInput.files[0]);
    fileInput.value = "";
  });
  inputEl.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 96) + "px";
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _onSubmit(); }
  });

  function _onSubmit() {
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = ""; inputEl.style.height = "auto";
    if (!conversationId) {
      // En el hero, escribir directo manda al sector default
      var def = sectors.find(function (s) { return s.is_default; }) || sectors[0];
      if (def) _enterChat(def, text);
    } else {
      _sendMessage(text);
    }
  }

  // ── API helpers ────────────────────────────────────────────────────────────────
  function _headers() {
    return { "Content-Type": "application/json", "Authorization": "Bearer " + WIDGET_TOKEN };
  }

  // ── Hero / sectores ─────────────────────────────────────────────────────────
  function _showHero() {
    backBtn.style.display = "none";
    titleEl.textContent = TITLE;
    bodyInner.innerHTML = "";
    var hero = document.createElement("div");
    hero.id = "ia-w-hero";
    var greetingText = GREETING || "¡Hola! 👋 Soy tu asistente virtual. ¿En qué área puedo ayudarte?";
    hero.innerHTML =
      '<div id="ia-w-hero-top">' +
      '  <div id="ia-w-hero-avatar">' + (LOGO_URL ? '<img src="' + LOGO_URL + '" alt="" />' : ICON_BOT) + '</div>' +
      '  <p id="ia-w-hero-greeting"></p>' +
      '</div>' +
      '<div id="ia-w-pills"></div>';
    bodyInner.appendChild(hero);
    hero.querySelector("#ia-w-hero-greeting").textContent = greetingText;

    inputEl.placeholder = sectors.length ? "Escribí tu consulta y presioná Enter…" : "Cargando sectores…";
    _renderPills();
    if (!sectors.length) _loadSectors();
  }

  function _renderPills() {
    var pills = document.getElementById("ia-w-pills");
    if (!pills) return;
    pills.innerHTML = "";
    if (!sectors.length) {
      for (var i = 0; i < 4; i++) { var sk = document.createElement("div"); sk.className = "ia-w-skel"; pills.appendChild(sk); }
      return;
    }
    sectors.forEach(function (s) {
      var p = document.createElement("button");
      p.className = "ia-w-pill";
      p.textContent = s.nombre;
      p.addEventListener("click", function () { _enterChat(s); });
      pills.appendChild(p);
    });
    // Divider
    var div = document.createElement("div");
    div.id = "ia-w-divider";
    div.innerHTML = '<div class="ln"></div><span class="tx">o escribí directamente</span><div class="ln"></div>';
    pills.parentNode.appendChild(div);
  }

  function _loadSectors() {
    fetch(API_BASE + "/api/v1/widget/sectors", { headers: _headers() })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        if (Array.isArray(data)) { sectors = data; }
        else { sectors = (data && Array.isArray(data.sectors)) ? data.sectors : []; if (data && data.greeting_message) GREETING = data.greeting_message; }
        if (!conversationId) {
          var g = document.getElementById("ia-w-hero-greeting");
          if (g && GREETING) g.textContent = GREETING;
          inputEl.placeholder = "Escribí tu consulta y presioná Enter…";
          _renderPills();
        }
      })
      .catch(function (err) {
        console.error("[IA Widget] sectores:", err);
        var pills = document.getElementById("ia-w-pills");
        if (pills) pills.innerHTML = '<p style="color:' + SLATE_400 + ';font-size:13px;">No se pudieron cargar los sectores.</p>';
      });
  }

  function _enterChat(sector, pendingMessage) {
    selectedSector = sector;
    localStorage.setItem(SECTOR_KEY, JSON.stringify(sector));
    backBtn.style.display = "flex";
    titleEl.textContent = sector.nombre;
    bodyInner.innerHTML = "";
    inputEl.placeholder = "Escribí tu mensaje…";
    inputEl.focus();
    _fetchOperatorsOnline(sector.id);
    _startConversation(sector.id, pendingMessage);
  }

  function _fetchOperatorsOnline(sectorId) {
    fetch(API_BASE + "/api/v1/widget/operators-online?sector_id=" + encodeURIComponent(sectorId), { headers: _headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { operatorsOnline = { count: d.online || 0, names: d.operators || [] }; _updateHeader(); } })
      .catch(function () {});
  }

  function _startConversation(sectorId, pendingMessage) {
    fetch(API_BASE + "/api/v1/widget/conversation/start", {
      method: "POST", headers: _headers(),
      body: JSON.stringify({ widget_session_id: widgetSessionId, sector_id: sectorId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        conversationId = data.conversation_id;
        convStatus = data.status;
        handoffBubble = null; handoffConfirmed = false;
        _updateHeader();
        if (data.resumed) {
          _loadHistory();
        } else {
          var greeting = GREETING || ("¡Hola! Soy " + TITLE + ", asistente de " + (selectedSector ? selectedSector.nombre : TITLE) + ". ¿En qué te puedo ayudar?");
          _appendMessage("system", greeting);
          if (pendingMessage) _sendMessage(pendingMessage);
        }
        _startPolling();
      })
      .catch(function (err) {
        console.error("[IA Widget] start:", err);
        _appendMessage("error", "Error al iniciar la conversación.");
      });
  }

  function _loadHistory() {
    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/poll?widget_session_id=" + encodeURIComponent(widgetSessionId), { headers: _headers() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        bodyInner.innerHTML = "";
        (data.messages || []).forEach(function (m) {
          if (m.is_handoff_offer && data.status === "bot_active") { _showHandoffOffer(m.content); }
          else { _appendMessage(m.sender_type, m.content, m.attachment_name ? { id: m.id, name: m.attachment_name, mime: m.attachment_mime } : null); }
          lastMessageId = m.id;
        });
        convStatus = data.status;
        operatorName = data.operator_name || null;
        afiliadoIdentified = !!data.afiliado_identified;
        _updateHeader();
      })
      .catch(function (err) { console.error("[IA Widget] history:", err); });
  }

  // ── Enviar mensaje ────────────────────────────────────────────────────────────
  var typingEl = null;
  function _showTyping() {
    if (typingEl) return;
    typingEl = document.createElement("div");
    typingEl.className = "ia-w-row";
    typingEl.innerHTML =
      '<div class="ia-w-bavatar bot">' + (LOGO_URL ? '<img src="' + LOGO_URL + '" alt="" />' : ICON_BOT) + '</div>' +
      '<div class="ia-w-typing"><span></span><span></span><span></span></div>';
    bodyInner.appendChild(typingEl);
    _scrollBottom();
  }
  function _hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  function _sendMessage(question) {
    _appendMessage("user", question);
    sendBtn.disabled = true; inputEl.disabled = true;
    _showTyping();

    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/message", {
      method: "POST", headers: _headers(),
      body: JSON.stringify({ content: question, widget_session_id: widgetSessionId }),
    })
      .then(function (r) {
        if (r.status === 410) {
          // Conversacion cerrada por operador: reabrir y reenviar
          _hideTyping();
          if (selectedSector) {
            _stopPolling(); conversationId = null; lastMessageId = null; handoffBubble = null;
            bodyInner.innerHTML = "";
            _startConversation(selectedSector.id, question);
          }
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        _hideTyping();
        if (data.bot_response) _appendMessage("bot", data.bot_response);
        convStatus = data.status;
        _updateHeader();
        if (data.handoff_offered && data.handoff_message) _showHandoffOffer(data.handoff_message);
        else if (data.handoff_activated && data.handoff_message) _appendMessage("system", data.handoff_message);
      })
      .catch(function (err) {
        _hideTyping();
        _appendMessage("error", "Error al enviar. Intentá de nuevo.");
        console.error("[IA Widget] send:", err);
      })
      .finally(function () {
        sendBtn.disabled = false; inputEl.disabled = false; inputEl.focus();
      });
  }

  // ── Adjuntos (afiliado → operador) ────────────────────────────────────────────
  var _OK_ATTACH = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];
  function _uploadAttachment(file) {
    if (!conversationId) { _appendMessage("error", "Iniciá la conversación antes de adjuntar."); return; }
    if (_OK_ATTACH.indexOf(file.type) === -1) { _appendMessage("error", "Solo se permiten imágenes (PNG/JPG/WEBP) o PDF."); return; }
    if (file.size > 10 * 1024 * 1024) { _appendMessage("error", "El archivo supera el máximo de 10 MB."); return; }
    clipBtn.disabled = true; sendBtn.disabled = true;
    var fd = new FormData();
    fd.append("file", file);
    fd.append("widget_session_id", widgetSessionId);
    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/attachment", {
      method: "POST",
      headers: { "Authorization": "Bearer " + WIDGET_TOKEN },  // sin Content-Type: el browser pone el boundary
      body: fd,
    })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.detail || "Error al subir"); }); })
      .then(function (data) {
        // Pintar optimista el adjunto del afiliado (el poll lo omite por ser 'user').
        _appendMessage("user", "", { id: data.message_id, name: data.attachment_name, mime: data.attachment_mime });
        lastMessageId = data.message_id;
      })
      .catch(function (err) { _appendMessage("error", "No se pudo enviar el archivo. " + (err.message || "")); })
      .finally(function () { clipBtn.disabled = false; sendBtn.disabled = false; });
  }

  function _renderAttachment(attach, parentEl) {
    if (!attach || !attach.name) return;
    var url = API_BASE + "/api/v1/widget/conversation/" + conversationId + "/attachment/" + attach.id +
              "?widget_session_id=" + encodeURIComponent(widgetSessionId);
    var isImg = !!(attach.mime && attach.mime.indexOf("image/") === 0);
    // Una <img src>/<a href> directa NO envía el header Authorization, así que el
    // download fallaría. Bajamos el archivo con fetch (token en header) y lo
    // mostramos con un object URL.
    var el;
    if (isImg) {
      el = document.createElement("img"); el.className = "ia-w-attach-img"; el.alt = attach.name; el.title = attach.name;
    } else {
      el = document.createElement("a"); el.className = "ia-w-attach-file"; el.href = "#";
      el.innerHTML = ICON_CLIP + "<span>" + _escape(attach.name) + "</span>";
    }
    parentEl.appendChild(el);
    fetch(url, { headers: { "Authorization": "Bearer " + WIDGET_TOKEN } })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (blob) {
        if (!blob) return;
        var burl = URL.createObjectURL(blob);
        if (isImg) {
          el.src = burl;
          el.addEventListener("click", function () { window.open(burl, "_blank"); });
        } else {
          el.href = burl; el.setAttribute("download", attach.name);
        }
      })
      .catch(function () {});
  }

  // ── Long-polling (para mensajes de operador / cambios de estado) ──────────────
  function _startPolling() { if (pollTimeout) clearTimeout(pollTimeout); pollAlive = true; _pollLoop(); }
  function _stopPolling() { pollAlive = false; if (pollTimeout) clearTimeout(pollTimeout); pollTimeout = null; }
  function _pollLoop() {
    if (!pollAlive || !conversationId) return;
    _poll().finally(function () { if (pollAlive) pollTimeout = setTimeout(_pollLoop, 250); });
  }
  function _poll() {
    if (!conversationId) return Promise.resolve();
    var url = API_BASE + "/api/v1/widget/conversation/" + conversationId + "/poll?widget_session_id=" + encodeURIComponent(widgetSessionId);
    if (lastMessageId) url += "&last_message_id=" + encodeURIComponent(lastMessageId);
    return fetch(url, { headers: _headers() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status;
        operatorName = data.operator_name || null;
        afiliadoIdentified = !!data.afiliado_identified;
        if (data.status === "bot_active") handoffConfirmed = false;
        _updateHeader();
        var pendingOffer = null;
        (data.messages || []).forEach(function (m) {
          if (m.is_handoff_offer) { pendingOffer = m.content; return; }
          if (lastMessageId === m.id) return;
          // Solo agregamos mensajes que no hayamos pintado ya (operador / sistema
          // que llegan por poll). Los del bot/user ya se pintaron en _sendMessage.
          if (m.sender_type === "operator" || m.sender_type === "system") {
            _appendMessage(m.sender_type, m.content, m.attachment_name ? { id: m.id, name: m.attachment_name, mime: m.attachment_mime } : null);
            lastMessageId = m.id;
            if (!panel.classList.contains("open")) { badge.style.display = "flex"; badge.textContent = "!"; }
          } else {
            lastMessageId = m.id;
          }
        });
        if (pendingOffer && convStatus === "bot_active") _showHandoffOffer(pendingOffer);
        else if (convStatus !== "bot_active" && handoffBubble && !handoffConfirmed) { /* la oferta sigue visible hasta confirmar */ }
      })
      .catch(function () {});
  }

  // ── Handoff inline (igual que /chat HandoffOfferBubble: offer → form → loader) ─
  function _showHandoffOffer(message) {
    if (handoffBubble) return;  // ya mostrada
    handoffBubble = document.createElement("div");
    handoffBubble.className = "ia-w-handoff";
    _renderHandoffOffer(message);
    bodyInner.appendChild(handoffBubble);
    _scrollBottom();
  }

  function _renderHandoffOffer(message) {
    handoffBubble.innerHTML = "";
    var p = document.createElement("p");
    p.className = "ia-w-hf-text";
    _renderTextWithLinks(message, p);
    handoffBubble.appendChild(p);

    var btnOffer = document.createElement("button");
    btnOffer.className = "ia-w-hf-btn";
    btnOffer.innerHTML = ICON_USERCHECK + "<span>Sí, conectarme con un operador</span>";
    btnOffer.addEventListener("click", function () {
      // Si la conversación ya tiene nombre + DNI (handoff previo), no re-pedirlos.
      if (afiliadoIdentified) _confirmHandoff(null);
      else _renderHandoffForm(message);
    });
    handoffBubble.appendChild(btnOffer);
  }

  function _renderHandoffForm(message) {
    handoffBubble.innerHTML = "";
    var p = document.createElement("p");
    p.className = "ia-w-hf-text"; _renderTextWithLinks(message, p);
    handoffBubble.appendChild(p);

    var form = document.createElement("div");
    form.className = "ia-w-hf-form";
    form.innerHTML =
      '<div class="t">Antes de conectarte con un operador</div>' +
      '<div class="h">Para una mejor atención, decinos tu nombre y DNI:</div>' +
      '<input type="text" id="ia-w-hf-nombre" placeholder="Nombre y apellido" maxlength="200" />' +
      '<input type="text" id="ia-w-hf-dni" inputmode="numeric" placeholder="DNI (sin puntos)" maxlength="20" />' +
      '<div class="err" id="ia-w-hf-err" style="display:none"></div>' +
      '<div class="actions" style="justify-content:flex-end;">' +
      '  <button class="ia-w-hf-btn" id="ia-w-hf-submit" style="padding:8px 16px;"><span>Continuar</span></button>' +
      '</div>';
    handoffBubble.appendChild(form);

    var nombreEl = form.querySelector("#ia-w-hf-nombre");
    var dniEl    = form.querySelector("#ia-w-hf-dni");
    var errEl    = form.querySelector("#ia-w-hf-err");
    var submitEl = form.querySelector("#ia-w-hf-submit");
    nombreEl.focus();

    function showErr(m) { errEl.textContent = m; errEl.style.display = "block"; }
    function submit() {
      var n = nombreEl.value.trim(), d = dniEl.value.trim();
      if (!n) return showErr("Decinos tu nombre, por favor.");
      if (!d) return showErr("Decinos tu DNI, por favor.");
      if (d.length < 4) return showErr("El DNI parece muy corto.");
      _confirmHandoff({ afiliado_nombre: n, afiliado_dni: d });
    }
    submitEl.addEventListener("click", submit);
    dniEl.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  }

  function _renderHandoffLoader() {
    if (!handoffBubble) return;
    handoffBubble.innerHTML =
      '<div class="ia-w-hf-loader">' + ICON_SPINNER + '<span>Buscando operador disponible…</span></div>';
  }

  function _confirmHandoff(identifyData) {
    handoffConfirmed = true;
    _renderHandoffLoader();
    var opts = { method: "POST", headers: _headers() };
    if (identifyData && (identifyData.afiliado_nombre || identifyData.afiliado_dni)) {
      opts.body = JSON.stringify(identifyData);
    }
    fetch(API_BASE + "/api/v1/widget/conversation/" + conversationId + "/confirm-handoff?widget_session_id=" + encodeURIComponent(widgetSessionId), opts)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        convStatus = data.status; _updateHeader();
        if (data.message) _appendMessage("system", data.message);
      })
      .catch(function (err) {
        console.error("[IA Widget] confirm handoff:", err);
        handoffConfirmed = false;
        _appendMessage("error", "No pudimos conectarte. Probá de nuevo.");
      });
  }

  // ── Render de mensajes (burbujas con avatar, igual que /chat) ─────────────────
  function _appendMessage(senderType, text, attach) {
    // El typing siempre debe quedar al final; lo removemos antes de insertar.
    var hadTyping = !!typingEl;
    if (hadTyping) _hideTyping();

    var row = document.createElement("div");

    if (senderType === "user") {
      row.className = "ia-w-row user";
      var ub = document.createElement("div"); ub.className = "ia-w-bubble user";
      if (text) _renderTextWithLinks(text, ub);
      if (attach) _renderAttachment(attach, ub);
      row.appendChild(ub);

    } else if (senderType === "operator") {
      row.className = "ia-w-row";
      var oav = document.createElement("div"); oav.className = "ia-w-bavatar op"; oav.innerHTML = ICON_USERCHECK;
      var owrap = document.createElement("div");
      var ob = document.createElement("div"); ob.className = "ia-w-bubble op";
      if (text) _renderTextWithLinks(text, ob);
      if (attach) _renderAttachment(attach, ob);
      owrap.appendChild(ob);
      var oname = document.createElement("div"); oname.className = "ia-w-opname"; oname.textContent = operatorName || "Operador";
      owrap.appendChild(oname);
      row.appendChild(oav); row.appendChild(owrap);

    } else if (senderType === "system" || senderType === "error") {
      row.className = "ia-w-row center";
      var sb = document.createElement("div"); sb.className = "ia-w-sys";
      if (senderType === "error") { sb.style.background = "#fee2e2"; sb.style.color = "#b91c1c"; }
      _renderTextWithLinks(text, sb); row.appendChild(sb);

    } else { // bot
      row.className = "ia-w-row";
      var bav = document.createElement("div"); bav.className = "ia-w-bavatar bot";
      bav.innerHTML = LOGO_URL ? '<img src="' + LOGO_URL + '" alt="" />' : ICON_BOT;
      var bb = document.createElement("div"); bb.className = "ia-w-bubble bot"; _renderTextWithLinks(text, bb);
      row.appendChild(bav); row.appendChild(bb);
    }

    bodyInner.appendChild(row);
    if (hadTyping) _showTyping();  // re-anclar typing al final
    _scrollBottom();
  }

  function _scrollBottom() { bodyEl.scrollTop = bodyEl.scrollHeight; }

  // ── Header / estado ───────────────────────────────────────────────────────────
  function _updateHeader() {
    headerEl.classList.remove("handoff", "attending");
    dotEl.className = "";
    var label;
    if (convStatus === "handoff_requested") {
      headerEl.classList.add("handoff"); dotEl.className = "amber pulse"; label = "Esperando operador…";
    } else if (convStatus === "human_attending") {
      headerEl.classList.add("attending"); dotEl.className = "pulse"; label = operatorName ? ("Atendiéndote: " + operatorName) : "Operador conectado";
    } else if (convStatus === "closed") {
      dotEl.className = "gray"; label = "Conversación cerrada";
    } else {
      dotEl.className = "pulse"; label = "En línea";
      // Operadores disponibles (solo en bot_active, igual que /chat)
      if (conversationId && operatorsOnline) {
        if (operatorsOnline.count > 0) label += operatorsOnline.count === 1 ? " · 1 operador disponible" : (" · " + operatorsOnline.count + " operadores disponibles");
      }
    }
    substatusEl.textContent = label;

    var closed = convStatus === "closed";
    inputEl.disabled = closed; sendBtn.disabled = closed;
  }

  // ── Texto con links (XSS-safe: createTextNode/createElement, nunca innerHTML) ─
  // Soporta markdown [etiqueta](url) — el LLM genera ese formato; sin esto se veía
  // el markdown crudo + la URL larga (parecía link duplicado). Y URLs sueltas.
  var MD_LINK_REGEX = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  var URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

  function _appendAnchor(parent, href, label) {
    var a = document.createElement("a");
    a.href = String(href).replace(/[.,;:!?]+$/, "");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    parent.appendChild(a);
  }

  // URLs sueltas (http://...) dentro de un fragmento de texto plano.
  function _appendPlainWithUrls(text, parentEl) {
    URL_REGEX.lastIndex = 0;
    var last = 0, match;
    while ((match = URL_REGEX.exec(text)) !== null) {
      if (match.index > last) parentEl.appendChild(document.createTextNode(text.slice(last, match.index)));
      var url = match[0].replace(/[.,;:!?]+$/, "");
      _appendAnchor(parentEl, url, url);
      last = match.index + url.length;
    }
    if (last < text.length) parentEl.appendChild(document.createTextNode(text.slice(last)));
  }

  function _renderTextWithLinks(text, parentEl) {
    // Markdown [etiqueta](url) primero (muestra solo la etiqueta); en los
    // segmentos de texto restantes, detecta URLs sueltas.
    MD_LINK_REGEX.lastIndex = 0;
    var last = 0, m;
    while ((m = MD_LINK_REGEX.exec(text)) !== null) {
      if (m.index > last) _appendPlainWithUrls(text.slice(last, m.index), parentEl);
      _appendAnchor(parentEl, m[2], m[1]);
      last = m.index + m[0].length;
    }
    if (last < text.length) _appendPlainWithUrls(text.slice(last), parentEl);
  }

  function _escape(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
