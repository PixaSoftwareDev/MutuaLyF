"use client";

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2, Send, Bot, UserCheck, AlertTriangle, Paperclip, Plus } from "lucide-react";
import { api, type TenantBranding } from "@/lib/api";
import { applyBrandingVars, readCachedBranding, writeCachedBranding } from "@/lib/use-tenant-branding";
import { renderWithLinks } from "@/lib/render-with-links";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface Sector { id: string; nombre: string; descripcion: string | null; is_default: boolean; }
interface Message {
  id: string;
  role: "user" | "bot" | "operator" | "system";
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
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-light to-brand-dark flex items-center justify-center shrink-0 shadow-md shadow-black/20">
        <Bot className="h-4 w-4 text-brand-foreground" />
      </div>
      <div className="max-w-[78%] sm:max-w-[65%]">
        <div className="bg-white text-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed shadow-sm border border-slate-100">
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
        <div className="bg-gradient-to-br from-brand to-brand-dark text-brand-foreground rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed shadow-md shadow-black/15">
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
  ) : (
    <a href={src} download={msg.attachment?.name} className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2 break-all">
      <Paperclip className="h-4 w-4 shrink-0" />{msg.attachment?.name}
    </a>
  );

  if (fromUser) {
    return (
      <div className="flex justify-end animate-fade-in-up">
        <div className="max-w-[78%] sm:max-w-[65%]">
          <div className="bg-gradient-to-br from-brand to-brand-dark text-brand-foreground rounded-2xl rounded-br-sm px-3 py-2.5 shadow-md shadow-black/15">
            {inner}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3 items-end animate-fade-in-up">
      <div className="w-8 h-8 rounded-xl bg-success flex items-center justify-center shrink-0 shadow-md shadow-black/10">
        <UserCheck className="h-4 w-4 text-success-foreground" />
      </div>
      <div className="max-w-[78%] sm:max-w-[65%]">
        {operatorName && <p className="text-[11px] text-muted-foreground mb-1 ml-1">{operatorName}</p>}
        <div className="bg-white text-slate-800 rounded-2xl rounded-bl-sm px-3 py-2.5 shadow-sm border border-slate-100">
          {inner}
        </div>
      </div>
    </div>
  );
}

function OperatorBubble({ content, operatorName }: { content: string; operatorName?: string | null }) {
  return (
    <div className="flex gap-3 items-end animate-fade-in-up">
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center shrink-0 shadow-md shadow-emerald-500/30">
        <UserCheck className="h-4 w-4 text-white" />
      </div>
      <div className="max-w-[78%] sm:max-w-[65%]">
        <div className="bg-white text-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed shadow-sm border border-emerald-100">
          {renderWithLinks(content)}
        </div>
        <p className="text-xs text-emerald-600 mt-1 ml-1 font-medium">{operatorName || "Operador"}</p>
      </div>
    </div>
  );
}

function SystemBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-center py-1 animate-fade-in-up">
      <span className="text-xs text-slate-400 bg-slate-100 rounded-full px-4 py-1.5">
        {renderWithLinks(content)}
      </span>
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

  return (
    <div className="flex justify-center py-2 animate-fade-in-up">
      <div className="max-w-[85%] bg-warning/10 border border-warning/20 rounded-2xl px-4 py-3 text-center space-y-3">
        <p className="text-sm text-warning">{renderWithLinks(content)}</p>
        {confirmed ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-warning font-medium">
            <Loader2 className="h-3 w-3 animate-spin" />
            Buscando operador disponible…
          </span>
        ) : phase === "offer" ? (
          <button
            onClick={() => identified
              ? onConfirm(preselectedSectorId ? { sector_id: preselectedSectorId } : undefined)
              : setPhase("identify")}
            className="inline-flex items-center gap-2 bg-warning text-warning-foreground hover:bg-warning/90 active:scale-95 text-sm font-medium rounded-xl px-4 py-2 transition-all"
          >
            <UserCheck className="h-4 w-4" />
            Sí, conectarme con un operador
          </button>
        ) : (
          <div className="text-left space-y-2">
            <p className="text-xs font-semibold text-warning">Antes de conectarte con un operador</p>
            <p className="text-[11px] text-warning leading-relaxed">
              Para una mejor atención, decinos tu nombre y DNI:
            </p>
            <input
              type="text"
              value={nombre}
              onChange={e => setNombre(e.target.value)}
              placeholder="Nombre y apellido"
              maxLength={200}
              autoFocus
              className="w-full px-3 py-2 rounded-md border border-warning/20 text-sm text-warning placeholder:text-warning/40 bg-white focus:outline-none focus:ring-2 focus:ring-warning/40"
            />
            <input
              type="text"
              inputMode="numeric"
              value={dni}
              onChange={e => setDni(e.target.value)}
              placeholder="DNI (sin puntos)"
              maxLength={20}
              className="w-full px-3 py-2 rounded-md border border-warning/20 text-sm text-warning placeholder:text-warning/40 bg-white focus:outline-none focus:ring-2 focus:ring-warning/40"
              onKeyDown={e => { if (e.key === "Enter") submit(); }}
            />
            {sectors.length > 1 && (
              <>
                <p className="text-[11px] text-warning leading-relaxed">¿Con qué área querés hablar?</p>
                <select
                  value={sectorId}
                  onChange={e => setSectorId(e.target.value)}
                  aria-label="Área que te va a atender"
                  className="w-full px-3 py-2 rounded-md border border-warning/20 text-sm text-warning bg-white focus:outline-none focus:ring-2 focus:ring-warning/40"
                >
                  {sectors.map(s => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
              </>
            )}
            {err && <p className="text-[11px] text-destructive">{err}</p>}
            <div className="flex items-center justify-end pt-1">
              <button
                onClick={submit}
                className="bg-warning text-warning-foreground hover:bg-warning/90 active:scale-95 text-sm font-medium rounded-xl px-4 py-2 transition-all"
              >
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
  const [open, setOpen] = useState(false);

  if (selected) {
    return (
      <div className="flex justify-center animate-fade-in-up">
        <span className="text-xs text-muted-foreground bg-muted rounded-full px-4 py-1.5">
          Área elegida: <span className="font-medium text-foreground">{selected.nombre}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex justify-center animate-fade-in-up">
      {open ? (
        <div className="w-full max-w-sm rounded-2xl border bg-card shadow-md overflow-hidden">
          <p className="border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
            ¿Con qué área querés hablar?
          </p>
          <div className="max-h-64 overflow-y-auto">
            {sectors.map(s => (
              <button
                key={s.id}
                onClick={() => onSelect(s)}
                className="block w-full border-b px-4 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-brand/5 hover:text-brand"
              >
                {s.nombre}
              </button>
            ))}
            <button
              onClick={() => setOpen(false)}
              className="block w-full px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
            >
              No importa, sigo con el asistente
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="rounded-full border bg-card px-4 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-brand/30 hover:text-brand"
        >
          ¿Preferís hablar con un área específica?
        </button>
      )}
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

function ChatInner() {
  const params   = useSearchParams();
  const token    = params.get("token") || "";
  const tenantId = params.get("tenant") || "";
  const isTest   = params.get("test") === "1";

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
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => setResolvedToken(data.widget_token))
      .catch(e => { setError(`No se pudo conectar: ${e.message}`); setSectorsLoading(false); });
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
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setConversationId(data.conversation_id);
      setStatus(data.status);
      // Always poll: greeting is persisted in DB so it survives subsequent polls
      await pollMessages(data.conversation_id);
      startPolling(data.conversation_id);
      if (pendingMessage) await sendMessageTo(data.conversation_id, pendingMessage);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error desconocido";
      setMessages([{ id: "err", role: "system", content: `Error al iniciar el chat: ${msg}` }]);
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
      const data = await r.json();
      setStatus(data.status);
      // Mensajes bot y handoff llegan via poll (publish en backend tras insert).
      // Inserts optimistas quitados: causaban duplicados + parpadeo al ser
      // reemplazados por el snapshot real del siguiente poll cycle.
    } catch {
      setMessages(prev => [...prev, { id: Date.now().toString() + "e", role: "system", content: "Error al enviar. Intentá de nuevo." }]);
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

  // Mismos límites que el backend (attachments.py): imágenes/PDF, 10 MB.
  const ALLOWED_ATTACH = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];

  async function uploadAttachment(file: File) {
    if (!conversationId || uploadingFile) return;
    if (!ALLOWED_ATTACH.includes(file.type)) {
      setMessages(prev => [...prev, { id: Date.now() + "av", role: "system", content: "Solo se pueden enviar imágenes (PNG/JPG/WEBP) o PDF." }]);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMessages(prev => [...prev, { id: Date.now() + "as", role: "system", content: "El archivo supera el máximo de 10 MB." }]);
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
      setMessages(prev => [...prev, { id: Date.now() + "ae", role: "system", content: msg }]);
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
      setMessages(prev => [...prev, { id: Date.now().toString() + "he", role: "system", content: msg }]);
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
          <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-2.5 shadow-lg shadow-black/[0.06]">
            <div className="relative shrink-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark shadow-sm">
                <Bot className="h-[18px] w-[18px] text-brand-foreground" />
              </div>
              <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${statusDot}`} />
            </div>
            <div className="pr-1 leading-tight">
              <p className="text-sm font-semibold text-slate-900">{botName}</p>
              <p className="text-xs text-slate-500">
                {statusLabel}
                {operatorsOnline !== null && status === "bot_active" && (
                  operatorsOnline.count > 0
                    ? ` · ${operatorsOnline.count === 1 ? "1 operador disponible" : `${operatorsOnline.count} operadores disponibles`}`
                    : " · Sin operadores"
                )}
              </p>
            </div>
          </div>
        </div>

        {/* ── Área de mensajes (con padding para no quedar bajo card/input) ── */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 pb-28 pt-24 sm:px-6">
            <div className="flex-1" />
            {messages.length === 0 && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            )}
            <div className="space-y-4">
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
            </div>
            <div ref={bottomRef} />
          </div>
        </div>

        {/* ── Input FLOTANTE — pill blanca con sombra, con margen (como Text) ── */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4 sm:pb-5">
          <div className="pointer-events-auto mx-auto flex max-w-2xl items-center gap-1 rounded-full border border-slate-200/80 bg-white py-1.5 pl-2 pr-1.5 shadow-lg shadow-black/[0.07]">
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
                    : <Plus className="h-5 w-5" />}
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
