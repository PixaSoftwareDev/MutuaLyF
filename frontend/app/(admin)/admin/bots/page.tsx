"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { Bot, CheckCircle2, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

function catLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1).replace(/[_-]/g, " ");
}

export default function BotsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["assigned-templates"],
    queryFn: api.promptTemplates.listAssigned,
  });

  const activateM = useMutation({
    mutationFn: (id: string) => api.promptTemplates.activate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assigned-templates"] });
      toast({ title: "Personalidad activada", description: "El asistente usará esta personalidad en todas las consultas.", variant: "success" });
    },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al activar", variant: "destructive" }),
  });

  const deactivateM = useMutation({
    mutationFn: api.promptTemplates.deactivate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assigned-templates"] });
      toast({ title: "Personalidad desactivada", description: "El asistente vuelve al modo estándar." });
    },
  });

  const templates = data?.templates ?? [];
  const activeTemplate = templates.find(t => t.is_active);

  return (
    <PageShell>
      <PageHeader
        title="Personalidad del bot"
        description="Elegí cómo se comunica tu asistente. Solo puede estar activa una personalidad a la vez."
      />

      {/* Estado actual */}
      <div className={cn(
        "rounded-lg border px-4 py-3 flex items-center justify-between gap-3",
        activeTemplate
          ? "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800"
          : "bg-muted/40 border-border"
      )}>
        <div className="flex items-center gap-2">
          {activeTemplate ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
              <div>
                <span className="text-sm font-semibold text-green-800 dark:text-green-300">
                  {activeTemplate.nombre}
                </span>
                <span className="text-xs text-green-700/70 dark:text-green-400/70 ml-2">
                  — {catLabel(activeTemplate.categoria)}
                </span>
              </div>
            </>
          ) : (
            <>
              <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">
                Sin personalidad activa — el asistente usa el modo estándar
              </span>
            </>
          )}
        </div>
        {activeTemplate && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-destructive"
            disabled={deactivateM.isPending}
            onClick={() => deactivateM.mutate()}
          >
            {deactivateM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Desactivar"}
          </Button>
        )}
      </div>

      {/* Lista de personalidades */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-16 text-center">
          <Bot className="h-10 w-10 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">No tenés personalidades disponibles</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
            El administrador de la plataforma puede habilitarte personalidades según tu plan.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map(t => {
            const isActive = t.is_active;
            const isPending = activateM.isPending && activateM.variables === t.id;
            return (
              <Card
                key={t.id}
                className={cn(
                  "transition-all cursor-default",
                  isActive
                    ? "border-primary shadow-sm ring-1 ring-primary/20"
                    : "hover:border-primary/40 hover:shadow-sm"
                )}
              >
                <CardContent className="p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-sm leading-tight">{t.nombre}</p>
                      <Badge variant="secondary" className="mt-1 text-[10px] px-1.5 py-0">
                        {catLabel(t.categoria)}
                      </Badge>
                    </div>
                    {isActive && (
                      <Badge className="text-[10px] bg-green-100 text-green-700 border-green-200 shrink-0">
                        Activa
                      </Badge>
                    )}
                  </div>

                  {t.descripcion && (
                    <p className="text-xs text-muted-foreground leading-relaxed">{t.descripcion}</p>
                  )}

                  <Button
                    size="sm"
                    variant={isActive ? "outline" : "default"}
                    className="w-full h-8 mt-auto"
                    disabled={isActive || activateM.isPending}
                    onClick={() => !isActive && activateM.mutate(t.id)}
                  >
                    {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                    {isActive ? "En uso" : "Usar esta personalidad"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground pb-2">
        Las personalidades disponibles dependen de tu plan. Para más opciones, contactá al administrador de la plataforma.
      </p>
    </PageShell>
  );
}
