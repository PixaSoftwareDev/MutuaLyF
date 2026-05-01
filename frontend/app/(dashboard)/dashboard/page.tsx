"use client";

import { useEffect, useRef } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ChatInput } from "@/components/chat/chat-input";
import { useChatStore } from "@/lib/store";
import { api } from "@/lib/api";

const SUGGESTED_QUESTIONS = [
  "¿Cuáles son los procedimientos de onboarding?",
  "¿Quién es responsable de aprobar presupuestos?",
  "¿Cuáles son los horarios de atención al cliente?",
];

export default function DashboardPage() {
  const { messages, isTyping, addMessage, updateMessage, clearMessages, setTyping } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSend = async (question: string) => {
    // Add user message
    addMessage({ role: "user", content: question });

    // Add loading assistant message
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
    } finally {
      setTyping(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h1 className="font-semibold text-lg">Consultas</h1>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearMessages} className="text-muted-foreground">
            <Trash2 className="h-4 w-4 mr-1" />
            Limpiar
          </Button>
        )}
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
    <div className="flex flex-col items-center justify-center h-full py-16 px-4 space-y-6">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
        <MessageSquare className="h-7 w-7 text-primary" />
      </div>
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-1">¿En qué puedo ayudarte?</h2>
        <p className="text-muted-foreground text-sm">
          Hacé una pregunta sobre el conocimiento de tu organización
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full max-w-md">
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
