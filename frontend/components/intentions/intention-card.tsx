"use client";

import { CheckCircle, XCircle, Zap, BookOpen, TrendingUp, AlertTriangle, MoreVertical, ToggleLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  id,
  label,
  description,
  exampleCount,
  autoLearnedCount,
  isActive,
  queries7d = 0,
  avgConfidence7d = 0,
  isPending,
  pendingQueryCount,
  pendingAvgConfidence,
  onApprove,
  onReject,
  onToggleActive,
  onDelete,
}: IntentionCardProps) {
  const autoLearnPct = exampleCount > 0 ? Math.round((autoLearnedCount / exampleCount) * 100) : 0;
  const capWarning = autoLearnPct >= 25;
  const confidencePct = Math.round((isPending ? pendingAvgConfidence ?? 0 : avgConfidence7d) * 100);

  return (
    <Card className={
      isPending
        ? "border-amber-300 bg-amber-50/40 dark:bg-amber-950/20"
        : !isActive
        ? "opacity-60"
        : ""
    }>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Zap className={`h-4 w-4 shrink-0 ${isActive && !isPending ? "text-primary" : "text-muted-foreground"}`} />
            <span className="font-medium text-sm truncate">{label}</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isPending && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-100"
                  onClick={() => onApprove?.(id)}
                  title="Aprobar esta intención"
                >
                  <CheckCircle className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
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
            <Badge variant="outline" className="text-xs">
              {confidencePct}% confianza
            </Badge>
          )}
          {capWarning && (
            <Badge variant="outline" className="text-xs text-amber-700 border-amber-300">
              <AlertTriangle className="h-3 w-3 mr-1" />
              Cap auto-aprendizaje
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-2.5">
        {description && (
          <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {isPending ? (
            <>
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                {pendingQueryCount} consultas detectadas
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1">
                <BookOpen className="h-3 w-3" />
                {exampleCount} ejemplos
              </span>
              {queries7d > 0 && (
                <span className="flex items-center gap-1">
                  <TrendingUp className="h-3 w-3" />
                  {queries7d} consultas (7d)
                </span>
              )}
            </>
          )}
        </div>

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
  );
}
