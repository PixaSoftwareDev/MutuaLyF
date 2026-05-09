"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, RefreshCw, Loader2, Send, UserCheck,
  XCircle, User, Bot, Info, Eye, ChevronDown, Search, Flame,
} from "lucide-react";
import { api, type ConversationRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<string, string> = {
  bot_active:        "Bot activo",
  handoff_requested: "En espera",
  human_attending:   "En atención",
  closed:            "Cerrado",
};
const STATUS_VARIANT: Record<string, any> = {
  bot_active:        "secondary",
  handoff_requested: "warning",
  human_attending:   "success",
  closed:            "outline",
};

const SENDER_ICONS: Record<string, React.ReactNode> = {
  user:     <User className="h-3.5 w-3.5" />,
  bot:      <Bot className="h-3.5 w-3.5" />,
  operator: <UserCheck className="h-3.5 w-3.5" />,
  system:   <Info className="h-3.5 w-3.5" />,
};

const URGENT_THRESHOLD_MS = 60_000; // 1 min in handoff_requested → urgent
const CLOSED_LIMIT = 20;
const COLLAPSED_KEY = "ia_ops_collapsed_v1";

type SectionKey = "handoff_requested" | "human_attending" | "bot_active" | "closed";

const SECTION_DEFS: Array<{ key: SectionKey; label: string; defaultOpen: boolean; tone: string }> = [
  { key: "handoff_requested", label: "En espera",   defaultOpen: true,  tone: "text-amber-700" },
  { key: "human_attending",   label: "En atención", defaultOpen: true,  tone: "text-emerald-700" },
  { key: "bot_active",        label: "Bot activo",  defaultOpen: false, tone: "text-slate-600" },
  { key: "closed",            label: "Cerradas recientes", defaultOpen: false, tone: "text-slate-500" },
];

export type ConversationsPanelMode = "operator" | "admin-readonly";

export function ConversationsPanel({ mode }: { mode: ConversationsPanelMode }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyText, setReplyText]   = useState("");
  const [search, setSearch]         = useState("");
  const [sectorFilter, setSectorFilter] = useState<string>("all");
  const [now, setNow]               = useState<number>(() => Date.now());

  const readOnly = mode === "admin-readonly";

  // Tick every 5s so relative timestamps and urgency flags stay fresh
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  // Collapsed sections persisted in localStorage
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* ignore */ }
  }, [collapsed]);

  const isCollapsed = (key: SectionKey) => {
    const stored = collapsed[key];
    if (stored === undefined) {
      const def = SECTION_DEFS.find(s => s.key === key)!;
      return !def.defaultOpen;
    }
    return stored;
  };
  const toggleSection = (key: SectionKey) => setCollapsed(prev => ({ ...prev, [key]: !isCollapsed(key) }));

  // Fetch all conversations (no status filter — we segment client-side)
  const { data, isLoading, error } = useQuery({
    queryKey: ["operator-conversations", "all", mode],
    queryFn: () => api.operator.listConversations(),
    staleTime: 4_000,
    refetchInterval: 5000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["conversation-detail", selectedId],
    queryFn: () => api.operator.getConversation(selectedId!),
    enabled: !!selectedId,
    staleTime: 4_000,
    refetchInterval: 5000,
  });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["operator-conversations"] });
    qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] });
  };

  const acceptM = useMutation({
    mutationFn: (id: string) => api.operator.accept(id),
    onSuccess: () => { inv(); toast({ title: "Conversación aceptada", variant: "success" }); },
  });
  const closeM  = useMutation({
    mutationFn: (id: string) => api.operator.close(id),
    onSuccess: () => { inv(); toast({ title: "Conversación cerrada" }); },
  });
  const replyM  = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => api.operator.reply(id, content),
    onSuccess: () => { inv(); setReplyText(""); },
    onError:   () => toast({ title: "Error al enviar", variant: "destructive" }),
  });

  const allConversations: ConversationRow[] = data?.sectors.flatMap(s => s.conversations) ?? [];
  const sectorOptions = useMemo(
    () => Array.from(new Set(allConversations.map(c => c.sector_nombre).filter(Boolean) as string[])).sort(),
    [allConversations],
  );

  // Filter by search + sector
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allConversations.filter(c => {
      if (sectorFilter !== "all" && c.sector_nombre !== sectorFilter) return false;
      if (!q) return true;
      const name = (c.afiliado_nombre || "").toLowerCase();
      const sec  = (c.sector_nombre   || "").toLowerCase();
      return name.includes(q) || sec.includes(q);
    });
  }, [allConversations, search, sectorFilter]);

  // Segment by section + sort within
  const sections = useMemo(() => segmentAndSort(filtered, now), [filtered, now]);

  const handoffWaitingCount = sections.handoff_requested.length;

  // Update tab title with handoff count (operator only)
  useEffect(() => {
    if (mode !== "operator") return;
    const original = document.title;
    document.title = handoffWaitingCount > 0 ? `(${handoffWaitingCount}) Panel Operador` : "Panel Operador";
    return () => { document.title = original; };
  }, [handoffWaitingCount, mode]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: queue */}
      <div className="w-80 border-r flex flex-col shrink-0">
        <div className="p-4 border-b flex items-center justify-between">
          <h1 className="font-semibold flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-primary" />
            {readOnly ? "Conversaciones" : "Panel Operador"}
            {readOnly && (
              <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0 h-5">
                <Eye className="h-3 w-3" />
                Solo lectura
              </Badge>
            )}
          </h1>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={inv} title="Refrescar">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* Search + sector filter */}
        <div className="px-3 pt-3 pb-2 space-y-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Buscar afiliado o sector…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          {sectorOptions.length > 1 && (
            <select
              value={sectorFilter}
              onChange={e => setSectorFilter(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">Todos los sectores</option>
              {sectorOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>

        {/* Sectioned list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)
          ) : error ? (
            <p className="text-xs text-destructive text-center py-8">Error al cargar</p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">
              {search || sectorFilter !== "all" ? "Sin resultados" : "Sin conversaciones"}
            </p>
          ) : (
            SECTION_DEFS.map(def => {
              const items = sections[def.key];
              if (items.length === 0) return null;
              const collapsedNow = isCollapsed(def.key);
              return (
                <div key={def.key}>
                  <button
                    onClick={() => toggleSection(def.key)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronDown className={cn("h-3 w-3 transition-transform", collapsedNow && "-rotate-90")} />
                    <span className={def.tone}>{def.label}</span>
                    <span className="ml-auto text-muted-foreground/70 normal-case font-normal">
                      {items.length}
                    </span>
                  </button>
                  {!collapsedNow && (
                    <div className="space-y-1 mt-1">
                      {items.map(conv => (
                        <ConvCard
                          key={conv.id}
                          conv={conv}
                          now={now}
                          selected={selectedId === conv.id}
                          onClick={() => setSelectedId(conv.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right: detail */}
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
            <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-sm">{detail.afiliado_nombre || "Afiliado anónimo"}</p>
                <p className="text-xs text-muted-foreground">{detail.afiliado_email || ""} · {detail.sector_nombre}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={STATUS_VARIANT[detail.status]}>{STATUS_LABELS[detail.status]}</Badge>

                {!readOnly && detail.status === "handoff_requested" && (
                  <Button size="sm" onClick={() => acceptM.mutate(detail.id)} disabled={acceptM.isPending}>
                    {acceptM.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <UserCheck className="h-4 w-4 mr-1" />}
                    Aceptar
                  </Button>
                )}
                {!readOnly && detail.status === "human_attending" && (
                  <Button size="sm" variant="outline" onClick={() => closeM.mutate(detail.id)} disabled={closeM.isPending}>
                    <XCircle className="h-4 w-4 mr-1" />
                    Cerrar
                  </Button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {detail.messages.map(m => (
                <MessageBubble key={m.id} msg={m} />
              ))}
            </div>

            {!readOnly && detail.status === "human_attending" && (
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function segmentAndSort(convs: ConversationRow[], now: number): Record<SectionKey, ConversationRow[]> {
  const out: Record<SectionKey, ConversationRow[]> = {
    handoff_requested: [],
    human_attending:   [],
    bot_active:        [],
    closed:            [],
  };
  for (const c of convs) {
    if (c.status in out) out[c.status as SectionKey].push(c);
  }
  // En espera: oldest first (FIFO — quien más esperó atiende primero)
  out.handoff_requested.sort((a, b) =>
    msSince(a.last_message_at ?? a.created_at, now) - msSince(b.last_message_at ?? b.created_at, now)
  );
  // En atención: tu turno primero (último msg = afiliado), por antigüedad de ese mensaje DESC
  out.human_attending.sort((a, b) => {
    const aWaiting = a.last_message_sender === "user" ? 1 : 0;
    const bWaiting = b.last_message_sender === "user" ? 1 : 0;
    if (aWaiting !== bWaiting) return bWaiting - aWaiting;
    return msSince(a.last_message_at ?? a.created_at, now) - msSince(b.last_message_at ?? b.created_at, now);
  });
  // Bot activo: más reciente arriba
  out.bot_active.sort((a, b) =>
    msSince(b.last_message_at ?? b.created_at, now) - msSince(a.last_message_at ?? a.created_at, now)
  );
  // Cerradas: más reciente arriba, limitadas
  out.closed.sort((a, b) =>
    msSince(b.last_message_at ?? b.created_at, now) - msSince(a.last_message_at ?? a.created_at, now)
  );
  out.closed = out.closed.slice(0, CLOSED_LIMIT);
  return out;
}

function msSince(iso: string | null | undefined, now: number): number {
  if (!iso) return Infinity;
  return now - new Date(iso).getTime();
}

function formatRelative(ms: number): string {
  if (!isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
}

// ── Conversation card ──────────────────────────────────────────────────────────

function ConvCard({
  conv, now, selected, onClick,
}: {
  conv: ConversationRow;
  now: number;
  selected: boolean;
  onClick: () => void;
}) {
  const ms = msSince(conv.last_message_at ?? conv.created_at, now);
  const ageStr = formatRelative(ms);
  const isUrgent = conv.status === "handoff_requested" && ms > URGENT_THRESHOLD_MS;
  const yourTurn = conv.status === "human_attending" && conv.last_message_sender === "user";

  // Border color by status (left edge accent)
  const borderClass =
    conv.status === "handoff_requested" ? (isUrgent ? "border-l-red-500" : "border-l-amber-400") :
    conv.status === "human_attending"   ? "border-l-emerald-500" :
    conv.status === "bot_active"        ? "border-l-slate-300" :
    "border-l-transparent";

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-lg px-3 py-2 transition-colors hover:bg-accent border-l-2",
        borderClass,
        selected && "bg-accent ring-1 ring-primary/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {isUrgent && <Flame className="h-3.5 w-3.5 text-red-500 shrink-0 animate-pulse" />}
          <p className="text-sm font-medium truncate">{conv.afiliado_nombre || "Anónimo"}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {conv.unread_count > 0 && (
            <span className="bg-primary text-white rounded-full text-[10px] w-4 h-4 flex items-center justify-center font-bold">
              {conv.unread_count}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">{ageStr}</span>
        </div>
      </div>
      <div className="flex items-center justify-between mt-0.5 gap-2">
        <p className="text-xs text-muted-foreground truncate">{conv.sector_nombre || "Sin sector"}</p>
        {yourTurn && (
          <span className="text-[10px] font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded px-1.5 py-0 shrink-0">
            tu turno
          </span>
        )}
      </div>
    </button>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: { id: string; sender_type: string; content: string; created_at: string } }) {
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
