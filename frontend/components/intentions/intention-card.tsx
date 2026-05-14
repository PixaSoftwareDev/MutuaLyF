"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle, XCircle, Zap, BookOpen, TrendingUp, AlertTriangle,
  MoreVertical, ToggleLeft, Trash2, Sparkles, Clock, ShieldCheck,
  Info, Loader2, MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type IntentionDetail } from "@/lib/api";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function ConfBadge({ conf }: { conf: number }) {
  const pct = Math.round(conf * 100);
  const color =
    pct >= 95 ? "bg-green-100 text-green-800 border-green-200" :
    pct >= 70 ? "bg-amber-100 text-amber-800 border-amber-200" :
    "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium tabular-nums ${color}`}>
      {pct}%
    </span>
  );
}

// ── Drawer de detalle de intención ────────────────────────────────────────────

function IntentionDetailDrawer({
  id, label, exampleCount, autoLearnedCount,
  open, onClose,
}: {
  id: string;
  label: string;
  exampleCount: number;
  autoLearnedCount: number;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<IntentionDetail>({
    queryKey: ["intention-examples", id],
    queryFn: () => api.intentions.getExamples(id),
    enabled: open,
    staleTime: 30_000,
  });

  const autoLearnPct = exampleCount > 0
    ? Math.round((autoLearnedCount / exampleCount) * 100)
    : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-primary" />
            {label}
          </DialogTitle>

          {/* Cap auto-aprendizaje — explicación inline */}
          <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground leading-relaxed mt-2">
            <p className="font-semibold text-foreground mb-1">¿Cómo funciona el aprendizaje de esta intención?</p>
            <p>
              Cada vez que alguien hace una consulta y el clasificador la identifica con{" "}
              <span className="font-medium text-foreground">≥ 95% de confianza</span>, esa pregunta
              se agrega automáticamente como ejemplo de entrenamiento (<span className="font-medium text-foreground">auto-aprendizaje</span>).
              Si la confianza es entre 70 y 94%, la consulta queda en la cola de revisión humana.
            </p>
            <p className="mt-1">
              <span className="font-medium text-foreground">Cap del 30%:</span>{" "}
              el auto-aprendizaje tiene un límite: cuando el{" "}
              <span className="font-medium text-foreground">30% de los ejemplos</span>{" "}
              fueron agregados automáticamente, el sistema para y marca los nuevos como{" "}
              <span className="font-medium text-foreground">"bloqueados"</span> para que un humano los revise.
              Esto previene que el modelo derive por error de clasificación repetido.
              {autoLearnPct > 0 && (
                <span className={autoLearnPct >= 25 ? " text-amber-700 font-medium" : ""}>
                  {" "}Estado actual: {autoLearnedCount} de {exampleCount} ejemplos son auto-aprendidos ({autoLearnPct}%).
                  {autoLearnPct >= 25 && " Cerca del límite."}
                </span>
              )}
            </p>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 mt-2">
          {isLoading ? (
            <div className="space-y-2 p-1">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Tabs defaultValue="training">
              <TabsList className="mb-3">
                <TabsTrigger value="training">
                  <BookOpen className="h-3.5 w-3.5 mr-1.5" />
                  Ejemplos de entrenamiento
                  {data && (
                    <Badge variant="secondary" className="ml-1.5 text-xs px-1.5">
                      {data.training_examples.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="matches">
                  <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                  Consultas recientes
                  {data && (
                    <Badge variant="secondary" className="ml-1.5 text-xs px-1.5">
                      {data.recent_matches.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              {/* Ejemplos de entrenamiento */}
              <TabsContent value="training" className="mt-0">
                {!data?.training_examples.length ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No hay ejemplos de entrenamiento todavía.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {data.training_examples.map((ex) => (
                      <div
                        key={ex.id}
                        className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-muted/40 transition-colors"
                      >
                        <div className="shrink-0 mt-0.5">
                          {ex.is_auto_learned ? (
                            <Sparkles className="h-3.5 w-3.5 text-primary" aria-label="Auto-aprendido" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" aria-label="Manual" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground leading-snug">
                            {ex.question_text ?? <span className="text-muted-foreground italic">Sin texto</span>}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-muted-foreground">{fmtDate(ex.created_at)}</span>
                            {ex.is_auto_learned && (
                              <span className="text-xs text-primary font-medium">auto-aprendido</span>
                            )}
                            {!ex.is_approved && (
                              <span className="text-xs text-amber-600 font-medium">pendiente aprobación</span>
                            )}
                            {ex.version_id && (
                              <span className="text-xs text-muted-foreground font-mono">v{ex.version_id.slice(0, 6)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Consultas recientes que matchearon */}
              <TabsContent value="matches" className="mt-0">
                <p className="text-xs text-muted-foreground mb-3">
                  Consultas de los últimos 30 días que el clasificador identificó como esta intención.
                  Las marcadas con ✦ se agregaron automáticamente como ejemplos.
                </p>
                {!data?.recent_matches.length ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    Sin consultas registradas en los últimos 30 días.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {data.recent_matches.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-muted/40 transition-colors"
                      >
                        <div className="shrink-0 mt-0.5">
                          {m.auto_learning_blocked ? (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Bloqueado por cap 30%" />
                          ) : m.intent_confidence !== null && m.intent_confidence >= 0.95 ? (
                            <Sparkles className="h-3.5 w-3.5 text-primary" aria-label="Auto-aprendido" />
                          ) : (
                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground leading-snug">
                            {m.question_text ?? <span className="text-muted-foreground italic">Sin texto</span>}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-xs text-muted-foreground">{fmtDate(m.created_at)}</span>
                            {m.intent_confidence !== null && <ConfBadge conf={m.intent_confidence} />}
                            {m.from_cache && (
                              <span className="text-xs text-muted-foreground">desde caché</span>
                            )}
                            {m.auto_learning_blocked && (
                              <span className="text-xs text-amber-600 font-medium">bloqueado · cap 30%</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── IntentionCard ──────────────────────────────────────────────────────────────

interface IntentionCardProps {
  id: string;
  label: string;
  description?: string | null;
  exampleCount: number;
  autoLearnedCount: number;
  isActive: boolean;
  queries7d?: number;
  avgConfidence7d?: number;
  isPending?: boolean;
  pendingQueryCount?: number;
  pendingAvgConfidence?: number;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onToggleActive?: (id: string, currentActive: boolean) => void;
  onDelete?: (id: string) => void;
}

export function IntentionCard({
  id, label, description, exampleCount, autoLearnedCount,
  isActive, queries7d = 0, avgConfidence7d = 0,
  isPending, pendingQueryCount, pendingAvgConfidence,
  onApprove, onReject, onToggleActive, onDelete,
}: IntentionCardProps) {
  const [detailOpen, setDetailOpen] = useState(false);

  const autoLearnPct = exampleCount > 0
    ? Math.round((autoLearnedCount / exampleCount) * 100)
    : 0;
  const capWarning = autoLearnPct >= 25;
  const confidencePct = Math.round(
    (isPending ? pendingAvgConfidence ?? 0 : avgConfidence7d) * 100
  );

  return (
    <TooltipProvider delayDuration={300}>
      <>
        <Card
          className={[
            "cursor-pointer transition-shadow hover:shadow-md",
            isPending ? "border-amber-300 bg-amber-50/40 dark:bg-amber-950/20" : "",
            !isActive && !isPending ? "opacity-60" : "",
          ].join(" ")}
          onClick={() => !isPending && setDetailOpen(true)}
        >
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Zap className={`h-4 w-4 shrink-0 ${isActive && !isPending ? "text-primary" : "text-muted-foreground"}`} />
                <span className="font-medium text-sm truncate">{label}</span>
              </div>

              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                {isPending && (
                  <>
                    <Button
                      size="icon" variant="ghost"
                      className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-100"
                      onClick={() => onApprove?.(id)}
                      title="Aprobar esta intención"
                    >
                      <CheckCircle className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon" variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
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
                      <Button size="icon" variant="ghost" className="h-7 w-7">
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

            {/* Badges */}
            <div className="flex flex-wrap gap-1.5 mt-1">
              {isPending && (
                <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">
                  Pendiente revisión
                </Badge>
              )}
              {!isPending && !isActive && (
                <Badge variant="secondary" className="text-xs">Inactiva</Badge>
              )}
              {confidencePct > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-xs cursor-help gap-1">
                      {confidencePct}% confianza
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs">
                    <p className="font-medium mb-1">¿Qué es este porcentaje?</p>
                    <p>
                      {isPending
                        ? "Confianza promedio con la que el clasificador detectó estas consultas. Un valor alto indica que el patrón es claro."
                        : "Confianza promedio de clasificación en los últimos 7 días. Mide qué tan seguro está el clasificador cuando reconoce esta intención. ≥ 95% = alta certeza · 70–94% = consulta a revisión humana."}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
              {capWarning && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-xs text-amber-700 border-amber-300 cursor-help gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      Cap auto-aprendizaje
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs">
                    <p className="font-medium mb-1">Cap del 30% — ¿qué significa?</p>
                    <p>
                      El sistema agrega automáticamente como ejemplos las consultas con ≥ 95% de confianza.
                      Para evitar que un error de clasificación repetido "envenene" el modelo,
                      tiene un límite: cuando el 30% de los ejemplos son auto-aprendidos,
                      el sistema deja de agregar más automáticamente y los marca como pendientes de revisión humana.
                    </p>
                    <p className="mt-1 font-medium">
                      Estado actual: {autoLearnedCount}/{exampleCount} ejemplos son auto-aprendidos ({autoLearnPct}%).
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </CardHeader>

          <CardContent className="pt-0 space-y-2.5">
            {description && (
              <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {isPending ? (
                <span className="flex items-center gap-1">
                  <TrendingUp className="h-3 w-3" />
                  {pendingQueryCount} consultas detectadas
                </span>
              ) : (
                <>
                  <span className="flex items-center gap-1">
                    <BookOpen className="h-3 w-3" />
                    {exampleCount} ejemplos
                    {autoLearnedCount > 0 && (
                      <span className="text-primary">· {autoLearnedCount} auto</span>
                    )}
                  </span>
                  {queries7d > 0 && (
                    <span className="flex items-center gap-1">
                      <TrendingUp className="h-3 w-3" />
                      {queries7d} consultas (7d)
                    </span>
                  )}
                  {!isPending && (
                    <span className="text-xs text-muted-foreground/60 ml-auto">Clic para ver detalle →</span>
                  )}
                </>
              )}
            </div>

            {/* Barra de auto-aprendizaje */}
            {!isPending && autoLearnedCount > 0 && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Auto-aprendizaje</span>
                  <span className={capWarning ? "text-amber-700 font-medium" : ""}>
                    {autoLearnedCount}/{exampleCount} ({autoLearnPct}%{capWarning ? " ⚠" : ""})
                  </span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${capWarning ? "bg-amber-400" : "bg-primary"}`}
                    style={{ width: `${Math.min(autoLearnPct, 100)}%` }}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Drawer de detalle — solo para intenciones activas/inactivas */}
        {!isPending && (
          <IntentionDetailDrawer
            id={id}
            label={label}
            exampleCount={exampleCount}
            autoLearnedCount={autoLearnedCount}
            open={detailOpen}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </>
    </TooltipProvider>
  );
}
