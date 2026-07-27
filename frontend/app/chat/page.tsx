"use client";

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2, Send, Bot, UserCheck, AlertTriangle, Paperclip, Headphones, RotateCcw, Tag } from "lucide-react";
import { api, type TenantBranding } from "@/lib/api";
import { applyBrandingVars, readCachedBranding, writeCachedBranding } from "@/lib/use-tenant-branding";
import { renderWithLinks } from "@/lib/render-with-links";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface Sector { id: string; nombre: string; descripcion: string | null; is_default: boolean; }
interface Message {
  id: string;
  role: "user" | "bot" | "operator" | "system" | "error";
  content: string;
  handoffOffer?: boolean;
  attachment?: { name: string; mime: string } | null;
}

export default function ChatPage() {
  return (
    <Suspense fallback={
      <div className="h-screen flex items-center justify-center bg-muted/40">
        {/* Spinner NEUTRO a propósito: el avatar con gradient de marca dependía del
            branding (que aún no cargó) y el ícono parpadeaba violeta + trazo negro
            antes de aplicar el color. Gris fijo = cero flash en el arranque. */}
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    }>
      <ChatInner />
    </Suspense>
  );
}

// ── Bubble components ──────────────────────────────────────────────────────────

function BotBubble({ content }: { content: string }) {
  return (
    <div className="flex gap-3 items-end group animate-fade-in-up">
      <div className="relative w-8 h-8 shrink-0">
        <div className="w-full h-full rounded-full bg-gradient-to-br from-brand-light to-brand-dark flex items-center justify-center">
          <Bot className="h-4 w-4 text-brand-foreground" />
        </div>
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-white" />
      </div>
      <div className="max-w-[78%] sm:max-w-[65%]">
        <div className="bg-[#f4f5f7] text-slate-800 rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed">
          {renderWithLinks(content)}
        </div>
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end animate-fade-in-up">
      <div className="max-w-[78%] sm:max-w-[65%]">
        <div className="bg-gradient-to-br from-brand to-brand-dark text-brand-foreground rounded-2xl rounded-br-md px-4 py-3 text-sm leading-relaxed shadow-sm">
          {renderWithLinks(content)}
        </div>
      </div>
    </div>
  );
}

/**
 * Adjunto dentro de la conversación (imagen inline o link de descarga).
 * Baja el archivo con fetch + headers de auth (un <img src> directo no puede
 * mandar el Bearer) y muestra "expiró" si la retención de 60 días ya lo borró.
 */
function AttachmentMessage({ msg, url, headers, operatorName }: {
  msg: Message;
  url: string;
  headers: Record<string, string>;
  operatorName: string | null;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<"expired" | "failed" | null>(null);
  const isImage = (msg.attachment?.mime || "").startsWith("image/");
  const fromUser = msg.role === "user";

  useEffect(() => {
    let active = true;
    let created: string | null = null;
    fetch(url, { headers })
      .then(r => {
        if (!r.ok) throw Object.assign(new Error("attachment_fetch_failed"), { status: r.status });
        return r.blob();
      })
      .then(b => {
        const u = URL.createObjectURL(b);
        if (active) { created = u; setSrc(u); } else URL.revokeObjectURL(u);
      })
      .catch((e: any) => { if (active) setErr(e?.status === 410 ? "expired" : "failed"); });
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
      className="max-w-[220px] max-h-[220px] rounded-xl cursor-pointer"
    />
  ) : msg.attachment?.mime === "application/pdf" ? (
    // Vista previa: el blob URL abre en el visor de PDF del navegador (en móvil,
    // el visor nativo). La descarga queda disponible desde ese mismo visor.
    <button
      type="button"
      onClick={() => window.open(src, "_blank")}
      className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2 break-all text-left"
      title="Ver documento"
    >
      <Paperclip className="h-4 w-4 shrink-0" />{msg.attachment?.name}
    </button>
  ) : (
    <a href={src} download={msg.attachment?.name} className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2 break-all">
      <Paperclip className="h-4 w-4 shrink-0" />{msg.attachment?.name}
    </a>
  );

  if (fromUser) {
    return (
      <div className="flex justify-end animate-fade-in-up">
        <div className="max-w-[78%] sm:max-w-[65%]">
          <div className="bg-gradient-to-br from-brand to-brand-dark text-brand-foreground rounded-2xl rounded-br-md px-3 py-2.5 shadow-sm">
            {inner}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3 items-end animate-fade-in-up">
      <div className="relative w-8 h-8 shrink-0">
        <div className="w-full h-full rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center">
          <UserCheck className="h-4 w-4 text-white" />
        </div>
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-white" />
      </div>
      <div className="max-w-[78%] sm:max-w-[65%]">
        {operatorName && <p className="text-[11px] text-muted-foreground mb-1 ml-1">{operatorName}</p>}
        <div className="bg-emerald-50 text-slate-800 rounded-2xl rounded-bl-md px-3 py-2.5 border border-emerald-200">
          {inner}
        </div>
      </div>
    </div>
  );
}

function OperatorBubble({ content, operatorName }: { content: string; operatorName?: string | null }) {
  return (
    <div className="flex gap-3 items-end animate-fade-in-up">
      <div className="relative w-8 h-8 shrink-0">
        <div className="w-full h-full rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center">
          <UserCheck className="h-4 w-4 text-white" />
        </div>
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-white" />
      </div>
      <div className="max-w-[78%] sm:max-w-[65%]">
        <div className="bg-emerald-50 text-slate-800 rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed border border-emerald-200">
          {renderWithLinks(content)}
        </div>
        <p className="text-xs text-emerald-600 mt-1 ml-1 font-medium">{operatorName || "Operador"}</p>
      </div>
    </div>
  );
}

// ── Feedback al cierre (caritas 1-3 + chips de causa) ────────────────────────
// 😊 envía directo; 😞/😐 abren chips opcionales de causa (un tap) con la
// opción de omitir. Descartable con la X — no perseguimos al que no quiere
// opinar. Sin campos de texto: en el celular nadie tipea encuestas.
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
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-500"
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
                  className="flex h-12 w-12 items-center justify-center rounded-full text-2xl transition-transform hover:scale-110 hover:bg-slate-50 active:scale-95"
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
                  className="rounded-xl border border-slate-200 px-3 py-2 text-[13px] text-slate-600 transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-slate-900"
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button" onClick={() => onSubmit(pendingRating, null)}
                className="mt-0.5 text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
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

function SystemBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-center py-1 animate-fade-in-up">
      <span className="inline-flex max-w-[90%] items-center rounded-full bg-slate-100 px-3.5 py-1.5 text-xs leading-snug text-slate-500">
        {renderWithLinks(content)}
      </span>
    </div>
  );
}

// Error como mini-card (sin borde duro): círculo de ícono + texto. Opcional retry.
function ErrorBubble({ content, onRetry }: { content: string; onRetry?: () => void }) {
  return (
    <div className="flex justify-center py-1 animate-fade-in-up">
      <div className="flex max-w-[92%] items-center gap-2.5 rounded-2xl bg-red-50 py-2 pl-2.5 pr-3.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <span className="text-[12.5px] leading-snug text-red-800">{content}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-red-600 shadow-sm transition-colors hover:bg-red-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reintentar
          </button>
        )}
      </div>
    </div>
  );
}

function HandoffOfferBubble({
  content,
  onConfirm,
  confirmed,
  identified,
  sectors,
  preselectedSectorId,
}: {
  content: string;
  onConfirm: (identif?: { afiliado_nombre?: string; afiliado_dni?: string; sector_id?: string }) => void;
  confirmed: boolean;
  identified: boolean;
  sectors: Sector[];
  preselectedSectorId: string | null;
}) {
  // 3 estados: "offer" (botón inicial) → "identify" (form) → confirmed (loader)
  const [phase, setPhase] = useState<"offer" | "identify">("offer");
  const [nombre, setNombre] = useState("");
  const [dni, setDni]       = useState("");
  // El sector se decide acá — el momento en que importa de verdad (define la
  // cola de operadores). Pre-seleccionado: el elegido antes por chip, o el default.
  const [sectorId, setSectorId] = useState<string>(
    preselectedSectorId || sectors.find(s => s.is_default)?.id || sectors[0]?.id || ""
  );
  const [err, setErr]       = useState<string | null>(null);

  function submit() {
    setErr(null);
    const n = nombre.trim();
    const d = dni.trim();
    if (!n) { setErr("Decinos tu nombre, por favor."); return; }
    if (!d) { setErr("Decinos tu DNI o número de documento, por favor."); return; }
    // Sin mínimo de longitud: es un identificador para que el operador te reconozca,
    // no una credencial. Documentos cortos, provisorios o extranjeros son válidos.
    onConfirm({
      afiliado_nombre: n,
      afiliado_dni: d,
      ...(sectors.length > 1 && sectorId ? { sector_id: sectorId } : {}),
    });
  }

  const [dismissed, setDismissed] = useState(false);
  // El área solo se pregunta acá si NO se eligió antes (en la lista bajo el saludo).
  const askSector = sectors.length > 1 && !preselectedSectorId;
  const inputCls = "w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/25";

  return (
    // Formato burbuja: avatar del bot + burbuja gris con la acción adentro.
    <div className="flex items-end gap-3 animate-fade-in-up">
      <div className="relative h-8 w-8 shrink-0">
        <div className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark">
          <Bot className="h-4 w-4 text-brand-foreground" />
        </div>
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
      </div>
      <div className="flex max-w-[85%] flex-col gap-3 rounded-2xl rounded-bl-md bg-[#f4f5f7] px-4 py-3">
        <p className="text-sm leading-relaxed text-slate-800">{renderWithLinks(content)}</p>
        {dismissed ? null : confirmed ? (
          <span className="inline-flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
            Buscando operador disponible…
          </span>
        ) : phase === "offer" ? (
          <>
            <button
              onClick={() => identified
                ? onConfirm(preselectedSectorId ? { sector_id: preselectedSectorId } : undefined)
                : setPhase("identify")}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand to-brand-dark px-4 py-2.5 text-sm font-semibold text-brand-foreground shadow-sm transition-all hover:brightness-105 active:scale-95"
            >
              <Headphones className="h-4 w-4" />
              Conectarme con un operador
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="self-center text-xs text-slate-400 transition-colors hover:text-slate-600"
            >
              Seguir con el asistente
            </button>
          </>
        ) : (
          <div className="flex flex-col gap-2.5 text-left">
            <p className="text-sm font-semibold text-slate-800">Antes de conectarte con un operador</p>
            <input type="text" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Nombre y apellido" maxLength={200} autoFocus className={inputCls} />
            <input type="text" inputMode="numeric" value={dni} onChange={e => setDni(e.target.value)} placeholder="DNI (sin puntos)" maxLength={20} className={inputCls} onKeyDown={e => { if (e.key === "Enter") submit(); }} />
            {askSector && (
              <>
                <p className="text-xs text-slate-500">¿Con qué área querés hablar?</p>
                <select value={sectorId} onChange={e => setSectorId(e.target.value)} aria-label="Área que te va a atender" className={inputCls}>
                  {sectors.map(s => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
              </>
            )}
            {err && <p className="text-[11px] text-destructive">{err}</p>}
            <div className="flex justify-end pt-0.5">
              <button onClick={submit} className="rounded-xl bg-gradient-to-br from-brand to-brand-dark px-5 py-2 text-sm font-semibold text-brand-foreground shadow-sm transition-all hover:brightness-105 active:scale-95">
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
 * Elección de área OPCIONAL, dentro de la conversación (no como pantalla previa):
 * chip discreto → lista vertical → pill de confirmación. El sector no cambia lo
 * que responde el bot; solo define qué equipo atiende si se deriva a un humano.
 */
function SectorChooser({ sectors, selected, onSelect }: {
  sectors: Sector[];
  selected: Sector | null;
  onSelect: (s: Sector) => void;
}) {
  // Sin globito: la lista aparece directa. "No importa" descarta (queda en general).
  const [dismissed, setDismissed] = useState(false);

  if (selected) {
    return (
      <div className="flex justify-center py-1 animate-fade-in-up">
        <span className="inline-flex max-w-[90%] items-center gap-1.5 rounded-full bg-slate-100 px-3.5 py-1.5 text-xs text-slate-500">
          <Tag className="h-3.5 w-3.5 shrink-0" />
          <span>Consulta dirigida al área <span className="font-semibold text-slate-700">{selected.nombre}</span></span>
        </span>
      </div>
    );
  }
  if (dismissed) return null;

  return (
    <div className="flex justify-center animate-fade-in-up">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border bg-card shadow-md">
        <p className="border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
          ¿Con qué área querés hablar?
        </p>
        <div className="max-h-64 overflow-y-auto">
          {sectors.map(s => (
            <button
              key={s.id}
              onClick={() => onSelect(s)}
              className="block w-full border-b px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand/5 hover:text-brand"
            >
              {s.nombre}
            </button>
          ))}
          <button
            onClick={() => setDismissed(true)}
            className="block w-full px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
          >
            No importa, sigo con el asistente
          </button>
        </div>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-3 items-end animate-fade-in-up">
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-light to-brand-dark flex items-center justify-center shrink-0 shadow-md shadow-black/20">
        <Bot className="h-4 w-4 text-brand-foreground" />
      </div>
      <div className="bg-white rounded-2xl rounded-bl-sm px-5 py-4 shadow-sm border border-slate-100">
        <div className="flex gap-1.5 items-center">
          <span className="w-2 h-2 rounded-full bg-brand-light animate-bounce [animation-delay:0ms]" />
          <span className="w-2 h-2 rounded-full bg-brand-light animate-bounce [animation-delay:150ms]" />
          <span className="w-2 h-2 rounded-full bg-brand-light animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Traduce un fallo al iniciar/usar el chat a un mensaje que el usuario pueda
 * accionar. Nunca mostramos "HTTP 401" crudo: el caso más común es que el
 * token del tester fue revocado (cada "Probar chat" genera uno nuevo y mata
 * los anteriores) y eso tiene solución conocida — reabrir desde el panel.
 */
function friendlyChatError(status: number | null, isTest: boolean): string {
  if (status === 401 || status === 403) {
    return isTest
      ? "Este link de prueba ya no es válido: cada vez que abrís «Probar chat» se genera un link nuevo y los anteriores se desactivan. Cerrá esta pestaña y volvé a abrirlo desde el panel."
      : "El chat no está disponible en este momento. Recargá la página para intentar de nuevo.";
  }
  if (status === 429) return "Se alcanzó el límite de consultas por ahora. Esperá unos minutos e intentá de nuevo.";
  if (status !== null && status >= 500) return "El servicio está teniendo un problema temporal. Intentá de nuevo en unos minutos.";
  return "No pudimos conectar con el chat. Revisá tu conexión a internet e intentá de nuevo.";
}

function ChatInner() {
  const params   = useSearchParams();
  const token    = params.get("token") || "";
  const tenantId = params.get("tenant") || "";
  const isTest   = params.get("test") === "1";
  // Flags de completitud que setea el panel admin al abrir "Probar chat":
  // el tester avisa qué falta (docs/sectores) para que una prueba "vacía"
  // no parezca un error del bot.
  const missingKb      = isTest && params.get("kb") === "0";
  const missingSectors = isTest && params.get("sectors") === "0";

  const [sectors, setSectors]               = useState<Sector[]>([]);
  // El branding arranca null y el cache se lee en useLayoutEffect (post-mount,
  // pre-paint). Leerlo en el initializer del useState rompía la hidratación:
  // el SSR no tiene localStorage y renderizaba "Asistente" mientras el cliente
  // renderizaba el bot_name cacheado → "Text content does not match". Con el
  // layout effect no hay flash visible (corre antes del primer paint) y el
  // HTML del server y del cliente coinciden.
  const [branding, setBranding]             = useState<TenantBranding | null>(null);
  useLayoutEffect(() => {
    if (tenantId) setBranding(prev => prev ?? readCachedBranding(tenantId));
  }, [tenantId]);
  const [sectorsLoading, setSectorsLoading] = useState(true);
  const [selectedSector, setSelectedSector] = useState<Sector | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages]             = useState<Message[]>([]);
  const [input, setInput]                   = useState("");
  const [sending, setSending]               = useState(false);
  const [status, setStatus]                 = useState("bot_active");
  const [operatorName, setOperatorName]     = useState<string | null>(null);
  const [error, setError]                   = useState<string | null>(null);
  const [resolvedToken, setResolvedToken]   = useState(token);
  const [operatorsOnline, setOperatorsOnline] = useState<{ count: number; names: string[] } | null>(null);
  const [handoffConfirmed, setHandoffConfirmed] = useState(false);
  const [afiliadoIdentified, setAfiliadoIdentified] = useState(false);
  // Feedback al cierre (caritas 1-3). feedbackGiven viene del poll; dismissed
  // es local (si lo cierra sin votar, no lo perseguimos en esta sesión).
  const [feedbackGiven, setFeedbackGiven] = useState(false);
  const [feedbackDismissed, setFeedbackDismissed] = useState(false);
  const [feedbackThanks, setFeedbackThanks] = useState(false);
  // Conversación ANTERIOR cerrada sin calificar (viene de /start) — reapertura
  const [prevFeedbackConvId, setPrevFeedbackConvId] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile]   = useState(false);
  const bottomRef                           = useRef<HTMLDivElement>(null);
  const inputRef                            = useRef<HTMLInputElement>(null);
  const fileInputRef                        = useRef<HTMLInputElement>(null);
  const sessionId                           = useRef<string>("");
  const pollTimeoutRef                      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAliveRef                        = useRef<boolean>(false);
  const lastMessageIdRef                    = useRef<string | null>(null);
  // Cada call a startPolling incrementa esta version. Si un loop viejo
  // dispara su proximo tick despues de que arrancamos uno nuevo, lo detecta
  // por version mismatch y termina sin hacer fetch. Sin esto, al renovar
  // una conv cerrada podian quedar dos loops corriendo en paralelo.
  const pollVersionRef                      = useRef<number>(0);

  useEffect(() => {
    const key = "ia_chat_session_" + (token || tenantId).slice(-8);
    const stored = localStorage.getItem(key);
    if (stored) { sessionId.current = stored; }
    else {
      const id = "cs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
      localStorage.setItem(key, id);
      sessionId.current = id;
    }
  }, [token, tenantId]);

  useEffect(() => {
    if (token) { setResolvedToken(token); return; }
    if (!tenantId) {
      setError("URL inválida. El chat requiere el parámetro ?tenant=TU_ORGANIZACION");
      setSectorsLoading(false);
      return;
    }
    fetch(`${API_BASE}/api/v1/public/chat-token`, { headers: { "X-Tenant-ID": tenantId } })
      .then(r => { if (!r.ok) throw Object.assign(new Error("chat_token_failed"), { status: r.status }); return r.json(); })
      .then(data => setResolvedToken(data.widget_token))
      .catch((e: { status?: number }) => {
        setError(friendlyChatError(e?.status ?? null, isTest));
        setSectorsLoading(false);
      });
  }, [token, tenantId]);

  // Load tenant branding (public endpoint) + apply CSS variables.
  // Si el cache sincronico ya nos dio un branding inicial, igual revalidamos
  // contra el server por si cambio (logo, color). Guardamos lo fresco al cache
  // para el proximo refresh.
  useEffect(() => {
    if (!tenantId) return;
    const cached = readCachedBranding(tenantId);
    if (cached) applyBrandingVars(cached);
    api.branding.get(tenantId)
      .then(b => {
        setBranding(b);
        applyBrandingVars(b);
        writeCachedBranding(tenantId, b);
      })
      .catch(() => { /* keep cached or generic defaults */ });
  }, [tenantId]);

  useEffect(() => {
    if (!resolvedToken) return;
    fetch(`${API_BASE}/api/v1/widget/sectors`, {
      headers: { Authorization: `Bearer ${resolvedToken}`, "X-Tenant-ID": tenantId },
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { sectors: Sector[]; greeting_message: string | null }) => {
        setSectors(data.sectors);
        setSectorsLoading(false);
      })
      // Sectores son opcionales ahora (solo importan al derivar) — un fallo acá
      // no bloquea el chat.
      .catch(() => setSectorsLoading(false));
  }, [resolvedToken, tenantId]);

  // Arranque directo en conversación: sin pantalla de selección de área. El
  // saludo llega como primer mensaje del bot (persistido en DB, viene por poll).
  const startedRef = useRef(false);
  useEffect(() => {
    if (!resolvedToken || startedRef.current) return;
    startedRef.current = true;
    startChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedToken]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sectorsLoading]);

  useEffect(() => () => {
    pollAliveRef.current = false;
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    lastMessageIdRef.current = null;
    pollVersionRef.current++;  // invalida cualquier loop async pendiente
  }, []);

  function getHeaders() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${resolvedToken}`, "X-Tenant-ID": tenantId };
  }

  const pollMessages = useCallback(async (convId: string) => {
    try {
      const anchor = lastMessageIdRef.current;
      const url = `${API_BASE}/api/v1/widget/conversation/${convId}/poll?widget_session_id=${encodeURIComponent(sessionId.current)}`
        + (anchor ? `&last_message_id=${encodeURIComponent(anchor)}` : "");
      const r = await fetch(url, { headers: getHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      // El flag handoffOffer ahora viene de la DB (is_handoff_offer). El cliente
      // solo lo respeta mientras la conversacion siga en bot_active — si ya
      // paso a handoff_requested, la tarjeta deja de ofrecer accion.
      const isStillBot = data.status === "bot_active";
      const msgs = (data.messages || []).map((m: { id: string; sender_type: string; content: string; is_handoff_offer?: boolean; attachment_name?: string | null; attachment_mime?: string | null }) => ({
        id:   m.id,
        role: m.sender_type as Message["role"],
        content: m.content,
        handoffOffer: isStillBot && Boolean(m.is_handoff_offer),
        attachment: m.attachment_name ? { name: m.attachment_name, mime: m.attachment_mime || "" } : null,
      }));
      setMessages(msgs);
      if (msgs.length > 0) lastMessageIdRef.current = msgs[msgs.length - 1].id;
      setStatus(data.status);
      setOperatorName(data.operator_name ?? null);
      setAfiliadoIdentified(Boolean(data.afiliado_identified));
      setFeedbackGiven(Boolean(data.feedback_given));
      // Resetear handoffConfirmed cuando la conversacion vuelve a bot_active
      // (operador la cerro / la devolvio al bot / acepto el handoff y termino).
      // Sin esto, un cartel nuevo en un ciclo posterior aparece ya en modo
      // "Buscando operador disponible..." sin boton.
      if (data.status === "bot_active") {
        setHandoffConfirmed(false);
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedToken, tenantId]);

  // Long-polling loop: server holds the request up to ~25s and replies as soon
  // as there's news. We chain the next fetch right after each response so the
  // perceived latency is essentially network RTT.
  //
  // Version token: cada call genera una nueva version. Si un loop viejo despierta
  // despues (porque su await /poll tardo y nosotros ya arrancamos otro), detecta
  // el mismatch y termina. Sin esto, al renovar conv cerrada podian quedar dos
  // loops paralelos.
  const startPolling = useCallback((convId: string) => {
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    pollAliveRef.current = true;
    const myVersion = ++pollVersionRef.current;
    const loop = async () => {
      if (!pollAliveRef.current || pollVersionRef.current !== myVersion) return;
      await pollMessages(convId);
      if (!pollAliveRef.current || pollVersionRef.current !== myVersion) return;
      pollTimeoutRef.current = setTimeout(loop, 250);
    };
    loop();
  }, [pollMessages]);

  async function fetchOperatorsOnline(sectorId?: string | null) {
    try {
      const qs = sectorId ? `?sector_id=${sectorId}` : "";
      const r = await fetch(`${API_BASE}/api/v1/widget/operators-online${qs}`, { headers: getHeaders() });
      if (r.ok) { const d = await r.json(); setOperatorsOnline({ count: d.online ?? 0, names: d.operators ?? [] }); }
    } catch { /* non-critical */ }
  }

  async function startChat(pendingMessage?: string) {
    // Reset critico: matar polling viejo (si lo hay) y limpiar todos los refs
    // que persisten entre ciclos. Sin esto, al renovar conv el cliente quedaba
    // polleando con last_message_id de la conv vieja → backend hacia long-poll
    // 25s buscando un mensaje que ya no existia → UX se sentia "rota".
    pollAliveRef.current = false;
    if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
    lastMessageIdRef.current = null;

    setMessages([]);
    setHandoffConfirmed(false);
    setTimeout(() => inputRef.current?.focus(), 100);
    fetchOperatorsOnline(selectedSector?.id);
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/start`, {
        method: "POST", headers: getHeaders(),
        // Sin sector: el backend usa el default del tenant. El área real se
        // decide al derivar (confirm-handoff la re-etiqueta).
        body: JSON.stringify({ widget_session_id: sessionId.current, sector_id: selectedSector?.id ?? null, is_test: isTest }),
      });
      if (!r.ok) {
        // Pantalla completa con explicación accionable, no una burbuja "HTTP 401".
        setError(friendlyChatError(r.status, isTest));
        return;
      }
      const data = await r.json();
      setConversationId(data.conversation_id);
      setStatus(data.status);
      // Reapertura: la conversación anterior quedó cerrada sin calificar →
      // ofrecer las caritas UNA vez para esa conversación previa.
      setPrevFeedbackConvId(data.prev_feedback_pending ?? null);
      // Always poll: greeting is persisted in DB so it survives subsequent polls
      await pollMessages(data.conversation_id);
      startPolling(data.conversation_id);
      if (pendingMessage) await sendMessageTo(data.conversation_id, pendingMessage);
    } catch {
      // fetch lanzó sin respuesta (red caída / backend inaccesible).
      setError(friendlyChatError(null, isTest));
    }
  }

  async function sendMessageTo(convId: string, text: string) {
    setSending(true);
    setMessages(prev => [...prev, { id: Date.now().toString(), role: "user", content: text }]);
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${convId}/message`, {
        method: "POST", headers: getHeaders(),
        body: JSON.stringify({ content: text, widget_session_id: sessionId.current }),
      });
      // 410 = conversacion cerrada por el operador. Arrancar una nueva
      // automaticamente y reenviar el mensaje del usuario.
      if (r.status === 410) {
        // Limpiar el "user" optimista para que no quede duplicado en la nueva conv
        setMessages(prev => prev.filter(m => m.content !== text || m.role !== "user"));
        await startChat(text);
        return;
      }
      // Token revocado a mitad de conversación (p.ej. se reabrió "Probar chat"
      // en otra pestaña): explicar qué pasó en vez de un error de envío genérico.
      if (r.status === 401 || r.status === 403) {
        setError(friendlyChatError(r.status, isTest));
        return;
      }
      const data = await r.json();
      setStatus(data.status);
      // Mensajes bot y handoff llegan via poll (publish en backend tras insert).
      // Inserts optimistas quitados: causaban duplicados + parpadeo al ser
      // reemplazados por el snapshot real del siguiente poll cycle.
    } catch {
      setMessages(prev => [...prev, { id: Date.now().toString() + "e", role: "error", content: "Error al enviar. Intentá de nuevo." }]);
    } finally {
      setSending(false);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !conversationId || sending) return;
    setInput("");
    await sendMessageTo(conversationId, text);
  }

  // Feedback al cierre — un solo voto por conversación (el backend lo garantiza).
  // Silencioso ante error: nunca molestar al afiliado por un voto que no entró.
  // targetConvId permite calificar la conversación ANTERIOR (caso reapertura).
  async function submitFeedback(rating: number, reason: string | null, targetConvId?: string) {
    const cid = targetConvId ?? conversationId;
    if (!cid) return;
    try {
      const r = await fetch(
        `${API_BASE}/api/v1/widget/conversation/${cid}/feedback?widget_session_id=${encodeURIComponent(sessionId.current)}`,
        {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({ rating, ...(reason ? { reason } : {}) }),
        },
      );
      if (r.ok || r.status === 409) {
        if (targetConvId) setPrevFeedbackConvId(null);
        else setFeedbackGiven(true);
        setFeedbackThanks(true);
        setTimeout(() => setFeedbackThanks(false), 4000);
      }
    } catch { /* silencioso */ }
  }

  // Mismos límites que el backend (attachments.py): imágenes/PDF, 10 MB.
  const ALLOWED_ATTACH = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];

  async function uploadAttachment(file: File) {
    if (!conversationId || uploadingFile) return;
    if (!ALLOWED_ATTACH.includes(file.type)) {
      setMessages(prev => [...prev, { id: Date.now() + "av", role: "error", content: "Solo se pueden enviar imágenes (PNG/JPG/WEBP) o PDF." }]);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMessages(prev => [...prev, { id: Date.now() + "as", role: "error", content: "El archivo supera el máximo de 10 MB." }]);
      return;
    }
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.append("widget_session_id", sessionId.current);
      fd.append("file", file);
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${conversationId}/attachment`, {
        method: "POST",
        // Sin Content-Type: el browser arma el multipart boundary solo.
        headers: { Authorization: `Bearer ${resolvedToken}`, "X-Tenant-ID": tenantId },
        body: fd,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = typeof data?.detail === "string" ? data.detail : "No se pudo enviar el archivo. Probá de nuevo.";
        throw new Error(detail);
      }
      await pollMessages(conversationId);  // refleja el adjunto recién subido
    } catch (e) {
      const msg = e instanceof Error ? e.message : "No se pudo enviar el archivo. Probá de nuevo.";
      setMessages(prev => [...prev, { id: Date.now() + "ae", role: "error", content: msg }]);
    } finally {
      setUploadingFile(false);
    }
  }

  async function confirmHandoff(identif?: { afiliado_nombre?: string; afiliado_dni?: string; sector_id?: string }) {
    if (!conversationId) return;
    setHandoffConfirmed(true);
    try {
      const headers: Record<string, string> = { ...getHeaders() };
      // Siempre que haya sector elegido (form o chip), mandarlo: el backend
      // re-etiqueta la conversación para la cola de operadores correcta.
      const payload = { ...(identif || {}) };
      if (!payload.sector_id && selectedSector) payload.sector_id = selectedSector.id;
      let body: string | undefined;
      if (payload.afiliado_nombre || payload.afiliado_dni || payload.sector_id) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(payload);
      }
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${conversationId}/confirm-handoff?widget_session_id=${encodeURIComponent(sessionId.current)}`, {
        method: "POST",
        headers,
        body,
      });
      const data = await r.json().catch(() => ({}));
      // ANTES: no se chequeaba r.ok → ante un 422/404/410 igual se ponía
      // "Esperando operador…" aunque el handoff nunca se creó (falla silenciosa,
      // el afiliado esperaba para siempre). Ahora un no-2xx revierte y avisa.
      if (!r.ok) {
        const detail =
          typeof data?.detail === "string" ? data.detail :
          Array.isArray(data?.detail)      ? (data.detail[0]?.msg ?? "") :
          "";
        throw new Error(detail || `No se pudo conectar con un operador (error ${r.status}). Probá de nuevo.`);
      }
      setStatus(data.status ?? "handoff_requested");
      if (data.message)
        setMessages(prev => [...prev, { id: Date.now().toString() + "c", role: "system", content: data.message }]);
    } catch (e) {
      // Revertir el estado "confirmado" para que el afiliado pueda reintentar,
      // y mostrarle el motivo en vez de dejarlo esperando sin feedback.
      setHandoffConfirmed(false);
      const msg = e instanceof Error ? e.message : "No se pudo conectar con un operador. Probá de nuevo.";
      setMessages(prev => [...prev, { id: Date.now().toString() + "he", role: "error", content: msg }]);
    }
  }

  const statusLabel =
    status === "human_attending"    ? (operatorName ? `Atendiéndote: ${operatorName}` : "Operador conectado") :
    status === "handoff_requested"  ? "Esperando operador…" :
    "En línea";

  const statusDot =
    status === "human_attending"    ? "bg-success" :
    status === "handoff_requested"  ? "bg-warning animate-pulse" :
    "bg-success animate-pulse";

  // Texto de estado combinado (nombre aparte) — dispara la animación al cambiar.
  const statusSuffix =
    operatorsOnline !== null && status === "bot_active"
      ? (operatorsOnline.count > 0
          ? ` · ${operatorsOnline.count === 1 ? "1 operador disponible" : `${operatorsOnline.count} operadores disponibles`}`
          : " · Sin operadores")
      : "";
  const statusText = statusLabel + statusSuffix;

  // Efecto "Dynamic Island" (igual que el widget): la tarjeta de identidad crece
  // o se achica con un spring suave cuando cambia el texto de estado, en vez de
  // saltar. Mide el ancho natural nuevo, fija el viejo y transiciona al nuevo.
  const idCardRef = useRef<HTMLDivElement>(null);
  const prevCardW = useRef<number | null>(null);
  useLayoutEffect(() => {
    const card = idCardRef.current;
    if (!card) return;
    const w1 = card.offsetWidth;              // ancho natural con el texto ya actualizado
    const w0 = prevCardW.current;
    if (w0 != null && w0 !== w1) {
      card.style.width = `${w0}px`;
      void card.offsetWidth;                  // reflow para fijar el punto de partida
      card.style.width = `${w1}px`;           // animar hacia el nuevo ancho
      const id = setTimeout(() => {
        if (idCardRef.current) { idCardRef.current.style.width = ""; prevCardW.current = idCardRef.current.offsetWidth; }
      }, 480);
      return () => clearTimeout(id);
    }
    prevCardW.current = w1;
  }, [statusText]);

  // ── Error ────────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="h-screen bg-muted/40 flex items-center justify-center p-4">
        <div className="bg-card border rounded-xl p-8 max-w-sm w-full text-center space-y-3 shadow-sm">
          <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
          <h2 className="text-foreground font-semibold text-lg">No se pudo conectar</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  // ── Layout ───────────────────────────────────────────────────────────────────
  // Patrón "Chat Page" (referencia Text): columna de bienvenida a la izquierda,
  // conversación a la derecha con dos piezas FLOTANTES que le dan la misma
  // identidad que el widget embebido — card de identidad arriba e input abajo.
  // Esta pantalla vive siempre en claro (sin .dark), por eso los grises son fijos.
  const botName = branding?.bot_name || branding?.display_name || "Asistente";
  const orgName = branding?.display_name || "tu organización";

  return (
    <div className="h-screen flex bg-slate-100 overflow-hidden">

      {/* ── Columna de bienvenida (solo desktop) ── */}
      <aside className="hidden lg:flex w-[340px] shrink-0 flex-col justify-between p-10">
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

      {/* ── Conversación (contenedor blanco redondeado sobre el lienzo gris) ── */}
      <div className="relative flex flex-1 flex-col overflow-hidden bg-white lg:my-3 lg:mr-3 lg:rounded-3xl lg:border lg:border-slate-200/70 lg:shadow-sm">

        {/* Card de identidad FLOTANTE — centrada arriba (como el widget) */}
        <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex flex-col items-center px-4">
          <div
            ref={idCardRef}
            className="pointer-events-auto flex items-center gap-3 overflow-hidden rounded-2xl border border-slate-200/80 bg-white px-4 py-2.5 shadow-[0_4px_12px_-3px_rgba(0,0,0,0.10),0_1px_4px_-1px_rgba(0,0,0,0.06)] transition-[width] duration-[380ms] ease-[cubic-bezier(0.34,1.4,0.5,1)]"
          >
            <div className="relative shrink-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark shadow-sm">
                <Bot className="h-[18px] w-[18px] text-brand-foreground" />
              </div>
              <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${statusDot}`} />
            </div>
            <div className="min-w-0 pr-1 leading-tight">
              <p className="truncate text-sm font-semibold text-slate-900">{botName}</p>
              <p key={statusText} className="animate-fade-in truncate text-xs text-slate-500">{statusText}</p>
            </div>
          </div>
        </div>

        {/* ── Área de mensajes (con padding para no quedar bajo card/input) ── */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 pb-28 pt-24 sm:px-6">
            <div className="flex-1" />
            {/* Aviso de completitud en modo prueba: qué le falta al asistente
                para que una respuesta "vacía" no se confunda con un error. */}
            {(missingKb || missingSectors) && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-900">
                <p className="mb-1 font-semibold">Modo prueba — a tu asistente todavía le falta configuración</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {missingKb && (
                    <li>
                      No hay documentos en la base de conocimiento: va a responder solo con la
                      descripción general de tu organización. Cargalos desde <b>Documentos</b> en el panel.
                    </li>
                  )}
                  {missingSectors && (
                    <li>
                      No hay sectores configurados: no va a poder derivar consultas a un operador.
                      Crealos desde <b>Configuración</b> en el panel.
                    </li>
                  )}
                </ul>
              </div>
            )}
            {messages.length === 0 && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            )}
            <div className="space-y-4">
              {/* Reapertura: la charla anterior quedó sin calificar — una vez */}
              {prevFeedbackConvId && (
                <FeedbackCard
                  title="¿Cómo estuvo tu consulta anterior?"
                  onSubmit={(rating, reason) => submitFeedback(rating, reason, prevFeedbackConvId)}
                  onDismiss={() => setPrevFeedbackConvId(null)}
                />
              )}
              {messages.map(m => {
                if (m.attachment && conversationId)
                  return (
                    <AttachmentMessage
                      key={m.id}
                      msg={m}
                      url={`${API_BASE}/api/v1/widget/conversation/${conversationId}/attachment/${m.id}?widget_session_id=${encodeURIComponent(sessionId.current)}`}
                      headers={{ Authorization: `Bearer ${resolvedToken}`, "X-Tenant-ID": tenantId }}
                      operatorName={operatorName}
                    />
                  );
                if (m.role === "user")     return <UserBubble     key={m.id} content={m.content} />;
                if (m.role === "operator") return <OperatorBubble key={m.id} content={m.content} operatorName={operatorName} />;
                if (m.role === "system" && m.handoffOffer)
                  return <HandoffOfferBubble key={m.id} content={m.content} onConfirm={confirmHandoff} confirmed={handoffConfirmed} identified={afiliadoIdentified} sectors={sectors} preselectedSectorId={selectedSector?.id ?? null} />;
                if (m.role === "error")    return <ErrorBubble    key={m.id} content={m.content} />;
                if (m.role === "system")   return <SystemBubble   key={m.id} content={m.content} />;
                return                            <BotBubble      key={m.id} content={m.content} />;
              })}
              {/* Elección de área opcional — visible mientras atiende el bot */}
              {conversationId && messages.length > 0 && status === "bot_active" && !sectorsLoading && sectors.length > 1 && (
                <SectorChooser
                  sectors={sectors}
                  selected={selectedSector}
                  onSelect={s => { setSelectedSector(s); fetchOperatorsOnline(s.id); }}
                />
              )}
              {sending && status === "bot_active" && <TypingIndicator />}
              {/* Feedback al cierre: caritas 1-3 (+ chips de causa si 😞/😐).
                  Aparece con la conversación cerrada y sin voto; descartable. */}
              {conversationId && status === "closed" && !feedbackGiven && !feedbackDismissed && (
                <FeedbackCard
                  onSubmit={submitFeedback}
                  onDismiss={() => setFeedbackDismissed(true)}
                />
              )}
              {feedbackThanks && (
                <div className="flex justify-center animate-fade-in-up">
                  <span className="rounded-full bg-slate-100 px-4 py-1.5 text-xs text-slate-500">
                    ¡Gracias por tu opinión! Nos ayuda a mejorar.
                  </span>
                </div>
              )}
            </div>
            <div ref={bottomRef} />
          </div>
        </div>

        {/* ── Input FLOTANTE — pill blanca con sombra, con margen (como Text) ── */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4 sm:pb-5">
          <div className="pointer-events-auto mx-auto flex max-w-2xl items-center gap-1 rounded-full border border-transparent bg-slate-100 py-1.5 pl-2 pr-1.5 shadow-sm transition-colors focus-within:border-transparent focus-within:bg-white focus-within:ring-2 focus-within:ring-brand/25">
            {/* Adjuntar — solo con conversación activa */}
            {conversationId && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp,application/pdf"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) uploadAttachment(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingFile}
                  aria-label="Adjuntar imagen o PDF"
                  title="Adjuntar imagen o PDF"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                >
                  {uploadingFile
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Paperclip className="h-[18px] w-[18px]" />}
                </button>
              </>
            )}
            <input
              ref={inputRef}
              className="min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none disabled:opacity-60"
              placeholder={conversationId ? "Escribí un mensaje…" : "Conectando…"}
              disabled={!conversationId}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key !== "Enter" || e.shiftKey) return;
                e.preventDefault();
                sendMessage();
              }}
            />
            <button
              onClick={sendMessage}
              disabled={!conversationId || !input.trim() || sending}
              aria-label="Enviar mensaje"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-dark text-brand-foreground shadow-sm transition-all hover:scale-105 active:scale-95 disabled:scale-100 disabled:opacity-40 disabled:shadow-none"
            >
              {sending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
