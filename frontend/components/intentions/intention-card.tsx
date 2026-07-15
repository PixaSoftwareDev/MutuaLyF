"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle, XCircle, TrendingUp,
  MoreVertical, ToggleLeft, Trash2, Tag, AlertTriangle,
  MessagesSquare, Target, Database, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type IntentionDetail } from "@/lib/api";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

// ── Panel lateral de detalle de tema ──────────────────────────────────────────
// Desliza desde la derecha (como los paneles de editar del admin). Encabezado +
// métricas derivadas de las consultas reales + dos secciones: qué preguntó la
// gente (recent_matches) y qué ejemplos definen el tema (training_examples).

function fmtLatency(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function IntentionDetailDrawer({
  id, label, isActive, open, onClose,
}: {
  id: string;
  label: string;
  isActive: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<IntentionDetail>({
    queryKey: ["intention-examples", id],
    queryFn: () => api.intentions.getExamples(id),
    enabled: open,
    staleTime: 30_000,
  });

  const matches = data?.recent_matches ?? [];

  // Métricas derivadas de las consultas reales (últimos 30 días)
  const avgConf = matches.length
    ? Math.round(matches.reduce((s, m) => s + (m.intent_confidence ?? 0), 0) / matches.length * 100)
    : null;
  const cachePct = matches.length
    ? Math.round(matches.filter((m) => m.from_cache).length / matches.length * 100)
    : null;
  const lats = matches.map((m) => m.latency_ms).filter((x): x is number => x != null);
  const avgLat = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg p-0 gap-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-5 border-b border-border/70 space-y-0 text-left">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
              <Tag className="h-5 w-5 text-action" />
            </div>
            <div className="min-w-0 space-y-1">
              <SheetTitle className="truncate">{label}</SheetTitle>
              <ThemeStatus isActive={isActive} />
            </div>
          </div>
        </SheetHeader>

        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* Métricas — tarjetas suaves con ícono, sin líneas divisorias */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 px-6 py-5">
              <MetricCard icon={MessagesSquare} value={String(matches.length)} label="Consultas" sub="30 días" />
              <MetricCard icon={Target} value={avgConf != null ? `${avgConf}%` : "—"} label="Confianza" />
              <MetricCard icon={Database} value={cachePct != null ? `${cachePct}%` : "—"} label="Cache" />
              <MetricCard icon={Clock} value={avgLat != null ? fmtLatency(avgLat) : "—"} label="Latencia" />
            </div>

            {/* Consultas reales */}
            <DetailSection title="Consultas reales" count={matches.length}>
              {matches.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">Sin consultas en los últimos 30 días.</p>
              ) : (
                <ul className="space-y-0.5">
                  {matches.map((m) => (
                    <li key={m.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-muted/40">
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-foreground leading-snug">
                          {m.question_text ?? <span className="text-muted-foreground italic">Sin texto</span>}
                        </span>
                        <span className="text-xs text-muted-foreground">{fmtDate(m.created_at)}</span>
                      </span>
                      {m.from_cache && (
                        <span className="shrink-0 mt-0.5 inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          cache
                        </span>
                      )}
                      <ConfChip value={m.intent_confidence} />
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MetricCard({
  icon: Icon, value, label, sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  label: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 transition-colors hover:bg-muted/50">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-xl font-semibold tabular-nums text-foreground leading-none">{value}</span>
        {sub && <span className="text-[10px] text-muted-foreground/60">{sub}</span>}
      </div>
    </div>
  );
}

function DetailSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="px-4 py-4 border-b border-border/60 last:border-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-2 px-2">
        {title} {count > 0 && <span className="text-muted-foreground/50">· {count}</span>}
      </p>
      {children}
    </div>
  );
}

function ConfChip({ value }: { value: number | null }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  const cls = pct >= 90 ? "text-success" : pct >= 70 ? "text-warning" : "text-muted-foreground";
  return <span className={cn("shrink-0 mt-0.5 text-xs tabular-nums font-medium", cls)}>{pct}%</span>;
}

// Línea de metadato: consultas del tema (mismo ritmo que sectores/operadores).
function QueryCountLine({ count, window }: { count: number; window?: string }) {
  const has = count > 0;
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <TrendingUp className={cn("h-3.5 w-3.5", has ? "text-muted-foreground/60" : "text-muted-foreground/40")} />
      {has ? (
        <span>
          <span className="font-semibold text-foreground tabular-nums">{count}</span>{" "}
          {count === 1 ? "consulta" : "consultas"}{window ? ` · ${window}` : ""}
        </span>
      ) : (
        <span className="text-muted-foreground/70">Sin consultas{window ? ` · ${window}` : ""}</span>
      )}
    </div>
  );
}

// ── IntentionCard ──────────────────────────────────────────────────────────────

interface IntentionCardProps {
  id: string;
  label: string;
  description?: string | null;
  isActive: boolean;
  queries7d?: number;
  isPending?: boolean;
  pendingQueryCount?: number;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onToggleActive?: (id: string, currentActive: boolean) => void;
  onDelete?: (id: string) => void;
}

export function IntentionCard({
  id, label, description,
  isActive, queries7d = 0,
  isPending, pendingQueryCount,
  onApprove, onReject, onToggleActive, onDelete,
}: IntentionCardProps) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          "group rounded-2xl border bg-card p-5 shadow-sm transition-shadow duration-200",
          !isPending && "cursor-pointer hover:shadow-md hover:border-action/25",
          isPending && "border-warning/30 bg-warning/[0.04]",
          !isActive && !isPending && "opacity-70",
        )}
        onClick={() => !isPending && setDetailOpen(true)}
      >
        {/* Header: tile + (nombre / metadato de consultas) + acciones */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              isPending ? "bg-warning/15" : "bg-action-gradient-soft",
            )}>
              <Tag className={cn("h-5 w-5", isPending ? "text-warning" : "text-action")} />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-[15px] tracking-tight text-foreground truncate">{label}</h3>
              <QueryCountLine
                count={isPending ? (pendingQueryCount ?? 0) : queries7d}
                window={isPending ? undefined : "7 días"}
              />
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            {isPending && (
              <>
                <Button
                  size="icon" variant="ghost"
                  className="h-8 w-8 text-success hover:text-success hover:bg-success/10"
                  onClick={() => onApprove?.(id)}
                  title="Aprobar"
                >
                  <CheckCircle className="h-4 w-4" />
                </Button>
                <Button
                  size="icon" variant="ghost"
                  className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onReject?.(id)}
                  title="Descartar"
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </>
            )}

            {!isPending && (onToggleActive || onDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-8 w-8 -mt-0.5 text-muted-foreground">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onToggleActive && (
                    <DropdownMenuItem onClick={() => onToggleActive(id, isActive)}>
                      <ToggleLeft className="h-4 w-4 mr-2" />
                      {isActive ? "Desactivar" : "Activar"}
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDelete(id)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Eliminar
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Cuerpo: descripción (si hay) */}
        {description && (
          <p className="text-sm text-muted-foreground mt-4 line-clamp-2">{description}</p>
        )}
      </div>

      {/* Drawer de detalle — solo para temas activos/inactivos */}
      {!isPending && (
        <IntentionDetailDrawer
          id={id}
          label={label}
          isActive={isActive}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </>
  );
}

// ── IntentionRow (vista Lista / tabla, escala a muchos temas) ─────────────────

interface IntentionRowProps {
  id: string;
  label: string;
  description?: string | null;
  isActive: boolean;
  queries7d?: number;
  // Máximo de consultas de la lista → escala la barra de uso relativa.
  maxQueries?: number;
  onToggleActive?: (id: string, currentActive: boolean) => void;
  onDelete?: (id: string) => void;
}

export function IntentionRow({
  id, label, description, isActive, queries7d = 0, maxQueries = 1,
  onToggleActive, onDelete,
}: IntentionRowProps) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setDetailOpen(true)}>
        <TableCell>
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-action-gradient-soft">
              <Tag className="h-4 w-4 text-action" />
            </div>
            <div className="min-w-0">
              <span className="block font-medium text-foreground truncate">{label}</span>
              {description && <span className="block text-xs text-muted-foreground truncate">{description}</span>}
            </div>
          </div>
        </TableCell>
        <TableCell>
          <UsageBar value={queries7d} max={maxQueries} />
        </TableCell>
        <TableCell className="hidden md:table-cell whitespace-nowrap">
          <ThemeStatus isActive={isActive} />
        </TableCell>
        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
          {(onToggleActive || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onToggleActive && (
                  <DropdownMenuItem onClick={() => onToggleActive(id, isActive)}>
                    <ToggleLeft className="h-4 w-4 mr-2" />
                    {isActive ? "Desactivar" : "Activar"}
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(id)}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Eliminar
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </TableCell>
      </TableRow>

      <IntentionDetailDrawer id={id} label={label} isActive={isActive} open={detailOpen} onClose={() => setDetailOpen(false)} />
    </>
  );
}

// Barra de uso: mini-barra proporcional + número. Cero = aviso "sin uso"
// (candidato a desactivar).
function UsageBar({ value, max }: { value: number; max: number }) {
  if (value <= 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-warning">
        <AlertTriangle className="h-3.5 w-3.5" /> Sin uso
      </span>
    );
  }
  const pct = Math.max(6, Math.round((value / Math.max(max, 1)) * 100));
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-action" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm tabular-nums font-medium text-foreground w-7 text-right">{value}</span>
    </div>
  );
}

function ThemeStatus({ isActive }: { isActive: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span className={cn("h-1.5 w-1.5 rounded-full", isActive ? "bg-success" : "bg-muted-foreground/40")} />
      <span className={isActive ? "text-foreground" : "text-muted-foreground"}>{isActive ? "Activo" : "Inactivo"}</span>
    </span>
  );
}
