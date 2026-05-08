"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2, Send, User } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface Sector { id: string; nombre: string; descripcion: string | null; is_default: boolean; }
interface Message { id: string; role: "user" | "bot" | "operator" | "system"; content: string; }

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></div>}>
      <ChatInner />
    </Suspense>
  );
}

function ChatInner() {
  const params   = useSearchParams();
  const token    = params.get("token") || "";
  const tenantId = params.get("tenant") || "";

  const [sectors, setSectors]               = useState<Sector[]>([]);
  const [sectorsLoading, setSectorsLoading] = useState(true);
  const [selectedSector, setSelectedSector] = useState<Sector | null>(null);
  const [phase, setPhase]                   = useState<"selecting" | "chat">("selecting");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages]             = useState<Message[]>([]);
  const [input, setInput]                   = useState("");
  const [sending, setSending]               = useState(false);
  const [status, setStatus]                 = useState("bot_active");
  const [error, setError]                   = useState<string | null>(null);
  const [resolvedToken, setResolvedToken]   = useState(token);
  const bottomRef                           = useRef<HTMLDivElement>(null);
  const sessionId                           = useRef<string>("");
  const pollIntervalRef                     = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialize sessionId client-side only (localStorage is not available on server)
  useEffect(() => {
    const key = "ia_chat_session_" + (token || tenantId).slice(-8);
    const stored = localStorage.getItem(key);
    if (stored) {
      sessionId.current = stored;
    } else {
      const id = "cs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
      localStorage.setItem(key, id);
      sessionId.current = id;
    }
  }, [token, tenantId]);

  // If no token in URL, auto-fetch one from the public endpoint (chat is public)
  useEffect(() => {
    if (token) { setResolvedToken(token); return; }
    if (!tenantId) { setError("URL inválida. El chat requiere el parámetro ?tenant=TU_ORGANIZACION"); setSectorsLoading(false); return; }
    fetch(`${API_BASE}/api/v1/public/chat-token`, {
      headers: { "X-Tenant-ID": tenantId },
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => setResolvedToken(data.widget_token))
      .catch(e => { setError(`No se pudo conectar al chat: ${e.message}`); setSectorsLoading(false); });
  }, [token, tenantId]);

  // Load sectors once we have a token
  useEffect(() => {
    if (!resolvedToken) return;
    setSectorsLoading(true);
    fetch(`${API_BASE}/api/v1/widget/sectors`, {
      headers: { Authorization: `Bearer ${resolvedToken}`, "X-Tenant-ID": tenantId },
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Sector[]) => {
        setSectors(data);
        setSectorsLoading(false);
      })
      .catch((e) => {
        setError(`Error al cargar los sectores: ${e.message}`);
        setSectorsLoading(false);
      });
  }, [resolvedToken, tenantId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Cleanup polling on unmount
  useEffect(() => () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); }, []);

  function headers() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${resolvedToken}`, "X-Tenant-ID": tenantId };
  }

  const pollMessages = useCallback(async (convId: string) => {
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${convId}/poll`, { headers: headers() });
      if (!r.ok) return;
      const data = await r.json();
      setMessages((data.messages || []).map((m: { id: string; sender_type: string; content: string }) => ({
        id: m.id, role: m.sender_type as Message["role"], content: m.content,
      })));
      setStatus(data.status);
    } catch { /* ignore poll errors */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tenantId]);

  const startPolling = useCallback((convId: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(() => pollMessages(convId), 4000);
  }, [pollMessages]);

  async function startChat(sector: Sector, pendingMessage?: string) {
    setSelectedSector(sector);
    setPhase("chat");
    setMessages([]);
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/start`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ widget_session_id: sessionId.current, sector_id: sector.id }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setConversationId(data.conversation_id);
      setStatus(data.status);
      if (data.resumed) {
        await pollMessages(data.conversation_id);
      } else {
        setMessages([{ id: "welcome", role: "bot", content: `¡Hola! Soy el asistente de ${sector.nombre}. ¿En qué te puedo ayudar?` }]);
      }
      startPolling(data.conversation_id);

      // If user typed before selecting sector, send that message now
      if (pendingMessage) {
        await sendMessageTo(data.conversation_id, pendingMessage);
      }
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
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ content: text, widget_session_id: sessionId.current }),
      });
      const data = await r.json();
      setStatus(data.status);
      if (data.bot_response) setMessages(prev => [...prev, { id: Date.now().toString() + "b", role: "bot", content: data.bot_response }]);
      if (data.handoff_offered && data.handoff_message) setMessages(prev => [...prev, { id: Date.now().toString() + "h", role: "system", content: data.handoff_message }]);
      if (data.handoff_activated && data.handoff_message) setMessages(prev => [...prev, { id: Date.now().toString() + "ha", role: "system", content: data.handoff_message }]);
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

  async function requestHuman() {
    if (!conversationId) return;
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${conversationId}/human`, { method: "POST", headers: headers() });
      const data = await r.json();
      setStatus(data.status);
      if (data.message) setMessages(prev => [...prev, { id: Date.now().toString(), role: "system", content: data.message }]);
    } catch { /* ignore */ }
  }

  // ── Error screen ──────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md text-center space-y-3">
          <div className="text-4xl">⚠️</div>
          <h2 className="font-semibold text-slate-800">No se pudo iniciar el chat</h2>
          <p className="text-sm text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  // ── Sector selection screen ───────────────────────────────────────────────────
  if (phase === "selecting") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-lg overflow-hidden">
          <div className="bg-blue-600 px-6 py-5 text-white">
            <h1 className="text-xl font-bold">¿En qué área necesitás ayuda?</h1>
            <p className="text-blue-100 text-sm mt-1">Elegí un sector o comenzá a escribir directamente.</p>
          </div>
          <div className="p-4 space-y-2">
            {sectorsLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>
            ) : sectors.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-6">No hay sectores disponibles.</p>
            ) : (
              sectors.map(s => (
                <button
                  key={s.id}
                  onClick={() => startChat(s)}
                  className="w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:border-blue-400 hover:bg-blue-50 transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-slate-800 group-hover:text-blue-700">{s.nombre}</span>
                      {s.is_default && <span className="ml-2 text-xs text-slate-400">(predeterminado)</span>}
                      {s.descripcion && <p className="text-xs text-slate-500 mt-0.5">{s.descripcion}</p>}
                    </div>
                    <span className="text-slate-300 group-hover:text-blue-400 text-lg">→</span>
                  </div>
                </button>
              ))
            )}
          </div>
          {!sectorsLoading && sectors.length > 0 && (
            <div className="px-4 pb-4">
              <div className="relative">
                <input
                  className="w-full border border-slate-200 rounded-xl px-4 py-3 pr-12 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  placeholder="O escribí tu consulta y te asignamos automáticamente..."
                  onKeyDown={e => {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (e.key === "Enter" && val) {
                      const def = sectors.find(s => s.is_default) || sectors[0];
                      startChat(def, val);
                    }
                  }}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 text-xs">↵</span>
              </div>
              <p className="text-xs text-slate-400 mt-2 text-center">
                Si no elegís un sector, te asignamos a <strong>{sectors.find(s => s.is_default)?.nombre || sectors[0]?.nombre}</strong>
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Chat view ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg flex flex-col" style={{ height: "600px" }}>
        {/* Header */}
        <div className="bg-blue-600 px-4 py-3 rounded-t-2xl flex items-center justify-between">
          <div>
            <h2 className="text-white font-semibold text-sm">{selectedSector?.nombre}</h2>
            <span className="text-blue-200 text-xs">
              {status === "human_attending" ? "Operador conectado" : status === "handoff_requested" ? "Esperando operador..." : "Asistente virtual"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={requestHuman}
              className="text-blue-200 hover:text-white text-xs flex items-center gap-1 border border-blue-400 rounded-lg px-2 py-1 hover:border-white transition-colors"
              title="Hablar con un operador"
            >
              <User className="h-3 w-3" /> Operador
            </button>
            <button
              onClick={() => {
                if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                setPhase("selecting");
                setConversationId(null);
                setMessages([]);
              }}
              className="text-blue-200 hover:text-white text-xs border border-blue-400 rounded-lg px-2 py-1 hover:border-white transition-colors"
            >
              Cambiar área
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map(m => (
            <div
              key={m.id}
              className={
                m.role === "user" ? "flex justify-end"
                : m.role === "system" ? "flex justify-center"
                : "flex justify-start"
              }
            >
              <div className={
                m.role === "user"
                  ? "bg-blue-600 text-white rounded-2xl rounded-br-sm px-4 py-2 max-w-xs text-sm"
                  : m.role === "operator"
                  ? "bg-emerald-50 border border-emerald-200 text-slate-800 rounded-2xl rounded-bl-sm px-4 py-2 max-w-xs text-sm"
                  : m.role === "system"
                  ? "bg-amber-50 border border-amber-200 text-amber-800 rounded-full px-4 py-1.5 text-xs text-center max-w-xs"
                  : "bg-slate-100 text-slate-800 rounded-2xl rounded-bl-sm px-4 py-2 max-w-xs text-sm"
              }>
                {m.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-slate-100 rounded-2xl rounded-bl-sm px-4 py-2 text-slate-400 text-sm">Escribiendo…</div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t p-3 flex gap-2">
          <input
            className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            placeholder="Escribí tu consulta..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            disabled={sending}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || sending}
            className="bg-blue-600 text-white rounded-xl px-3 py-2 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
