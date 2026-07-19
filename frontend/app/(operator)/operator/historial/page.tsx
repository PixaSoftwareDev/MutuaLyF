"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search, ChevronLeft, ChevronRight, Loader2, MessageSquare,
  X, UserCheck, MessageCircle, SlidersHorizontal,
} from "lucide-react";
import { api, type ConversationHistoryFilters } from "@/lib/api";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  StatusBadge, MessageBubble,
} from "@/components/conversations/conversations-panel";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "",                  label: "Todos los estados" },
  { value: "bot_active",        label: "Bot activo"        },
  { value: "handoff_requested", label: "En espera"         },
  { value: "human_attending",   label: "En atención"       },
  { value: "closed",            label: "Cerradas"          },
];

const PAGE_SIZE = 20;

export default function OperatorHistoryPage() {
  const [filters, setFilters] = useState<ConversationHistoryFilters>({ page: 1, pageSize: PAGE_SIZE });
  const [searchInput, setSearchInput] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
  const page       = filters.page ?? 1;
  const pageSize   = filters.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const activeFiltersCount = useMemo(() => {
    let n = 0;
    if (filters.status)   n++;
    if (filters.q)        n++;
    if (filters.dateFrom) n++;
    if (filters.dateTo)   n++;
    return n;
  }, [filters]);

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

  const applySearch = () => setFilters(f => ({ ...f, q: searchInput.trim() || undefined, page: 1 }));
  const clearFilters = () => { setSearchInput(""); setFilters({ page: 1, pageSize: PAGE_SIZE }); };

  const inputCls = "h-9 w-full rounded-lg border border-transparent bg-muted/60 px-2.5 text-xs shadow-none transition-colors focus-visible:border-border focus-visible:bg-card focus-visible:outline-none focus-visible:ring-0";

  return (
    <div className="flex h-full min-h-0">
      {/* ── IZQUIERDA: filtros + lista ────────────────────────────────────── */}
      <section className={cn(
        "flex min-h-0 w-full flex-col border-r sm:w-80 sm:shrink-0",
        selectedId ? "hidden sm:flex" : "flex",
      )}>
        {/* Búsqueda + filtros */}
        <div className="shrink-0 space-y-2 border-b px-3 py-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Buscar afiliado…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") applySearch(); }}
                onBlur={applySearch}
                className={cn(inputCls, "pl-8")}
              />
            </div>
            <button
              onClick={() => setFiltersOpen(v => !v)}
              title="Filtros"
              aria-expanded={filtersOpen}
              className={cn(
                "flex h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[11px] transition-colors",
                activeFiltersCount > 0
                  ? "bg-action/[0.08] font-medium text-action"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="hidden min-[360px]:inline">Filtros</span>
              {activeFiltersCount > 0 && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-action text-[10px] font-bold text-action-foreground">
                  {activeFiltersCount}
                </span>
              )}
            </button>
          </div>

          {filtersOpen && (
            <div className="space-y-2 pt-1">
              <select
                value={filters.status ?? ""}
                onChange={e => setFilters(f => ({ ...f, status: e.target.value || undefined, page: 1 }))}
                className={inputCls}
              >
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={filters.dateFrom ?? ""}
                  onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value || undefined, page: 1 }))}
                  className={cn(inputCls, "flex-1")}
                />
                <span className="text-xs text-muted-foreground" aria-hidden>→</span>
                <input
                  type="date"
                  value={filters.dateTo ?? ""}
                  onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value || undefined, page: 1 }))}
                  className={cn(inputCls, "flex-1")}
                />
              </div>

              {activeFiltersCount > 0 && (
                <Button size="sm" variant="ghost" className="h-7 w-full text-xs" onClick={clearFilters}>
                  <X className="mr-1 h-3 w-3" /> Limpiar filtros
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
            {isFetching && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            <span>{total} resultado{total !== 1 ? "s" : ""}</span>
          </div>
        </div>

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
              {activeFiltersCount > 0 && (
                <button onClick={clearFilters} className="mt-2 text-[11px] text-action hover:underline">
                  Limpiar filtros
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
                onClick={() => setFilters(f => ({ ...f, page: Math.max(1, (f.page ?? 1) - 1) }))}
                aria-label="Página anterior"
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <span className="px-1 tabular-nums">{page}/{totalPages}</span>
              <Button
                size="sm" variant="outline" className="h-6 px-1.5"
                disabled={page >= totalPages}
                onClick={() => setFilters(f => ({ ...f, page: Math.min(totalPages, (f.page ?? 1) + 1) }))}
                aria-label="Página siguiente"
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* ── DERECHA: detalle (solo lectura) ───────────────────────────────── */}
      <section className={cn(
        "flex min-w-0 flex-1 flex-col",
        !selectedId && "hidden sm:flex",
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
                className="-ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:hidden"
                aria-label="Volver"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Afiliado anónimo")}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {detail.sector_nombre}
                  {detail.afiliado_email && ` · ${detail.afiliado_email}`}
                  {detail.operator_name && ` · atendió ${detail.operator_name}`}
                </p>
              </div>
              <StatusBadge status={detail.status} />
            </div>

            {/* Mensajes */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4">
              <div className="mx-auto w-full max-w-4xl space-y-3">
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
