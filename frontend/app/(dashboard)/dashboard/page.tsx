"use client";

import { useEffect, useRef } from "react";
import { MessageSquare, Trash2, Zap, Clock } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ChatInput } from "@/components/chat/chat-input";
import { useChatStore, useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { toast } from "@/components/ui/toast";

const SUGGESTED_QUESTIONS = [
  "¿Cuáles son los procedimientos de onboarding para nuevos empleados?",
  "¿Quién es el responsable de aprobar solicitudes de vacaciones?",
  "¿Cuáles son los beneficios de salud que ofrece la organización?",
  "¿Cómo funciona la política de trabajo remoto?",
];

export default function DashboardPage() {
  const { messages, isTyping, addMessage, updateMessage, clearMessages, setTyping } = useChatStore();
  const { tenantId } = useAuthStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSend = async (question: string) => {
    addMessage({ role: "user", content: question });
    const loadingId = addMessage({ role: "assistant", content: "", isLoading: true });
    setTyping(true);

    try {
      const data = await api.query.ask(question);
      updateMessage(loadingId, {
        content: data.answer,
        sources: data.sources,
        intent_label: data.intent_label ?? undefined,
        from_cache: data.from_cache,
        latency_ms: data.latency_ms,
        isLoading: false,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.detail || "Hubo un error al procesar tu consulta. Intentá de nuevo.";
      updateMessage(loadingId, { content: msg, isLoading: false });
      toast({ title: "Error en la consulta", description: msg, variant: "destructive" });
    } finally {
      setTyping(false);
    }
  };

  const totalLatency = messages
    .filter((m) => m.role === "assistant" && m.latency_ms && !m.isLoading)
    .reduce((sum, m) => sum + (m.latency_ms ?? 0), 0);
  const answeredCount = messages.filter((m) => m.role === "assistant" && !m.isLoading && m.content).length;
  const cachedCount = messages.filter((m) => m.from_cache).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h1 className="font-semibold">Consultas</h1>
          {tenantId && (
            <Badge variant="outline" className="text-xs font-mono">{tenantId}</Badge>
          )}
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
              {answeredCount > 0 && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {Math.round(totalLatency / answeredCount / 100) / 10}s promedio
                </span>
              )}
            </div>
          )}
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearMessages} className="text-muted-foreground">
              <Trash2 className="h-4 w-4 mr-1" />
              Limpiar
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4 py-4">
        {messages.length === 0 ? (
          <EmptyState onSuggestion={handleSend} />
        ) : (
          <div className="space-y-4 max-w-3xl mx-auto">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {isTyping && (
              <div className="flex gap-3 items-start">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <div className="flex gap-0.5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-1 h-1 rounded-full bg-primary animate-bounce"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground mt-2">Procesando consulta…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <div className="px-4 pb-4 pt-2 max-w-3xl mx-auto w-full">
        <ChatInput onSend={handleSend} disabled={isTyping} />
        <p className="text-xs text-muted-foreground text-center mt-2">
          Enter para enviar · Shift+Enter para nueva línea
        </p>
      </div>
    </div>
  );
}

function EmptyState({ onSuggestion }: { onSuggestion: (q: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-4 space-y-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <MessageSquare className="h-8 w-8 text-primary" />
      </div>
      <div>
        <h2 className="text-xl font-semibold mb-2">¿En qué puedo ayudarte?</h2>
        <p className="text-muted-foreground text-sm max-w-sm">
          Hacé una pregunta sobre el conocimiento de tu organización.
          Respondo basándome únicamente en los documentos cargados.
        </p>
      </div>
      <div className="grid gap-2 w-full max-w-md">
        {SUGGESTED_QUESTIONS.map((q) => (
          <button
            key={q}
            onClick={() => onSuggestion(q)}
            className="text-left text-sm px-4 py-2.5 rounded-lg border hover:bg-accent hover:border-primary/30 transition-colors"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
