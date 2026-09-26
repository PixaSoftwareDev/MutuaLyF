"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Send, Bot, UserCheck, AlertTriangle, Paperclip, Headphones, RotateCcw, Tag, Check, ArrowDown, MessageSquarePlus } from "lucide-react";
import { FEEDBACK_UI_ENABLED } from "@/lib/features";
import { api, type TenantBranding } from "@/lib/api";
import { applyBrandingVars, readCachedBranding, writeCachedBranding } from "@/lib/use-tenant-branding";
import { renderWithLinks } from "@/lib/render-with-links";
import { getOrCreateSessionId, type ChatMessage, type ChatSector, type ChatProtocol } from "@/lib/chat-protocol";
import { useChatConversation } from "@/components/chat/use-chat-conversation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

/**
 * Pantalla del chat (la usan app/chat/page.tsx y app/chat/[tenant]/page.tsx —
 * Next no permite exportar otra cosa que la página desde un page.tsx).
 * `tenant` viene por prop desde la ruta del canal "Chat por link"
 * (/chat/[tenant]); sin prop se lee ?tenant= de la URL (compat y tester).
 *
 * Toda la lógica de conversación (token, start, poll, envío, adjuntos,
 * sector, derivación, feedback) vive en lib/chat-protocol.ts, compartida con
 * el widget embebido. Acá solo hay render y comportamiento de pantalla
 * (teclado, scroll, metadatos de app).
 */
export function ChatScreen({ tenant }: { tenant?: string }) {
  return (
    <Suspense fallback={
      <div className="h-screen flex items-center justify-center bg-muted/40">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    }>
      <ChatInner tenantOverride={tenant} />
    </Suspense>
  );
}

// ── Burbujas ──────────────────────────────────────────────────────────────────
// Texto 15 px (14 se lee chico a distancia de celular) y ancho hasta 85 %.
// `showAvatar`: en una seguidilla del mismo remitente, el avatar va solo en la
// última burbuja (agrupado, como en cualquier app de mensajes).

function BotAvatar({ hidden }: { hidden?: boolean }) {
  return (
    <div className={`relative h-8 w-8 shrink-0 ${hidden ? "invisible" : ""}`}>
      <div className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark">
        <Bot className="h-4 w-4 text-brand-foreground" />
      </div>
      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
    </div>
  );
}

function OperatorAvatar({ hidden }: { hidden?: boolean }) {
  return (
    <div className={`relative h-8 w-8 shrink-0 ${hidden ? "invisible" : ""}`}>
      <div className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-600">
        <UserCheck className="h-4 w-4 text-white" />
      </div>
      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
    </div>
  );
}

function BotBubble({ content, showAvatar = true, animate = true }: { content: string; showAvatar?: boolean; animate?: boolean }) {
  return (
    <div className={`flex items-end gap-2.5 ${animate ? "animate-fade-in-up" : ""}`}>
      <BotAvatar hidden={!showAvatar} />
      <div className="max-w-[85%] sm:max-w-[70%]">
        <div className="rounded-2xl rounded-bl-md bg-[#f4f5f7] px-4 py-2.5 text-[15px] leading-relaxed text-slate-800">
          {renderWithLinks(content)}
        </div>
      </div>
    </div>
  );
}

function UserBubble({ content, pending, animate = true }: { content: string; pending?: boolean; animate?: boolean }) {
  return (
    <div className={`flex justify-end ${animate ? "animate-fade-in-up" : ""}`}>
      <div className="max-w-[85%] sm:max-w-[70%]">
        <div className={`rounded-2xl rounded-br-md bg-gradient-to-br from-brand to-brand-dark px-4 py-2.5 text-[15px] leading-relaxed text-brand-foreground shadow-sm ${pending ? "opacity-80" : ""}`}>
          {renderWithLinks(content)}
        </div>
      </div>
    </div>
  );
}

function OperatorBubble({ content, operatorName, showAvatar = true }: { content: string; operatorName?: string | null; showAvatar?: boolean }) {
  return (
    <div className="flex items-end gap-2.5 animate-fade-in-up">
      <OperatorAvatar hidden={!showAvatar} />
      <div className="max-w-[85%] sm:max-w-[70%]">
        <div className="rounded-2xl rounded-bl-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-[15px] leading-relaxed text-slate-800">
          {renderWithLinks(content)}
        </div>
        {showAvatar && <p className="ml-1 mt-1 text-xs font-medium text-emerald-600">{operatorName || "Operador"}</p>}
      </div>
    </div>
  );
}

// Mensajes de sistema ("Listo, tu solicitud fue recibida…", avisos) salen
// como burbuja del bot: todo sale como un mensaje de quien escribe.
function SystemBubble({ content, showAvatar }: { content: string; showAvatar?: boolean }) {
  return <BotBubble content={content} showAvatar={showAvatar} />;
}

/** "Consulta dirigida al área X": píldora anclada en su lugar de la cronología. */
function SectorNotePill({ content }: { content: string }) {
  return (
    <div className="flex justify-center py-1 animate-fade-in-up">
      <span className="inline-flex max-w-[90%] items-center gap-1.5 rounded-full bg-slate-100 px-3.5 py-1.5 text-xs text-slate-500">
        <Tag className="h-3.5 w-3.5 shrink-0" />
        <span>{content}</span>
      </span>
    </div>
  );
}

/** Mismo avatar y misma burbuja gris que BotBubble: al reemplazarse por la
 *  respuesta no "salta" de forma. */
function TypingIndicator() {
  return (
    <div className="flex items-end gap-2.5 animate-fade-in-up">
      <BotAvatar />
      <div className="rounded-2xl rounded-bl-md bg-[#f4f5f7] px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
          <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
          <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

// Error como mini-card: círculo de ícono + texto. Opcional reintento.
function ErrorBubble({ content, onRetry }: { content: string; onRetry?: () => void }) {
  return (
    <div className="flex justify-center py-1 animate-fade-in-up">
      <div className="flex max-w-[92%] items-center gap-2.5 rounded-2xl bg-red-50 py-2 pl-2.5 pr-3.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <span className="text-[13px] leading-snug text-red-800">{content}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-red-600 shadow-sm transition-colors hover:bg-red-50 active:bg-red-100"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reintentar
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Adjunto dentro de la conversación (imagen inline o link de descarga).
 * Baja el archivo con el fetch autenticado del protocolo (renueva el token si
 * venció) y muestra "expiró" si la retención ya lo borró.
 */
function AttachmentMessage({ msg, url, fetcher, operatorName, showAvatar }: {
  msg: ChatMessage;
  url: string;
  fetcher: (url: string) => Promise<Response>;
  operatorName: string | null;
  showAvatar: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<"expired" | "failed" | null>(null);
  const isImage = (msg.attachment?.mime || "").startsWith("image/");
  const fromUser = msg.role === "user";

  useEffect(() => {
    let active = true;
    let created: string | null = null;
    fetcher(url)
      .then(r => {
        if (!r.ok) throw Object.assign(new Error("attachment_fetch_failed"), { status: r.status });
        return r.blob();
      })
      .then(b => {
        const u = URL.createObjectURL(b);
        if (active) { created = u; setSrc(u); } else URL.revokeObjectURL(u);
      })
      .catch((e: { status?: number }) => { if (active) setErr(e?.status === 410 ? "expired" : "failed"); });
    return () => { active = false; if (created) URL.revokeObjectURL(created); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const inner = err === "expired" ? (
    <span className="inline-flex items-center gap-1.5 text-xs opacity-70">
      <Paperclip className="h-3.5 w-3.5 shrink-0" />El archivo expiró y ya no está disponible
    </span>
  ) : err ? (
    <span className="text-xs opacity-70">No se pudo cargar el archivo</span>
  ) : !src ? (
    <span className="inline-flex items-center gap-1.5 text-xs opacity-70">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />{msg.attachment?.name}
    </span>
  ) : isImage ? (
    <img
      src={src}
      alt={msg.attachment?.name || "imagen"}
      onClick={() => window.open(src, "_blank")}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); window.open(src, "_blank"); } }}
      role="button"
      tabIndex={0}
      className="max-h-[240px] max-w-[240px] cursor-pointer rounded-xl"
    />
  ) : msg.attachment?.mime === "application/pdf" ? (
    <button
      type="button"
      onClick={() => window.open(src, "_blank")}
      className="inline-flex items-center gap-1.5 break-all text-left text-[15px] underline underline-offset-2"
      title="Ver documento"
    >
      <Paperclip className="h-4 w-4 shrink-0" />{msg.attachment?.name}
    </button>
  ) : (
    <a href={src} download={msg.attachment?.name} className="inline-flex items-center gap-1.5 break-all text-[15px] underline underline-offset-2">
      <Paperclip className="h-4 w-4 shrink-0" />{msg.attachment?.name}
    </a>
  );

  if (fromUser) {
    return (
      <div className="flex justify-end animate-fade-in-up">
        <div className="max-w-[85%] sm:max-w-[70%]">
          <div className="rounded-2xl rounded-br-md bg-gradient-to-br from-brand to-brand-dark px-3 py-2.5 text-brand-foreground shadow-sm">
            {inner}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-end gap-2.5 animate-fade-in-up">
      <OperatorAvatar hidden={!showAvatar} />
      <div className="max-w-[85%] sm:max-w-[70%]">
        <div className="rounded-2xl rounded-bl-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-slate-800">
          {inner}
        </div>
        {showAvatar && operatorName && <p className="ml-1 mt-1 text-xs font-medium text-emerald-600">{operatorName}</p>}
      </div>
    </div>
  );
}

// ── Feedback al cierre (caritas 1-3 + chips de causa) ────────────────────────
function FeedbackCard({ onSubmit, onDismiss, title = "¿Cómo estuvo tu consulta?" }: {
  onSubmit: (rating: number, reason: string | null) => void;
  onDismiss: () => void;
  title?: string;
}) {
  const [pendingRating, setPendingRating] = useState<number | null>(null);
  const FACES = [
    { v: 1, emoji: "😞", label: "Mal" },
    { v: 2, emoji: "😐", label: "Más o menos" },
    { v: 3, emoji: "😊", label: "Bien" },
  ];
  const CHIPS = [
    { key: "not_found",    label: "No encontré lo que buscaba" },
    { key: "wrong_info",   label: "La información era incorrecta" },
    { key: "slow_service", label: "Tardaron en atenderme" },
  ];
  const pick = (v: number) => (v === 3 ? onSubmit(3, null) : setPendingRating(v));

  return (
    <div className="flex justify-center animate-fade-in-up">
      <div className="relative w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-4 text-center shadow-sm">
        <button
          type="button" onClick={onDismiss} aria-label="Cerrar encuesta"
          className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-500"
        >
          ✕
        </button>
        {pendingRating === null ? (
          <>
            <p className="text-sm font-medium text-slate-700">{title}</p>
            <div className="mt-3 flex items-center justify-center gap-3">
              {FACES.map(f => (
                <button
                  key={f.v} type="button" onClick={() => pick(f.v)}
                  aria-label={f.label} title={f.label}
                  className="flex h-12 w-12 items-center justify-center rounded-full text-2xl transition-transform active:scale-95"
                >
                  {f.emoji}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-700">¿Qué fue lo que falló?</p>
            <div className="mt-3 flex flex-col gap-1.5">
              {CHIPS.map(c => (
                <button
                  key={c.key} type="button"
                  onClick={() => onSubmit(pendingRating, c.key)}
                  className="min-h-[44px] rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-slate-600 transition-colors active:bg-brand/5"
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button" onClick={() => onSubmit(pendingRating, null)}
                className="mt-0.5 min-h-[40px] text-xs text-slate-400 underline underline-offset-2"
              >
                Enviar sin detalle
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HandoffOfferBubble({
  content, onConfirm, confirmed, resolved, identified, sectors, preselectedSectorId, showAvatar,
}: {
  content: string;
  onConfirm: (identif?: { afiliado_nombre?: string; afiliado_dni?: string; sector_id?: string }) => void;
  confirmed: boolean;
  resolved: boolean;
  identified: boolean;
  sectors: ChatSector[];
  preselectedSectorId: string | null;
  showAvatar: boolean;
}) {
  const [phase, setPhase] = useState<"offer" | "identify">("offer");
  const [nombre, setNombre] = useState("");
  const [dni, setDni]       = useState("");
  const [sectorId, setSectorId] = useState<string>("");
  // Los sectores pueden llegar después de montar la tarjeta: sincronizar.
  useEffect(() => {
    if (sectorId) return;
    setSectorId(preselectedSectorId || sectors.find(s => s.is_default)?.id || sectors[0]?.id || "");
  }, [sectors, preselectedSectorId, sectorId]);
  // Si el afiliado elige área por chip DESPUÉS de que apareció la tarjeta, esa
  // elección manda (antes quedaba fijado el default y derivaba a otra cola).
  useEffect(() => {
    if (preselectedSectorId) setSectorId(preselectedSectorId);
  }, [preselectedSectorId]);
  const [err, setErr]       = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  function submit() {
    setErr(null);
    const n = nombre.trim();
    const d = dni.trim();
    if (!n) { setErr("Decinos tu nombre, por favor."); return; }
    if (!d) { setErr("Decinos tu DNI o número de documento, por favor."); return; }
    // El sector solo viaja si se eligió en ESTE formulario (select visible). Si
    // ya se eligió por chip, lo completa el protocolo con el del servidor.
    onConfirm({ afiliado_nombre: n, afiliado_dni: d, ...(askSector && sectorId ? { sector_id: sectorId } : {}) });
  }

  const askSector = sectors.length > 1 && !preselectedSectorId;
  const inputCls = "w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/25";
  const autoFocusDesktop = typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  return (
    <div className="flex items-end gap-2.5 animate-fade-in-up">
      <BotAvatar hidden={!showAvatar} />
      <div className="flex max-w-[88%] flex-col gap-3 rounded-2xl rounded-bl-md bg-[#f4f5f7] px-4 py-3">
        <p className="text-[15px] leading-relaxed text-slate-800">{renderWithLinks(content)}</p>
        {dismissed || resolved ? (
          resolved && !dismissed ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <Check className="h-3.5 w-3.5" />
              Solicitud enviada
            </span>
          ) : null
        ) : confirmed ? (
          <span className="inline-flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
            Buscando operador disponible…
          </span>
        ) : phase === "offer" ? (
          <>
            <button
              type="button"
              onClick={() => identified
                ? onConfirm(preselectedSectorId ? { sector_id: preselectedSectorId } : undefined)
                : setPhase("identify")}
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand to-brand-dark px-4 py-2.5 text-sm font-semibold text-brand-foreground shadow-sm transition-all active:scale-[0.98]"
            >
              <Headphones className="h-4 w-4" />
              Conectarme con un operador
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="min-h-[40px] self-center text-xs text-slate-400 transition-colors hover:text-slate-600"
            >
              Seguir con el asistente
            </button>
          </>
        ) : (
          <div className="flex flex-col gap-2.5 text-left">
            <p className="text-sm font-semibold text-slate-800">Antes de conectarte con un operador</p>
            <input type="text" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Nombre y apellido" maxLength={200} autoFocus={autoFocusDesktop} autoComplete="name" autoCapitalize="words" enterKeyHint="next" className={inputCls} />
            <input type="text" inputMode="numeric" value={dni} onChange={e => setDni(e.target.value)} placeholder="DNI (sin puntos)" maxLength={20} autoComplete="off" enterKeyHint="done" className={inputCls} onKeyDown={e => { if (e.key === "Enter") submit(); }} />
            {askSector && (
              <>
                <p className="text-xs text-slate-500">¿Con qué área querés hablar?</p>
                <select value={sectorId} onChange={e => setSectorId(e.target.value)} aria-label="Área que te va a atender" className={inputCls}>
                  {sectors.map(s => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
              </>
            )}
            {err && <p className="text-[12px] text-destructive">{err}</p>}
            <div className="flex justify-end pt-0.5">
              <button type="button" onClick={submit} className="min-h-[44px] rounded-xl bg-gradient-to-br from-brand to-brand-dark px-5 py-2 text-sm font-semibold text-brand-foreground shadow-sm transition-all active:scale-[0.98]">
                Continuar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Elección de área OPCIONAL, como chips bajo el saludo (sin scroll anidado,
 * con feedback táctil). La elección se persiste en el servidor y vuelve como
 * píldora en la cronología (SectorNotePill). "No importa" la oculta.
 */
function SectorChips({ sectors, onSelect, busy }: { sectors: ChatSector[]; onSelect: (s: ChatSector) => void; busy: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="flex items-end gap-2.5 animate-fade-in-up">
      <BotAvatar hidden />
      <div className="max-w-[92%]">
        <p className="mb-2 text-xs font-medium text-slate-500">¿Con qué área querés hablar?</p>
        <div className="flex flex-wrap gap-2">
          {sectors.map(s => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => onSelect(s)}
              className="min-h-[40px] rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-[14px] text-slate-700 shadow-sm transition-colors active:border-brand active:bg-brand/5 disabled:opacity-60"
            >
              {s.nombre}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="min-h-[40px] rounded-full px-3 py-1.5 text-[13px] text-slate-400 transition-colors active:bg-slate-100"
          >
            No importa
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Textos de error fatal ─────────────────────────────────────────────────────

function friendlyChatError(status: number | null, isTest: boolean): string {
  if (status === 401 || status === 403) {
    return isTest
      ? "No se pudo abrir el chat de prueba: tu sesión del panel no está activa o venció. Iniciá sesión en el panel y volvé a tocar «Probar chat»."
      : status === 403
        ? "Este chat no está disponible por el momento."
        : "El chat no está disponible en este momento. Recargá la página para intentar de nuevo.";
  }
  if (status === 429) return "Se alcanzó el límite de consultas por ahora. Esperá unos minutos e intentá de nuevo.";
  if (status !== null && status >= 500) return "El servicio está teniendo un problema temporal. Intentá de nuevo en unos minutos.";
  return "No pudimos conectar con el chat. Revisá tu conexión a internet e intentá de nuevo.";
}

// ── Alto real de la pantalla en el celular ────────────────────────────────────
// 100vh miente (barras del navegador) y ningún alto CSS sigue al teclado en
// iOS. Medimos el visual viewport y lo aplicamos al contenedor raíz (fixed):
// al abrir el teclado la pantalla se achica y la barra de escritura queda
// pegada a él. Mientras vive la pantalla, la página no scrollea (sin rebote
// ni pull-to-refresh). Solo `resize`: escuchar `scroll` peleaba con iOS.
function useMobileAppHeight(): { height: number | null; isDesktop: boolean } {
  const [height, setHeight] = useState<number | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    setIsDesktop(window.matchMedia("(hover: hover) and (pointer: fine)").matches);
    const vv = window.visualViewport;
    const update = () => {
      setHeight(Math.round(vv ? vv.height : window.innerHeight));
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    vv?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    const html = document.documentElement, body = document.body;
    const prev = [html.style.overscrollBehavior, body.style.overscrollBehavior, body.style.overflow];
    html.style.overscrollBehavior = "none";
    body.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    return () => {
      vv?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      [html.style.overscrollBehavior, body.style.overscrollBehavior, body.style.overflow] = prev;
    };
  }, []);
  return { height, isDesktop };
}

// ── Pantalla ──────────────────────────────────────────────────────────────────

function ChatInner({ tenantOverride }: { tenantOverride?: string }) {
  const params   = useSearchParams();
  const tenantId = tenantOverride || params.get("tenant") || "";
  // Modo prueba del panel: el token sale de la sesión del admin (mismo
  // origen); nada sensible en la URL.
  const isTest   = params.get("test") === "1";
  const missingKb      = isTest && params.get("kb") === "0";
  const missingSectors = isTest && params.get("sectors") === "0";

  // Branding: cache sincrónico en layout effect (evita flash e hidratación rota).
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  useLayoutEffect(() => {
    if (tenantId) setBranding(prev => prev ?? readCachedBranding(tenantId));
  }, [tenantId]);
  useEffect(() => {
    if (!tenantId) return;
    const cached = readCachedBranding(tenantId);
    if (cached) applyBrandingVars(cached);
    api.branding.get(tenantId)
      .then(b => { setBranding(b); applyBrandingVars(b); writeCachedBranding(tenantId, b); })
      .catch(() => { /* cache o defaults */ });
  }, [tenantId]);

  // Sesión por navegador (separada para el tester).
  const [sessionId, setSessionId] = useState("");
  useEffect(() => {
    if (!tenantId) return;
    setSessionId(getOrCreateSessionId("ia_chat_session_" + tenantId.slice(-8) + (isTest ? "_test" : "")));
  }, [tenantId, isTest]);

  // Token: público del canal link (respeta el interruptor) o del tester (sesión admin).
  const getToken = useCallback(async (): Promise<string> => {
    if (isTest) {
      try {
        const d = await api.tenants.chatTesterToken(tenantId);
        return d.widget_token;
      } catch (e) {
        const status = (e as { response?: { status?: number } })?.response?.status ?? null;
        throw Object.assign(new Error("tester_token_failed"), { status });
      }
    }
    // tenant_id por query: nginx pisa la cabecera X-Tenant-ID por host.
    const r = await fetch(`${API_BASE}/api/v1/public/chat-token?channel=link&tenant_id=${encodeURIComponent(tenantId)}`, { headers: { "X-Tenant-ID": tenantId } });
    if (!r.ok) throw Object.assign(new Error("chat_token_failed"), { status: r.status });
    return (await r.json()).widget_token as string;
  }, [tenantId, isTest]);

  const protocolOpts = useMemo(
    () => (tenantId && sessionId ? { apiBase: API_BASE, tenantId, sessionId, channel: (isTest ? "widget" : "link") as "widget" | "link", getToken } : null),
    [tenantId, sessionId, isTest, getToken],
  );
  const { chat, state } = useChatConversation(protocolOpts);

  const { height: appHeight, isDesktop } = useMobileAppHeight();

  // Volver a la app (pantalla bloqueada, otra app): snapshot ya, sin long-poll paralelo.
  useEffect(() => {
    if (!chat) return;
    const onVisible = () => { if (document.visibilityState === "visible") chat.refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [chat]);

  // Metadatos de app con el branding: theme-color + manifest/ícono (solo en el link público).
  useEffect(() => {
    if (!branding?.primary_color) return;
    const setMeta = (name: string, content: string) => {
      let m = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!m) { m = document.createElement("meta"); m.name = name; document.head.appendChild(m); }
      m.content = content;
    };
    const setLink = (rel: string, href: string) => {
      let l = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!l) { l = document.createElement("link"); l.rel = rel; document.head.appendChild(l); }
      l.href = href;
    };
    setMeta("theme-color", branding.primary_color);
    if (!tenantOverride) return;
    const appName = branding.bot_name || branding.display_name;
    const q = new URLSearchParams({ name: appName, color: branding.primary_color });
    if (branding.logo_url) q.set("icon", branding.logo_url);
    setLink("manifest", `/chat/${encodeURIComponent(tenantOverride)}/manifest.webmanifest?${q.toString()}`);
    setLink("apple-touch-icon", branding.logo_url || "/Logo.png");
    setMeta("apple-mobile-web-app-title", appName);
  }, [branding, tenantOverride]);

  // ── Estado derivado ────────────────────────────────────────────────────────
  const status = state?.status ?? "bot_active";
  const operatorName = state?.operatorName ?? null;
  const messages = state?.messages ?? [];
  const sectors = state?.sectors ?? [];
  const conversationId = state?.conversationId ?? null;

  const [handoffConfirmed, setHandoffConfirmed] = useState(false);
  const [feedbackDismissed, setFeedbackDismissed] = useState(false);
  const [feedbackThanks, setFeedbackThanks] = useState(false);
  const [sectorBusy, setSectorBusy] = useState(false);
  // Estado local por conversación: al renovar (410 / nueva consulta) se limpia.
  useEffect(() => { setHandoffConfirmed(false); setFeedbackDismissed(false); }, [conversationId]);
  useEffect(() => { if (status === "bot_active") setHandoffConfirmed(false); }, [status]);

  const statusLabel =
    status === "human_attending"    ? (operatorName ? `Atendiéndote: ${operatorName}` : "Operador conectado") :
    status === "handoff_requested"  ? "Esperando operador…" :
    status === "closed"             ? "Conversación finalizada" :
    "En línea";
  const statusDot =
    status === "human_attending"    ? "bg-success" :
    status === "handoff_requested"  ? "bg-warning animate-pulse" :
    status === "closed"             ? "bg-slate-300" :
    "bg-success animate-pulse";

  // Efecto "Dynamic Island" de la tarjeta de identidad al cambiar el estado.
  const idCardRef = useRef<HTMLDivElement>(null);
  const prevCardW = useRef<number | null>(null);
  useLayoutEffect(() => {
    const card = idCardRef.current;
    if (!card) return;
    const w1 = card.offsetWidth;
    const w0 = prevCardW.current;
    if (w0 != null && w0 !== w1) {
      card.style.width = `${w0}px`;
      void card.offsetWidth;
      card.style.width = `${w1}px`;
      const id = setTimeout(() => {
        if (idCardRef.current) { idCardRef.current.style.width = ""; prevCardW.current = idCardRef.current.offsetWidth; }
      }, 480);
      return () => clearTimeout(id);
    }
    prevCardW.current = w1;
  }, [statusLabel]);

  // ── Lista: auto-scroll inteligente ─────────────────────────────────────────
  // Solo seguimos al final si el usuario ya estaba ahí (o si el último mensaje
  // es suyo). Si está leyendo arriba, no lo arrastramos: aparece "↓ nuevos".
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const lastKeyRef = useRef<string>("");
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = dist < 120;
    if (atBottomRef.current) setUnseen(false);
  };
  const scrollToBottom = (smooth = true) => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setUnseen(false);
  };
  useEffect(() => {
    const last = messages[messages.length - 1];
    const key = last ? `${last.id}:${messages.length}:${state?.botTyping ? 1 : 0}` : "";
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const mine = last?.role === "user" || last?.role === "error";
    if (atBottomRef.current || mine) scrollToBottom(messages.length > 1);
    else setUnseen(true);
  }, [messages, state?.botTyping]);
  // Teclado abre/cierra o giro: el último mensaje sigue a la vista.
  useEffect(() => { if (appHeight && atBottomRef.current) scrollToBottom(false); }, [appHeight]);

  // ── Barra de escritura ─────────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isDesktop && conversationId) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isDesktop, conversationId]);
  const sendMessage = () => {
    const text = input.trim();
    if (!text || !chat || !conversationId) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    chat.send(text);
  };
  // Al scrollear la lista con el dedo, el teclado se guarda (como en las apps).
  const onListTouchMove = () => {
    if (document.activeElement === inputRef.current) inputRef.current?.blur();
  };

  const submitFeedback = async (rating: number, reason: string | null, targetConvId?: string) => {
    if (!chat) return;
    const ok = await chat.submitFeedback(rating, reason, targetConvId);
    if (ok) { setFeedbackThanks(true); setTimeout(() => setFeedbackThanks(false), 4000); }
  };

  const confirmHandoff = async (identif?: { afiliado_nombre?: string; afiliado_dni?: string; sector_id?: string }) => {
    if (!chat) return;
    setHandoffConfirmed(true);
    const ok = await chat.confirmHandoff(identif);
    if (!ok) setHandoffConfirmed(false);
  };

  const chooseSector = async (s: ChatSector) => {
    if (!chat) return;
    setSectorBusy(true);
    await chat.setSector(s.id);
    setSectorBusy(false);
  };

  // ── Error fatal ────────────────────────────────────────────────────────────
  if (!tenantId) {
    return <FatalScreen text="URL inválida. El chat requiere el parámetro ?tenant=TU_ORGANIZACION" />;
  }
  if (state?.fatal) {
    return <FatalScreen text={friendlyChatError(state.fatal.status, isTest)} />;
  }

  const botName = branding?.bot_name || branding?.display_name || "Asistente";
  const orgName = branding?.display_name || "tu organización";
  const showTyping = status === "bot_active" && (Boolean(state?.botTyping) || (state?.sending ?? 0) > 0)
    && messages[messages.length - 1]?.role !== "bot";
  const showSectorChips = Boolean(conversationId) && messages.length > 0 && status === "bot_active"
    && Boolean(state?.sectorsLoaded) && sectors.length > 1 && !state?.sectorChosen;
  const preselectedSectorId = state?.sectorChosen ? (state?.sectorId ?? null) : null;

  // ── Layout: tres bloques apilados (cabecera, lista, barra) ─────────────────
  // Nada flotante: al abrir el teclado la barra sube y la lista se achica de
  // forma exacta, sin superposiciones ni rellenos calculados a ojo.
  return (
    <div
      className="chat-app fixed inset-x-0 top-0 flex h-[100dvh] overflow-hidden bg-slate-100"
      style={appHeight ? { height: `${appHeight}px` } : undefined}
    >
      {/* Columna de bienvenida (solo desktop) */}
      <aside className="hidden w-[340px] shrink-0 flex-col justify-between p-10 lg:flex">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">¡Hola!</h1>
          <p className="mt-4 max-w-[250px] text-sm leading-relaxed text-slate-500">
            Estás en el chat de <span className="font-medium text-slate-700">{orgName}</span>.
            Escribinos tu consulta y {botName} te responde al instante.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className={`h-2 w-2 rounded-full ${statusDot}`} />
          <span>{statusLabel}</span>
        </div>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white lg:my-3 lg:mr-3 lg:rounded-3xl lg:border lg:border-slate-200/70 lg:shadow-sm">

        {/* Cabecera: barra de app en móvil (borde a borde, safe-area); tarjeta centrada en desktop */}
        <header className="z-10 shrink-0 border-b border-slate-200/80 bg-white pt-[env(safe-area-inset-top)] lg:border-0 lg:bg-transparent lg:pt-4">
          <div className="flex h-14 items-center px-3 lg:h-auto lg:justify-center lg:px-4">
            <div
              ref={idCardRef}
              className="flex items-center gap-3 overflow-hidden lg:rounded-2xl lg:border lg:border-slate-200/80 lg:bg-white lg:px-4 lg:py-2.5 lg:shadow-[0_4px_12px_-3px_rgba(0,0,0,0.10),0_1px_4px_-1px_rgba(0,0,0,0.06)] lg:transition-[width] lg:duration-[380ms] lg:ease-[cubic-bezier(0.34,1.4,0.5,1)]"
            >
              <div className="relative shrink-0">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark shadow-sm">
                  <Bot className="h-[18px] w-[18px] text-brand-foreground" />
                </div>
                <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${statusDot}`} />
              </div>
              <div className="min-w-0 pr-1 leading-tight">
                <p className="truncate text-[15px] font-semibold text-slate-900">{botName}</p>
                <p key={statusLabel} className="animate-fade-in truncate text-xs text-slate-500">{statusLabel}</p>
              </div>
            </div>
          </div>
        </header>

        {/* Lista de mensajes */}
        <div
          ref={listRef}
          onScroll={onListScroll}
          onTouchMove={onListTouchMove}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
          aria-live="polite"
        >
          <div className="mx-auto flex min-h-full max-w-2xl flex-col px-3 pb-3 pt-3 sm:px-6 lg:pt-16">
            <div className="flex-1" />
            {(missingKb || missingSectors) && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-900">
                <p className="mb-1 font-semibold">Modo prueba — a tu asistente todavía le falta configuración</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {missingKb && <li>No hay documentos en la base de conocimiento: va a responder solo con la descripción general de tu organización. Cargalos desde <b>Documentos</b> en el panel.</li>}
                  {missingSectors && <li>No hay sectores configurados: no va a poder derivar consultas a un operador. Crealos desde <b>Configuración</b> en el panel.</li>}
                </ul>
              </div>
            )}
            {messages.length === 0 && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            )}
            <div className="flex flex-col">
              {FEEDBACK_UI_ENABLED && state?.prevFeedbackConvId && (
                <div className="mb-4">
                  <FeedbackCard
                    title="¿Cómo estuvo tu consulta anterior?"
                    onSubmit={(rating, reason) => submitFeedback(rating, reason, state.prevFeedbackConvId!)}
                    onDismiss={() => chat?.clearPrevFeedback()}
                  />
                </div>
              )}
              {messages.map((m, i) => {
                const next = messages[i + 1];
                const sameNext = Boolean(next) && next.role === m.role && !next.handoffOffer && !next.sectorNote && !m.handoffOffer && !m.sectorNote && !next.attachment;
                const showAvatar = !sameNext;
                const gap = i === 0 ? "" : (messages[i - 1].role === m.role && !m.sectorNote && !messages[i - 1].sectorNote ? "mt-1" : "mt-4");
                let node: React.ReactNode;
                if (m.attachment && conversationId && chat) {
                  node = (
                    <AttachmentMessage
                      msg={m}
                      url={chat.attachmentUrl(m.id) || ""}
                      fetcher={(u) => chat.authFetch(u, {}, false)}
                      operatorName={operatorName}
                      showAvatar={showAvatar}
                    />
                  );
                } else if (m.role === "user") {
                  node = <UserBubble content={m.content} pending={Boolean(m.local)} animate={Boolean(m.local)} />;
                } else if (m.role === "operator") {
                  node = <OperatorBubble content={m.content} operatorName={operatorName} showAvatar={showAvatar} />;
                } else if (m.role === "error") {
                  node = <ErrorBubble content={m.content} onRetry={m.retry ? () => { chat?.dismissLocal(m.id); m.retry?.(); } : undefined} />;
                } else if (m.role === "system" && m.sectorNote) {
                  node = <SectorNotePill content={m.content} />;
                } else if (m.role === "system" && m.handoffOffer) {
                  node = (
                    <HandoffOfferBubble
                      content={m.content}
                      onConfirm={confirmHandoff}
                      confirmed={handoffConfirmed}
                      resolved={status !== "bot_active"}
                      identified={Boolean(state?.afiliadoIdentified)}
                      sectors={sectors}
                      preselectedSectorId={preselectedSectorId}
                      showAvatar={showAvatar}
                    />
                  );
                } else if (m.role === "system") {
                  node = <SystemBubble content={m.content} showAvatar={showAvatar} />;
                } else {
                  node = <BotBubble content={m.content} showAvatar={showAvatar} animate={i === messages.length - 1} />;
                }
                return <div key={m.id} className={gap}>{node}</div>;
              })}
              {showSectorChips && (
                <div className="mt-4"><SectorChips sectors={sectors} onSelect={chooseSector} busy={sectorBusy} /></div>
              )}
              {showTyping && <div className="mt-4"><TypingIndicator /></div>}
              {FEEDBACK_UI_ENABLED && conversationId && status === "closed" && !state?.feedbackGiven && !feedbackDismissed && (
                <div className="mt-4"><FeedbackCard onSubmit={submitFeedback} onDismiss={() => setFeedbackDismissed(true)} /></div>
              )}
              {feedbackThanks && (
                <div className="mt-4 flex justify-center animate-fade-in-up">
                  <span className="rounded-full bg-slate-100 px-4 py-1.5 text-xs text-slate-500">¡Gracias por tu opinión! Nos ayuda a mejorar.</span>
                </div>
              )}
            </div>
            <div ref={bottomRef} className="h-px" />
          </div>

          {unseen && (
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className="sticky bottom-3 left-1/2 z-10 -translate-x-1/2 inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-900/85 px-3.5 text-xs font-medium text-white shadow-md backdrop-blur animate-fade-in-up"
            >
              <ArrowDown className="h-3.5 w-3.5" /> Mensajes nuevos
            </button>
          )}
        </div>

        {/* Barra de escritura: pegada al teclado en móvil (borde a borde), píldora en desktop */}
        <div className="shrink-0 border-t border-slate-200/80 bg-white px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 lg:border-0 lg:bg-transparent lg:px-4 lg:pb-5 lg:pt-0">
          {status === "closed" ? (
            <div className="mx-auto flex max-w-2xl justify-center">
              <button
                type="button"
                onClick={() => chat?.restart()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-gradient-to-br from-brand to-brand-dark px-5 text-sm font-semibold text-brand-foreground shadow-sm active:scale-[0.98]"
              >
                <MessageSquarePlus className="h-4 w-4" /> Nueva consulta
              </button>
            </div>
          ) : (
            <div className="mx-auto flex max-w-2xl items-end gap-1 rounded-[24px] bg-slate-100 p-1 transition-colors focus-within:bg-slate-100 lg:border lg:border-transparent lg:bg-slate-100 lg:shadow-sm lg:focus-within:bg-white lg:focus-within:ring-2 lg:focus-within:ring-brand/25">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp,application/pdf"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f && chat) chat.uploadAttachment(f); e.target.value = ""; }}
              />
              {/* Con texto escrito, el clip cede el lugar al botón Enviar (patrón de mensajería). */}
              {!input.trim() && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!conversationId}
                  aria-label="Adjuntar imagen o PDF"
                  title="Adjuntar imagen o PDF"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors active:bg-slate-200 disabled:opacity-50"
                >
                  <Paperclip className="h-[19px] w-[19px]" />
                </button>
              )}
              <textarea
                ref={inputRef}
                rows={1}
                {...({ enterKeyHint: "send" } as Record<string, string>)}
                autoComplete="off"
                autoCapitalize="sentences"
                className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none bg-transparent px-2 py-[10px] text-base leading-6 text-slate-900 placeholder:text-slate-400 outline-none disabled:opacity-60"
                placeholder={conversationId ? "Escribí un mensaje…" : "Conectando…"}
                disabled={!conversationId}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
                }}
                onKeyDown={e => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  sendMessage();
                }}
              />
              {input.trim() && (
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={!conversationId}
                  aria-label="Enviar mensaje"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-dark text-brand-foreground shadow-sm transition-all active:scale-95 disabled:opacity-40 animate-fade-in"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FatalScreen({ text }: { text: string }) {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-3 rounded-xl border bg-card p-8 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
        <h2 className="text-lg font-semibold text-foreground">No se pudo conectar</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
