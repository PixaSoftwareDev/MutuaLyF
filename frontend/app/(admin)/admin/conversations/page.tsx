"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, ChevronLeft, ChevronRight, MessageSquare, CalendarDays,
  SlidersHorizontal, X, AlertCircle, Inbox as InboxIcon, Loader2, Bot,
  PanelRight, CornerDownLeft,
} from "lucide-react";
import { api, type ConversationHistoryRow, type ConversationDetail } from "@/lib/api";
import { MessageBubble, StatusBadge } from "@/components/conversations/conversations-panel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

// ── Types & constants ──────────────────────────────────────────────────────────
// Estructura de referencia (inbox Text): las vistas por estado y el filtro por
// sector viven en el panel secundario (Sidebar → InboxViews) y llegan por URL
// (?status=&sector=). La página es el inbox puro: lista + conversación.

type StatusFilter = "all" | "handoff_requested" | "human_attending" | "bot_active" | "closed";

const STATUS_LABELS: Record<StatusFilter, string> = {
  all:               "Todas",
  handoff_requested: "En espera",
  human_attending:   "En atención",
  bot_active:        "Bot activo",
  closed:            "Cerradas",
};

const PAGE_SIZE = 25;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminConversationsPage() {
  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    }>
      <ConversationsInbox />
    </Suspense>
  );
}

function ConversationsInbox() {
  const qc = useQueryClient();
  const params = useSearchParams();

  // Vistas desde la URL (las escribe el panel contextual del Sidebar)
  const status   = (params.get("status") ?? "all") as StatusFilter;
  const sectorId = params.get("sector") ?? "";

  // Filtros locales de la lista
  const [search,      setSearch]      = useState("");
  const [dateFrom,    setDateFrom]    = useState("");
  const [dateTo,      setDateTo]      = useState("");
  const [page,        setPage]        = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  // Detalle: inline en desktop, Sheet en mobile
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen,  setPanelOpen]  = useState(false);
  // Columna 3 (contexto del afiliado): colapsable desde el header de la conversación
  const [contextOpen, setContextOpen] = useState(true);

  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Al cruzar el breakpoint con un detalle abierto, cerralo (evita materializar
  // un Sheet no pedido al pasar de desktop a mobile).
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

  useEffect(() => { setPage(1); }, [status, sectorId, dateFrom, dateTo]);

  // ── Queries ────────────────────────────────────────────────────────────────

  const historyQuery = useQuery({
    queryKey: ["admin-conversations", status, debouncedSearch, sectorId, dateFrom, dateTo, page],
    queryFn: () => api.operator.listHistory({
      status:   status === "all" ? undefined : status,
      q:        debouncedSearch || undefined,
      sectorId: sectorId || undefined,
      dateFrom: dateFrom || undefined,
      dateTo:   dateTo   || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    staleTime: 10_000,
    refetchInterval: 45_000,
  });

  const detailQuery = useQuery({
    queryKey: ["conversation-detail", selectedId],
    queryFn:  () => api.operator.getConversation(selectedId!),
    enabled:  !!selectedId && panelOpen,
    staleTime: 5_000,
    refetchInterval: (query) =>
      panelOpen && (query.state.data as ConversationDetail | undefined)?.status !== "closed" ? 5_000 : false,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const items      = historyQuery.data?.items ?? [];
  const total      = historyQuery.data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasDateFilter = !!dateFrom || !!dateTo;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const openDetail  = (id: string) => { setSelectedId(id); setPanelOpen(true); };
  const closeDetail = () => { setPanelOpen(false); setTimeout(() => setSelectedId(null), 300); };

  const applyDatePreset = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    // YMD en hora LOCAL: toISOString() es UTC y en AR (UTC-3), pasadas las
    // 21:00, "hoy" en UTC ya es mañana → traía el día errado.
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setDateFrom(iso(from));
    setDateTo(iso(to));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex h-full min-h-0">

        {/* ══ Columna 1: lista de conversaciones ══════════════════════════════ */}
        <section className="flex min-h-0 w-full flex-col lg:w-[360px] lg:shrink-0 lg:border-r" aria-label="Lista de conversaciones">
          {/* Header: vista activa + total + filtros de fecha (barra estándar) */}
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{STATUS_LABELS[status]}</h2>
            {!historyQuery.isLoading && (
              <span className="text-xs tabular-nums text-muted-foreground">{total.toLocaleString("es-AR")}</span>
            )}
            <button
              onClick={() => setShowFilters(v => !v)}
              title="Filtrar por fecha"
              aria-label="Filtrar por fecha"
              aria-expanded={showFilters}
              className={cn(
                "ml-auto flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                showFilters || hasDateFilter ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Búsqueda — subfila bajo la barra, como el "Chats · Oldest" de la referencia */}
          <div className="shrink-0 px-3 pb-2 pt-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                aria-label="Buscar conversaciones"
                placeholder="Buscar por nombre, email, DNI…"
                value={search}
                onChange={e => handleSearch(e.target.value)}
                className="h-8 border-transparent bg-muted/60 pl-8 text-[13px] shadow-none focus-visible:bg-card"
              />
              {search && (
                <button
                  aria-label="Limpiar búsqueda"
                  onClick={() => { handleSearch(""); setDebouncedSearch(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Filtro de fechas — colapsable, compacto */}
          {showFilters && (
            <div className="shrink-0 space-y-2 border-b px-3 pb-3">
              <div className="flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <Input type="date" aria-label="Desde" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} className="h-8 flex-1 px-2 text-xs" />
                <span className="text-xs text-muted-foreground" aria-hidden>→</span>
                <Input type="date" aria-label="Hasta" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} className="h-8 flex-1 px-2 text-xs" />
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={() => applyDatePreset(0)}>Hoy</Button>
                <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={() => applyDatePreset(7)}>7 días</Button>
                <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={() => applyDatePreset(30)}>30 días</Button>
                {hasDateFilter && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => { setDateFrom(""); setDateTo(""); }} aria-label="Limpiar fechas">
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Filas */}
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim [scrollbar-gutter:stable]">
            {historyQuery.isLoading ? (
              <div>{Array.from({ length: 12 }).map((_, i) => <RowSkeleton key={i} />)}</div>
            ) : historyQuery.isError ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                <AlertCircle className="h-8 w-8 opacity-40" />
                <p className="text-sm">Error al cargar las conversaciones</p>
                <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["admin-conversations"] })}>
                  Reintentar
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                <MessageSquare className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium text-foreground/70">Sin conversaciones</p>
                <p className="text-xs">
                  {debouncedSearch || hasDateFilter || sectorId ? "Probá con otra vista o filtros" : "Aún no hay conversaciones registradas"}
                </p>
              </div>
            ) : (
              items.map(conv => (
                <ConvRow
                  key={conv.id}
                  conv={conv}
                  selected={selectedId === conv.id}
                  onClick={() => openDetail(conv.id)}
                />
              ))
            )}
          </div>

          {/* Paginación */}
          {!historyQuery.isLoading && !historyQuery.isError && total > 0 && (
            <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-1.5">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total.toLocaleString("es-AR")}
              </span>
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page === 1} onClick={() => setPage(p => p - 1)} aria-label="Página anterior">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="px-1 text-[11px] tabular-nums text-muted-foreground">{page} / {totalPages}</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} aria-label="Página siguiente">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ══ Columna 2: conversación (desktop) ═══════════════════════════════ */}
        <section className="hidden min-h-0 flex-1 flex-col lg:flex" aria-label="Conversación">
          {selectedId ? (
            <ConvDetail
              detail={detailQuery.data ?? null}
              loading={detailQuery.isLoading}
              isError={detailQuery.isError}
              onRetry={() => qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] })}
              onClose={closeDetail}
              contextOpen={contextOpen}
              onToggleContext={() => setContextOpen(o => !o)}
            />
          ) : (
            <EmptyDetail />
          )}
        </section>

        {/* ══ Columna 3: contexto del afiliado (pantallas anchas) ═════════════ */}
        {/* El ancho anima entre 272px y 0 (patrón referencia): el contenido va en
            un wrapper de ancho FIJO para que no se reacomode durante el slide. */}
        {selectedId && (
          <aside
            className={cn(
              "hidden min-h-0 shrink-0 flex-col overflow-hidden xl:flex",
              "transition-[width,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              contextOpen ? "w-[272px] border-l" : "w-0 border-l border-l-transparent",
            )}
            aria-label="Información del afiliado"
            aria-hidden={!contextOpen}
          >
            <div className="flex min-h-0 w-[272px] shrink-0 flex-1 flex-col overflow-y-auto scrollbar-slim">
              <ContextPanel
                detail={detailQuery.data ?? null}
                loading={detailQuery.isLoading}
                onCollapse={() => setContextOpen(false)}
              />
            </div>
          </aside>
        )}
      </div>

      {/* ══ Detalle en Sheet (solo mobile/tablet) ═════════════════════════════ */}
      <Sheet open={panelOpen && isMobile} onOpenChange={(o) => { if (!o) closeDetail(); }}>
        <SheetContent side="right" hideClose aria-describedby={undefined} className="w-full p-0 sm:max-w-xl">
          <SheetTitle className="sr-only">Detalle de conversación</SheetTitle>
          {selectedId && (
            <ConvDetail
              detail={detailQuery.data ?? null}
              loading={detailQuery.isLoading}
              isError={detailQuery.isError}
              onRetry={() => qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] })}
              onClose={closeDetail}
              backArrow
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

// ── Fila de conversación (estilo lista de la referencia) ──────────────────────

function ConvRow({ conv, selected, onClick }: {
  conv: ConversationHistoryRow;
  selected: boolean;
  onClick: () => void;
}) {
  const date    = conv.last_message_at ?? conv.created_at;
  const dateStr = date ? fmtDate(date) : "—";
  const dateTitle = date ? fmtDateFull(date) : undefined;

  const name = conv.afiliado_nombre || (conv.afiliado_ip ? `IP ${conv.afiliado_ip}` : null);
  const initial = conv.afiliado_nombre?.trim()[0]?.toUpperCase() ?? null;

  return (
    <button
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-muted/70" : "hover:bg-muted/40",
      )}
    >
      {/* Avatar */}
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
        {initial ?? <Bot className="h-4 w-4" />}
      </span>

      <span className="min-w-0 flex-1">
        {/* línea 1: nombre + tiempo (referencia: fila simple; el resto de la
            info vive en el panel derecho de contexto) */}
        <span className="flex items-baseline gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* El origen "de prueba" vive en el panel de contexto — la fila queda limpia */}
            <span className="truncate text-[13px] font-semibold text-foreground">
              {name ?? <span className="font-normal italic text-muted-foreground">Anónimo</span>}
            </span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground" title={dateTitle ?? "Fecha no disponible"}>{dateStr}</span>
        </span>

        {/* línea 2: último mensaje (↩ cuando lo escribió el afiliado) */}
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {conv.last_message_sender === "user" && <CornerDownLeft className="h-3 w-3 shrink-0 opacity-60" aria-hidden />}
          <span className="min-w-0 truncate">
            {conv.last_message_preview || <span className="italic opacity-70">Sin mensajes</span>}
          </span>
        </span>
      </span>
    </button>
  );
}

// ── Vacío (desktop, sin selección) ────────────────────────────────────────────

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-10 text-center text-muted-foreground">
      <div className="space-y-2">
        <InboxIcon className="mx-auto h-10 w-10 opacity-15" />
        <p className="text-sm">Elegí una conversación</p>
        <p className="mx-auto max-w-xs text-xs leading-relaxed opacity-70">
          Seleccioná una conversación de la lista para ver el detalle y todos los mensajes.
        </p>
      </div>
    </div>
  );
}

// ── Detalle de conversación ───────────────────────────────────────────────────

function ConvDetail({ detail, loading, isError, onRetry, onClose, backArrow, contextOpen, onToggleContext }: {
  detail: ConversationDetail | null;
  loading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
  /** Flecha "volver" (Sheet mobile) en vez de la X de cerrar (inline desktop). */
  backArrow?: boolean;
  /** Toggle de la columna de contexto (solo desktop ancho). */
  contextOpen?: boolean;
  onToggleContext?: () => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Solo al abrir una conversación distinta — no en cada refetch.
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "auto" }); }, [detail?.id]);

  // Cerrar con ESC (inline desktop; el Sheet ya lo maneja Radix)
  useEffect(() => {
    if (backArrow) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [backArrow, onClose]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header de la conversación (referencia: título + acciones) */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        {backArrow && (
          <button
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Volver"
            title="Volver"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}

        {loading || !detail ? (
          <Skeleton className="h-4 w-44 flex-1" />
        ) : (
          <>
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">
              {detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Anónimo")}
            </p>
            <StatusBadge status={detail.status} />
          </>
        )}

        {/* Reabrir el panel de contexto: el ícono queda SOLO cuando el panel está
            contraído, en la misma posición donde vivía dentro del panel. */}
        {!backArrow && onToggleContext && !contextOpen && (
          <button
            onClick={onToggleContext}
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground xl:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring animate-fade-in"
            aria-label="Mostrar información del afiliado"
            title="Mostrar información del afiliado"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}
        {!backArrow && (
          <button
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Cerrar detalle"
            title="Cerrar detalle (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Mensajes — ancho de lectura acotado; el aire sobrante lo ocupa el
          panel de contexto (columna 3), no un vacío. */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
        <div className="mx-auto w-full max-w-3xl space-y-3 p-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-2/3 rounded-2xl" />
              <Skeleton className="ml-auto h-12 w-3/5 rounded-2xl" />
              <Skeleton className="h-16 w-3/4 rounded-2xl" />
            </div>
          ) : isError ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
              <AlertCircle className="h-7 w-7 opacity-40" />
              <p className="text-sm">No se pudo cargar la conversación</p>
              <Button variant="outline" size="sm" onClick={onRetry}>Reintentar</Button>
            </div>
          ) : !detail || detail.messages?.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <p className="text-sm">Sin mensajes</p>
            </div>
          ) : (
            <>
              {detail.messages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} senderName={detail.afiliado_nombre} />)}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Panel de contexto del afiliado (columna 3, patrón referencia) ─────────────

function ContextPanel({ detail, loading, onCollapse }: {
  detail: ConversationDetail | null;
  loading: boolean;
  onCollapse: () => void;
}) {
  // Header propio del panel, alineado con el header de la conversación: el
  // botón de contraer vive DENTRO del cuadrante que se contrae (referencia).
  const header = (
    <div className="flex h-12 shrink-0 items-center justify-between border-b pl-4 pr-2">
      <span className="text-[13px] font-semibold text-foreground">Afiliado</span>
      <button
        onClick={onCollapse}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Ocultar información del afiliado"
        title="Ocultar información del afiliado"
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  );

  if (loading || !detail) {
    return (
      <div className="flex flex-col">
      {header}
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-16" /></div>
        </div>
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
      </div>
    );
  }

  const name    = detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Anónimo");
  const initial = detail.afiliado_nombre?.trim()[0]?.toUpperCase() ?? null;
  const isWhatsApp = detail.channel === "whatsapp";

  const fmtWhen = (iso: string | null) => iso
    ? new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;

  // ── Métricas calculadas de los mensajes (sin backend extra) ────────────────
  const msgs = detail.messages ?? [];
  const lastMsgAt = msgs.length ? msgs[msgs.length - 1].created_at : null;

  // Duración: del inicio a la última actividad (mide la charla real).
  const durationMs = lastMsgAt ? new Date(lastMsgAt).getTime() - new Date(detail.created_at).getTime() : null;

  // Espera hasta atención humana: del pedido de operador al primer mensaje del
  // operador. El dato operativo más valioso del panel.
  let waitMs: number | null = null;
  if (detail.handoff_requested_at) {
    const handoffTs = new Date(detail.handoff_requested_at).getTime();
    const firstOp = msgs.find(m => m.sender_type === "operator" && new Date(m.created_at).getTime() >= handoffTs);
    if (firstOp) waitMs = new Date(firstOp.created_at).getTime() - handoffTs;
  }

  const byAfiliado = msgs.filter(m => m.sender_type === "user").length;
  const byBot      = msgs.filter(m => m.sender_type === "bot").length;
  const byOperator = msgs.filter(m => m.sender_type === "operator").length;

  return (
    <div className="flex flex-col">
      {header}
      {/* Identidad */}
      <div className="flex items-center gap-3 border-b px-4 py-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
          {initial ?? <Bot className="h-4 w-4" />}
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[13px] font-semibold text-foreground" title={name}>{name}</p>
          <div className="mt-1"><StatusBadge status={detail.status} /></div>
        </div>
      </div>

      <PanelSection title="Datos del afiliado">
        <PanelRow label="Email"    value={detail.afiliado_email} />
        <PanelRow label="DNI"      value={detail.afiliado_dni} />
        <PanelRow label="Teléfono" value={isWhatsApp ? detail.external_id ?? null : null} />
        <PanelRow label="IP"       value={detail.afiliado_ip} />
      </PanelSection>

      <PanelSection title="Conversación">
        <PanelRow label="Canal"    value={isWhatsApp ? "WhatsApp" : "Widget web"} />
        <PanelRow label="Sector"   value={detail.sector_nombre} />
        <PanelRow label="Operador" value={detail.operator_name} />
        <PanelRow label="Iniciada" value={fmtWhen(detail.created_at)} />
        <PanelRow label="Derivada" value={fmtWhen(detail.handoff_requested_at)} />
        {detail.is_test && <PanelRow label="Origen" value="Conversación de prueba" />}
      </PanelSection>

      <PanelSection title="Actividad">
        <PanelRow label="Duración"         value={durationMs != null ? fmtDuration(durationMs) : null} />
        <PanelRow label="Última actividad" value={fmtWhen(lastMsgAt)} />
        <PanelRow label="Espera operador"  value={waitMs != null ? fmtDuration(waitMs) : null} />
        <PanelRow label="Mensajes"         value={String(msgs.length)} />
        <PanelRow label="Del afiliado"     value={byAfiliado ? String(byAfiliado) : null} />
        <PanelRow label="Del asistente"    value={byBot ? String(byBot) : null} />
        <PanelRow label="Del operador"     value={byOperator ? String(byOperator) : null} />
      </PanelSection>
    </div>
  );
}

/** Sección colapsable del panel de contexto (chevron, abierta por defecto). */
function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between px-4 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted/40"
      >
        {title}
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="space-y-2 px-4 pb-3.5">{children}</div>}
    </div>
  );
}

/** Fila label/valor — si no hay valor, no se muestra (sin "—" de relleno). */
function PanelRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-foreground" title={value}>{value}</span>
    </div>
  );
}

// ── Skeleton de fila (espeja el layout de ConvRow) ────────────────────────────

function RowSkeleton() {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Skeleton className="mt-0.5 h-9 w-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-36 flex-1" />
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
        <Skeleton className="mt-1.5 h-3 w-4/5" />
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

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

function fmtDateFull(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
