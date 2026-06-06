"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search, ChevronLeft, ChevronRight, ChevronDown, Loader2, MessageSquare,
  X, UserCheck, MessageCircle, History as HistoryIcon, Filter,
} from "lucide-react";
import { api, type ConversationHistoryFilters } from "@/lib/api";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── LEFT: filters + list ──────────────────────────────────────────── */}
      <div className={cn(
        "border-r flex flex-col shrink-0 bg-card",
        "w-full sm:w-80",
        selectedId ? "hidden sm:flex" : "flex"
      )}>
        {/* Header */}
        <div className="h-16 px-4 flex items-center justify-between border-b shrink-0">
          <h1 className="font-semibold text-sm flex items-center gap-2">
            <HistoryIcon className="h-4 w-4 text-primary" />
            Historial
          </h1>
          <button
            onClick={() => setFiltersOpen(v => !v)}
            className={cn(
              "flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-colors",
              activeFiltersCount > 0
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <Filter className="h-3 w-3" />
            Filtros
            {activeFiltersCount > 0 && (
              <span className="bg-primary text-white rounded-full text-[10px] w-4 h-4 flex items-center justify-center font-bold">
                {activeFiltersCount}
              </span>
            )}
          </button>
        </div>

        {/* Search + filters */}
        <div className="px-4 pt-3 pb-3 space-y-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Buscar afiliado…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") applySearch(); }}
              onBlur={applySearch}
              className="w-full h-8 pl-8 pr-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {filtersOpen && (
            <div className="space-y-2 pt-1">
              <select
                value={filters.status ?? ""}
                onChange={e => setFilters(f => ({ ...f, status: e.target.value || undefined, page: 1 }))}
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={filters.dateFrom ?? ""}
                  onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value || undefined, page: 1 }))}
                  className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="Desde"
                />
                <span className="text-xs text-muted-foreground">→</span>
                <input
                  type="date"
                  value={filters.dateTo ?? ""}
                  onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value || undefined, page: 1 }))}
                  className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="Hasta"
                />
              </div>

              {activeFiltersCount > 0 && (
                <Button size="sm" variant="ghost" className="w-full h-7 text-xs" onClick={clearFilters}>
                  <X className="h-3 w-3 mr-1" /> Limpiar filtros
                </Button>
              )}
            </div>
          )}

          <div className="text-[10px] text-muted-foreground tabular-nums flex items-center gap-1">
            {isFetching && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            <span>{total} resultados</span>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
          ) : error ? (
            <p className="text-xs text-destructive text-center py-8">Error al cargar</p>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs">Sin resultados</p>
              {activeFiltersCount > 0 && (
                <button onClick={clearFilters} className="text-[11px] text-primary hover:underline mt-2">
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

        {/* Pagination */}
        {!isLoading && total > 0 && (
          <div className="px-3 py-2 border-t flex items-center justify-between text-[11px] text-muted-foreground shrink-0">
            <span className="tabular-nums">
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} de {total}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm" variant="outline" className="h-6 px-1.5"
                disabled={page <= 1}
                onClick={() => setFilters(f => ({ ...f, page: Math.max(1, (f.page ?? 1) - 1) }))}
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <span className="px-1 tabular-nums">{page}/{totalPages}</span>
              <Button
                size="sm" variant="outline" className="h-6 px-1.5"
                disabled={page >= totalPages}
                onClick={() => setFilters(f => ({ ...f, page: Math.min(totalPages, (f.page ?? 1) + 1) }))}
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT: detail (read-only) ─────────────────────────────────────── */}
      <div className={cn(
        "flex-1 flex flex-col min-w-0 bg-background",
        !selectedId && "hidden sm:flex"
      )}>
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-2">
              <MessageSquare className="h-10 w-10 mx-auto opacity-15" />
              <p className="text-sm">Seleccioná una conversación</p>
              <p className="text-xs opacity-70">Vista de solo lectura</p>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : detail ? (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b flex items-center justify-between gap-3 bg-card">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setSelectedId(null)}
                  className="sm:hidden flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                  aria-label="Volver"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0">
                  <p className="font-semibold text-sm truncate">{detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Afiliado anónimo")}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {detail.sector_nombre}
                    {detail.afiliado_email && ` · ${detail.afiliado_email}`}
                    {detail.operator_name && ` · atendió ${detail.operator_name}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge status={detail.status} />
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {botMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}
              {operatorMessages.length > 0 && botMessages.length > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 border-t border-dashed border-border" />
                  <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
                    <UserCheck className="h-3 w-3" /> Operador tomó la conversación
                  </span>
                  <div className="flex-1 border-t border-dashed border-border" />
                </div>
              )}
              {operatorMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}
              {detail.messages.length === 0 && (
                <p className="text-center text-sm text-muted-foreground py-10">Conversación sin mensajes</p>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Footer: read-only notice */}
            <div className="px-4 py-2.5 border-t bg-muted/30 text-center">
              <p className="text-[11px] text-muted-foreground flex items-center justify-center gap-1.5">
                <MessageCircle className="h-3 w-3" />
                Vista histórica de solo lectura
              </p>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── History card ──────────────────────────────────────────────────────────────

function HistoryCard({
  row, selected, onClick,
}: {
  row: import("@/lib/api").ConversationHistoryRow;
  selected: boolean;
  onClick: () => void;
}) {
  // Status is communicated by a leading dot, same vocabulary as the inbox.
  const dotColor =
    row.status === "handoff_requested" ? "bg-amber-500"   :
    row.status === "human_attending"   ? "bg-emerald-500" :
    "bg-transparent";

  const dateRef = row.last_message_at ?? row.updated_at ?? row.created_at;
  const dateStr = dateRef
    ? new Date(dateRef).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <div
      className={cn(
        "rounded-lg transition-colors",
        selected ? "bg-accent ring-1 ring-primary/20" : "hover:bg-muted/50",
      )}
    >
      <button onClick={onClick} className="w-full text-left px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <span
            className={cn("w-2 h-2 rounded-full shrink-0 mt-1.5", dotColor)}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate leading-tight flex items-center gap-1.5">
              {row.is_test && <span className="shrink-0 text-[9px] font-bold bg-violet-100 text-violet-700 rounded px-1 py-0.5 uppercase tracking-wide">TEST</span>}
              {row.afiliado_nombre || (row.afiliado_ip ? `IP ${row.afiliado_ip}` : "Anónimo")}
            </p>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{row.sector_nombre || "Sin sector"}</p>
            {row.operator_name && (
              <p className="text-[10px] mt-0.5 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-slate-300" />
                <span className="truncate text-muted-foreground">{row.operator_name}</span>
              </p>
            )}
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1">
            <span className="text-[10px] text-muted-foreground tabular-nums">{dateStr}</span>
            <span className="text-[10px] text-muted-foreground tabular-nums">{row.message_count} msj</span>
          </div>
        </div>
      </button>
    </div>
  );
}
