import { ChatProtocol } from "../lib/chat-protocol";

// ════════════════════════════════════════════════════════════════════════════
// FUENTE del widget embebible. Se compila con esbuild a public/widget/widget.js
// (pnpm build:widget; también corre en pnpm build). La lógica de conversación
// (token, start, poll, envío, adjuntos, sector, derivación) es lib/chat-protocol.ts,
// compartida con la pantalla /chat: los dos canales se comportan igual.
// ════════════════════════════════════════════════════════════════════════════
(function main() {
  "use strict";
  // Guard de doble carga (hosts SPA que re-inyectan el script): un solo widget.
  if (window.__iaWidgetLoaded) return;
  window.__iaWidgetLoaded = true;

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
  var PLACEHOLDER   = scriptTag ? (scriptTag.getAttribute("data-placeholder") || "Escribí un mensaje…") : "Escribí un mensaje…";
  // TITLE y branding son defaults; se sobreescriben con el branding del tenant.
  var TITLE         = scriptTag ? (scriptTag.getAttribute("data-title") || "Asistente") : "Asistente";
  // Color neutro: SOLO se usa si el branding del tenant no carga (fallback).
  // En el flujo normal la esfera aparece recién con el color real del tenant.
  var DEFAULT_PRIMARY = "#64748b";
  var LOGO_URL      = null;
  var GREETING      = null;  // saludo del tenant si esta configurado
  var PANEL_WIDTH   = scriptTag ? (scriptTag.getAttribute("data-width")  || "400") : "400";
  var PANEL_HEIGHT  = scriptTag ? (scriptTag.getAttribute("data-height") || "640") : "640";
  // Tamaño "agrandado" (botón expandir) — proporción del preview del panel.
  var PANEL_WIDTH_XL  = Math.round(Number(PANEL_WIDTH)  * 1.28);
  var PANEL_HEIGHT_XL = Math.round(Number(PANEL_HEIGHT) * 1.10);

  if (!WIDGET_TOKEN) { console.error("[IA Widget] data-token is required"); return; }

  // Logs de diagnostico: ocultos por defecto para no ensuciar la consola del
  // sitio donde se embebe. Activar con data-debug="true" en el <script>.
  var DEBUG = scriptTag ? (scriptTag.getAttribute("data-debug") === "true") : false;
  function wwarn() { if (DEBUG) console.warn.apply(console, arguments); }
  function werr()  { if (DEBUG) console.error.apply(console, arguments); }

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
    root.style.setProperty("--ia-brand-06", _rgba(hex, 0.06));
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
  // Maximize2 / Minimize2 de lucide (igual que el preview del panel).
  var ICON_EXPAND    = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  var ICON_SHRINK    = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  var ICON_USERCHECK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>';
  var ICON_SPINNER   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ia-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  // Auriculares (operador humano) — para el botón de derivación.
  var ICON_HEADSET   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-7a9 9 0 0 1 18 0v7a1 1 0 0 1-1 1h-2a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/><path d="M21 16v2a4 4 0 0 1-4 4h-5"/></svg>';
  // Etiqueta (nota de área), alerta (error) y reintentar.
  var ICON_TAG       = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>';
  var ICON_ALERT     = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  var ICON_RETRY     = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
  var ICON_CLIP      = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 1 1-2.83-2.83l8.49-8.48"/></svg>';

  // ── Session + remembered sector ──────────────────────────────────────────────
  var SESSION_KEY = "ia_widget_session_" + WIDGET_TOKEN.slice(-8);
  var widgetSessionId = localStorage.getItem(SESSION_KEY);
  if (!widgetSessionId) {
    widgetSessionId = "ws_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem(SESSION_KEY, widgetSessionId);
  }
  // El sector ya no se elige al abrir — se decide recién al derivar a un humano
  // (no afecta lo que responde el bot). Limpiar la preferencia de sesiones viejas.
  try { localStorage.removeItem("ia_widget_sector_" + WIDGET_TOKEN.slice(-8)); } catch (e) {}

  // ── Styles ─────────────────────────────────────────────────────────────────────
  var SLATE_50 = "#f8fafc", SLATE_100 = "#f1f5f9", SLATE_200 = "#e2e8f0",
      SLATE_300 = "#cbd5e1", SLATE_400 = "#94a3b8", SLATE_600 = "#475569", SLATE_800 = "#1e293b";

  var style = document.createElement("style");
  style.textContent = [
    "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');",

    // FAB
    "#ia-w-btn{position:fixed;bottom:24px;right:24px;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--ia-brand-light),var(--ia-brand-dark));color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s,opacity .25s;opacity:0;}",
    "#ia-w-btn.ia-ready{opacity:1;}",
    "#ia-w-btn svg{width:28px;height:28px;transition:opacity .15s;}",
    "#ia-w-btn:hover{transform:scale(1.08);box-shadow:0 8px 28px rgba(0,0,0,.3);}",
    "#ia-w-btn img{width:34px;height:34px;border-radius:50%;object-fit:cover;transition:opacity .15s;}",
    // Hover del FAB: la cara/logo se desvanece y aparecen 3 puntitos que rebotan
    // (idéntico al preview del panel).
    "#ia-w-btn:hover>svg,#ia-w-btn:hover>img{opacity:0;}",
    "#ia-w-dots{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:5px;opacity:0;transition:opacity .15s;pointer-events:none;}",
    "#ia-w-btn:hover #ia-w-dots{opacity:1;}",
    "#ia-w-dots span{width:7px;height:7px;border-radius:50%;background:#fff;animation:ia-bounce 1.4s infinite ease-in-out;}",
    "#ia-w-dots span:nth-child(2){animation-delay:.15s;}",
    "#ia-w-dots span:nth-child(3){animation-delay:.3s;}",
    "#ia-w-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:50%;width:20px;height:20px;font-size:11px;display:none;align-items:center;justify-content:center;font-weight:700;border:2px solid #fff;}",

    // Panel
    "#ia-w-panel{position:fixed;bottom:24px;right:24px;width:" + PANEL_WIDTH + "px;max-width:calc(100vw - 32px);height:" + PANEL_HEIGHT + "px;max-height:calc(100vh - 48px);border-radius:16px;background:#fff;color:" + SLATE_800 + ";color-scheme:light;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:2147483000;display:none;flex-direction:column;font-family:'Inter',system-ui,-apple-system,sans-serif;overflow:hidden;}",
    "#ia-w-panel *,#ia-w-panel *::before,#ia-w-panel *::after{box-sizing:border-box;color-scheme:light;}",
    "#ia-w-panel.open{display:flex;animation:ia-slideup .28s cubic-bezier(.16,1,.3,1);transform-origin:bottom right;}",
    "#ia-w-panel.closing{display:flex;animation:ia-slidedown .2s cubic-bezier(.4,0,1,1) forwards;transform-origin:bottom right;}",
    "@keyframes ia-slideup{from{opacity:0;transform:translateY(16px) scale(.97);}to{opacity:1;transform:translateY(0) scale(1);}}",
    "@keyframes ia-slidedown{from{opacity:1;transform:translateY(0) scale(1);}to{opacity:0;transform:translateY(12px) scale(.98);}}",
    "@keyframes ia-fab-in{from{opacity:0;transform:scale(.5);}to{opacity:1;transform:scale(1);}}",
    "@media (prefers-reduced-motion:reduce){#ia-w-panel.open,#ia-w-panel.closing{animation-duration:.01ms;}}",
    "#ia-w-panel input,#ia-w-panel textarea{color:" + SLATE_800 + ";caret-color:var(--ia-brand);-webkit-text-fill-color:" + SLATE_800 + ";}",
    // Scrollbar sutil
    "#ia-w-panel ::-webkit-scrollbar{width:8px;height:8px;}",
    "#ia-w-panel ::-webkit-scrollbar-track{background:transparent;}",
    "#ia-w-panel ::-webkit-scrollbar-button{display:none;width:0;height:0;}",
    "#ia-w-panel ::-webkit-scrollbar-thumb{background:" + SLATE_300 + ";border-radius:8px;border:2px solid transparent;background-clip:content-box;}",
    "#ia-w-panel{scrollbar-width:thin;scrollbar-color:" + SLATE_300 + " transparent;}",
    // Responsive
    "@media (max-width:640px){"
      + "#ia-w-panel{top:0;right:0;left:0;bottom:auto;width:100vw;height:100vh;height:100dvh;max-width:100vw;max-height:none;border-radius:0;box-shadow:none;overflow-x:hidden;touch-action:manipulation;}"
      + "#ia-w-panel.open{animation:ia-slideup-m .2s ease-out;transform-origin:center;}"
      + "#ia-w-btn{bottom:16px;right:16px;width:56px;height:56px;box-shadow:0 2px 10px rgba(0,0,0,.25);touch-action:manipulation;}"
      + "#ia-w-close{top:calc(12px + env(safe-area-inset-top,0));}"
      + "#ia-w-expand{display:none;}"
      + "#ia-w-idcard{margin-top:calc(16px + env(safe-area-inset-top,0));}"
      + "#ia-w-inputbar{-webkit-backdrop-filter:none;backdrop-filter:none;background:#fff;padding-bottom:calc(12px + env(safe-area-inset-bottom,0));}"
      + "#ia-w-avatar{-webkit-backdrop-filter:none;backdrop-filter:none;}"
      + "#ia-w-input,.ia-w-hf-form input{font-size:16px;}"
      + "#ia-w-body{overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}"
    + "}",
    "@keyframes ia-slideup-m{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}",
    "@media (min-width:1441px){#ia-w-panel{width:440px;height:700px;bottom:32px;right:32px;}#ia-w-btn{width:72px;height:72px;bottom:32px;right:32px;}}",

    // Posición IZQUIERDA (branding.widget_position === 'left'): flip esquina.
    "#ia-w-btn.ia-left{right:auto;left:24px;}",
    "#ia-w-panel.ia-left{right:auto;left:24px;transform-origin:bottom left;}",
    "@media (max-width:640px){#ia-w-btn.ia-left{left:16px;}}",
    "@media (min-width:1441px){#ia-w-btn.ia-left{left:32px;}#ia-w-panel.ia-left{left:32px;}}",

    // Top WHITE-FIRST (idéntico al preview de personalización): sin barra de
    // color. El botón cerrar flota arriba a la derecha; una tarjeta de identidad
    // centrada (avatar + nombre + estado) va fijada arriba y refleja el estado en
    // vivo (handoff/atendiendo tiñen su borde). El color de marca es acento.
    "#ia-w-close{position:absolute;top:10px;right:12px;z-index:20;background:none;border:none;color:#94a3b8;cursor:pointer;font-size:22px;line-height:1;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:color .2s,background .2s;}",
    "#ia-w-close:hover{color:#1e293b;background:rgba(0,0,0,.05);}",
    "#ia-w-panel.ia-dark #ia-w-close{color:#8b939e;}",
    "#ia-w-panel.ia-dark #ia-w-close:hover{color:#e7e9ec;background:rgba(255,255,255,.08);}",
    // Agrandar/reducir — espejo del cerrar, arriba a la izquierda (igual preview).
    "#ia-w-expand{position:absolute;top:10px;left:12px;z-index:20;background:none;border:none;color:#94a3b8;cursor:pointer;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:color .2s,background .2s;}",
    "#ia-w-expand svg{width:15px;height:15px;}",
    "#ia-w-expand:hover{color:#1e293b;background:rgba(0,0,0,.05);}",
    "#ia-w-panel.ia-dark #ia-w-expand{color:#8b939e;}",
    "#ia-w-panel.ia-dark #ia-w-expand:hover{color:#e7e9ec;background:rgba(255,255,255,.08);}",
    // El panel anima el cambio de tamaño (igual que el preview del panel).
    "#ia-w-panel{transition:width .3s cubic-bezier(.22,1,.36,1),height .3s cubic-bezier(.22,1,.36,1);}",
    "#ia-w-panel.ia-expanded{width:" + PANEL_WIDTH_XL + "px;height:" + PANEL_HEIGHT_XL + "px;}",
    "#ia-w-idcard{flex-shrink:0;margin:14px auto 8px;display:flex;align-items:center;gap:10px;width:fit-content;max-width:calc(100% - 88px);background:#fff;border:1px solid #eceef1;border-radius:16px;padding:8px 14px 8px 9px;box-shadow:0 4px 12px -3px rgba(0,0,0,.10),0 1px 4px -1px rgba(0,0,0,.06);min-width:0;transition:width .38s cubic-bezier(.34,1.4,.5,1),border-color .3s,box-shadow .3s;overflow:hidden;}",
    "#ia-w-substatus{min-width:0;}",
    "#ia-w-substatus-text{min-width:0;transition:opacity .16s;}",
    "#ia-w-panel.ia-dark #ia-w-idcard{background:#1c2126;border-color:#262c33;}",
    "#ia-w-idcard.handoff{border-color:#fcd34d;}",
    "#ia-w-idcard.attending{border-color:var(--ia-brand-30);}",
    "#ia-w-avatar{position:relative;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--ia-brand-light),var(--ia-brand-dark));display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
    "#ia-w-avatar svg{width:18px;height:18px;color:#fff;}",
    "#ia-w-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;}",
    "#ia-w-avatar::after{content:'';position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:50%;background:#22c55e;border:2px solid #fff;}",
    "#ia-w-panel.ia-dark #ia-w-avatar::after{border-color:#1c2126;}",
    "#ia-w-titlewrap{min-width:0;}",
    "#ia-w-title{color:#1e293b;font-weight:600;font-size:13px;line-height:1.15;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    "#ia-w-panel.ia-dark #ia-w-title{color:#e7e9ec;}",
    "#ia-w-substatus{display:flex;align-items:center;gap:6px;margin-top:2px;}",
    // El indicador de estado vive en el punto del avatar (igual que el preview);
    // este dot separado se oculta para no duplicarlo. Sigue en el DOM porque el
    // JS lo referencia; el color de estado lo pinta el avatar según la clase.
    "#ia-w-dot{display:none;}",
    "#ia-w-idcard.handoff #ia-w-avatar::after{background:#f59e0b;}",
    "#ia-w-idcard.attending #ia-w-avatar::after{background:#22c55e;}",
    "#ia-w-idcard.closed #ia-w-avatar::after{background:#94a3b8;}",
    "@keyframes ia-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5);}70%{box-shadow:0 0 0 5px rgba(34,197,94,0);}100%{box-shadow:0 0 0 0 rgba(34,197,94,0);}}",
    "#ia-w-substatus-text{font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    "#ia-w-panel.ia-dark #ia-w-substatus-text{color:#8b939e;}",

    // Body scrollable — gris base con un velo apenas perceptible del color de
    // marca cayendo desde el header: le da atmósfera sin ensuciar la lectura.
    "#ia-w-body{flex:1 1 auto;min-height:0;overflow-y:auto;background:#fff;}",
    "#ia-w-body-inner{min-height:100%;display:flex;flex-direction:column;padding:20px 16px;gap:14px;}",

    // Elección de área (opcional): lista vertical directa bajo el saludo,
    // estilo lista de mensajería. Escala a cualquier cantidad de sectores.
    ".ia-w-seclist{align-self:stretch;background:#fff;border:1px solid " + SLATE_100 + ";border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:280px;overflow-y:auto;}",
    ".ia-w-seclist .hd{padding:10px 14px;font-size:12px;font-weight:600;color:" + SLATE_600 + ";border-bottom:1px solid " + SLATE_100 + ";background:" + SLATE_50 + ";position:sticky;top:0;}",
    ".ia-w-secitem{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid " + SLATE_100 + ";padding:11px 14px;font-size:13px;color:" + SLATE_800 + ";cursor:pointer;font-family:inherit;transition:background .15s,color .15s;}",
    ".ia-w-secitem:last-child{border-bottom:none;}",
    ".ia-w-secitem:hover{background:var(--ia-brand-06);color:var(--ia-brand);}",
    ".ia-w-secitem.muted{color:" + SLATE_400 + ";font-size:12px;}",

    // Burbujas (igual que /chat)
    // Entrada de mensajes: fade + 6px de deslizamiento. Como los mensajes se
    // APPENDEAN (no se re-renderiza la lista), cada burbuja anima solo al
    // insertarse — cero impacto en latencia (transform/opacity van al compositor).
    ".ia-w-row{display:flex;gap:10px;align-items:flex-end;animation:ia-msg-in .22s cubic-bezier(.16,1,.3,1) backwards;}",
    "@keyframes ia-msg-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}",
    "@media (prefers-reduced-motion:reduce){.ia-w-row{animation:none;}}",
    ".ia-w-row.user{justify-content:flex-end;}",
    ".ia-w-row.center{justify-content:center;padding:2px 0;}",
    ".ia-w-bavatar{position:relative;width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;}",
    ".ia-w-bavatar.bot{background:linear-gradient(135deg,var(--ia-brand-light),var(--ia-brand-dark));}",
    ".ia-w-bavatar.op{background:linear-gradient(135deg,#34d399,#0d9488);}",
    ".ia-w-bavatar svg{width:15px;height:15px;color:#fff;}",
    ".ia-w-bavatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;}",
    // Punto verde \"en línea\" (igual que el preview): esquina inferior-derecha.
    ".ia-w-bavatar::after{content:'';position:absolute;bottom:-1px;right:-1px;width:8px;height:8px;border-radius:50%;background:#22c55e;border:2px solid #fff;}",
    "#ia-w-panel.ia-dark .ia-w-bavatar::after{border-color:#101214;}",
    ".ia-w-bubble{max-width:80%;padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.5;word-break:break-word;}",
    ".ia-w-bubble.bot{background:#f4f5f7;color:" + SLATE_800 + ";border-bottom-left-radius:4px;}",
    ".ia-w-bubble.op{background:#ecfdf5;color:" + SLATE_800 + ";border:1px solid #a7f3d0;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06);}",
    ".ia-w-bubble.user{background:linear-gradient(135deg,var(--ia-brand),var(--ia-brand-dark));color:var(--ia-brand-fg);border-bottom-right-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.15);}",
    ".ia-w-bubble.user a{color:#fff;}",
    ".ia-w-opname{font-size:11px;color:#059669;margin-top:4px;margin-left:2px;font-weight:500;}",
    ".ia-w-sys{align-self:center;background:" + SLATE_100 + ";color:" + SLATE_400 + ";font-size:12px;border-radius:9999px;padding:5px 16px;max-width:90%;text-align:center;}",
    ".ia-w-bubble a,.ia-w-sys a{color:inherit;text-decoration:underline;text-underline-offset:2px;word-break:break-all;}",

    // Typing
    ".ia-w-typing{display:flex;gap:5px;align-items:center;padding:12px 16px;background:#f4f5f7;border-radius:16px;border-bottom-left-radius:4px;}",
    ".ia-w-typing span{width:7px;height:7px;border-radius:50%;background:var(--ia-brand-light);animation:ia-bounce 1.4s infinite ease-in-out;}",
    ".ia-w-typing span:nth-child(2){animation-delay:.16s;}",
    ".ia-w-typing span:nth-child(3){animation-delay:.32s;}",
    "@keyframes ia-bounce{0%,80%,100%{transform:translateY(0);opacity:.4;}40%{transform:translateY(-5px);opacity:1;}}",

    // Derivación a humano en FORMATO BURBUJA (avatar + burbuja del bot): la oferta
    // se lee como un mensaje más, con un botón de acción de marca adentro.
    ".ia-w-bubble.ia-w-hf{display:flex;flex-direction:column;gap:11px;max-width:85%;}",
    ".ia-w-hf-cta{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,var(--ia-brand),var(--ia-brand-dark));color:var(--ia-brand-fg);border:none;border-radius:11px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 3px 10px -3px var(--ia-brand-30);transition:transform .12s,box-shadow .12s;}",
    ".ia-w-hf-cta svg{width:16px;height:16px;}",
    ".ia-w-hf-cta:hover{transform:translateY(-1px);box-shadow:0 5px 14px -3px var(--ia-brand-30);}",
    ".ia-w-hf-cta:active{transform:scale(.98);}",
    ".ia-w-hf-keep{align-self:center;background:none;border:none;color:#94a3b8;font-size:12px;cursor:pointer;font-family:inherit;padding:2px 4px;transition:color .15s;}",
    ".ia-w-hf-keep:hover{color:#475569;}",
    "#ia-w-panel.ia-dark .ia-w-hf-keep{color:#6b7280;}",
    "#ia-w-panel.ia-dark .ia-w-hf-keep:hover{color:#aab2bc;}",

    ".ia-w-hf-loader{display:inline-flex;align-items:center;gap:9px;font-size:13px;color:" + SLATE_600 + ";justify-content:center;}",
    ".ia-w-hf-done{font-size:12px;color:#94a3b8;}",
    "#ia-w-panel.ia-dark .ia-w-hf-done{color:#6b7280;}",
    ".ia-w-hf-loader svg{width:16px;height:16px;color:var(--ia-brand);}",
    ".ia-w-hf-form{text-align:left;display:flex;flex-direction:column;gap:9px;}",
    ".ia-w-hf-form .t{font-size:13px;font-weight:600;color:#1e293b;}",
    ".ia-w-hf-form .h{font-size:12px;color:" + SLATE_600 + ";line-height:1.4;}",
    ".ia-w-hf-form input,.ia-w-hf-form select{padding:10px 12px;border:1px solid " + SLATE_200 + ";border-radius:10px;font-size:14px;width:100%;background:#fff;font-family:inherit;color:" + SLATE_800 + ";box-sizing:border-box;}",
    ".ia-w-hf-form input:focus,.ia-w-hf-form select:focus{outline:none;border-color:var(--ia-brand);box-shadow:0 0 0 3px var(--ia-brand-25);}",
    ".ia-w-hf-form .err{font-size:11px;color:#dc2626;}",
    ".ia-w-hf-form .actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px;}",

    // Nota de sistema mejorada (pill con ícono) + nota de área (con área en negrita)
    ".ia-w-sysnote{display:inline-flex;align-items:center;gap:6px;background:" + SLATE_100 + ";color:" + SLATE_600 + ";font-size:12px;border-radius:9999px;padding:6px 13px;max-width:90%;line-height:1.35;}",
    ".ia-w-sysnote svg{width:13px;height:13px;flex-shrink:0;}",
    ".ia-w-sysnote b{font-weight:600;color:#475569;}",
    "#ia-w-panel.ia-dark .ia-w-sysnote{background:#1c2126;color:#aab2bc;}",
    "#ia-w-panel.ia-dark .ia-w-sysnote b{color:#e7e9ec;}",

    // Error como mini-card (sin borde duro): círculo de ícono + texto + reintentar
    ".ia-w-errcard{display:flex;align-items:center;gap:10px;background:#fef2f2;border-radius:14px;padding:9px 13px 9px 10px;max-width:92%;}",
    ".ia-w-erricon{width:28px;height:28px;border-radius:50%;background:#fee2e2;color:#dc2626;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
    ".ia-w-erricon svg{width:15px;height:15px;}",
    ".ia-w-errtxt{font-size:12.5px;color:#991b1b;line-height:1.35;}",
    ".ia-w-errbtn{display:inline-flex;align-items:center;gap:5px;background:#fff;color:#dc2626;border:none;border-radius:9px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 1px 2px rgba(0,0,0,.06);flex-shrink:0;}",
    ".ia-w-errbtn svg{width:13px;height:13px;}",
    ".ia-w-errbtn:hover{background:#fff5f5;}",
    "#ia-w-panel.ia-dark .ia-w-errcard{background:#2a1618;}",
    "#ia-w-panel.ia-dark .ia-w-erricon{background:#3f1d1d;color:#f87171;}",
    "#ia-w-panel.ia-dark .ia-w-errtxt{color:#fca5a5;}",
    "#ia-w-panel.ia-dark .ia-w-errbtn{background:#1c2126;color:#f87171;}",
    ".ia-w-hf-skip{background:none;border:none;cursor:pointer;color:#92400e;font-size:12px;text-decoration:underline;font-family:inherit;}",

    // Input tipo píldora (idéntico al preview del panel): la FILA es la píldora
    // gris; el textarea va transparente adentro; el enviar es un círculo con el
    // gradiente de marca. El clip queda a la izquierda dentro de la misma píldora.
    "#ia-w-inputbar{flex-shrink:0;background:#fff;padding:10px 12px;}",
    "#ia-w-inputrow{display:flex;gap:4px;align-items:flex-end;background:" + SLATE_100 + ";border-radius:22px;padding:5px 5px 5px 6px;transition:background .15s,box-shadow .15s;}",
    "#ia-w-inputrow:focus-within{background:#fff;box-shadow:0 0 0 2px var(--ia-brand-25);}",
    "#ia-w-input{flex:1;background:transparent;border:none;padding:7px 6px;font-size:14px;outline:none;resize:none;min-height:20px;max-height:96px;font-family:inherit;line-height:1.4;overflow-y:hidden;}",
    "#ia-w-input::placeholder{color:" + SLATE_400 + ";}",
    "#ia-w-clip{flex-shrink:0;width:34px;height:34px;border:none;background:none;color:" + SLATE_400 + ";cursor:pointer;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:all .15s;}",
    "#ia-w-clip:hover{color:var(--ia-brand);}",
    "#ia-w-clip svg{width:18px;height:18px;}",
    "#ia-w-clip:disabled{opacity:.45;cursor:default;}",
    ".ia-w-attach-img{max-width:210px;max-height:210px;border-radius:10px;margin-top:4px;cursor:pointer;display:block;border:1px solid " + SLATE_200 + ";}",
    ".ia-w-attach-file{display:inline-flex;align-items:center;gap:6px;margin-top:4px;padding:8px 12px;background:rgba(0,0,0,.05);border-radius:10px;text-decoration:none;color:inherit;font-size:13px;word-break:break-all;}",
    ".ia-w-attach-file svg{width:16px;height:16px;flex-shrink:0;}",
    ".ia-w-attach-file:hover{background:rgba(0,0,0,.09);}",
    "#ia-w-send{width:34px;height:34px;flex-shrink:0;border-radius:50%;background:linear-gradient(135deg,var(--ia-brand),var(--ia-brand-dark));color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.12);transition:transform .15s,opacity .15s;}",
    "#ia-w-send svg{width:15px;height:15px;}",
    "#ia-w-send:hover:not(:disabled){transform:scale(1.06);}",
    "#ia-w-send:active:not(:disabled){transform:scale(.94);}",
    "#ia-w-send:disabled{opacity:.4;cursor:not-allowed;}",
    ".ia-spin{animation:ia-rotate 1s linear infinite;}",
    "@keyframes ia-rotate{to{transform:rotate(360deg);}}",

    // ── Tema OSCURO del widget (branding.widget_theme === 'dark') ─────────────
    // Scope por clase en el panel: superficies oscuras, texto claro. El color de
    // marca (header, burbuja del usuario, FAB) no cambia — es la identidad.
    "#ia-w-panel.ia-dark{background:#101214;color:#e7e9ec;color-scheme:dark;}",
    "#ia-w-panel.ia-dark *,#ia-w-panel.ia-dark *::before,#ia-w-panel.ia-dark *::after{color-scheme:dark;}",
    "#ia-w-panel.ia-dark #ia-w-body{background:#101214;}",
    "#ia-w-panel.ia-dark .ia-w-bubble.bot{background:#1c2126;color:#e7e9ec;}",
    "#ia-w-panel.ia-dark .ia-w-bubble.op{background:#0e2a21;color:#d9f5e8;border-color:#1d4536;}",
    "#ia-w-panel.ia-dark .ia-w-sys{background:#1c2126;color:#8b939e;}",
    "#ia-w-panel.ia-dark .ia-w-typing{background:#1c2126;border-color:#262c33;}",
    "#ia-w-panel.ia-dark #ia-w-inputbar{background:#101214;}",
    "#ia-w-panel.ia-dark #ia-w-inputrow{background:#1c2126;}",
    "#ia-w-panel.ia-dark #ia-w-inputrow:focus-within{background:#20262c;}",
    "#ia-w-panel.ia-dark #ia-w-input{background:transparent;color:#e7e9ec;-webkit-text-fill-color:#e7e9ec;}",
    "#ia-w-panel.ia-dark #ia-w-input::placeholder{color:#6b7280;}",
    "#ia-w-panel.ia-dark .ia-w-seclist{background:#171b1f;border-color:#262c33;box-shadow:0 4px 16px rgba(0,0,0,.4);}",
    "#ia-w-panel.ia-dark .ia-w-seclist .hd{background:#1c2126;border-bottom-color:#262c33;color:#aab2bc;}",
    "#ia-w-panel.ia-dark .ia-w-secitem{color:#e7e9ec;border-bottom-color:#262c33;}",
    "#ia-w-panel.ia-dark .ia-w-secitem.muted{color:#6b7280;}",
    "#ia-w-panel.ia-dark .ia-w-hf-form .t{color:#e7e9ec;}",
    "#ia-w-panel.ia-dark .ia-w-hf-form .h{color:#aab2bc;}",
    "#ia-w-panel.ia-dark .ia-w-hf-form input,#ia-w-panel.ia-dark .ia-w-hf-form select{background:#1c2126;border-color:#2a3138;color:#e7e9ec;-webkit-text-fill-color:#e7e9ec;}",
    "#ia-w-panel.ia-dark .ia-w-attach-file{background:rgba(255,255,255,.08);}",
    "#ia-w-panel.ia-dark ::-webkit-scrollbar-thumb{background:#3a424b;border:2px solid transparent;background-clip:content-box;}",
  ].join("");
  document.head.appendChild(style);

  // ── DOM ─────────────────────────────────────────────────────────────────────
  var btn = document.createElement("button");
  btn.id = "ia-w-btn";
  btn.setAttribute("aria-label", "Abrir asistente");
  var FAB_DOTS = "<span id='ia-w-dots'><span></span><span></span><span></span></span>";
  btn.innerHTML = ICON_BOT + FAB_DOTS + "<span id='ia-w-badge'></span>";

  var panel = document.createElement("div");
  panel.id = "ia-w-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TITLE);
  panel.innerHTML = [
    '<button id="ia-w-expand" type="button" aria-label="Agrandar">' + ICON_EXPAND + '</button>',
    '<button id="ia-w-close" aria-label="Cerrar">&times;</button>',
    '<div id="ia-w-idcard">',
    '  <div id="ia-w-avatar">' + ICON_BOT + '</div>',
    '  <div id="ia-w-titlewrap">',
    '    <span id="ia-w-title">' + _escape(TITLE) + '</span>',
    '    <div id="ia-w-substatus"><span id="ia-w-dot" class="pulse"></span><span id="ia-w-substatus-text">En línea</span></div>',
    '  </div>',
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

  var headerEl   = document.getElementById("ia-w-idcard");
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
  var expandBtn  = document.getElementById("ia-w-expand");

  // Agrandar/reducir el panel (desktop) — mismo gesto que el preview del panel.
  expandBtn.addEventListener("click", function () {
    var xl = panel.classList.toggle("ia-expanded");
    expandBtn.innerHTML = xl ? ICON_SHRINK : ICON_EXPAND;
    expandBtn.setAttribute("aria-label", xl ? "Reducir" : "Agrandar");
  });

  // ── Branding del tenant ───────────────────────────────────────────────────────
  // Revela la esfera (fade-in). Se llama SOLO cuando ya se aplicó el color del
  // tenant (o el neutro de fallback) → nunca se ve el parpadeo de color default.
  function _revealBtn() { btn.classList.add("ia-ready"); }

  function _loadBranding() {
    if (!TENANT_ID) { _revealBtn(); return; }
    fetch(API_BASE + "/api/v1/public/tenant-branding?tenant_id=" + encodeURIComponent(TENANT_ID))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) {
        if (b) {
          if (b.primary_color) _applyBrand(b.primary_color);
          // Color de letra personalizado (secondary_color): pisa el legible-auto
          // del header/burbuja del usuario, igual que "Color de la letra" del panel.
          if (b.secondary_color) document.documentElement.style.setProperty("--ia-brand-fg", b.secondary_color);
          if (b.widget_theme === "dark") panel.classList.add("ia-dark");
          if (b.widget_position === "left") { btn.classList.add("ia-left"); panel.classList.add("ia-left"); }
          if (b.bot_name) { TITLE = b.bot_name; titleEl.textContent = b.bot_name; panel.setAttribute("aria-label", b.bot_name); }
          if (b.greeting_message) GREETING = b.greeting_message;
          if (b.logo_url) {
            LOGO_URL = b.logo_url.indexOf("http") === 0 ? b.logo_url : (API_BASE + b.logo_url);
            btn.innerHTML = '<img src="' + LOGO_URL + '" alt="" />' + FAB_DOTS + '<span id="ia-w-badge"></span>';
            badge = document.getElementById("ia-w-badge");
            avatarEl.innerHTML = '<img src="' + LOGO_URL + '" alt="" />';
          }
        }
        _revealBtn();
      })
      .catch(function (err) { wwarn("[IA Widget] branding:", err); _revealBtn(); });
  }
  _loadBranding();

  // ══════════════════════════════════════════════════════════════════════════
  // Lógica de conversación: TODA en lib/chat-protocol.ts (compartida con la
  // pantalla /chat). Acá solo hay render del panel sobre el estado observable.
  // ══════════════════════════════════════════════════════════════════════════

  // ── Estilos adicionales (móvil / tacto / chips / cierre) ────────────────────
  var style2 = document.createElement("style");
  style2.textContent = [
    "#ia-w-btn,#ia-w-panel,#ia-w-panel *{-webkit-tap-highlight-color:transparent;}",
    "#ia-w-panel button,#ia-w-panel a,#ia-w-panel input,#ia-w-panel textarea,#ia-w-panel select{touch-action:manipulation;}",
    // Hover solo con mouse: en el celular los :hover quedaban "pegados" tras el tap.
    "@media (hover:none){#ia-w-btn:hover{transform:none;}#ia-w-btn:hover>svg,#ia-w-btn:hover>img{opacity:1;}#ia-w-btn:hover #ia-w-dots{opacity:0;}#ia-w-send:hover:not(:disabled){transform:none;}.ia-w-hf-cta:hover{transform:none;}}",
    // Targets táctiles ≥ 44 px
    "#ia-w-close,#ia-w-expand{width:40px;height:40px;}",
    "#ia-w-clip,#ia-w-send{width:40px;height:40px;}",
    "#ia-w-send svg{width:16px;height:16px;}",
    "#ia-w-input{font-size:15px;padding:9px 6px;}",
    ".ia-w-bubble{font-size:15px;max-width:85%;}",
    ".ia-w-hf-keep{padding:8px 10px;min-height:36px;}",
    ".ia-w-hf-form select{font-size:16px;}",
    "@media (max-width:640px){#ia-w-input,.ia-w-hf-form input,.ia-w-hf-form select{font-size:16px;}#ia-w-clip,#ia-w-send{width:44px;height:44px;}#ia-w-close,#ia-w-expand{width:44px;height:44px;}}",
    // Agrupado: burbujas seguidas del mismo remitente van más juntas y sin avatar repetido
    ".ia-w-row.ia-grouped{margin-top:-9px;}",
    ".ia-w-bavatar.ia-hidden{visibility:hidden;}",
    // Chips de área
    ".ia-w-chips{display:flex;flex-direction:column;gap:8px;padding-left:38px;}",
    ".ia-w-chips .hd{font-size:12px;font-weight:500;color:#64748b;}",
    ".ia-w-chips .row{display:flex;flex-wrap:wrap;gap:8px;}",
    ".ia-w-chip{min-height:40px;border-radius:9999px;border:1px solid #e2e8f0;background:#fff;color:#334155;padding:6px 14px;font-size:14px;font-family:inherit;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:background .15s,border-color .15s;}",
    ".ia-w-chip:active{border-color:var(--ia-brand);background:var(--ia-brand-06);}",
    ".ia-w-chip.muted{border:none;box-shadow:none;background:none;color:#94a3b8;font-size:13px;}",
    "#ia-w-panel.ia-dark .ia-w-chip{background:#1c2126;border-color:#2a3138;color:#e7e9ec;}",
    "#ia-w-panel.ia-dark .ia-w-chips .hd{color:#aab2bc;}",
    // Optimista (aún no confirmado)
    ".ia-w-bubble.user.ia-pending{opacity:.8;}",
    // "Mensajes nuevos" cuando el usuario está leyendo arriba
    "#ia-w-newmsgs{position:absolute;left:50%;bottom:78px;transform:translateX(-50%);z-index:5;display:none;align-items:center;gap:6px;background:rgba(15,23,42,.85);color:#fff;border:none;border-radius:9999px;padding:8px 14px;font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2);}",
    "#ia-w-newmsgs.on{display:inline-flex;}",
    // Nueva conversación (conversación cerrada)
    "#ia-w-newconv{display:none;width:100%;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,var(--ia-brand),var(--ia-brand-dark));color:var(--ia-brand-fg);border:none;border-radius:9999px;min-height:44px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 3px 10px -3px var(--ia-brand-30);}",
    "#ia-w-newconv.on{display:inline-flex;}",
    "#ia-w-inputrow.off{display:none;}",
    // Esperando operador: aviso con "Volver al asistente"
    "#ia-w-waitbar{display:none;align-items:center;justify-content:space-between;gap:10px;background:#fffbeb;border-radius:16px;padding:6px 6px 6px 13px;margin-bottom:8px;}",
    "#ia-w-waitbar.on{display:flex;animation:ia-msg-in .22s cubic-bezier(.16,1,.3,1);}",
    "#ia-w-waitbar .t{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;color:#78350f;}",
    "#ia-w-waitbar .t i{width:8px;height:8px;border-radius:50%;background:#f59e0b;flex-shrink:0;animation:ia-pulse-dot 1.4s infinite;}",
    "@keyframes ia-pulse-dot{0%,100%{opacity:1;}50%{opacity:.35;}}",
    "#ia-w-waitbar button{display:inline-flex;align-items:center;gap:6px;min-height:36px;background:#fff;color:#334155;border:none;border-radius:11px;padding:0 12px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08);flex-shrink:0;}",
    "#ia-w-waitbar button:disabled{opacity:.6;cursor:default;}",
    "#ia-w-panel.ia-dark #ia-w-waitbar{background:#2a2310;}",
    "#ia-w-panel.ia-dark #ia-w-waitbar .t{color:#fcd34d;}",
    "#ia-w-panel.ia-dark #ia-w-waitbar button{background:#1c2126;color:#e7e9ec;}",
    // Error fatal (token revocado, canal apagado)
    ".ia-w-fatal{align-self:center;text-align:center;padding:24px 12px;color:#64748b;font-size:14px;line-height:1.5;max-width:300px;}",
    ".ia-w-fatal b{display:block;color:#1e293b;font-size:15px;margin-bottom:6px;}",
  ].join("");
  document.head.appendChild(style2);

  // ── DOM extra: chip "mensajes nuevos" y botón "Nueva conversación" ────────
  var newMsgsBtn = document.createElement("button");
  newMsgsBtn.id = "ia-w-newmsgs"; newMsgsBtn.type = "button";
  newMsgsBtn.innerHTML = "↓ <span>Mensajes nuevos</span>";
  panel.appendChild(newMsgsBtn);
  var inputRow = document.getElementById("ia-w-inputrow");
  var newConvBtn = document.createElement("button");
  newConvBtn.id = "ia-w-newconv"; newConvBtn.type = "button";
  newConvBtn.innerHTML = ICON_BOT + "<span>Nueva consulta</span>";
  inputRow.parentNode.insertBefore(newConvBtn, inputRow.nextSibling);
  var waitBar = document.createElement("div");
  waitBar.id = "ia-w-waitbar";
  waitBar.innerHTML = '<span class="t"><i></i><span>Esperando un operador…</span></span><button type="button">↩ Volver al asistente</button>';
  inputRow.parentNode.insertBefore(waitBar, inputRow);
  var waitBtn = waitBar.querySelector("button");
  waitBtn.addEventListener("click", function () {
    waitBtn.disabled = true;
    chat.cancelHandoff().then(function () { waitBtn.disabled = false; });
  });
  inputEl.setAttribute("enterkeyhint", "send");
  inputEl.setAttribute("autocapitalize", "sentences");

  // ── Protocolo ───────────────────────────────────────────────────────────────
  var chat = new ChatProtocol({
    apiBase: API_BASE,
    tenantId: TENANT_ID || "",
    sessionId: widgetSessionId,
    channel: "widget",
    // El widget-token es fijo (va en el <script>): no hay renovación posible.
    // Si el backend lo rechaza (revocado/vencido), el protocolo marca fatal.
    getToken: function () { return Promise.resolve(WIDGET_TOKEN); },
  });

  var started = false;
  var panelOpen = false;
  var atBottom = true;
  var lastServerCount = 0;
  var rows = new Map();        // id → fila renderizada
  var offerUI = new Map();     // id de oferta → { phase, sig }
  var chipsDismissed = false;
  var chipsEl = null, typingEl = null, fatalEl = null;

  function _isMobile() { return window.matchMedia("(max-width:640px)").matches; }
  function _lockBody(on) {
    var v = on ? "hidden" : "";
    document.documentElement.style.overflow = v;
    document.body.style.overflow = v;
    document.documentElement.style.overscrollBehavior = on ? "none" : "";
  }

  // ── Abrir / cerrar ──────────────────────────────────────────────────────────
  btn.addEventListener("click", function () {
    panel.classList.add("open");
    panelOpen = true;
    btn.style.display = "none";
    badge.style.display = "none";
    if (_isMobile()) _lockBody(true);
    if (!started) { started = true; chat.loadSectors(); chat.start(); }
    else chat.refresh();
    if (!_isMobile()) inputEl.focus();
    requestAnimationFrame(function () { _scrollBottom(); });
  });

  document.getElementById("ia-w-close").addEventListener("click", function () {
    if (panel.classList.contains("closing")) return;
    panel.classList.add("closing");
    setTimeout(function () {
      panel.classList.remove("open", "closing");
      panel.style.height = "";
      panel.style.transform = "";
      panelOpen = false;
      _lockBody(false);
      btn.style.display = "flex";
      btn.style.animation = "ia-fab-in .25s cubic-bezier(.16,1,.3,1)";
      setTimeout(function () { btn.style.animation = ""; }, 280);
    }, 200);
  });

  // Móvil: el panel sigue al viewport visible (teclado abre/cierra).
  if (window.visualViewport) {
    var _vv = window.visualViewport, _vvRaf = 0, _lastH = -1;
    var _syncViewport = function () {
      if (_vvRaf) return;
      _vvRaf = requestAnimationFrame(function () {
        _vvRaf = 0;
        if (window.innerWidth <= 640 && panel.classList.contains("open")) {
          var h = Math.round(_vv.height);
          if (h !== _lastH) { panel.style.height = h + "px"; _lastH = h; }
          panel.style.transform = "translateY(" + (_vv.offsetTop || 0) + "px)";
          if (atBottom) requestAnimationFrame(_scrollBottom);
        } else if (window.innerWidth > 640) {
          if (_lastH !== 0) { panel.style.height = ""; panel.style.transform = ""; _lastH = 0; }
        }
      });
    };
    _vv.addEventListener("resize", _syncViewport);
    _vv.addEventListener("scroll", _syncViewport);
    inputEl.addEventListener("focus", function () { setTimeout(_syncViewport, 100); setTimeout(_syncViewport, 350); });
    inputEl.addEventListener("blur", function () { setTimeout(_syncViewport, 100); });
  }

  // Volver a la pestaña: refrescar ya (sin abrir otro long-poll paralelo).
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && started) chat.refresh();
  });

  // ── Barra de escritura ──────────────────────────────────────────────────────
  function _onSubmit() {
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = ""; inputEl.style.height = "auto"; inputEl.style.overflowY = "hidden";
    _updateSendState();
    chat.send(text);   // sin deshabilitar el textarea: el teclado NO se cierra
    if (!_isMobile()) inputEl.focus();
  }
  sendBtn.addEventListener("click", _onSubmit);
  clipBtn.addEventListener("click", function () { if (!fileInput.disabled) fileInput.click(); });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) chat.uploadAttachment(fileInput.files[0]);
    fileInput.value = "";
  });
  inputEl.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 96) + "px";
    this.style.overflowY = this.scrollHeight > 96 ? "auto" : "hidden";
    _updateSendState();
    if (atBottom) _scrollBottom();
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _onSubmit(); }
  });
  function _updateSendState() {
    var st = chat.getState();
    var ready = !!st.conversationId && st.status !== "closed";
    sendBtn.disabled = !ready || !inputEl.value.trim();
    clipBtn.disabled = !ready;
  }
  newConvBtn.addEventListener("click", function () { chipsDismissed = false; chat.restart(); });
  newMsgsBtn.addEventListener("click", function () { _scrollBottom(); });

  // Auto-scroll inteligente: seguimos al final solo si el usuario ya estaba ahí.
  bodyEl.addEventListener("scroll", function () {
    var dist = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight;
    atBottom = dist < 100;
    if (atBottom) newMsgsBtn.classList.remove("on");
  });
  // Al scrollear con el dedo se guarda el teclado (como en las apps).
  bodyEl.addEventListener("touchmove", function () {
    if (document.activeElement === inputEl) inputEl.blur();
  }, { passive: true });
  function _scrollBottom() { bodyEl.scrollTop = bodyEl.scrollHeight; atBottom = true; newMsgsBtn.classList.remove("on"); }

  // ── Render ──────────────────────────────────────────────────────────────────
  chat.subscribe(_render);

  function _render(st) {
    _updateHeader(st);
    _renderFatal(st);
    var lastRow = _renderMessages(st);
    _renderChips(st, lastRow);
    _renderTyping(st, chipsEl || lastRow);
    _updateSendState();
    inputRow.classList.toggle("off", st.status === "closed");
    newConvBtn.classList.toggle("on", st.status === "closed");
    waitBar.classList.toggle("on", st.status === "handoff_requested");

    // Mensajes nuevos del servidor → scroll (si estaba abajo) o aviso, y badge si el panel está cerrado.
    var serverCount = 0, lastServer = null;
    for (var i = 0; i < st.messages.length; i++) { if (!st.messages[i].local) { serverCount++; lastServer = st.messages[i]; } }
    if (serverCount > lastServerCount) {
      var mine = lastServer && lastServer.role === "user";
      if (atBottom || mine) requestAnimationFrame(_scrollBottom);
      else newMsgsBtn.classList.add("on");
      if (!panelOpen && lastServer && (lastServer.role === "bot" || lastServer.role === "operator")) { badge.style.display = "flex"; badge.textContent = "!"; }
    }
    lastServerCount = serverCount;
  }

  function _renderFatal(st) {
    if (!st.fatal) { if (fatalEl) { fatalEl.remove(); fatalEl = null; } return; }
    if (fatalEl) return;
    fatalEl = document.createElement("div");
    fatalEl.className = "ia-w-fatal";
    var s = st.fatal.status;
    var txt = (s === 401) ? "El asistente no está disponible en este sitio en este momento."
      : (s === 403) ? "El asistente está pausado por el momento."
      : (s === 429) ? "Se alcanzó el límite de consultas por ahora. Esperá unos minutos."
      : "No pudimos conectar con el asistente. Revisá tu conexión e intentá de nuevo.";
    fatalEl.innerHTML = "<b></b><span></span>";
    fatalEl.querySelector("b").textContent = "No se pudo conectar";
    fatalEl.querySelector("span").textContent = txt;
    bodyInner.appendChild(fatalEl);
    inputRow.classList.add("off");
  }

  function _renderMessages(st) {
    var msgs = st.messages;
    var ids = new Set();
    var recycled = {};  // id del optimista → su fila (se reusa al confirmarse: sin parpadeo)
    // 1) quitar filas que ya no están
    rows.forEach(function (el, id) {
      var still = false;
      for (var i = 0; i < msgs.length; i++) if (msgs[i].id === id) { still = true; break; }
      if (!still) {
        rows.delete(id);
        if (id.indexOf("local-user") === 0) recycled[id] = el; else _disposeRow(el);
      }
    });
    // 2) crear/reordenar
    var prev = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i]; ids.add(m.id);
      var el = rows.get(m.id);
      if (!el) {
        var fromLocal = m.role === "user" && !m.local ? chat.confirmedLocal.get(m.id) : null;
        if (fromLocal && recycled[fromLocal]) {
          el = recycled[fromLocal]; delete recycled[fromLocal];
          var ub = el.querySelector(".ia-w-bubble"); if (ub) ub.classList.remove("ia-pending");
        } else {
          el = _buildRow(m, st);
        }
        rows.set(m.id, el);
      } else if (m.role === "system" && m.handoffOffer) {
        _syncOffer(el, m, st);
      }
      // agrupado: mismo remitente que el siguiente → sin avatar; que el anterior → menos margen
      var prevM = i > 0 ? msgs[i - 1] : null, nextM = i + 1 < msgs.length ? msgs[i + 1] : null;
      var special = m.handoffOffer || m.sectorNote || m.role === "error";
      var sameNext = !!nextM && nextM.role === m.role && !special && !nextM.handoffOffer && !nextM.sectorNote && !nextM.attachment;
      var samePrev = !!prevM && prevM.role === m.role && !special && !prevM.handoffOffer && !prevM.sectorNote;
      var av = el.querySelector(".ia-w-bavatar"); if (av) av.classList.toggle("ia-hidden", sameNext);
      el.classList.toggle("ia-grouped", samePrev);
      var ref = prev ? prev.nextSibling : bodyInner.firstChild;
      if (ref !== el) bodyInner.insertBefore(el, ref);
      prev = el;
    }
    Object.keys(recycled).forEach(function (k) { _disposeRow(recycled[k]); });
    return prev;
  }

  // Saca una fila del DOM y libera las imágenes/PDF que había bajado.
  function _disposeRow(el) {
    var blobs = el.querySelectorAll ? el.querySelectorAll("[data-blob]") : [];
    for (var i = 0; i < blobs.length; i++) { try { URL.revokeObjectURL(blobs[i].getAttribute("data-blob")); } catch (_e) {} }
    el.remove();
  }

  // Ubica `el` justo después de `anchor` SOLO si no está ya ahí: mover un nodo
  // reinicia su animación CSS (el "escribiendo" parpadeaba en cada render).
  function _placeAfter(el, anchor) {
    var target = anchor ? anchor.nextSibling : bodyInner.firstChild;
    if (target !== el) bodyInner.insertBefore(el, target);
  }

  function _avatarHTML(kind) {
    if (kind === "op") return '<div class="ia-w-bavatar op">' + ICON_USERCHECK + '</div>';
    return '<div class="ia-w-bavatar bot">' + (LOGO_URL ? '<img src="' + LOGO_URL + '" alt="" />' : ICON_BOT) + '</div>';
  }

  function _buildRow(m, st) {
    var row = document.createElement("div");
    row.__content = m.content;
    if (m.role === "user") {
      row.className = "ia-w-row user";
      var ub = document.createElement("div"); ub.className = "ia-w-bubble user" + (m.local ? " ia-pending" : "");
      if (m.attachment) _renderAttachment(m, ub); else _renderTextWithLinks(m.content, ub);
      row.appendChild(ub);
    } else if (m.role === "operator") {
      row.className = "ia-w-row";
      row.innerHTML = _avatarHTML("op");
      var owrap = document.createElement("div");
      var ob = document.createElement("div"); ob.className = "ia-w-bubble op";
      if (m.attachment) _renderAttachment(m, ob); else _renderTextWithLinks(m.content, ob);
      owrap.appendChild(ob);
      var oname = document.createElement("div"); oname.className = "ia-w-opname"; oname.textContent = st.operatorName || "Operador";
      owrap.appendChild(oname);
      row.appendChild(owrap);
    } else if (m.role === "error") {
      row.className = "ia-w-row center";
      var ec = document.createElement("div"); ec.className = "ia-w-errcard";
      ec.innerHTML = '<span class="ia-w-erricon">' + ICON_ALERT + '</span><span class="ia-w-errtxt"></span>';
      _renderTextWithLinks(m.content, ec.querySelector(".ia-w-errtxt"));
      if (m.retry) {
        var rb = document.createElement("button"); rb.className = "ia-w-errbtn"; rb.type = "button";
        rb.innerHTML = ICON_RETRY + "<span>Reintentar</span>";
        rb.addEventListener("click", function () { chat.dismissLocal(m.id); m.retry(); });
        ec.appendChild(rb);
      }
      row.appendChild(ec);
    } else if (m.role === "system" && m.sectorNote) {
      row.className = "ia-w-row center";
      var pill = document.createElement("div"); pill.className = "ia-w-sysnote";
      pill.innerHTML = ICON_TAG + "<span></span>";
      pill.querySelector("span").textContent = m.content;
      row.appendChild(pill);
    } else if (m.role === "system" && m.handoffOffer) {
      row.className = "ia-w-row";
      offerUI.set(m.id, { phase: "offer", sig: "" });
      _syncOffer(row, m, st);
    } else {
      row.className = "ia-w-row";
      row.innerHTML = _avatarHTML("bot");
      var bb = document.createElement("div"); bb.className = "ia-w-bubble bot";
      if (m.attachment) _renderAttachment(m, bb); else _renderTextWithLinks(m.content, bb);
      row.appendChild(bb);
    }
    return row;
  }

  // ── Oferta de derivación (offer → form → loader → resuelta) ────────────────
  function _syncOffer(row, m, st) {
    var ui = offerUI.get(m.id) || { phase: "offer", sig: "" };
    var resolved = st.status !== "bot_active";
    var sig = (resolved ? "resolved" : ui.phase) + "|" + st.afiliadoIdentified + "|" + st.sectors.length + "|" + (st.sectorChosen ? st.sectorId : "");
    if (sig === ui.sig) return;
    // Formulario ya abierto y la conversación sigue con el bot: no se redibuja
    // (antes llegaban los sectores o la píldora y se borraba el nombre/DNI tipeado).
    if (!resolved && ui.phase === "form" && ui.sig.indexOf("form|") === 0 && row.querySelector(".hf-nombre")) {
      ui.sig = sig; offerUI.set(m.id, ui);
      return;
    }
    ui.sig = sig; offerUI.set(m.id, ui);

    var inner;
    if (resolved) {
      inner = '<span class="ia-w-hf-txt"></span>' + (ui.phase === "dismissed" ? "" : '<span class="ia-w-hf-done">✓ Solicitud enviada</span>');
    } else if (ui.phase === "loading") {
      inner = '<span class="ia-w-hf-txt"></span><div class="ia-w-hf-loader">' + ICON_SPINNER + '<span>Buscando operador disponible…</span></div>';
    } else if (ui.phase === "form") {
      var sectorField = "";
      if (st.sectors.length > 1 && !st.sectorChosen) {
        var pre = st.sectors.find(function (s) { return s.is_default; }) || st.sectors[0];
        sectorField = '<div class="h">¿Con qué área querés hablar?</div><select id="ia-w-hf-sector" aria-label="Área que te va a atender">' +
          st.sectors.map(function (s) { return '<option value="' + _escape(s.id) + '"' + (pre && s.id === pre.id ? ' selected' : '') + '>' + _escape(s.nombre) + '</option>'; }).join("") + '</select>';
      }
      inner = '<span class="ia-w-hf-txt"></span><div class="ia-w-hf-form"><div class="t">Antes de conectarte con un operador</div>' +
        '<input type="text" class="hf-nombre" placeholder="Nombre y apellido" maxlength="200" autocomplete="name" autocapitalize="words" enterkeyhint="next" />' +
        '<input type="text" class="hf-dni" inputmode="numeric" placeholder="DNI (sin puntos)" maxlength="20" autocomplete="off" enterkeyhint="done" />' +
        sectorField + '<div class="err" style="display:none"></div>' +
        '<div class="actions"><button class="ia-w-hf-cta hf-submit" type="button" style="width:auto;padding:9px 20px;"><span>Continuar</span></button></div></div>';
    } else if (ui.phase === "dismissed") {
      inner = '<span class="ia-w-hf-txt"></span>';
    } else {
      inner = '<span class="ia-w-hf-txt"></span>' +
        '<button class="ia-w-hf-cta hf-offer" type="button">' + ICON_HEADSET + '<span>Conectarme con un operador</span></button>' +
        '<button class="ia-w-hf-keep hf-keep" type="button">Seguir con el asistente</button>';
    }
    row.innerHTML = _avatarHTML("bot") + '<div class="ia-w-bubble bot ia-w-hf">' + inner + '</div>';
    _renderTextWithLinks(m.content, row.querySelector(".ia-w-hf-txt"));

    var offerBtn = row.querySelector(".hf-offer");
    if (offerBtn) offerBtn.addEventListener("click", function () {
      if (chat.getState().afiliadoIdentified) _confirm(m.id, null);
      else { ui.phase = "form"; _syncOffer(row, m, chat.getState()); if (!_isMobile()) { var n = row.querySelector(".hf-nombre"); if (n) n.focus(); } }
    });
    var keepBtn = row.querySelector(".hf-keep");
    if (keepBtn) keepBtn.addEventListener("click", function () { ui.phase = "dismissed"; _syncOffer(row, m, chat.getState()); chat.dismissOffer(); });
    var submitBtn = row.querySelector(".hf-submit");
    if (submitBtn) {
      var doSubmit = function () {
        var n = row.querySelector(".hf-nombre").value.trim(), d = row.querySelector(".hf-dni").value.trim();
        var errEl = row.querySelector(".err");
        if (!n) { errEl.textContent = "Decinos tu nombre, por favor."; errEl.style.display = "block"; return; }
        if (!d) { errEl.textContent = "Decinos tu DNI, por favor."; errEl.style.display = "block"; return; }
        var sel = row.querySelector("#ia-w-hf-sector");
        _confirm(m.id, { afiliado_nombre: n, afiliado_dni: d, sector_id: sel ? sel.value : undefined });
      };
      submitBtn.addEventListener("click", doSubmit);
      row.querySelector(".hf-dni").addEventListener("keydown", function (e) { if (e.key === "Enter") doSubmit(); });
    }
  }

  function _confirm(offerId, identif) {
    var ui = offerUI.get(offerId); if (!ui) return;
    ui.phase = "loading";
    var row = rows.get(offerId); if (row) _syncOffer(row, chat.getState().messages.find(function (x) { return x.id === offerId; }), chat.getState());
    chat.confirmHandoff(identif || undefined).then(function (ok) {
      if (!ok) { ui.phase = "offer"; var r = rows.get(offerId); if (r) _syncOffer(r, chat.getState().messages.find(function (x) { return x.id === offerId; }), chat.getState()); }
    });
  }

  // ── Chips de área (bajo el saludo) ──────────────────────────────────────────
  function _renderChips(st, anchor) {
    var show = !!st.conversationId && st.messages.length > 0 && st.status === "bot_active"
      && st.sectorsLoaded && st.sectors.length > 1 && !st.sectorChosen && !chipsDismissed && !st.fatal;
    if (!show) { if (chipsEl) { chipsEl.remove(); chipsEl = null; } return; }
    if (!chipsEl) {
      chipsEl = document.createElement("div");
      chipsEl.className = "ia-w-chips";
      var hd = document.createElement("div"); hd.className = "hd"; hd.textContent = "¿Con qué área querés hablar?";
      var rowEl = document.createElement("div"); rowEl.className = "row";
      st.sectors.forEach(function (s) {
        var b = document.createElement("button"); b.type = "button"; b.className = "ia-w-chip"; b.textContent = s.nombre;
        b.addEventListener("click", function () {
          var all = rowEl.querySelectorAll("button"); for (var i = 0; i < all.length; i++) all[i].disabled = true;
          chat.setSector(s.id).then(function (ok) { if (!ok) for (var i = 0; i < all.length; i++) all[i].disabled = false; });
        });
        rowEl.appendChild(b);
      });
      var skip = document.createElement("button"); skip.type = "button"; skip.className = "ia-w-chip muted"; skip.textContent = "No importa";
      skip.addEventListener("click", function () { chipsDismissed = true; _render(chat.getState()); });
      rowEl.appendChild(skip);
      chipsEl.appendChild(hd); chipsEl.appendChild(rowEl);
    }
    _placeAfter(chipsEl, anchor);  // después del último mensaje
  }

  // ── "Escribiendo…" (señal del servidor o envío en vuelo) ────────────────────
  function _renderTyping(st, anchor) {
    var last = st.messages[st.messages.length - 1];
    var show = st.status === "bot_active" && (st.botTyping || st.sending > 0) && !(last && last.role === "bot");
    if (!show) { if (typingEl) { typingEl.remove(); typingEl = null; } return; }
    if (!typingEl) {
      typingEl = document.createElement("div");
      typingEl.className = "ia-w-row";
      typingEl.innerHTML = _avatarHTML("bot") + '<div class="ia-w-typing"><span></span><span></span><span></span></div>';
    }
    var wasPlaced = typingEl.parentNode === bodyInner;
    _placeAfter(typingEl, anchor);
    if (!wasPlaced && atBottom) _scrollBottom();
  }

  // ── Adjuntos (fetch autenticado del protocolo + object URL) ─────────────────
  function _renderAttachment(m, parentEl) {
    var attach = m.attachment; if (!attach || !attach.name) return;
    var url = chat.attachmentUrl(m.id); if (!url) return;
    var isImg = !!(attach.mime && attach.mime.indexOf("image/") === 0);
    var el;
    if (isImg) { el = document.createElement("img"); el.className = "ia-w-attach-img"; el.alt = attach.name; el.title = attach.name; }
    else { el = document.createElement("a"); el.className = "ia-w-attach-file"; el.href = "#"; el.innerHTML = ICON_CLIP + "<span>" + _escape(attach.name) + "</span>"; }
    parentEl.appendChild(el);
    chat.authFetch(url, {}, false)
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (blob) {
        if (!blob) return;
        var burl = URL.createObjectURL(blob);
        el.setAttribute("data-blob", burl);
        if (isImg) { el.src = burl; el.addEventListener("click", function () { window.open(burl, "_blank"); }); }
        else if (attach.mime === "application/pdf") { el.href = burl; el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener"); }
        else { el.href = burl; el.setAttribute("download", attach.name); }
      })
      .catch(function () {});
  }

  // ── Cabecera / estado ───────────────────────────────────────────────────────
  var _statusT1 = null, _statusT2 = null;
  function _setSubstatus(label) {
    if (substatusEl.textContent === label) return;
    var card = headerEl;
    substatusEl.style.opacity = "0";
    if (_statusT1) clearTimeout(_statusT1);
    if (_statusT2) clearTimeout(_statusT2);
    _statusT1 = setTimeout(function () {
      var w0 = card.offsetWidth;
      substatusEl.textContent = label;
      card.style.width = "";
      var w1 = card.offsetWidth;
      card.style.width = w0 + "px";
      void card.offsetWidth;
      card.style.width = w1 + "px";
      substatusEl.style.opacity = "1";
      _statusT2 = setTimeout(function () { card.style.width = ""; }, 440);
    }, 140);
  }

  function _updateHeader(st) {
    headerEl.classList.remove("handoff", "attending", "closed");
    var label;
    if (st.status === "handoff_requested") { headerEl.classList.add("handoff"); label = "Esperando operador…"; }
    else if (st.status === "human_attending") { headerEl.classList.add("attending"); label = st.operatorName ? ("Atendiéndote: " + st.operatorName) : "Operador conectado"; }
    else if (st.status === "closed") { headerEl.classList.add("closed"); label = "Conversación finalizada"; }
    else label = "En línea";
    _setSubstatus(label);
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

  // Links [etiqueta](url) + URLs sueltas dentro de un fragmento.
  function _appendLinks(text, parentEl) {
    MD_LINK_REGEX.lastIndex = 0;
    var last = 0, m;
    while ((m = MD_LINK_REGEX.exec(text)) !== null) {
      if (m.index > last) _appendPlainWithUrls(text.slice(last, m.index), parentEl);
      _appendAnchor(parentEl, m[2], m[1]);
      last = m.index + m[0].length;
    }
    if (last < text.length) _appendPlainWithUrls(text.slice(last), parentEl);
  }

  // Negrita **texto** → <strong>; el resto va por _appendLinks.
  function _appendInline(text, parentEl) {
    var BOLD = /\*\*([^*]+)\*\*/g;
    BOLD.lastIndex = 0;
    var last = 0, m;
    while ((m = BOLD.exec(text)) !== null) {
      if (m.index > last) _appendLinks(text.slice(last, m.index), parentEl);
      var strong = document.createElement("strong");
      _appendLinks(m[1], strong);
      parentEl.appendChild(strong);
      last = m.index + m[0].length;
    }
    if (last < text.length) _appendLinks(text.slice(last), parentEl);
  }

  // Render de Markdown básico (negrita, listas con -/*, saltos de línea) + links,
  // todo con DOM (seguro: nunca innerHTML con texto del LLM).
  function _renderTextWithLinks(text, parentEl) {
    var lines = String(text == null ? "" : text).split("\n");
    lines.forEach(function (line, i) {
      if (i > 0) parentEl.appendChild(document.createElement("br"));
      var bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) { parentEl.appendChild(document.createTextNode("• ")); line = bullet[1]; }
      _appendInline(line, parentEl);
    });
  }

  function _escape(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
