"use client";

import { useState, useRef, useEffect } from "react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// ── Types & constants ──────────────────────────────────────────────────────────

type StatusFilter = "all" | "handoff_requested" | "human_attending" | "bot_active" | "closed";

const STATUS_TABS: Array<{ key: StatusFilter; label: string; icon: React.ElementType; dot?: string }> = [
  { key: "all",               label: "Todas",       icon: MessageSquare },
  { key: "handoff_requested", label: "En espera",   icon: Clock,      dot: "bg-amber-500" },
  { key: "human_attending",   label: "En atención", icon: UserCheck,  dot: "bg-emerald-500" },
  { key: "bot_active",        label: "Bot activo",  icon: Bot,        dot: "bg-slate-400" },
  { key: "closed",            label: "Cerradas",    icon: XCircle,    dot: "bg-slate-300" },
];

// Grid de columnas — definido UNA vez y compartido por header y filas (desktop).
const GRID_COLS = "grid-cols-[minmax(0,2.5fr)_minmax(0,1fr)_minmax(0,1fr)_110px_72px_96px]";

const PAGE_SIZE = 25;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminConversationsPage() {
  const qc = useQueryClient();

  // Filters
  const [status,      setStatus]      = useState<StatusFilter>("all");
  const [search,      setSearch]      = useState("");
  const [sectorId,    setSectorId]    = useState("");
  const [dateFrom,    setDateFrom]    = useState("");
  const [dateTo,      setDateTo]      = useState("");
  const [page,        setPage]        = useState(1);
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

  // Close detail with ESC
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDetail(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

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

  // Live counts for the summary chips — polls active conversations
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

  const allActive      = activeQuery.data?.sectors.flatMap((s: any) => s.conversations) ?? [];
  const waitingCount   = allActive.filter((c: any) => c.status === "handoff_requested").length;
  const attendingCount = allActive.filter((c: any) => c.status === "human_attending").length;

  const items      = historyQuery.data?.items ?? [];
  const total      = historyQuery.data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const hasActiveFilters = !!sectorId || !!dateFrom || !!dateTo;
  const activeFilterCount = [sectorId, dateFrom, dateTo].filter(Boolean).length;
  const sectors = (sectorsQuery.data as any) ?? [];
  const sectorName = sectors.find((s: any) => s.id === sectorId)?.nombre;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const openDetail = (id: string) => { setSelectedId(id); setPanelOpen(true); };
  const closeDetail = () => { setPanelOpen(false); setTimeout(() => setSelectedId(null), 300); };
  const clearFilters = () => { setSectorId(""); setDateFrom(""); setDateTo(""); setPage(1); };

  const applyDatePreset = (days: number | null) => {
    if (days === null) { setDateFrom(""); setDateTo(""); return; }
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    setDateFrom(iso(from));
    setDateTo(iso(to));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <PageShell>
        <PageHeader
          title="Conversaciones"
          description="Historial de conversaciones del asistente y de la atención humana."
          actions={
            (waitingCount > 0 || attendingCount > 0) ? (
              <div className="hidden sm:flex items-center gap-2">
                {waitingCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-2.5 h-7 text-xs font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    {waitingCount} en espera
                  </span>
                )}
                {attendingCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 h-7 text-xs font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    {attendingCount} en atención
                  </span>
                )}
              </div>
            ) : undefined
          }
        />

        {/* ── Toolbar: tabs + search + filtros ──────────────────────────────── */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Status tabs — segmented control */}
          <div role="tablist" aria-label="Filtrar por estado" className="inline-flex items-center gap-1 p-1 bg-muted rounded-lg overflow-x-auto">
            {STATUS_TABS.map(tab => {
              const Icon = tab.icon;
              const isActive = status === tab.key;
              return (
                <button
                  key={tab.key}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => { setStatus(tab.key); setPage(1); }}
                  className={cn(
                    "inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs sm:text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isActive
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tab.dot
                    ? <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", tab.dot)} />
                    : <Icon className="h-3.5 w-3.5 shrink-0" />}
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Search + filter toggle */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 lg:flex-none lg:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                type="text"
                aria-label="Buscar conversaciones"
                placeholder="Buscar por nombre, email, DNI…"
                value={search}
                onChange={e => handleSearch(e.target.value)}
                className="pl-8 h-9"
              />
              {search && (
                <button
                  aria-label="Limpiar búsqueda"
                  onClick={() => { handleSearch(""); setDebouncedSearch(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              variant={showFilters || hasActiveFilters ? "default" : "outline"}
              size="sm"
              className="gap-1.5 h-9 shrink-0"
              onClick={() => setShowFilters(v => !v)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Filtros</span>
              {activeFilterCount > 0 && (
                <span className="ml-0.5 bg-primary-foreground text-primary rounded-full text-[10px] font-bold w-4 h-4 flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </div>
        </div>

        {/* ── Advanced filters — expandable ─────────────────────────────────── */}
        {showFilters && (
          <Card>
            <CardContent className="p-4 flex flex-col sm:flex-row sm:items-end gap-4 flex-wrap">
              {/* Sector */}
              <div className="flex flex-col gap-1.5 min-w-[180px]">
                <label className="text-xs font-medium text-muted-foreground">Sector</label>
                <select
                  value={sectorId}
                  onChange={e => setSectorId(e.target.value)}
                  className="h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Todos los sectores</option>
                  {sectors.map((s: any) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
              </div>

              {/* Date range */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Rango de fechas</label>
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    type="date" aria-label="Desde" value={dateFrom} max={dateTo || undefined}
                    onChange={e => setDateFrom(e.target.value)}
                    className="h-9 px-2 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span className="text-xs text-muted-foreground">a</span>
                  <input
                    type="date" aria-label="Hasta" value={dateTo} min={dateFrom || undefined}
                    onChange={e => setDateTo(e.target.value)}
                    className="h-9 px-2 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>

              {/* Presets */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Rápido</label>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" className="h-9" onClick={() => applyDatePreset(0)}>Hoy</Button>
                  <Button variant="outline" size="sm" className="h-9" onClick={() => applyDatePreset(7)}>7 días</Button>
                  <Button variant="outline" size="sm" className="h-9" onClick={() => applyDatePreset(30)}>30 días</Button>
                </div>
              </div>

              {hasActiveFilters && (
                <Button variant="ghost" size="sm" className="h-9 gap-1 text-muted-foreground sm:ml-auto" onClick={clearFilters}>
                  <X className="h-3.5 w-3.5" /> Limpiar
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Active filter chips ───────────────────────────────────────────── */}
        {hasActiveFilters && !showFilters && (
          <div className="flex items-center gap-2 flex-wrap -mt-1">
            {sectorName && <FilterChip label={sectorName} onClear={() => setSectorId("")} />}
            {(dateFrom || dateTo) && (
              <FilterChip
                label={`${dateFrom || "…"} → ${dateTo || "…"}`}
                onClear={() => { setDateFrom(""); setDateTo(""); }}
              />
            )}
          </div>
        )}

        {/* ── List card ─────────────────────────────────────────────────────── */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {/* Table header (desktop only) */}
            <div className={cn(
              "hidden md:grid gap-x-4 px-4 py-2.5 border-b bg-muted/40 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
              GRID_COLS,
            )}>
              <span>Usuario</span>
              <span>Sector</span>
              <span>Operador</span>
              <span>Estado</span>
              <span className="text-right">Mensajes</span>
              <span className="text-right">Fecha</span>
            </div>

            {/* Rows */}
            {historyQuery.isLoading ? (
              <div className="divide-y">
                {Array.from({ length: 8 }).map((_, i) => <RowSkeleton key={i} />)}
              </div>
            ) : historyQuery.isError ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <AlertCircle className="h-8 w-8 opacity-40" />
                <p className="text-sm">Error al cargar las conversaciones</p>
                <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["admin-conversations"] })}>
                  Reintentar
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <MessageSquare className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium text-foreground/70">Sin conversaciones</p>
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
          </CardContent>

          {/* Pagination */}
          {!historyQuery.isLoading && !historyQuery.isError && total > 0 && (
            <div className="border-t px-4 py-3 flex items-center justify-between gap-3 bg-muted/20">
              <span className="text-xs text-muted-foreground">
                {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total.toLocaleString("es-AR")}
              </span>
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page === 1} onClick={() => setPage(p => p - 1)} aria-label="Anterior">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
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
                      <button
                        key={p}
                        onClick={() => setPage(p as number)}
                        className={cn(
                          "h-8 min-w-8 px-2 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          page === p ? "bg-primary text-primary-foreground" : "hover:bg-muted text-foreground"
                        )}>
                        {p}
                      </button>
                    ))}
                  <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} aria-label="Siguiente">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      </PageShell>

      {/* ── Detail overlay panel ────────────────────────────────────────────── */}
      <div
        className={cn(
          "fixed inset-0 bg-black/30 z-40 transition-opacity duration-300",
          panelOpen ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
        onClick={closeDetail}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label="Detalle de conversación"
        className={cn(
          "fixed right-0 top-0 h-full z-50 w-full sm:w-[480px] lg:w-[540px]",
          "bg-card border-l shadow-2xl flex flex-col",
          "transition-transform duration-300 ease-out",
          panelOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {selectedId && (
          <ConvDetail
            detail={detailQuery.data ?? null}
            loading={detailQuery.isLoading}
            isError={detailQuery.isError}
            onRetry={() => qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] })}
            onClose={closeDetail}
          />
        )}
      </div>
    </>
  );
}

// ── Conversation row ───────────────────────────────────────────────────────────

function ConvRow({ conv, selected, onClick }: {
  conv: ConversationHistoryRow;
  selected: boolean;
  onClick: () => void;
}) {
  const date    = conv.last_message_at ?? conv.created_at;
  const dateStr = date ? fmtDate(date) : "—";
  const dateTitle = date ? fmtDateFull(date) : undefined;
  const initials = (conv.afiliado_nombre ?? "?").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();

  const name = conv.afiliado_nombre || (conv.afiliado_ip ? `IP ${conv.afiliado_ip}` : null);
  const subInfo = conv.afiliado_email || (conv.afiliado_dni ? `DNI ${conv.afiliado_dni}` : null);

  const avatar = (
    <div className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-xs font-semibold bg-muted text-muted-foreground border border-border">
      {initials || <User className="h-4 w-4" />}
    </div>
  );

  const nameNode = (
    <span className="flex items-center gap-1.5 min-w-0">
      {conv.is_test && <span className="shrink-0 text-[9px] font-bold bg-violet-100 text-violet-700 rounded px-1 py-0.5 uppercase tracking-wide">TEST</span>}
      <span className="truncate">{name ?? <span className="text-muted-foreground italic">Anónimo</span>}</span>
    </span>
  );

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-brand/10 border-l-2 border-brand" : "hover:bg-muted/50 border-l-2 border-transparent",
      )}
    >
      {/* ── Desktop: table grid ── */}
      <div className={cn("hidden md:grid gap-x-4 px-4 py-3 items-center", GRID_COLS)}>
        <div className="flex items-center gap-3 min-w-0">
          {avatar}
          <div className="min-w-0">
            <p className="text-sm font-medium leading-tight">{nameNode}</p>
            {subInfo && <p className="text-[11px] text-muted-foreground truncate mt-0.5">{subInfo}</p>}
          </div>
        </div>
        <span className="text-xs text-muted-foreground truncate">{conv.sector_nombre || <span className="italic">Sin sector</span>}</span>
        <span className="text-xs text-muted-foreground truncate">{conv.operator_name || "—"}</span>
        <div><StatusBadge status={conv.status} /></div>
        <span className="text-xs text-muted-foreground tabular-nums text-right inline-flex items-center justify-end gap-1">
          <MessageSquare className="h-3 w-3 opacity-50" />{conv.message_count ?? "—"}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums text-right whitespace-nowrap" title={dateTitle}>{dateStr}</span>
      </div>

      {/* ── Mobile: stacked card ── */}
      <div className="md:hidden flex items-center gap-3 px-4 py-3">
        {avatar}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight">{nameNode}</p>
          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
            {[conv.sector_nombre || "Sin sector", conv.operator_name].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <StatusBadge status={conv.status} />
          <span className="text-[11px] text-muted-foreground tabular-nums" title={dateTitle}>{dateStr}</span>
        </div>
      </div>
    </button>
  );
}

// ── Detail panel ───────────────────────────────────────────────────────────────

function ConvDetail({ detail, loading, isError, onRetry, onClose }: {
  detail: ConversationDetail | null;
  loading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [detail?.messages?.length]);

  const initials = (detail?.afiliado_nombre ?? "?").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b flex items-center gap-3 bg-card">
        <button
          onClick={onClose}
          className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          <>
            <div className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-xs font-semibold bg-muted text-muted-foreground border border-border">
              {initials || <User className="h-4 w-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">
                {detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Anónimo")}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {[detail.sector_nombre, detail.afiliado_email, detail.afiliado_dni && `DNI ${detail.afiliado_dni}`].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
            <StatusBadge status={detail.status} />
          </>
        )}
      </div>

      {/* Meta — definition grid */}
      {detail && !loading && (
        <div className="shrink-0 px-4 py-2.5 border-b bg-muted/30 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {detail.operator_name && <Meta label="Operador" value={detail.operator_name} />}
          {detail.created_at && <Meta label="Inicio" value={fmtDateFull(detail.created_at)} />}
          {(detail as any).closed_at && <Meta label="Cierre" value={fmtDateFull((detail as any).closed_at)} />}
          <Meta label="Mensajes" value={String(detail.messages?.length ?? 0)} />
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/20">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-2/3 rounded-2xl" />
            <Skeleton className="h-12 w-3/5 rounded-2xl ml-auto" />
            <Skeleton className="h-16 w-3/4 rounded-2xl" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
            <AlertCircle className="h-7 w-7 opacity-40" />
            <p className="text-sm">No se pudo cargar la conversación</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Reintentar</Button>
          </div>
        ) : !detail || detail.messages?.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
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

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="font-medium text-muted-foreground shrink-0">{label}:</span>
      <span className="text-foreground truncate">{value}</span>
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] bg-muted text-foreground rounded-md pl-2 pr-1 py-1">
      {label}
      <button onClick={onClear} className="p-0.5 rounded hover:bg-background/60 text-muted-foreground hover:text-foreground" aria-label={`Quitar filtro ${label}`}>
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="h-9 w-9 rounded-full shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-5 w-20 rounded-full shrink-0" />
    </div>
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
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
