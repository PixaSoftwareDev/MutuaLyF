"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, RefreshCw, Loader2, Send, UserCheck,
  ArrowRightLeft, XCircle, User, Bot, Info,
} from "lucide-react";
import { api, type ConversationRow, type ConversationDetail } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<string, string> = {
  bot_active:       "Bot activo",
  handoff_requested:"En espera",
  human_attending:  "En atención",
  closed:           "Cerrado",
};
const STATUS_VARIANT: Record<string, any> = {
  bot_active:       "secondary",
  handoff_requested:"warning",
  human_attending:  "success",
  closed:           "outline",
};

const SENDER_ICONS: Record<string, React.ReactNode> = {
  user:     <User className="h-3.5 w-3.5" />,
  bot:      <Bot className="h-3.5 w-3.5" />,
  operator: <UserCheck className="h-3.5 w-3.5" />,
  system:   <Info className="h-3.5 w-3.5" />,
};

export default function OperatorPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [activeTab, setActiveTab] = useState("handoff_requested");

  const { data, isLoading, error } = useQuery({
    queryKey: ["operator-conversations", activeTab],
    queryFn: () => api.operator.listConversations(activeTab === "all" ? undefined : activeTab),
    refetchInterval: 5000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["conversation-detail", selectedId],
    queryFn: () => api.operator.getConversation(selectedId!),
    enabled: !!selectedId,
    refetchInterval: 5000,
  });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["operator-conversations"] });
    qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] });
  };

  const acceptM  = useMutation({ mutationFn: (id: string) => api.operator.accept(id),   onSuccess: () => { inv(); toast({ title: "Conversación aceptada", variant: "success" }); } });
  const closeM   = useMutation({ mutationFn: (id: string) => api.operator.close(id),    onSuccess: () => { inv(); toast({ title: "Conversación cerrada" }); } });
  const replyM   = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => api.operator.reply(id, content),
    onSuccess: () => { inv(); setReplyText(""); },
    onError: () => toast({ title: "Error al enviar", variant: "destructive" }),
  });

  const allConversations = data?.sectors.flatMap(s => s.conversations) ?? [];
  const sectors = data?.sectors ?? [];

  const statusTabs = [
    { key: "handoff_requested", label: "En espera" },
    { key: "human_attending",   label: "En atención" },
    { key: "all",               label: "Todas" },
    { key: "closed",            label: "Cerradas" },
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left: conversation list */}
      <div className="w-80 border-r flex flex-col shrink-0">
        <div className="p-4 border-b flex items-center justify-between">
          <h1 className="font-semibold flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-primary" />
            Panel Operador
          </h1>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={inv}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-3 mt-2 grid grid-cols-4 h-8">
            {statusTabs.map(t => (
              <TabsTrigger key={t.key} value={t.key} className="text-xs px-1">{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto p-2 space-y-1 mt-2">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)
            ) : error ? (
              <p className="text-xs text-destructive text-center py-8">Error al cargar</p>
            ) : allConversations.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">Sin conversaciones</p>
            ) : (
              allConversations.map(conv => (
                <ConvCard
                  key={conv.id}
                  conv={conv}
                  selected={selectedId === conv.id}
                  onClick={() => setSelectedId(conv.id)}
                />
              ))
            )}
          </div>
        </Tabs>
      </div>

      {/* Right: conversation detail */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            <div className="text-center space-y-2">
              <MessageSquare className="h-10 w-10 mx-auto opacity-20" />
              <p>Seleccioná una conversación</p>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : detail ? (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-sm">{detail.afiliado_nombre || "Afiliado anónimo"}</p>
                <p className="text-xs text-muted-foreground">{detail.afiliado_email || ""} · {detail.sector_nombre}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={STATUS_VARIANT[detail.status]}>{STATUS_LABELS[detail.status]}</Badge>

                {detail.status === "handoff_requested" && (
                  <Button size="sm" onClick={() => acceptM.mutate(detail.id)} disabled={acceptM.isPending}>
                    {acceptM.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <UserCheck className="h-4 w-4 mr-1" />}
                    Aceptar
                  </Button>
                )}
                {detail.status === "human_attending" && (
                  <Button size="sm" variant="outline" onClick={() => closeM.mutate(detail.id)} disabled={closeM.isPending}>
                    <XCircle className="h-4 w-4 mr-1" />
                    Cerrar
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {detail.messages.map(m => (
                <MessageBubble key={m.id} msg={m} />
              ))}
            </div>

            {/* Reply box */}
            {detail.status === "human_attending" && (
              <div className="px-4 py-3 border-t flex gap-2">
                <Input
                  placeholder="Escribí tu respuesta…"
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey && replyText.trim()) {
                      e.preventDefault();
                      replyM.mutate({ id: detail.id, content: replyText.trim() });
                    }
                  }}
                />
                <Button
                  disabled={!replyText.trim() || replyM.isPending}
                  onClick={() => replyM.mutate({ id: detail.id, content: replyText.trim() })}
                >
                  {replyM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ConvCard({ conv, selected, onClick }: { conv: ConversationRow; selected: boolean; onClick: () => void }) {
  const ago = conv.last_message_at
    ? new Date(conv.last_message_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
    : "";
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-lg px-3 py-2.5 transition-colors hover:bg-accent",
        selected && "bg-accent ring-1 ring-primary/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium truncate">{conv.afiliado_nombre || "Anónimo"}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          {conv.unread_count > 0 && (
            <span className="bg-primary text-white rounded-full text-[10px] w-4 h-4 flex items-center justify-center font-bold">
              {conv.unread_count}
            </span>
          )}
          <Badge variant={STATUS_VARIANT[conv.status]} className="text-[10px] h-4 px-1.5">
            {STATUS_LABELS[conv.status]}
          </Badge>
        </div>
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <p className="text-xs text-muted-foreground truncate">{conv.sector_nombre}</p>
        <p className="text-xs text-muted-foreground shrink-0">{ago}</p>
      </div>
    </button>
  );
}

function MessageBubble({ msg }: { msg: { sender_type: string; content: string; created_at: string } }) {
  const isUser     = msg.sender_type === "user";
  const isSystem   = msg.sender_type === "system";
  const isOperator = msg.sender_type === "operator";

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-3 py-1">
          {msg.content}
        </span>
      </div>
    );
  }

  const time = new Date(msg.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5",
          isOperator ? "bg-emerald-100 text-emerald-700" : "bg-primary/10 text-primary",
        )}>
          {SENDER_ICONS[msg.sender_type]}
        </div>
      )}
      <div className={cn(
        "max-w-[70%] rounded-lg px-3 py-2 text-sm",
        isUser     && "bg-primary text-white rounded-br-sm",
        isOperator && "bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-bl-sm",
        !isUser && !isOperator && "bg-muted text-foreground rounded-bl-sm",
      )}>
        <p className="leading-relaxed">{msg.content}</p>
        <p className={cn("text-[10px] mt-1 opacity-60", isUser && "text-right")}>{time}</p>
      </div>
    </div>
  );
}
