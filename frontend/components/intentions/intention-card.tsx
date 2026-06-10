"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle, XCircle, TrendingUp,
  MoreVertical, ToggleLeft, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type IntentionDetail } from "@/lib/api";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

// ── Drawer de detalle de intención ────────────────────────────────────────────

function IntentionDetailDrawer({
  id, label, open, onClose,
}: {
  id: string;
  label: string;
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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-base">{label}</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 mt-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-xs font-medium text-muted-foreground">
              Consultas recientes
            </p>
            {matches.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {matches.length} en los últimos 30 días
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-2 p-1">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Sin consultas en los últimos 30 días.
            </p>
          ) : (
            <div className="space-y-1">
              {matches.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground leading-snug">
                      {m.question_text ?? <span className="text-muted-foreground italic">Sin texto</span>}
                    </p>
                    <span className="text-xs text-muted-foreground">{fmtDate(m.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
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
      <Card
        className={[
          "shadow-sm transition-all duration-200",
          !isPending && "cursor-pointer hover:shadow-md hover:-translate-y-0.5",
          isPending ? "border-warning/20 bg-warning/5" : "",
          !isActive && !isPending ? "opacity-60" : "",
        ].filter(Boolean).join(" ")}
        onClick={() => !isPending && setDetailOpen(true)}
      >
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-sm truncate">{label}</p>
              {description && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{description}</p>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              {isPending && (
                <>
                  <Button
                    size="icon" variant="ghost"
                    className="h-7 w-7 text-success hover:text-success hover:bg-success/10"
                    onClick={() => onApprove?.(id)}
                    title="Aprobar"
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
                    <Button size="icon" variant="ghost" className="h-8 w-8">
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
        </CardHeader>

        <CardContent className="pt-0">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {isPending ? (
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                {pendingQueryCount} consultas
              </span>
            ) : queries7d > 0 ? (
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                {queries7d} consulta{queries7d !== 1 ? "s" : ""} en los últimos 7 días
              </span>
            ) : (
              <span className="text-muted-foreground/70">Sin consultas en los últimos 7 días</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Drawer de detalle — solo para temas activos/inactivos */}
      {!isPending && (
        <IntentionDetailDrawer
          id={id}
          label={label}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </>
  );
}
