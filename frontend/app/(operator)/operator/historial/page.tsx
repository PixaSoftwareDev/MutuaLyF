"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Search, ChevronLeft, ChevronRight, Loader2, MessageSquare,
  X, UserCheck, MessageCircle, SlidersHorizontal, PanelRight,
} from "lucide-react";
import { api, type ConversationHistoryFilters } from "@/lib/api";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  StatusBadge, MessageBubble,
} from "@/components/conversations/conversations-panel";
import { ConversationContextPanel } from "@/components/conversations/conversation-context-panel";
import { cn } from "@/lib/utils";

// Etiquetas de vista por estado — el estado activo vive en la URL (?status=),
// lo escribe el submenú (OperatorSidebar) y esta página lo lee para filtrar.
const HISTORY_LABELS: Record<string, string> = {
  "":                "Todas",
  bot_active:        "Bot activo",
  handoff_requested: "En espera",
  human_attending:   "En atención",
  closed:            "Cerradas",
};

// Pills de estado para mobile (en desktop las vistas viven en el submenú).
const MOBILE_STATUS: Array<{ key: string; label: string }> = [
  { key: "",                  label: "Todas" },
  { key: "bot_active",        label: "Bot activo" },
  { key: "handoff_requested", label: "En espera" },
  { key: "human_attending",   label: "En atención" },
  { key: "closed",            label: "Cerradas" },
];

const PAGE_SIZE = 20;

export default function OperatorHistoryPage() {
  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    }>
      <HistoryInbox />
    </Suspense>
  );
}

function HistoryInbox() {
  // Vista y sector activos — desde la URL (los escribe el submenú OperatorSidebar
  // en desktop y las pills en mobile). Mismo patrón que la bandeja.
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const sector = params.get("sector") ?? "";

  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState<string | undefined>(undefined);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Panel de contexto del afiliado (columna 3) — colapsable con pin, igual que
  // la bandeja de entrada.
  const [contextOpen, setContextOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Cualquier cambio de filtro vuelve a la página 1.
  useEffect(() => { setPage(1); }, [status, sector, q, dateFrom, dateTo]);

  const filters: ConversationHistoryFilters = useMemo(() => ({
    page, pageSize: PAGE_SIZE,
    status:   status || undefined,
    sectorId: sector || undefined,
    q:        q || undefined,
    dateFrom: dateFrom || undefined,
    dateTo:   dateTo || undefined,
  }), [page, status, sector, q, dateFrom, dateTo]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["operator-history", filters],
    queryFn: () => api.operator.listHistory(filters),
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["conversation-detail", selectedId],
    queryFn: () => api.operator.getConversation(selectedId!),
    enabled: !!selectedId,
  });

  const total      = data?.total ?? 0;
  const items      = data?.items ?? [];
  const pageSize   = PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasDateFilter = !!dateFrom || !!dateTo;

  const { botMessages, operatorMessages } = useMemo(() => {
    if (!detail?.messages) return { botMessages: [], operatorMessages: [] };
    const msgs = detail.messages;
    const firstOperatorIdx = msgs.findIndex(m => m.sender_type === "operator");
    if (firstOperatorIdx === -1) return { botMessages: msgs, operatorMessages: [] };
    return { botMessages: msgs.slice(0, firstOperatorIdx), operatorMessages: msgs.slice(firstOperatorIdx) };
  }, [detail?.messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages?.length]);

  const applySearch = () => setQ(searchInput.trim() || undefined);
  const clearSearchAndDates = () => { setSearchInput(""); setQ(undefined); setDateFrom(""); setDateTo(""); };

  // href de las pills mobile (preserva el sector activo).
  const viewHref = (key: string) => {
    const p = new URLSearchParams();
    if (key)    p.set("status", key);
    if (sector) p.set("sector", sector);
    const s = p.toString();
    return "/operator/historial" + (s ? `?${s}` : "");
  };

  const inputCls = "h-9 w-full rounded-lg border border-transparent bg-muted/60 px-2.5 text-xs shadow-none transition-colors focus-visible:border-border focus-visible:bg-card focus-visible:outline-none focus-visible:ring-0";

  return (
    <div className="flex h-full min-h-0">
      {/* ── Columna 1: filtros + lista (mismo ancho/breakpoint que la bandeja) ── */}
      <section className={cn(
        "flex min-h-0 flex-col lg:w-[360px] lg:shrink-0 lg:border-r",
        selectedId ? "hidden w-full lg:flex" : "flex w-full",
      )}>
        {/* Header: vista activa + total + toggle de fechas (igual que la bandeja;
            las vistas por estado viven en el submenú OperatorSidebar). */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{HISTORY_LABELS[status] ?? "Todas"}</h2>
          {!isLoading && (
            <span className="text-xs tabular-nums text-muted-foreground">{total.toLocaleString("es-AR")}</span>
          )}
          {isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          <button
            onClick={() => setFiltersOpen(v => !v)}
            title="Filtrar por fecha"
            aria-label="Filtrar por fecha"
            aria-expanded={filtersOpen}
            className={cn(
              "ml-auto flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
              filtersOpen || hasDateFilter ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Pills de estado — SOLO mobile (en desktop está el submenú) */}
        <div className="shrink-0 px-3 pt-2 lg:hidden">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide rounded-xl bg-muted/60 p-1">
            {MOBILE_STATUS.map(v => {
              const active = status === v.key;
              return (
                <Link
                  key={v.key || "all"}
                  href={viewHref(v.key)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all",
                    active ? "bg-card text-foreground font-semibold shadow-xs" : "text-muted-foreground",
                  )}
                >
                  {v.label}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Búsqueda — subfila (igual que la bandeja) */}
        <div className="shrink-0 px-3 pb-2 pt-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              aria-label="Buscar afiliado"
              placeholder="Buscar afiliado…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") applySearch(); }}
              onBlur={applySearch}
              className={cn(inputCls, "h-8 pl-8 text-[13px]")}
            />
            {searchInput && (
              <button
                aria-label="Limpiar búsqueda"
                onClick={() => { setSearchInput(""); setQ(undefined); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Filtro de fechas — colapsable, compacto (igual que la bandeja) */}
        {filtersOpen && (
          <div className="shrink-0 space-y-2 border-b px-3 pb-3">
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                aria-label="Desde"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={e => setDateFrom(e.target.value)}
                className={cn(inputCls, "h-8 flex-1")}
              />
              <span className="text-xs text-muted-foreground" aria-hidden>→</span>
              <input
                type="date"
                aria-label="Hasta"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={e => setDateTo(e.target.value)}
                className={cn(inputCls, "h-8 flex-1")}
              />
              {hasDateFilter && (
                <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={() => { setDateFrom(""); setDateTo(""); }} aria-label="Limpiar fechas">
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Lista */}
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-slim p-2">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
          ) : error ? (
            <p className="py-8 text-center text-xs text-destructive">Error al cargar</p>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <MessageSquare className="mx-auto mb-2 h-8 w-8 opacity-20" />
              <p className="text-xs">Sin resultados</p>
              {(searchInput || hasDateFilter) && (
                <button onClick={clearSearchAndDates} className="mt-2 text-[11px] text-action hover:underline">
                  Limpiar búsqueda y fechas
                </button>
              )}
            </div>
          ) : (
            items.map(row => (
              <HistoryCard
                key={row.id}
                row={row}
                selected={selectedId === row.id}
                onClick={() => setSelectedId(row.id)}
              />
            ))
          )}
        </div>

        {/* Paginación */}
        {!isLoading && total > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} de {total}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm" variant="outline" className="h-6 px-1.5"
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                aria-label="Página anterior"
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <span className="px-1 tabular-nums">{page}/{totalPages}</span>
              <Button
                size="sm" variant="outline" className="h-6 px-1.5"
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                aria-label="Página siguiente"
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* ── Columna 2: detalle (solo lectura) ─────────────────────────────── */}
      <section className={cn(
        "flex min-w-0 flex-1 flex-col",
        !selectedId && "hidden lg:flex",
      )}>
        {!selectedId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <MessageSquare className="h-10 w-10 opacity-15" />
            <p className="text-sm">Seleccioná una conversación</p>
            <p className="text-xs opacity-70">Vista de solo lectura</p>
          </div>
        ) : detailLoading ? (
          // Skeleton de chat (no un spinner suelto): se ve la estructura cargando.
          <div className="flex flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b px-4">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="flex-1 space-y-3 p-4">
              <Skeleton className="h-12 w-2/3 rounded-2xl" />
              <Skeleton className="ml-auto h-12 w-1/2 rounded-2xl" />
              <Skeleton className="h-10 w-3/5 rounded-2xl" />
            </div>
          </div>
        ) : detail ? (
          <>
            {/* Header */}
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <button
                onClick={() => setSelectedId(null)}
                className="-ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
                aria-label="Volver"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {/* Una sola línea: los datos (sector, email, quién atendió) viven en
                  el panel de contexto de la derecha, no acá. */}
              <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Afiliado anónimo")}</p>
              <StatusBadge status={detail.status} />

              {/* Pin del panel de contexto: reaparece SOLO cuando está contraído,
                  en pantallas anchas (igual que la bandeja). */}
              {!contextOpen && (
                <button
                  onClick={() => setContextOpen(true)}
                  className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground xl:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring animate-fade-in"
                  aria-label="Mostrar información del afiliado"
                  title="Mostrar información del afiliado"
                >
                  <PanelRight className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Mensajes */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4">
              <div className="mx-auto w-full max-w-3xl space-y-3">
                {botMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}
                {operatorMessages.length > 0 && botMessages.length > 0 && (
                  <div className="flex items-center gap-2 py-1">
                    <div className="flex-1 border-t border-dashed border-border" />
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                      <UserCheck className="h-3 w-3" /> Operador tomó la conversación
                    </span>
                    <div className="flex-1 border-t border-dashed border-border" />
                  </div>
                )}
                {operatorMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}
                {detail.messages.length === 0 && (
                  <p className="py-10 text-center text-sm text-muted-foreground">Conversación sin mensajes</p>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Pie: aviso de solo lectura */}
            <div className="shrink-0 border-t bg-muted/30 px-4 py-2.5 text-center">
              <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                <MessageCircle className="h-3 w-3" />
                Vista histórica de solo lectura
              </p>
            </div>
          </>
        ) : null}
      </section>

      {/* ── Columna 3: contexto del afiliado (pantallas anchas, colapsable) ── */}
      {/* Igual que la bandeja: el ancho anima entre 272px y 0; el contenido va en
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
            <ConversationContextPanel
              detail={detail ?? null}
              loading={detailLoading}
              onCollapse={() => setContextOpen(false)}
            />
          </div>
        </aside>
      )}
    </div>
  );
}

// ── Fila del historial ─────────────────────────────────────────────────────────

function HistoryCard({
  row, selected, onClick,
}: {
  row: import("@/lib/api").ConversationHistoryRow;
  selected: boolean;
  onClick: () => void;
}) {
  // El estado se comunica con un punto adelante, mismo vocabulario que la bandeja.
  const dotColor =
    row.status === "handoff_requested" ? "bg-warning" :
    row.status === "human_attending"   ? "bg-success" :
    "bg-transparent";

  const dateRef = row.last_message_at ?? row.updated_at ?? row.created_at;
  const dateStr = dateRef
    ? new Date(dateRef).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <button
      onClick={onClick}
      aria-selected={selected}
      className={cn(
        "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
        selected ? "bg-muted/70" : "hover:bg-muted/40",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dotColor)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium leading-tight text-foreground">
            {row.is_test && <span className="shrink-0 rounded bg-action/10 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-action">TEST</span>}
            {row.channel === "whatsapp" && <span aria-label="WhatsApp" className="inline-flex shrink-0 items-center gap-0.5 rounded bg-success/10 px-1 py-0.5 text-[9px] font-semibold text-success"><WhatsAppIcon className="h-2.5 w-2.5" />WA</span>}
            {row.afiliado_nombre || (row.afiliado_ip ? `IP ${row.afiliado_ip}` : "Anónimo")}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.sector_nombre || "Sin sector"}</p>
          {row.operator_name && (
            <p className="mt-0.5 flex items-center gap-1 text-[10px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
              <span className="truncate text-muted-foreground">{row.operator_name}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] tabular-nums text-muted-foreground">{dateStr}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground">{row.message_count} msj</span>
        </div>
      </div>
    </button>
  );
}
