"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { MessageSquare, Trash2, Zap, Clock } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ChatInput } from "@/components/chat/chat-input";
import { useAuthStore, type ChatMessage } from "@/lib/store";
import { api } from "@/lib/api";
import { toast } from "@/components/ui/toast";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface Sector { id: string; nombre: string; descripcion: string | null; is_default: boolean; is_active: boolean; }

export default function DashboardPage() {
  const { tenantId } = useAuthStore();

  const [widgetToken, setWidgetToken]       = useState<string | null>(null);
  const [sectors, setSectors]               = useState<Sector[]>([]);
  const [sectorsLoading, setSectorsLoading] = useState(true);
  const [selectedSector, setSelectedSector] = useState<Sector | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages]             = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping]             = useState(false);
  const [status, setStatus]                 = useState("bot_active");
  const bottomRef                           = useRef<HTMLDivElement>(null);
  const pollRef                             = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionId                           = useRef("admin_" + Date.now());

  const totalLatency = messages.filter(m => m.role === "assistant" && m.latency_ms).reduce((s, m) => s + (m.latency_ms ?? 0), 0);
  const answeredCount = messages.filter(m => m.role === "assistant" && !m.isLoading).length;
  const cachedCount = messages.filter(m => m.from_cache).length;

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isTyping]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  useEffect(() => {
    if (!tenantId) return;
    api.tenants.generateWidgetToken(tenantId)
      .then(d => setWidgetToken(d.widget_token))
      .catch(() => toast({ title: "Error al inicializar el chat", variant: "destructive" }));
    api.sectors.list()
      .then(data => { setSectors(data.filter(s => s.is_active)); setSectorsLoading(false); })
      .catch(() => setSectorsLoading(false));
  }, [tenantId]);

  function wHeaders() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${widgetToken}`, "X-Tenant-ID": tenantId || "" };
  }

  const pollMessages = useCallback(async (convId: string, token: string) => {
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${convId}/poll`, {
        headers: { Authorization: `Bearer ${token}`, "X-Tenant-ID": tenantId || "" },
      });
      if (!r.ok) return;
      const data = await r.json();
      // Never overwrite with empty — only update when DB has actual messages
      if (!data.messages || data.messages.length === 0) return;
      setMessages(
        data.messages.map((m: { id: string; sender_type: string; content: string }) => ({
          id: m.id,
          role: m.sender_type === "user" ? "user" : "assistant",
          content: m.content,
          timestamp: Date.now(),
        } as ChatMessage))
      );
      setStatus(data.status);
    } catch { /* ignore */ }
  }, [tenantId]);

  async function startChat(sector: Sector, pendingMessage?: string) {
    if (!widgetToken) { toast({ title: "Iniciando…", description: "Esperá un momento e intentá de nuevo." }); return; }
    setSelectedSector(sector);
    // Show loading bubble immediately — don't flash blank screen
    const loadingId = "welcome_loading";
    setMessages([{ id: loadingId, role: "assistant", content: "", isLoading: true, timestamp: Date.now() }]);
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/start`, {
        method: "POST",
        headers: wHeaders(),
        body: JSON.stringify({ widget_session_id: sessionId.current, sector_id: sector.id }),
      });
      const data = await r.json();
      setConversationId(data.conversation_id);
      setStatus(data.status);

      if (data.resumed) {
        await pollMessages(data.conversation_id, widgetToken);
      } else {
        setMessages([{
          id: "welcome",
          role: "assistant",
          content: `¡Gracias por elegir **${sector.nombre}**! Soy tu asistente virtual. ¿En qué te puedo ayudar hoy?`,
          timestamp: Date.now(),
        }]);
      }

      if (pendingMessage) await doSend(data.conversation_id, pendingMessage);
    } catch {
      setMessages([]);
      toast({ title: "Error al iniciar el chat", variant: "destructive" });
    }
  }

  async function doSend(convId: string, text: string) {
    if (!widgetToken) return;
    // Start polling on first message send
    if (!pollRef.current) {
      pollRef.current = setInterval(() => pollMessages(convId, widgetToken), 4000);
    }
    const start = Date.now();
    const loadingId = "loading_" + Date.now();
    setMessages(prev => [
      ...prev,
      { id: Date.now().toString(), role: "user", content: text, timestamp: Date.now() },
      { id: loadingId, role: "assistant", content: "", isLoading: true, timestamp: Date.now() },
    ]);
    setIsTyping(true);
    try {
      const r = await fetch(`${API_BASE}/api/v1/widget/conversation/${convId}/message`, {
        method: "POST",
        headers: wHeaders(),
        body: JSON.stringify({ content: text, widget_session_id: sessionId.current }),
      });
      const data = await r.json();
      setStatus(data.status);
      const latency = Date.now() - start;
      setMessages(prev => prev.map(m =>
        m.id === loadingId
          ? { ...m, content: data.bot_response || "…", isLoading: false, latency_ms: latency, from_cache: data.from_cache }
          : m
      ));
      if (data.handoff_offered && data.handoff_message) {
        setMessages(prev => [...prev, { id: Date.now().toString() + "h", role: "assistant", content: data.handoff_message, timestamp: Date.now() }]);
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === loadingId ? { ...m, content: "Error al enviar. Intentá de nuevo.", isLoading: false } : m));
    } finally {
      setIsTyping(false);
    }
  }

  function handleSend(text: string) {
    if (!conversationId) return;
    doSend(conversationId, text);
  }

  function clearChat() {
    if (pollRef.current) clearInterval(pollRef.current);
    setSelectedSector(null);
    setConversationId(null);
    setMessages([]);
    setIsTyping(false);
    sessionId.current = "admin_" + Date.now();
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h1 className="font-semibold">Consultas</h1>
          {tenantId && <Badge variant="outline" className="text-xs font-mono">{tenantId}</Badge>}
          {selectedSector && <Badge variant="secondary" className="text-xs">{selectedSector.nombre}</Badge>}
          {status === "human_attending" && <Badge className="text-xs bg-emerald-100 text-emerald-700 border-emerald-300">Operador conectado</Badge>}
          {status === "handoff_requested" && <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-300">Esperando operador…</Badge>}
        </div>
        <div className="flex items-center gap-3">
          {answeredCount > 0 && (
            <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground">
              {cachedCount > 0 && (
                <span className="flex items-center gap-1">
                  <Zap className="h-3 w-3 text-amber-500" />
                  {cachedCount} desde caché
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {Math.round(totalLatency / answeredCount / 100) / 10}s promedio
              </span>
            </div>
          )}
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearChat} className="text-muted-foreground">
              <Trash2 className="h-4 w-4 mr-1" />
              {selectedSector ? "Cambiar sector" : "Limpiar"}
            </Button>
          )}
        </div>
      </div>

      {/* Messages / Empty state */}
      <ScrollArea className="flex-1 px-4 py-4">
        {messages.length === 0 ? (
          <div className="space-y-4 max-w-3xl mx-auto">
            {/* Bot welcome message with sector picker */}
            <div className="flex gap-3 items-start">
              <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-primary text-xs font-bold">IA</span>
              </div>
              <div className="space-y-3 flex-1">
                <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3 text-sm inline-block">
                  ¡Hola! Soy el asistente de tu organización. ¿En qué área necesitás ayuda?
                </div>
                {sectorsLoading ? (
                  <div className="flex flex-wrap gap-2">
                    {[1,2,3].map(i => <Skeleton key={i} className="h-9 w-28 rounded-lg" />)}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {sectors.map(s => (
                      <button
                        key={s.id}
                        onClick={() => startChat(s)}
                        disabled={!widgetToken}
                        className="px-4 py-2 rounded-lg border text-sm font-medium transition-all hover:border-primary/50 hover:bg-accent hover:shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {s.nombre}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div ref={bottomRef} />
          </div>
        ) : (
          <div className="space-y-4 max-w-3xl mx-auto">
            {messages.map(msg => <MessageBubble key={msg.id} message={msg} />)}
            {isTyping && !messages.some(m => m.isLoading) && (
              <div className="flex gap-3 items-start">
                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-primary text-xs font-bold">IA</span>
                </div>
                <div className="text-xs text-muted-foreground mt-2">Procesando consulta…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </ScrollArea>

      {/* Input — always visible */}
      <div className="px-4 pb-4 pt-2 max-w-3xl mx-auto w-full">
        <ChatInput
          onSend={text => {
            if (selectedSector && conversationId) {
              handleSend(text);
            } else {
              const def = sectors.find(s => s.is_default) || sectors[0];
              if (def) startChat(def, text);
            }
          }}
          disabled={isTyping || (!widgetToken && !selectedSector)}
          placeholder={selectedSector ? "Escribí tu consulta…" : "Escribí tu consulta y te asignamos al sector correcto…"}
        />
        <p className="text-xs text-muted-foreground text-center mt-2">
          Enter para enviar · Shift+Enter para nueva línea
        </p>
      </div>
    </div>
  );
}

