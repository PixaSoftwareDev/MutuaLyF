"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Bot, Clock, UserCheck, XCircle, ChevronLeft, ChevronRight,
  MessageSquare, CalendarDays, SlidersHorizontal, X,
  AlertCircle, Inbox as InboxIcon,
} from "lucide-react";
import { api, type ConversationHistoryRow, type ConversationDetail } from "@/lib/api";
import { MessageBubble, StatusBadge } from "@/components/conversations/conversations-panel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ── Types & constants ──────────────────────────────────────────────────────────

type StatusFilter = "all" | "handoff_requested" | "human_attending" | "bot_active" | "closed";

// Los estados "vivos" (espera/atención) usan dot de color semántico; los
// neutros (todas/bot/cerradas) usan ícono → segunda señal no-cromática para
// daltonismo y para no depender de dos grises casi iguales.
const STATUS_TABS: Array<{ key: StatusFilter; label: string; icon: React.ElementType; dot?: string }> = [
  { key: "all",               label: "Todas",       icon: MessageSquare },
  { key: "handoff_requested", label: "En espera",   icon: Clock,      dot: "bg-warning" },
  { key: "human_attending",   label: "En atención", icon: UserCheck,  dot: "bg-success" },
  { key: "bot_active",        label: "Bot activo",  icon: Bot },
  { key: "closed",            label: "Cerradas",    icon: XCircle },
];

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

  // El detalle es inline en desktop (≥lg) y un Sheet deslizante en mobile/tablet.
  // El Sheet solo debe ABRIR en mobile: en desktop su overlay taparía el inline.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Al cruzar el breakpoint con un detalle abierto, cerralo: si no, pasar de
  // desktop (inline) a mobile materializa de golpe un Sheet que el usuario no
  // pidió. Depende solo de isMobile a propósito (incluir panelOpen lo cerraría
  // apenas se abre).
  useEffect(() => {
    if (panelOpen) closeDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

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

  // Cerrar detalle con ESC — solo para el inline de desktop; en mobile el
  // Sheet (Radix) ya cierra con Escape por su cuenta.
  useEffect(() => {
    if (!panelOpen || isMobile) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDetail(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, isMobile]);

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
    // El historial filtrado/paginado no necesita refresco agresivo; reordenar
    // bajo el cursor del admin mientras lee es molesto. Los conteos en vivo
    // los lleva activeQuery (8s), que es lo que sí justifica poll.
    refetchInterval: 45_000,
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
    // No tiene sentido pollear una conversación cerrada: no va a cambiar.
    refetchInterval: (query) =>
      panelOpen && (query.state.data as ConversationDetail | undefined)?.status !== "closed" ? 5_000 : false,
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

  // ── List body (shared) ──────────────────────────────────────────────────────

  const listBody = historyQuery.isLoading ? (
    <div className="space-y-1.5 p-2">
      {Array.from({ length: 12 }).map((_, i) => <RowSkeleton key={i} />)}
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
    <div className="space-y-1.5 p-2 stagger-children">
      {items.map(conv => (
        <ConvRow
          key={conv.id}
          conv={conv}
          selected={selectedId === conv.id}
          onClick={() => openDetail(conv.id)}
        />
      ))}
    </div>
  );

  const pagination = !historyQuery.isLoading && !historyQuery.isError && total > 0 && (
    <div className="border-t px-3 py-1.5 flex items-center justify-between gap-3 shrink-0">
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total.toLocaleString("es-AR")}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page === 1} onClick={() => setPage(p => p - 1)} aria-label="Página anterior">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-[11px] text-muted-foreground tabular-nums px-1">{page} / {totalPages}</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} aria-label="Página siguiente">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <PageShell>
        {/* Cabecera estándar de la app (igual que Temas reconocidos, Documentos…):
            PageHeader con título + descripción + estado en vivo, y Filtros como
            acción. Las tabs de estado y la búsqueda van debajo, en el marco. */}
        <PageHeader
          title="Conversaciones"
          badge={
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none" />
              En vivo
            </span>
          }
          // En mobile la descripción se oculta: el header ya carga título +
          // "En vivo" + filtros + tabs + búsqueda; la lista es lo que se viene a ver.
          description={<span className="hidden sm:inline">Todas las conversaciones del asistente y la atención humana, en tiempo real.</span>}
          actions={
            <Button
              variant={showFilters || hasActiveFilters ? "default" : "outline"}
              size="sm"
              className="gap-1.5 h-9 shrink-0"
              onClick={() => setShowFilters(v => !v)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Filtros</span>
              {activeFilterCount > 0 && (
                <span className="ml-0.5 bg-background/20 text-primary-foreground rounded-full text-[10px] font-bold min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          }
        />

        {/* Tabs de estado + búsqueda en la MISMA fila (gana espacio vertical).
            Tabs a la izquierda con los conteos en vivo en sus triggers; búsqueda
            a la derecha. En mobile se apilan. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Tabs
            value={status}
            onValueChange={(v) => { setStatus(v as StatusFilter); setPage(1); }}
            className="min-w-0"
          >
            {/* Sin overflow-x-auto: el scrollbar dentro del alto fijo recortaba
                las tabs en pantallas chicas. Ahora envuelven (flex-wrap del base). */}
            <TabsList className="max-w-full justify-start">
              {STATUS_TABS.map(tab => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.key} value={tab.key} className="gap-1.5">
                    {tab.dot
                      ? <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", tab.dot)} />
                      : <Icon className="h-3.5 w-3.5 shrink-0" />}
                    {tab.label}
                    {tab.key === "handoff_requested" && waitingCount > 0 && (
                      <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums bg-warning/15 text-warning">
                        {waitingCount}
                      </span>
                    )}
                    {tab.key === "human_attending" && attendingCount > 0 && (
                      <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums bg-success/15 text-success">
                        {attendingCount}
                      </span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          <div className="relative sm:ml-auto sm:w-64 shrink-0">
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
        </div>

        {/* ── Advanced filters — expandable ─────────────────────────────────── */}
        {showFilters && (
          <Card className="shrink-0">
            <CardContent className="p-4 flex flex-col sm:flex-row sm:items-end gap-4 flex-wrap">
              {/* Sector */}
              <div className="flex flex-col gap-1.5 min-w-[180px]">
                <label className="text-xs font-medium text-muted-foreground">Sector</label>
                <Select
                  value={sectorId || "all"}
                  onValueChange={v => setSectorId(v === "all" ? "" : v)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Todos los sectores" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los sectores</SelectItem>
                    {sectors.map((s: any) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* Date range */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Rango de fechas</label>
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Input
                    type="date" aria-label="Desde" value={dateFrom} max={dateTo || undefined}
                    onChange={e => setDateFrom(e.target.value)}
                    className="h-9 w-36 px-2 text-sm"
                  />
                  <span className="text-xs text-muted-foreground" aria-hidden>→</span>
                  <Input
                    type="date" aria-label="Hasta" value={dateTo} min={dateFrom || undefined}
                    onChange={e => setDateTo(e.target.value)}
                    className="h-9 w-36 px-2 text-sm"
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
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {sectorName && <FilterChip label={sectorName} onClear={() => setSectorId("")} />}
            {(dateFrom || dateTo) && (
              <FilterChip
                label={`${dateFrom ? fmtChipDate(dateFrom) : "…"} → ${dateTo ? fmtChipDate(dateTo) : "…"}`}
                onClear={() => { setDateFrom(""); setDateTo(""); }}
              />
            )}
          </div>
        )}

        {/* ── Inbox split: lista + conversación ─────────────────────────────── */}
        {/* Altura completa dentro del marco PageShell (flujo space-y, no h-full):
            mismo recurso que la pestaña Sugeridos de Temas reconocidos. El calc
            descuenta cabecera + tabs + búsqueda; ajustable si hace falta. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(340px,400px)_1fr] xl:grid-cols-[minmax(380px,440px)_1fr] lg:h-[calc(100dvh-14rem)] lg:min-h-[460px]">
          {/* Lista (scroll propio) */}
          <Card className="overflow-hidden rounded-lg flex flex-col h-full min-h-0">
            <div className="flex-1 overflow-y-auto scrollbar-slim min-h-0 [scrollbar-gutter:stable]">
              {listBody}
            </div>
            {pagination}
          </Card>

          {/* Conversación (desktop inline) */}
          <Card className="hidden lg:flex flex-col overflow-hidden rounded-lg h-full min-h-0">
            {selectedId ? (
              <ConvDetail
                detail={detailQuery.data ?? null}
                loading={detailQuery.isLoading}
                isError={detailQuery.isError}
                onRetry={() => qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] })}
                onClose={closeDetail}
                inline
              />
            ) : (
              <EmptyDetail />
            )}
          </Card>
        </div>
      </PageShell>

      {/* ── Detail Sheet (solo mobile/tablet) ───────────────────────────────── */}
      {/* Radix Dialog aporta focus-trap, aria-modal, scroll-lock y devuelve el
          foco a la fila que lo abrió al cerrar — todo lo que el overlay manual
          no hacía. Solo abre en mobile: en desktop el detalle es inline. */}
      <Sheet open={panelOpen && isMobile} onOpenChange={(o) => { if (!o) closeDetail(); }}>
        <SheetContent side="right" hideClose aria-describedby={undefined} className="w-full sm:max-w-xl p-0">
          <SheetTitle className="sr-only">Detalle de conversación</SheetTitle>
          {selectedId && (
            <ConvDetail
              detail={detailQuery.data ?? null}
              loading={detailQuery.isLoading}
              isError={detailQuery.isError}
              onRetry={() => qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] })}
              onClose={closeDetail}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

// ── Conversation row (inbox style) ──────────────────────────────────────────────

function ConvRow({ conv, selected, onClick }: {
  conv: ConversationHistoryRow;
  selected: boolean;
  onClick: () => void;
}) {
  const date    = conv.last_message_at ?? conv.created_at;
  const dateStr = date ? fmtDate(date) : "—";
  const dateTitle = date ? fmtDateFull(date) : undefined;

  const name = conv.afiliado_nombre || (conv.afiliado_ip ? `IP ${conv.afiliado_ip}` : null);
  const subInfo = conv.afiliado_email || (conv.afiliado_dni ? `DNI ${conv.afiliado_dni}` : null);

  return (
    <button
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full text-left px-3.5 py-3 block rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-action/[0.07] ring-1 ring-action/30" : "hover:bg-muted/50",
      )}
    >
      {/* línea 1: nombre + tiempo */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          {conv.is_test && <span aria-label="Conversación de prueba" className="shrink-0 text-[10px] font-bold bg-primary/10 text-primary rounded px-1 py-0.5 uppercase tracking-wide">TEST</span>}
          <span className="text-sm font-semibold truncate">
            {name ?? <span className="font-normal text-muted-foreground italic">Anónimo</span>}
          </span>
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 whitespace-nowrap" title={dateTitle ?? "Fecha no disponible"}>{dateStr}</span>
      </div>

      {/* línea 2: sub info */}
      {subInfo && <p className="text-xs text-muted-foreground truncate mt-0.5">{subInfo}</p>}

      {/* línea 3: estado + sector + mensajes */}
      <div className="flex items-center gap-2 mt-2 min-w-0">
        <StatusBadge status={conv.status} />
        <span className="text-[11px] text-muted-foreground truncate min-w-0">
          {conv.sector_nombre || "Sin sector"}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 inline-flex items-center gap-1 ml-auto" title="Mensajes en la conversación">
          <MessageSquare className="h-3 w-3 opacity-50" />{conv.message_count ?? 0}
        </span>
      </div>
    </button>
  );
}

// ── Empty detail (desktop, sin selección) ────────────────────────────────────────

function EmptyDetail() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-10 text-muted-foreground">
      <div className="w-16 h-16 rounded-2xl bg-action/10 text-action flex items-center justify-center mb-4">
        <InboxIcon className="h-7 w-7" />
      </div>
      <p className="text-base font-semibold text-foreground">Elegí una conversación</p>
      <p className="text-sm mt-1 max-w-xs leading-relaxed">
        Seleccioná una conversación de la lista para ver el detalle y todos los mensajes.
      </p>
    </div>
  );
}

// ── Detail panel ───────────────────────────────────────────────────────────────

function ConvDetail({ detail, loading, isError, onRetry, onClose, inline }: {
  detail: ConversationDetail | null;
  loading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Solo al abrir una conversación distinta — no en cada refetch. En un
  // historial de lectura, saltar al fondo cada 5s mientras el admin lee el
  // inicio es hostil.
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "auto" }); }, [detail?.id]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 h-12 border-b flex items-center gap-3 bg-card">
        <button
          onClick={onClose}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={inline ? "Cerrar detalle" : "Volver"}
          title={inline ? "Cerrar detalle" : "Volver"}
        >
          {inline ? <X className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>

        {loading || !detail ? (
          <Skeleton className="h-4 w-44 flex-1" />
        ) : (
          <>
            <p className="flex-1 min-w-0 font-semibold text-sm truncate">
              {detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Anónimo")}
            </p>
            <StatusBadge status={detail.status} />
          </>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-slim bg-muted/20 min-h-0">
        <div className={cn("p-4 space-y-3", inline && "max-w-5xl mx-auto w-full")}>
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
              {detail.messages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </div>

      {/* Sin banner de "cerrada": esta vista es solo lectura SIEMPRE (no hay
          composer) y el estado ya lo muestra el StatusBadge del header — la
          franja solo le robaba altura a los mensajes. */}
    </div>
  );
}

// ── Small components ──────────────────────────────────────────────────────────

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

// Espeja exactamente el layout de ConvRow (sin avatar, 3 líneas) para no
// generar layout shift al pasar de skeleton a contenido real.
function RowSkeleton() {
  return (
    <div className="px-3.5 py-3 rounded-xl">
      <div className="flex items-center gap-2">
        <Skeleton className="h-3.5 w-36 flex-1" />
        <Skeleton className="h-3 w-10 shrink-0" />
      </div>
      <Skeleton className="h-3 w-28 mt-1.5" />
      <div className="flex items-center gap-2 mt-2">
        <Skeleton className="h-4 w-16 rounded-full" />
        <Skeleton className="h-3 w-20" />
      </div>
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

// Las fechas de los inputs son "YYYY-MM-DD" (sin hora). Parsear con new Date()
// las toma como UTC-medianoche → en es-AR (-3) muestra el día anterior. El
// mediodía fijo evita ese corrimiento.
function fmtChipDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}

function fmtDateFull(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
