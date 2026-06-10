"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, Sparkles, Bot, Drama } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { SectionHeader } from "@/components/admin/settings/section-header";

export function GeneralSettings() {
  const qc = useQueryClient();
  const { tenantId } = useAuthStore();
  const [botDescription, setBotDescription] = useState("");

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });

  const { data: botsData, isLoading: botsLoading } = useQuery({
    queryKey: ["assigned-templates"],
    queryFn: api.promptTemplates.listAssigned,
  });

  useEffect(() => {
    if (botConfig) setBotDescription(botConfig.bot_description ?? "");
  }, [botConfig]);

  // El form está siempre editable; Guardar se habilita solo con cambios.
  const descriptionDirty = botConfig != null && (botDescription !== (botConfig.bot_description ?? ""));

  const saveDescriptionM = useMutation({
    mutationFn: () => api.tenants.updateBotConfig(tenantId!, {
      bot_description: botDescription.trim() || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      toast({ title: "Instrucciones actualizadas", variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const activateM = useMutation({
    mutationFn: (id: string) => api.promptTemplates.activate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assigned-templates"] });
      toast({ title: "Personalidad activada", variant: "success" });
    },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al activar", variant: "destructive" }),
  });

  const templates = botsData?.templates ?? [];

  return (
    <div className="space-y-6">
      {/* Instrucciones (bot_description) */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-4">
          <SectionHeader
            icon={Bot}
            title="Instrucciones del asistente"
            description="Guían al asistente en cada conversación. Definen quién es, a quién atiende y cómo se comporta."
          />
        </CardHeader>
        <CardContent>
          <Textarea
            value={botDescription}
            onChange={e => setBotDescription(e.target.value)}
            rows={10}
            placeholder="Sin instrucciones aún. Completá el onboarding o escribilas acá."
            className="text-sm resize-none leading-relaxed"
          />
          <div className="flex justify-end mt-3">
            <Button
              onClick={() => saveDescriptionM.mutate()}
              disabled={!descriptionDirty || saveDescriptionM.isPending}
            >
              {saveDescriptionM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Guardar cambios
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Personalidad */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-4">
          <SectionHeader
            icon={Drama}
            title="Personalidad"
            description="El tono con el que responde. Una sola activa a la vez."
          />
        </CardHeader>
        <CardContent>
          {botsLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : templates.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="Sin personalidades disponibles"
              description="El administrador de la plataforma puede habilitarte opciones."
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map(t => {
                const isActive = t.is_active;
                const isPending = activateM.isPending && activateM.variables === t.id;
                return (
                  <button
                    key={t.id}
                    disabled={isActive || activateM.isPending}
                    onClick={() => !isActive && activateM.mutate(t.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all",
                      isActive
                        ? "border-action/40 bg-action/[0.05] ring-1 ring-action/30 cursor-default"
                        : "border-border hover:border-action/40 hover:bg-muted/50 card-interactive"
                    )}
                  >
                    <div className="mt-0.5 shrink-0">
                      {isActive
                        ? <CheckCircle2 className="h-4 w-4 text-action" />
                        : isPending
                          ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          : <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
                      }
                    </div>
                    <div className="min-w-0">
                      <p className={cn("text-sm font-medium truncate", isActive && "text-action")}>{t.nombre}</p>
                      {t.descripcion && <p className="text-xs text-muted-foreground mt-0.5 leading-snug line-clamp-2">{t.descripcion}</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
