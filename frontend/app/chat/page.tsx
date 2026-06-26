"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2, Send, Bot, ChevronLeft, UserCheck, AlertTriangle, Paperclip } from "lucide-react";
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
            onClick={() => identified ? onConfirm() : setPhase("identify")}
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
  return (
    <div className="h-screen flex flex-col bg-muted/40 overflow-hidden">

      {/* ── Top bar ──────────────────────────────────────────────────────────────
          Header estable con el color de marca (antes cambiaba todo el fondo a
          ámbar/verde según estado — efecto "semáforo"). El estado ahora se lee
          en el punto + label de abajo, más sobrio. */}
      <header className="shrink-0 shadow-md z-10 bg-gradient-to-r from-brand-dark via-brand to-brand-light shadow-black/20">
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
                className="mr-1 text-brand-foreground/70 hover:text-brand-foreground transition-colors p-1 -ml-1 rounded-lg hover:bg-white/10"
                aria-label="Cambiar área"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            ) : null}
            {/* Avatar del bot — fijo para todos los tenants, no depende del logo del cliente */}
            <div className="w-9 h-9 rounded-xl bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center shadow-inner">
              <Bot className="h-5 w-5 text-brand-foreground" />
            </div>
            <div>
              <p className="text-brand-foreground font-semibold text-sm leading-none">
                {selectedSector ? selectedSector.nombre : (branding?.bot_name || branding?.display_name || "Asistente")}
              </p>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
                <span className="text-brand-foreground/80 text-xs">{phase === "selecting" ? "Elige un área para comenzar" : statusLabel}</span>
                {phase === "chat" && operatorsOnline !== null && status === "bot_active" && (
                  operatorsOnline.count > 0 ? (
                    <span className="text-brand-foreground/70 text-xs">
                      · {operatorsOnline.count === 1
                          ? "1 operador disponible"
                          : `${operatorsOnline.count} operadores disponibles`}
                    </span>
                  ) : (
                    <span className="text-brand-foreground/50 text-xs">· Sin operadores disponibles</span>
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
                  <Bot className="h-10 w-10 text-brand-foreground" />
                </div>
                <p className="text-muted-foreground text-sm sm:text-base whitespace-pre-line max-w-md mx-auto">
                  {greeting}
                </p>
              </div>

              {/* Sector pills */}
              {sectorsLoading ? (
                <div className="flex flex-wrap gap-3 justify-center">
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className="h-10 w-28 rounded-full bg-muted skeleton-shimmer" />
                  ))}
                </div>
              ) : sectors.length === 0 ? (
                <p className="text-muted-foreground text-sm">No hay sectores disponibles.</p>
              ) : (
                <div className="flex flex-wrap gap-3 justify-center max-w-lg">
                  {sectors.map(s => (
                    <button
                      key={s.id}
                      onClick={() => startChat(s)}
                      className="group relative bg-card hover:bg-gradient-to-br hover:from-brand hover:to-brand-dark border-2 border-brand/30 hover:border-transparent text-brand hover:text-brand-foreground font-medium text-sm rounded-full px-5 py-2.5 transition-all duration-200 shadow-sm hover:shadow-lg hover:shadow-black/20 active:scale-95"
                    >
                      {s.nombre}
                    </button>
                  ))}
                </div>
              )}

              {/* Hint discreto — el input está fijo abajo, evitamos el divisor colgado */}
              {!sectorsLoading && sectors.length > 0 && (
                <p className="text-muted-foreground text-xs text-center -mt-3">
                  Elegí un área o escribí tu consulta abajo
                </p>
              )}
            </div>
          ) : (
            /* ── Chat messages ───────────────────────────────────────────── */
            <>
              <div className="flex-1" />
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
                  return <HandoffOfferBubble key={m.id} content={m.content} onConfirm={confirmHandoff} confirmed={handoffConfirmed} identified={afiliadoIdentified} />;
                if (m.role === "system")   return <SystemBubble   key={m.id} content={m.content} />;
                return                            <BotBubble      key={m.id} content={m.content} />;
              })}
              {sending && status === "bot_active" && <TypingIndicator />}
            </>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input bar ────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t bg-card/80 backdrop-blur-md">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex gap-3 items-center">
            {/* Adjuntar — solo con conversación activa */}
            {phase === "chat" && conversationId && (
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
                  className="w-12 h-12 rounded-2xl shrink-0 bg-muted hover:bg-muted/70 text-muted-foreground hover:text-foreground flex items-center justify-center transition-all disabled:opacity-50"
                >
                  {uploadingFile
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Paperclip className="h-4 w-4" />}
                </button>
              </>
            )}
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                className="w-full bg-muted hover:bg-muted/70 focus:bg-card border border-transparent focus:border-brand rounded-2xl px-5 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-brand/30 transition-all"
                placeholder={
                  phase === "selecting"
                    ? sectorsLoading || sectors.length === 0
                      ? "Cargando sectores…"
                      : "Escribí tu consulta…"
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
              className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand to-brand-dark text-brand-foreground flex items-center justify-center shadow-md shadow-black/20 hover:shadow-lg hover:shadow-black/25 hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:shadow-md transition-all duration-150"
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
