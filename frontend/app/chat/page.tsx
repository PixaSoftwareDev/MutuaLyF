"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2, Send, Bot, ChevronLeft, UserCheck } from "lucide-react";
import { api, type TenantBranding } from "@/lib/api";
import { applyBrandingVars, readCachedBranding, writeCachedBranding } from "@/lib/use-tenant-branding";
import { renderWithLinks } from "@/lib/render-with-links";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface Sector { id: string; nombre: string; descripcion: string | null; is_default: boolean; }
interface Message { id: string; role: "user" | "bot" | "operator" | "system"; content: string; handoffOffer?: boolean; }

export default function ChatPage() {
  return (
    <Suspense fallback={
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-light to-brand-dark flex items-center justify-center shadow-lg shadow-black/30">
            <Bot className="h-7 w-7 text-white" />
          </div>
          <Loader2 className="h-5 w-5 animate-spin text-brand-light" />
        </div>
      </div>
    }>
      <ChatInner />
    </Suspense>
  );
}

// ── Bubble components ──────────────────────────────────────────────────────────

function BotBubble({ content }: { content: string }) {
  return (
    <div className="flex gap-3 items-end group">
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-light to-brand-dark flex items-center justify-center shrink-0 shadow-md shadow-black/20">
        <Bot className="h-4 w-4 text-white" />
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
    <div className="flex justify-end">
      <div className="max-w-[78%] sm:max-w-[65%]">
        <div className="bg-gradient-to-br from-brand to-brand-dark text-white rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed shadow-md shadow-black/15">
          {renderWithLinks(content)}
        </div>
      </div>
    </div>
  );
}

function OperatorBubble({ content, operatorName }: { content: string; operatorName?: string | null }) {
  return (
    <div className="flex gap-3 items-end">
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
    <div className="flex justify-center py-1">
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
}: {
  content: string;
  onConfirm: (identif?: { afiliado_nombre: string; afiliado_dni: string }) => void;
  confirmed: boolean;
  identified: boolean;
}) {
  // 3 estados: "offer" (botón inicial) → "identify" (form) → confirmed (loader)
  const [phase, setPhase] = useState<"offer" | "identify">("offer");
  const [nombre, setNombre] = useState("");
  const [dni, setDni]       = useState("");
  const [err, setErr]       = useState<string | null>(null);

  function submit() {
    setErr(null);
    const n = nombre.trim();
    const d = dni.trim();
    if (!n) { setErr("Decinos tu nombre, por favor."); return; }
    if (!d) { setErr("Decinos tu DNI o número de documento, por favor."); return; }
    // Sin mínimo de longitud: es un identificador para que el operador te reconozca,
    // no una credencial. Documentos cortos, provisorios o extranjeros son válidos.
    onConfirm({ afiliado_nombre: n, afiliado_dni: d });
  }

  return (
    <div className="flex justify-center py-2">
      <div className="max-w-[85%] bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-center space-y-3">
        <p className="text-sm text-amber-800">{renderWithLinks(content)}</p>
        {confirmed ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 font-medium">
            <Loader2 className="h-3 w-3 animate-spin" />
            Buscando operador disponible…
          </span>
        ) : phase === "offer" ? (
          <button
            onClick={() => identified ? onConfirm() : setPhase("identify")}
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 active:scale-95 text-white text-sm font-medium rounded-xl px-4 py-2 transition-all"
          >
            <UserCheck className="h-4 w-4" />
            Sí, conectarme con un operador
          </button>
        ) : (
          <div className="text-left space-y-2">
            <p className="text-xs font-semibold text-amber-900">Antes de conectarte con un operador</p>
            <p className="text-[11px] text-amber-700 leading-relaxed">
              Para una mejor atención, decinos tu nombre y DNI:
            </p>
            <input
              type="text"
              value={nombre}
              onChange={e => setNombre(e.target.value)}
              placeholder="Nombre y apellido"
              maxLength={200}
              autoFocus
              className="w-full px-3 py-2 rounded-md border border-amber-200 text-sm text-amber-900 placeholder:text-amber-300 bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <input
              type="text"
              inputMode="numeric"
              value={dni}
              onChange={e => setDni(e.target.value)}
              placeholder="DNI (sin puntos)"
              maxLength={20}
              className="w-full px-3 py-2 rounded-md border border-amber-200 text-sm text-amber-900 placeholder:text-amber-300 bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
              onKeyDown={e => { if (e.key === "Enter") submit(); }}
            />
            {err && <p className="text-[11px] text-red-600">{err}</p>}
            <div className="flex items-center justify-end pt-1">
              <button
                onClick={submit}
                className="bg-amber-500 hover:bg-amber-600 active:scale-95 text-white text-sm font-medium rounded-xl px-4 py-2 transition-all"
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

function TypingIndicator() {
  return (
    <div className="flex gap-3 items-end">
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-light to-brand-dark flex items-center justify-center shrink-0 shadow-md shadow-black/20">
        <Bot className="h-4 w-4 text-white" />
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
  // Inicializamos el branding desde el cache sincronicamente para evitar
  // el flash al refrescar (el fetch a /public/tenant-branding tarda
  // ~100-300ms y mientras tanto se veia el rojo default + "Asistente").
  const [branding, setBranding]             = useState<TenantBranding | null>(() =>
    tenantId ? readCachedBranding(tenantId) : null
  );
  const [greeting, setGreeting]             = useState<string>("¡Hola! 👋 Soy tu asistente virtual. ¿En qué área puedo ayudarte?");
  const [sectorsLoading, setSectorsLoading] = useState(true);
  const [selectedSector, setSelectedSector] = useState<Sector | null>(null);
  const [phase, setPhase]                   = useState<"selecting" | "chat">("selecting");
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
  const bottomRef                           = useRef<HTMLDivElement>(null);
  const inputRef                            = useRef<HTMLInputElement>(null);
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
        if (data.greeting_message) setGreeting(data.greeting_message);
        setSectorsLoading(false);
      })
      .catch(e => { setError(`Error al cargar sectores: ${e.message}`); setSectorsLoading(false); });
  }, [resolvedToken, tenantId]);

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
      const msgs = (data.messages || []).map((m: { id: string; sender_type: string; content: string; is_handoff_offer?: boolean }) => ({
        id:   m.id,
        role: m.sender_type as Message["role"],
        content: m.content,
        handoffOffer: isStillBot && Boolean(m.is_handoff_offer),
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

  async function fetchOperatorsOnline(sectorId: string) {
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/operators-online?sector_id=${sectorId}`, { headers: getHeaders() });
      if (r.ok) { const d = await r.json(); setOperatorsOnline({ count: d.online ?? 0, names: d.operators ?? [] }); }
    } catch { /* non-critical */ }
  }

  async function startChat(sector: Sector, pendingMessage?: string) {
    // Reset critico: matar polling viejo (si lo hay) y limpiar todos los refs
    // que persisten entre ciclos. Sin esto, al renovar conv el cliente quedaba
    // polleando con last_message_id de la conv vieja → backend hacia long-poll
    // 25s buscando un mensaje que ya no existia → UX se sentia "rota".
    pollAliveRef.current = false;
    if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
    lastMessageIdRef.current = null;

    setSelectedSector(sector);
    setPhase("chat");
    setMessages([]);
    setHandoffConfirmed(false);
    setTimeout(() => inputRef.current?.focus(), 100);
    fetchOperatorsOnline(sector.id);
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/start`, {
        method: "POST", headers: getHeaders(),
        body: JSON.stringify({ widget_session_id: sessionId.current, sector_id: sector.id, is_test: isTest }),
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
      if (r.status === 410 && selectedSector) {
        // Limpiar el "user" optimista para que no quede duplicado en la nueva conv
        setMessages(prev => prev.filter(m => m.content !== text || m.role !== "user"));
        await startChat(selectedSector, text);
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

  async function confirmHandoff(identif?: { afiliado_nombre: string; afiliado_dni: string }) {
    if (!conversationId) return;
    setHandoffConfirmed(true);
    try {
      const headers: Record<string, string> = { ...getHeaders() };
      let body: string | undefined;
      if (identif) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(identif);
      }
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${conversationId}/confirm-handoff?widget_session_id=${encodeURIComponent(sessionId.current)}`, {
        method: "POST",
        headers,
        body,
      });
      const data = await r.json();
      setStatus(data.status ?? "handoff_requested");
      if (data.message)
        setMessages(prev => [...prev, { id: Date.now().toString() + "c", role: "system", content: data.message }]);
    } catch { /* ignore */ }
  }

  const statusLabel =
    status === "human_attending"    ? (operatorName ? `Atendiéndote: ${operatorName}` : "Operador conectado") :
    status === "handoff_requested"  ? "Esperando operador…" :
    "En línea";

  const statusDot =
    status === "human_attending"    ? "bg-emerald-400" :
    status === "handoff_requested"  ? "bg-amber-400 animate-pulse" :
    "bg-emerald-400 animate-pulse";

  // ── Error ────────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-3xl p-10 max-w-sm w-full text-center space-y-4">
          <div className="text-5xl">⚠️</div>
          <h2 className="text-white font-semibold text-lg">No se pudo conectar</h2>
          <p className="text-slate-300 text-sm leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  // ── Layout ───────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">

      {/* ── Top bar ──────────────────────────────────────────────────────────── */}
      <header className={`shrink-0 shadow-lg z-10 transition-colors duration-500 ${
        status === "handoff_requested"
          ? "bg-gradient-to-r from-amber-600 via-amber-500 to-orange-500 shadow-amber-900/30"
          : status === "human_attending"
          ? "bg-gradient-to-r from-emerald-700 via-emerald-600 to-teal-600 shadow-emerald-900/30"
          : "bg-gradient-to-r from-brand-dark via-brand to-brand-light shadow-black/30"
      }`}>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          {/* Left: brand + status */}
          <div className="flex items-center gap-3">
            {phase === "chat" ? (
              <button
                onClick={() => {
                  pollAliveRef.current = false;
                  if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
                  lastMessageIdRef.current = null;
                  setPhase("selecting"); setConversationId(null); setMessages([]); setSelectedSector(null);
                }}
                className="mr-1 text-white/70 hover:text-white transition-colors p-1 -ml-1 rounded-lg hover:bg-white/10"
                aria-label="Cambiar área"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            ) : null}
            {/* Avatar del bot — fijo para todos los tenants, no depende del logo del cliente */}
            <div className="w-9 h-9 rounded-xl bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center shadow-inner">
              <Bot className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-white font-semibold text-sm leading-none">
                {selectedSector ? selectedSector.nombre : (branding?.bot_name || branding?.display_name || "Asistente")}
              </p>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
                <span className="text-white/80 text-xs">{phase === "selecting" ? "Elige un área para comenzar" : statusLabel}</span>
                {phase === "chat" && operatorsOnline !== null && status === "bot_active" && (
                  operatorsOnline.count > 0 ? (
                    <span className="text-white/70 text-xs">
                      · {operatorsOnline.count === 1
                          ? "1 operador disponible"
                          : `${operatorsOnline.count} operadores disponibles`}
                    </span>
                  ) : (
                    <span className="text-white/50 text-xs">· Sin operadores disponibles</span>
                  )
                )}
              </div>
            </div>
          </div>

        </div>
      </header>

      {/* ── Messages / Selection area ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4 min-h-full flex flex-col">

          {phase === "selecting" ? (
            /* ── Sector selection ─────────────────────────────────────────── */
            <div className="flex-1 flex flex-col justify-center items-center gap-8 py-8">
              {/* Hero */}
              <div className="text-center space-y-3">
                <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-brand-light to-brand-dark flex items-center justify-center mx-auto shadow-xl shadow-black/20">
                  <Bot className="h-10 w-10 text-white" />
                </div>
                <p className="text-slate-600 text-sm sm:text-base whitespace-pre-line max-w-md mx-auto">
                  {greeting}
                </p>
              </div>

              {/* Sector pills */}
              {sectorsLoading ? (
                <div className="flex flex-wrap gap-3 justify-center">
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className="h-10 w-28 rounded-full bg-slate-200 animate-pulse" />
                  ))}
                </div>
              ) : sectors.length === 0 ? (
                <p className="text-slate-400 text-sm">No hay sectores disponibles.</p>
              ) : (
                <div className="flex flex-wrap gap-3 justify-center max-w-lg">
                  {sectors.map(s => (
                    <button
                      key={s.id}
                      onClick={() => startChat(s)}
                      className="group relative bg-white hover:bg-gradient-to-br hover:from-brand hover:to-brand-dark border-2 border-brand/30 hover:border-transparent text-brand hover:text-white font-medium text-sm rounded-full px-5 py-2.5 transition-all duration-200 shadow-sm hover:shadow-lg hover:shadow-black/20 active:scale-95"
                    >
                      {s.nombre}
                    </button>
                  ))}
                </div>
              )}

              {/* Divider */}
              {!sectorsLoading && sectors.length > 0 && (
                <div className="w-full max-w-sm flex items-center gap-3">
                  <div className="flex-1 h-px bg-slate-200" />
                  <span className="text-xs text-slate-400 shrink-0">o escribí directamente</span>
                  <div className="flex-1 h-px bg-slate-200" />
                </div>
              )}
            </div>
          ) : (
            /* ── Chat messages ───────────────────────────────────────────── */
            <>
              <div className="flex-1" />
              {messages.map(m => {
                if (m.role === "user")     return <UserBubble     key={m.id} content={m.content} />;
                if (m.role === "operator") return <OperatorBubble key={m.id} content={m.content} operatorName={operatorName} />;
                if (m.role === "system" && m.handoffOffer)
                  return <HandoffOfferBubble key={m.id} content={m.content} onConfirm={confirmHandoff} confirmed={handoffConfirmed} identified={afiliadoIdentified} />;
                if (m.role === "system")   return <SystemBubble   key={m.id} content={m.content} />;
                return                            <BotBubble      key={m.id} content={m.content} />;
              })}
              {sending && <TypingIndicator />}
            </>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input bar ────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex gap-3 items-center">
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                className="w-full bg-slate-100 hover:bg-slate-50 focus:bg-white border border-transparent focus:border-brand rounded-2xl px-5 py-3 text-sm text-slate-800 placeholder-slate-400 outline-none focus:ring-2 focus:ring-brand/30 transition-all"
                placeholder={
                  phase === "selecting"
                    ? sectorsLoading || sectors.length === 0
                      ? "Cargando sectores…"
                      : "Escribí tu consulta y presioná Enter…"
                    : "Escribí tu mensaje…"
                }
                disabled={phase === "selecting" && (sectorsLoading || sectors.length === 0)}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  if (phase === "selecting") {
                    const val = input.trim();
                    if (val && sectors.length > 0) {
                      const def = sectors.find(s => s.is_default) || sectors[0];
                      setInput("");
                      startChat(def, val);
                    }
                  } else {
                    sendMessage();
                  }
                }}
              />
            </div>
            <button
              onClick={() => {
                if (phase === "chat") { sendMessage(); return; }
                const val = input.trim();
                if (phase === "selecting" && val && sectors.length > 0) {
                  const def = sectors.find(s => s.is_default) || sectors[0];
                  setInput("");
                  startChat(def, val);
                }
              }}
              disabled={
                phase === "chat"
                  ? (!input.trim() || sending)
                  : !input.trim() || sectorsLoading || sectors.length === 0
              }
              className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand to-brand-dark text-white flex items-center justify-center shadow-md shadow-black/20 hover:shadow-lg hover:shadow-black/25 hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:shadow-md transition-all duration-150"
            >
              {sending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Send className="h-4 w-4" />
              }
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}
