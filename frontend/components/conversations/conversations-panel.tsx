"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Loader2, Send, UserCheck, XCircle, User, Bot,
  Info, ChevronDown, Search, Flame, ArrowRightLeft, Eye, Wifi, WifiOff, Circle,
} from "lucide-react";
import { api, type ConversationRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const URGENT_MS   = 120_000; // 2 min waiting → urgent
const CLOSED_LIMIT = 15;
const COLLAPSED_KEY = "ia_ops_collapsed_v2";

type SectionKey = "handoff_requested" | "human_attending" | "closed" | "bot_active";

const SECTION_DEFS: Array<{ key: SectionKey; label: string; tone: string; defaultOpen: boolean }> = [
  { key: "handoff_requested", label: "En espera",   tone: "text-amber-600",   defaultOpen: true },
  { key: "human_attending",   label: "En atención", tone: "text-emerald-600", defaultOpen: true },
  { key: "closed",            label: "Cerradas",    tone: "text-slate-500",   defaultOpen: false },
];

export type ConversationsPanelMode = "operator" | "admin-readonly";

// ── Main component ────────────────────────────────────────────────────────────

export function ConversationsPanel({ mode }: { mode: ConversationsPanelMode }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [replyText, setReplyText]       = useState("");
  const [search, setSearch]             = useState("");
  const [sectorFilter, setSectorFilter] = useState<string>("all");
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferSector, setTransferSector] = useState("");
  const [sseConnected, setSseConnected] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const handoffIds     = useRef<Set<string>>(new Set());
  const readOnly = mode === "admin-readonly";

  // Tick for relative timestamps + urgency
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // Collapsed sections
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}"); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* ignore */ }
  }, [collapsed]);

  const isCollapsed  = (k: SectionKey) => {
    if (k in collapsed) return collapsed[k];
    const def = SECTION_DEFS.find(s => s.key === k);
    return def ? !def.defaultOpen : false; // bot_active defaults open
  };
  const toggleSection = (k: SectionKey) => setCollapsed(p => ({ ...p, [k]: !isCollapsed(k) }));

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data, isLoading, error } = useQuery({
    queryKey: ["operator-conversations", "all", mode],
    queryFn:  () => api.operator.listConversations(),
    staleTime: 30_000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["conversation-detail", selectedId],
    queryFn:  () => api.operator.getConversation(selectedId!),
    enabled:  !!selectedId,
    staleTime: 30_000,
  });

  const { data: sectorsData } = useQuery({
    queryKey: ["sectors"],
    queryFn:  api.sectors.list,
    staleTime: 60_000,
    enabled:  !readOnly,
  });

  const { data: presenceData } = useQuery({
    queryKey: ["operator-presence"],
    queryFn:  api.operator.presence,
    refetchInterval: 20_000,
    enabled: !readOnly,
  });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["operator-conversations"] });
    qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] });
  };

  // ── SSE ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (mode !== "operator") return;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }

    const base    = process.env.NEXT_PUBLIC_API_URL || "";
    const token   = localStorage.getItem("access_token") ?? "";
    const tenantId = localStorage.getItem("tenant_id") ?? "";
    const es = new EventSource(
      `${base}/api/v1/operator/events?token=${encodeURIComponent(token)}&tenant_id=${encodeURIComponent(tenantId)}`
    );

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        qc.invalidateQueries({ queryKey: ["operator-conversations"] });
        qc.invalidateQueries({ queryKey: ["operator-presence"] });
        if (event.conversation_id && event.conversation_id === selectedId) {
          qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] });
        }
      } catch { /* ignore */ }
    };

    return () => { es.close(); setSseConnected(false); };
  }, [mode, qc, selectedId]);

  // ── Notifications + sound on new handoff ──────────────────────────────────

  useEffect(() => {
    if (mode !== "operator") return;
    const all: ConversationRow[] = data?.sectors.flatMap((s: any) => s.conversations) ?? [];
    const waiting = all.filter(c => c.status === "handoff_requested");

    waiting.forEach(c => {
      if (handoffIds.current.has(c.id)) return;
      handoffIds.current.add(c.id);

      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("Nueva derivación", {
          body: `${c.afiliado_nombre || "Usuario"} — ${c.sector_nombre || ""}`,
          icon: "/favicon.ico",
          tag: c.id,
        });
      }
      try {
        const ctx  = new AudioContext();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        osc.start(); osc.stop(ctx.currentTime + 0.45);
      } catch { /* blocked until user interaction */ }
    });

    const activeIds = new Set(waiting.map(c => c.id));
    handoffIds.current.forEach(id => { if (!activeIds.has(id)) handoffIds.current.delete(id); });
  }, [data, mode]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const acceptM = useMutation({
    mutationFn: (id: string) => api.operator.accept(id),
    onSuccess: (_, id) => {
      inv();
      setSelectedId(id);
      toast({ title: "Conversación aceptada — ya podés responder", variant: "success" });
    },
  });

  const closeM = useMutation({
    mutationFn: (id: string) => api.operator.close(id),
    onSuccess: () => { inv(); toast({ title: "Conversación cerrada" }); },
  });

  const replyM = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => api.operator.reply(id, content),
    onSuccess: () => { inv(); setReplyText(""); textareaRef.current?.focus(); },
    onError:   () => toast({ title: "Error al enviar", variant: "destructive" }),
  });

  const transferM = useMutation({
    mutationFn: ({ id, sectorId }: { id: string; sectorId: string }) =>
      api.operator.transfer(id, sectorId),
    onSuccess: () => {
      inv(); setShowTransfer(false); setTransferSector("");
      toast({ title: "Conversación transferida", variant: "success" });
    },
  });

  // ── Auto-scroll to bottom on new messages ─────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages?.length]);

  // ── Tab title ──────────────────────────────────────────────────────────────

  const allConvs: ConversationRow[] = data?.sectors.flatMap((s: any) => s.conversations) ?? [];
  const waitingCount    = allConvs.filter(c => c.status === "handoff_requested").length;
  const attendingCount  = allConvs.filter(c => c.status === "human_attending").length;

  useEffect(() => {
    if (mode !== "operator") return;
    const original = document.title;
    document.title = waitingCount > 0 ? `(${waitingCount}) Panel Operador` : "Panel Operador";
    return () => { document.title = original; };
  }, [waitingCount, mode]);

  // ── Filtered + segmented ───────────────────────────────────────────────────

  const sectorOptions = useMemo(
    () => Array.from(new Set(allConvs.map(c => c.sector_nombre).filter(Boolean) as string[])).sort(),
    [allConvs],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allConvs.filter(c => {
      if (sectorFilter !== "all" && c.sector_nombre !== sectorFilter) return false;
      if (!q) return true;
      return (c.afiliado_nombre || "").toLowerCase().includes(q) ||
             (c.sector_nombre   || "").toLowerCase().includes(q);
    });
  }, [allConvs, search, sectorFilter]);

  const sections = useMemo(() => segmentAndSort(filtered, now), [filtered, now]);
  // Only show bot_active conversations with activity in the last 30 minutes
  const botActiveConvs = useMemo(() => filtered.filter(c => {
    if (c.status !== "bot_active") return false;
    const lastActivity = c.last_message_at ?? c.created_at;
    return msSince(lastActivity, now) < 30 * 60 * 1000;
  }), [filtered, now]);
  const onlineNames = useMemo(
    () => new Set((presenceData?.operators ?? []).map(o => o.name)),
    [presenceData],
  );

  // Split messages into bot-phase and operator-phase for context separation
  const { botMessages, operatorMessages } = useMemo(() => {
    if (!detail?.messages) return { botMessages: [], operatorMessages: [] };
    const msgs = detail.messages;
    // Split ONLY at the first real operator message — system messages stay in bot phase
    const firstOperatorIdx = msgs.findIndex(m => m.sender_type === "operator");
    if (firstOperatorIdx === -1) return { botMessages: msgs, operatorMessages: [] };
    return { botMessages: msgs.slice(0, firstOperatorIdx), operatorMessages: msgs.slice(firstOperatorIdx) };
  }, [detail?.messages]);

  const availableSectors = (sectorsData as any)?.sectors ?? sectorsData ?? [];

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── LEFT: queue ──────────────────────────────────────────────────── */}
      <div className="w-72 border-r flex flex-col shrink-0 bg-card">

        {/* Header + stats */}
        <div className="px-4 pt-4 pb-3 border-b space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="font-semibold text-sm flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              {readOnly ? "Conversaciones" : "Panel Operador"}
            </h1>
            {!readOnly && (
              <div className="flex items-center gap-1.5" title={sseConnected ? "Tiempo real activo" : "Reconectando..."}>
                {sseConnected
                  ? <Wifi    className="h-3.5 w-3.5 text-emerald-500" />
                  : <WifiOff className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />}
                <span className="text-[10px] text-muted-foreground">{sseConnected ? "En vivo" : "..."}</span>
              </div>
            )}
          </div>

          {/* Online operators */}
          {!readOnly && presenceData && presenceData.operators.length > 0 && (
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">En línea:</span>
              {presenceData.operators.map(op => (
                <span key={op.user_id} className="inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5">
                  <Circle className="h-1.5 w-1.5 fill-emerald-500 text-emerald-500" />
                  {op.name}
                </span>
              ))}
            </div>
          )}
          {!readOnly && presenceData && presenceData.operators.length === 0 && (
            <div className="flex items-center gap-1.5">
              <Circle className="h-2 w-2 fill-slate-300 text-slate-300" />
              <span className="text-[10px] text-muted-foreground">Sin operadores en línea</span>
            </div>
          )}

          {/* Stats pills */}
          {!readOnly && (
            <div className="flex gap-2">
              <span className={cn(
                "flex-1 text-center text-xs font-semibold rounded-md py-1.5",
                waitingCount > 0 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
              )}>
                {waitingCount} en espera
              </span>
              <span className={cn(
                "flex-1 text-center text-xs font-semibold rounded-md py-1.5",
                attendingCount > 0 ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"
              )}>
                {attendingCount} en atención
              </span>
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Buscar…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full h-8 pl-8 pr-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Sector pills */}
          {sectorOptions.length > 1 && (
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setSectorFilter("all")}
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                  sectorFilter === "all" ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary/40"
                )}
              >Todos</button>
              {sectorOptions.map(s => (
                <button
                  key={s}
                  onClick={() => setSectorFilter(sectorFilter === s ? "all" : s)}
                  className={cn(
                    "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                    sectorFilter === s ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary/40"
                  )}
                >{s}</button>
              ))}
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)
          ) : error ? (
            <p className="text-xs text-destructive text-center py-8">Error al cargar</p>
          ) : allConvs.length === 0 && !search && sectorFilter === "all" && !readOnly ? (
            <div className="text-center py-12 px-4 text-muted-foreground space-y-2">
              <MessageSquare className="h-8 w-8 mx-auto opacity-20" />
              <p className="text-sm font-medium text-foreground/70">Sin sectores asignados</p>
              <p className="text-xs leading-relaxed">
                No tenés sectores asignados. Pedile al administrador que te asigne los sectores que vas a atender.
              </p>
            </div>
          ) : filtered.filter(c => c.status !== "bot_active").length === 0 && botActiveConvs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs">{search ? "Sin resultados" : "Sin conversaciones activas"}</p>
            </div>
          ) : (
            <>
              {SECTION_DEFS.map(def => {
                const items = sections[def.key];
                if (items.length === 0) return null;
                const open = !isCollapsed(def.key);
                return (
                  <div key={def.key}>
                    <button
                      onClick={() => toggleSection(def.key)}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} />
                      <span className={def.tone}>{def.label}</span>
                      <span className="ml-auto font-normal">{items.length}</span>
                    </button>
                    {open && (
                      <div className="space-y-1 mb-2">
                        {items.map(conv => (
                          <ConvCard
                            key={conv.id}
                            conv={conv}
                            now={now}
                            selected={selectedId === conv.id}
                            readOnly={readOnly}
                            onlineNames={onlineNames}
                            onSelect={() => setSelectedId(conv.id)}
                            onAccept={() => acceptM.mutate(conv.id)}
                            accepting={acceptM.isPending && acceptM.variables === conv.id}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Bot-active conversations — visible for monitoring */}
              {botActiveConvs.length > 0 && (
                <div>
                  <button
                    onClick={() => toggleSection("bot_active")}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronDown className={cn("h-3 w-3 transition-transform", isCollapsed("bot_active") && "-rotate-90")} />
                    <span className="text-blue-500 flex items-center gap-1">
                      <Bot className="h-3 w-3" />
                      Conversaciones activas ({botActiveConvs.length})
                    </span>
                    <span className="ml-auto w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  </button>
                  {!isCollapsed("bot_active") && (
                    <div className="space-y-1 mb-2">
                      {botActiveConvs.map(conv => (
                        <ConvCard
                          key={conv.id}
                          conv={conv}
                          now={now}
                          selected={selectedId === conv.id}
                          readOnly={true}
                          onlineNames={onlineNames}
                          onSelect={() => setSelectedId(conv.id)}
                          onAccept={() => {}}
                          accepting={false}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── RIGHT: detail ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-2">
              <MessageSquare className="h-10 w-10 mx-auto opacity-15" />
              <p className="text-sm">Seleccioná una conversación</p>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : detail ? (
          <>
            {/* ── Header ── */}
            <div className="px-4 py-3 border-b flex items-center justify-between gap-3 bg-card">
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{detail.afiliado_nombre || "Afiliado anónimo"}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {detail.sector_nombre}
                  {detail.afiliado_email && ` · ${detail.afiliado_email}`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge status={detail.status} />
                {!readOnly && detail.status === "handoff_requested" && (
                  <Button size="sm" className="h-8" onClick={() => acceptM.mutate(detail.id)} disabled={acceptM.isPending}>
                    {acceptM.isPending
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      : <UserCheck className="h-3.5 w-3.5 mr-1.5" />}
                    Atender
                  </Button>
                )}
                {!readOnly && detail.status === "human_attending" && (
                  <>
                    <Button
                      size="sm" variant="outline" className="h-8"
                      onClick={() => setShowTransfer(v => !v)}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                      Transferir
                    </Button>
                    <Button
                      size="sm" variant="outline" className="h-8 text-destructive hover:text-destructive"
                      onClick={() => closeM.mutate(detail.id)}
                      disabled={closeM.isPending}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1.5" />
                      Cerrar
                    </Button>
                  </>
                )}
                {readOnly && <Eye className="h-4 w-4 text-muted-foreground" />}
              </div>
            </div>

            {/* Transfer panel */}
            {showTransfer && (
              <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
                <select
                  value={transferSector}
                  onChange={e => setTransferSector(e.target.value)}
                  className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">Elegí un sector…</option>
                  {availableSectors
                    .filter((s: any) => s.id !== detail.sector_id)
                    .map((s: any) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
                <Button
                  size="sm" className="h-8" disabled={!transferSector || transferM.isPending}
                  onClick={() => transferM.mutate({ id: detail.id, sectorId: transferSector })}
                >
                  {transferM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirmar"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setShowTransfer(false)}>
                  Cancelar
                </Button>
              </div>
            )}

            {/* ── Messages ── */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* Bot phase context (collapsible if long) */}
              {botMessages.length > 0 && (
                <BotPhaseContext messages={botMessages} hasOperatorPhase={operatorMessages.length > 0} />
              )}

              {/* Separator */}
              {operatorMessages.length > 0 && botMessages.length > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 border-t border-dashed border-border" />
                  <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
                    <UserCheck className="h-3 w-3" /> Operador tomó la conversación
                  </span>
                  <div className="flex-1 border-t border-dashed border-border" />
                </div>
              )}

              {/* Operator phase */}
              {operatorMessages.map(m => <MessageBubble key={m.id} msg={m} />)}

              <div ref={messagesEndRef} />
            </div>

            {/* ── Reply ── */}
            {!readOnly && detail.status === "human_attending" && (
              <div className="px-4 py-3 border-t bg-card flex gap-2 items-end">
                <textarea
                  ref={textareaRef}
                  rows={2}
                  placeholder="Escribí tu respuesta… (Enter para enviar, Shift+Enter para nueva línea)"
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey && replyText.trim()) {
                      e.preventDefault();
                      replyM.mutate({ id: detail.id, content: replyText.trim() });
                    }
                  }}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary min-h-[60px] max-h-40"
                />
                <Button
                  className="h-10 px-3 shrink-0"
                  disabled={!replyText.trim() || replyM.isPending}
                  onClick={() => replyM.mutate({ id: detail.id, content: replyText.trim() })}
                >
                  {replyM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            )}

            {/* Prompt to accept */}
            {!readOnly && detail.status === "handoff_requested" && (
              <div className="px-4 py-3 border-t bg-amber-50/60 text-center">
                <p className="text-xs text-amber-700 mb-2">
                  Este usuario está esperando atención humana.
                </p>
                <Button size="sm" onClick={() => acceptM.mutate(detail.id)} disabled={acceptM.isPending}>
                  {acceptM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <UserCheck className="h-3.5 w-3.5 mr-1.5" />}
                  Atender ahora
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    bot_active:        { label: "Bot activo",   cls: "bg-slate-100 text-slate-600" },
    handoff_requested: { label: "En espera",    cls: "bg-amber-100 text-amber-700" },
    human_attending:   { label: "En atención",  cls: "bg-emerald-100 text-emerald-700" },
    closed:            { label: "Cerrada",       cls: "bg-slate-100 text-slate-500" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", s.cls)}>{s.label}</span>;
}

// ── Bot phase context block ────────────────────────────────────────────────────

function BotPhaseContext({ messages, hasOperatorPhase }: {
  messages: { id: string; sender_type: string; content: string; created_at: string }[];
  hasOperatorPhase: boolean;
}) {
  const [expanded, setExpanded] = useState(!hasOperatorPhase);
  const preview = messages.filter(m => m.sender_type !== "system").slice(-3);

  if (!hasOperatorPhase) {
    return <>{messages.map(m => <MessageBubble key={m.id} msg={m} />)}</>;
  }

  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-muted/20">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5" />
          Contexto del bot ({messages.length} mensajes)
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <div className="px-3 pb-3 space-y-2 border-t border-dashed border-border/40 pt-2">
          {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
        </div>
      ) : (
        <div className="px-3 pb-2 space-y-1 border-t border-dashed border-border/40 pt-2">
          {preview.map(m => (
            <p key={m.id} className="text-xs text-muted-foreground truncate">
              <span className="font-medium">{m.sender_type === "user" ? "Usuario" : "Bot"}:</span> {m.content}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Conversation card ──────────────────────────────────────────────────────────

function ConvCard({ conv, now, selected, readOnly, onlineNames, onSelect, onAccept, accepting }: {
  conv: ConversationRow; now: number; selected: boolean; readOnly: boolean;
  onlineNames: Set<string>;
  onSelect: () => void; onAccept: () => void; accepting: boolean;
}) {
  const ms             = msSince(conv.last_message_at ?? conv.created_at, now);
  const ageStr         = formatRelative(ms);
  const isUrgent       = conv.status === "handoff_requested" && ms > URGENT_MS;
  const yourTurn       = conv.status === "human_attending" && conv.last_message_sender === "user";
  const operatorOnline = conv.operator_name ? onlineNames.has(conv.operator_name) : false;

  const leftBorder =
    isUrgent                                        ? "border-l-red-500" :
    conv.status === "handoff_requested"             ? "border-l-amber-400" :
    yourTurn                                        ? "border-l-orange-400" :
    conv.status === "human_attending"               ? "border-l-emerald-400" :
    "border-l-transparent";

  return (
    <div
      className={cn(
        "rounded-lg border-l-2 transition-colors",
        leftBorder,
        selected ? "bg-accent ring-1 ring-primary/20" : "hover:bg-muted/50",
        isUrgent && !selected && "bg-red-50/50",
      )}
    >
      <button className="w-full text-left px-3 py-2.5" onClick={onSelect}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {isUrgent && <Flame className="h-3 w-3 text-red-500 shrink-0 animate-pulse" />}
              <p className="text-sm font-medium truncate">{conv.afiliado_nombre || "Anónimo"}</p>
            </div>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{conv.sector_nombre || "Sin sector"}</p>
            {conv.operator_name && (
              <p className="text-[10px] mt-0.5 flex items-center gap-1">
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", operatorOnline ? "bg-emerald-500" : "bg-slate-300")} />
                <span className={cn("truncate", operatorOnline ? "text-emerald-600 font-medium" : "text-muted-foreground")}>
                  {conv.operator_name}
                </span>
              </p>
            )}
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1">
            <span className="text-[10px] text-muted-foreground tabular-nums">{ageStr}</span>
            {conv.unread_count > 0 && (
              <span className="bg-primary text-white rounded-full text-[10px] w-4 h-4 flex items-center justify-center font-bold">
                {conv.unread_count > 9 ? "9+" : conv.unread_count}
              </span>
            )}
            {yourTurn && (
              <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 rounded px-1.5">
                tu turno
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Quick accept button on card — no need to open detail first */}
      {!readOnly && conv.status === "handoff_requested" && (
        <div className="px-3 pb-2">
          <button
            onClick={e => { e.stopPropagation(); onAccept(); }}
            disabled={accepting}
            className="w-full flex items-center justify-center gap-1.5 rounded-md bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium py-1.5 transition-colors disabled:opacity-50"
          >
            {accepting
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <UserCheck className="h-3 w-3" />}
            Atender
          </button>
        </div>
      )}
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: { id: string; sender_type: string; content: string; created_at: string } }) {
  const isUser     = msg.sender_type === "user";
  const isSystem   = msg.sender_type === "system";
  const isOperator = msg.sender_type === "operator";
  const time = new Date(msg.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  if (isSystem) return (
    <div className="flex justify-center">
      <span className="text-[11px] bg-muted text-muted-foreground rounded-full px-3 py-1 flex items-center gap-1.5">
        <Info className="h-3 w-3 shrink-0" />
        {msg.content}
      </span>
    </div>
  );

  return (
    <div className={cn("flex gap-2 items-end", isUser ? "flex-row-reverse" : "flex-row")}>
      {!isUser && (
        <div className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
          isOperator ? "bg-emerald-100 text-emerald-700" : "bg-primary/10 text-primary",
        )}>
          {isOperator ? <UserCheck className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        </div>
      )}
      <div className={cn(
        "max-w-[72%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
        isUser     && "bg-primary text-white rounded-br-sm",
        isOperator && "bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-bl-sm",
        !isUser && !isOperator && "bg-muted text-foreground rounded-bl-sm",
      )}>
        <p className="whitespace-pre-wrap">{msg.content}</p>
        <p className={cn("text-[10px] mt-1 opacity-50", isUser ? "text-right" : "text-left")}>{time}</p>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function segmentAndSort(convs: ConversationRow[], now: number): Record<SectionKey, ConversationRow[]> {
  const out: Record<SectionKey, ConversationRow[]> = {
    handoff_requested: [], human_attending: [], closed: [], bot_active: [],
  };
  for (const c of convs) {
    if (c.status in out) out[c.status as SectionKey].push(c);
  }
  out.handoff_requested.sort((a, b) =>
    msSince(a.last_message_at ?? a.created_at, now) - msSince(b.last_message_at ?? b.created_at, now)
  );
  out.human_attending.sort((a, b) => {
    const aW = a.last_message_sender === "user" ? 1 : 0;
    const bW = b.last_message_sender === "user" ? 1 : 0;
    if (aW !== bW) return bW - aW;
    return msSince(a.last_message_at ?? a.created_at, now) - msSince(b.last_message_at ?? b.created_at, now);
  });
  out.closed.sort((a, b) =>
    msSince(b.last_message_at ?? b.created_at, now) - msSince(a.last_message_at ?? a.created_at, now)
  ).splice(CLOSED_LIMIT);
  return out;
}

function msSince(iso: string | null | undefined, now: number): number {
  if (!iso) return Infinity;
  return now - new Date(iso).getTime();
}

function formatRelative(ms: number): string {
  if (!isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
