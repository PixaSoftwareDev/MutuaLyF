"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Bot, Clock, UserCheck, XCircle, ChevronLeft, ChevronRight,
  MessageSquare, CalendarDays, SlidersHorizontal, X, User, Loader2,
  AlertCircle,
} from "lucide-react";
import { api, type ConversationHistoryRow, type ConversationDetail } from "@/lib/api";
import { MessageBubble, StatusBadge } from "@/components/conversations/conversations-panel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { renderWithLinks } from "@/lib/render-with-links";

// ── Types & constants ──────────────────────────────────────────────────────────

type StatusFilter = "all" | "handoff_requested" | "human_attending" | "bot_active" | "closed";

const STATUS_TABS: Array<{ key: StatusFilter; label: string; icon: React.ElementType; activeClass: string }> = [
  { key: "all",               label: "Todas",        icon: MessageSquare, activeClass: "bg-foreground text-background" },
  { key: "handoff_requested", label: "En espera",    icon: Clock,         activeClass: "bg-amber-500 text-white" },
  { key: "human_attending",   label: "En atención",  icon: UserCheck,     activeClass: "bg-emerald-500 text-white" },
  { key: "bot_active",        label: "Bot activo",   icon: Bot,           activeClass: "bg-slate-500 text-white" },
  { key: "closed",            label: "Cerradas",     icon: XCircle,       activeClass: "bg-slate-400 text-white" },
];

const PAGE_SIZE = 25;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminConversationsPage() {
  const qc = useQueryClient();

  // Filters
  const [status,     setStatus]     = useState<StatusFilter>("all");
  const [search,     setSearch]     = useState("");
  const [sectorId,   setSectorId]   = useState("");
  const [dateFrom,   setDateFrom]   = useState("");
  const [dateTo,     setDateTo]     = useState("");
  const [page,       setPage]       = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  // Detail panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen,  setPanelOpen]  = useState(false);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = (v: string) => {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setDebouncedSearch(v); setPage(1); }, 350);
  };

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [status, sectorId, dateFrom, dateTo]);

  // ── Queries ────────────────────────────────────────────────────────────────

  const historyQuery = useQuery({
    queryKey: ["admin-conversations", status, debouncedSearch, sectorId, dateFrom, dateTo, page],
    queryFn: () => api.operator.listHistory({
      status:    status === "all" ? undefined : status,
      q:         debouncedSearch || undefined,
      sectorId:  sectorId || undefined,
      dateFrom:  dateFrom || undefined,
      dateTo:    dateTo   || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  // Live counts for badges — polls active conversations
  const activeQuery = useQuery({
    queryKey: ["operator-conversations", "all", "admin"],
    queryFn: () => api.operator.listConversations(),
    staleTime: 5_000,
    refetchInterval: 8_000,
  });

  // Sectors for filter
  const sectorsQuery = useQuery({
    queryKey: ["sectors"],
    queryFn:  api.sectors.list,
    staleTime: 60_000,
  });

  // Detail
  const detailQuery = useQuery({
    queryKey: ["conversation-detail", selectedId],
    queryFn:  () => api.operator.getConversation(selectedId!),
    enabled:  !!selectedId && panelOpen,
    staleTime: 5_000,
    refetchInterval: panelOpen ? 5_000 : false,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const allActive   = activeQuery.data?.sectors.flatMap((s: any) => s.conversations) ?? [];
  const waitingCount   = allActive.filter((c: any) => c.status === "handoff_requested").length;
  const attendingCount = allActive.filter((c: any) => c.status === "human_attending").length;

  const liveCounts: Partial<Record<StatusFilter, number>> = {
    handoff_requested: waitingCount,
    human_attending:   attendingCount,
  };

  const items     = historyQuery.data?.items ?? [];
  const total     = historyQuery.data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const hasActiveFilters = !!sectorId || !!dateFrom || !!dateTo;
  const sectors = (sectorsQuery.data as any) ?? [];

  // ── Handlers ──────────────────────────────────────────────────────────────

  const openDetail = (id: string) => {
    setSelectedId(id);
    setPanelOpen(true);
  };

  const closeDetail = () => {
    setPanelOpen(false);
    setTimeout(() => setSelectedId(null), 300);
  };

  const clearFilters = () => {
    setSectorId("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b bg-card px-6 pt-5 pb-0 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Conversaciones</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {total > 0 ? `${total.toLocaleString("es-AR")} conversaciones` : "Cargando…"}
            </p>
          </div>

          {/* Search + filter toggle */}
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Buscar por nombre, email, DNI…"
                value={search}
                onChange={e => handleSearch(e.target.value)}
                className="w-full h-9 pl-8 pr-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {search && (
                <button onClick={() => { handleSearch(""); setDebouncedSearch(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              variant={showFilters ? "default" : "outline"}
              size="sm"
              className="gap-1.5 h-9"
              onClick={() => setShowFilters(v => !v)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filtros
              {hasActiveFilters && (
                <span className="ml-0.5 bg-primary-foreground text-primary rounded-full text-[10px] font-bold w-4 h-4 flex items-center justify-center">
                  {[sectorId, dateFrom, dateTo].filter(Boolean).length}
                </span>
              )}
            </Button>
          </div>
        </div>

        {/* Advanced filters — expandable */}
        {showFilters && (
          <div className="flex items-center gap-3 pb-3 flex-wrap">
            {/* Sector */}
            <div className="relative">
              <select
                value={sectorId}
                onChange={e => setSectorId(e.target.value)}
                className="h-8 pl-3 pr-8 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary appearance-none"
              >
                <option value="">Todos los sectores</option>
                {sectors.map((s: any) => (
                  <option key={s.id} value={s.id}>{s.nombre}</option>
                ))}
              </select>
            </div>

            {/* Date from */}
            <div className="flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                className="h-8 px-2 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <span className="text-xs text-muted-foreground">a</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                className="h-8 px-2 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {hasActiveFilters && (
              <button onClick={clearFilters}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <X className="h-3 w-3" /> Limpiar filtros
              </button>
            )}
          </div>
        )}

        {/* Status tabs */}
        <div className="flex items-center gap-1 -mb-px overflow-x-auto">
          {STATUS_TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = status === tab.key;
            const liveCount = liveCounts[tab.key];
            return (
              <button
                key={tab.key}
                onClick={() => { setStatus(tab.key); setPage(1); }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-t-md border border-transparent transition-all whitespace-nowrap",
                  isActive
                    ? "bg-background border-border border-b-background text-foreground -mb-px z-10"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {tab.label}
                {liveCount !== undefined && liveCount > 0 && (
                  <span className={cn(
                    "rounded-full text-[10px] font-bold px-1.5 min-w-[18px] h-[18px] flex items-center justify-center",
                    tab.key === "handoff_requested" ? "bg-amber-500 text-white" : "bg-emerald-500 text-white"
                  )}>
                    {liveCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── List ──────────────────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          {/* Table header */}
          <div className="grid grid-cols-[minmax(180px,2fr)_120px_140px_100px_90px_80px] gap-x-4 px-6 py-2.5 border-b bg-muted/40 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
            <span>Usuario</span>
            <span>Sector</span>
            <span>Operador</span>
            <span>Estado</span>
            <span>Mensajes</span>
            <span className="text-right">Fecha</span>
          </div>

          {/* Rows */}
          <div className="flex-1 overflow-y-auto">
            {historyQuery.isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-lg" />
                ))}
              </div>
            ) : historyQuery.isError ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
                <AlertCircle className="h-8 w-8 opacity-40" />
                <p className="text-sm">Error al cargar las conversaciones</p>
                <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["admin-conversations"] })}>
                  Reintentar
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
                <MessageSquare className="h-10 w-10 opacity-20" />
                <p className="text-sm font-medium">Sin conversaciones</p>
                <p className="text-xs">
                  {debouncedSearch || hasActiveFilters ? "Probá con otros filtros" : "Aún no hay conversaciones registradas"}
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {items.map(conv => (
                  <ConvRow
                    key={conv.id}
                    conv={conv}
                    selected={selectedId === conv.id}
                    onClick={() => openDetail(conv.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="shrink-0 border-t px-6 py-3 flex items-center justify-between bg-card">
              <span className="text-xs text-muted-foreground">
                Mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total.toLocaleString("es-AR")}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8"
                  disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {/* Page pills — show 5 around current */}
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                  .reduce<(number | "...")[]>((acc, p, idx, arr) => {
                    if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push("...");
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((p, i) => p === "..." ? (
                    <span key={`e${i}`} className="text-xs text-muted-foreground px-1">…</span>
                  ) : (
                    <button key={p}
                      onClick={() => setPage(p as number)}
                      className={cn(
                        "h-8 w-8 rounded-md text-xs font-medium transition-colors",
                        page === p ? "bg-primary text-primary-foreground" : "hover:bg-muted text-foreground"
                      )}>
                      {p}
                    </button>
                  ))
                }
                <Button variant="ghost" size="icon" className="h-8 w-8"
                  disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ── Detail slide-in panel ─────────────────────────────────────── */}
        <>
          {/* Backdrop */}
          {panelOpen && (
            <div
              className="fixed inset-0 bg-black/20 z-30 lg:hidden"
              onClick={closeDetail}
            />
          )}

          <div className={cn(
            "fixed lg:relative right-0 top-0 h-full z-40 lg:z-auto",
            "flex flex-col bg-card border-l shadow-xl lg:shadow-none",
            "transition-all duration-300 ease-in-out",
            "w-full sm:w-[480px] lg:w-[440px] xl:w-[520px]",
            panelOpen ? "translate-x-0" : "translate-x-full lg:translate-x-full",
            !panelOpen && "lg:hidden",
          )}>
            {panelOpen && selectedId && (
              <ConvDetail
                id={selectedId}
                detail={detailQuery.data ?? null}
                loading={detailQuery.isLoading}
                onClose={closeDetail}
              />
            )}
          </div>
        </>
      </div>
    </div>
  );
}

// ── Conversation row ───────────────────────────────────────────────────────────

function ConvRow({ conv, selected, onClick }: {
  conv: ConversationHistoryRow;
  selected: boolean;
  onClick: () => void;
}) {
  const date = conv.last_message_at ?? conv.created_at;
  const dateStr = date ? fmtDate(date) : "—";

  const initials = (conv.afiliado_nombre ?? "?")
    .split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full grid grid-cols-[minmax(180px,2fr)_120px_140px_100px_90px_80px] gap-x-4 px-6 py-3.5 text-left transition-colors hover:bg-muted/40",
        selected && "bg-accent hover:bg-accent"
      )}
    >
      {/* User */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-semibold bg-muted text-foreground/70 border border-border">
          {initials || <User className="h-3.5 w-3.5" />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate leading-tight flex items-center gap-1.5">
            {conv.is_test && <span className="shrink-0 text-[9px] font-bold bg-violet-100 text-violet-700 rounded px-1 py-0.5 uppercase tracking-wide">TEST</span>}
            {conv.afiliado_nombre || (conv.afiliado_ip ? `IP ${conv.afiliado_ip}` : <span className="text-muted-foreground italic">Anónimo</span>)}
          </p>
          {(conv.afiliado_email || conv.afiliado_dni) && (
            <p className="text-[11px] text-muted-foreground truncate">
              {conv.afiliado_email || `DNI ${conv.afiliado_dni}`}
            </p>
          )}
        </div>
      </div>

      {/* Sector */}
      <div className="flex items-center">
        <span className="text-xs text-muted-foreground truncate">
          {conv.sector_nombre || <span className="italic">Sin sector</span>}
        </span>
      </div>

      {/* Operator */}
      <div className="flex items-center">
        <span className="text-xs text-muted-foreground truncate">
          {conv.operator_name || "—"}
        </span>
      </div>

      {/* Status */}
      <div className="flex items-center">
        <StatusBadge status={conv.status} />
      </div>

      {/* Messages */}
      <div className="flex items-center">
        <span className="text-xs text-muted-foreground tabular-nums">
          {conv.message_count ?? "—"}
        </span>
      </div>

      {/* Date */}
      <div className="flex items-center justify-end">
        <span className="text-[11px] text-muted-foreground tabular-nums text-right whitespace-nowrap">
          {dateStr}
        </span>
      </div>
    </button>
  );
}

// ── Detail panel ───────────────────────────────────────────────────────────────

function ConvDetail({ id, detail, loading, onClose }: {
  id: string;
  detail: ConversationDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages?.length]);

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b flex items-center gap-3 bg-card">
        <button
          onClick={onClose}
          className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          aria-label="Cerrar"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {loading || !detail ? (
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-52" />
          </div>
        ) : (
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">
              {detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Anónimo")}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {[detail.sector_nombre, detail.afiliado_email, detail.afiliado_dni && `DNI ${detail.afiliado_dni}`]
                .filter(Boolean).join(" · ")}
            </p>
          </div>
        )}

        {detail && <StatusBadge status={detail.status} />}
      </div>

      {/* Meta row */}
      {detail && !loading && (
        <div className="shrink-0 px-4 py-2 border-b bg-muted/30 flex items-center gap-4 flex-wrap">
          {detail.operator_name && (
            <MetaChip label="Operador" value={detail.operator_name} />
          )}
          {detail.created_at && (
            <MetaChip label="Inicio" value={fmtDateFull(detail.created_at)} />
          )}
          {(detail as any).closed_at && (
            <MetaChip label="Cierre" value={fmtDateFull((detail as any).closed_at)} />
          )}
          <MetaChip label="Mensajes" value={String(detail.messages?.length ?? 0)} />
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/20">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !detail ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <p className="text-sm">No se pudo cargar la conversación</p>
          </div>
        ) : detail.messages?.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <p className="text-sm">Sin mensajes</p>
          </div>
        ) : (
          <>
            {detail.messages.map(m => <MessageBubble key={m.id} msg={m} />)}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Closed banner */}
      {detail?.status === "closed" && (
        <div className="shrink-0 px-4 py-2.5 border-t bg-muted/40 flex items-center gap-2 text-xs text-muted-foreground">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Conversación cerrada — solo lectura.</span>
        </div>
      )}
    </>
  );
}

// ── Small components ──────────────────────────────────────────────────────────

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/70">{label}:</span> {value}
    </span>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000)  return "ahora";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "2-digit" });
}

function fmtDateFull(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

