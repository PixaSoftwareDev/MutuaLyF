"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Check, Bot, Drama, Pencil, Building2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { SectionCard } from "@/components/admin/settings/section-card";

export function GeneralSettings() {
  const qc = useQueryClient();
  const { tenantId } = useAuthStore();
  const [botDescription, setBotDescription] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [orgName, setOrgName] = useState("");

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });

  // Nombre de la organización (branding) — identidad del tenant, no del widget.
  const { data: branding } = useQuery({
    queryKey: ["admin-branding"],
    queryFn: () => api.branding.getAdmin(),
  });
  useEffect(() => { if (branding) setOrgName(branding.display_name ?? ""); }, [branding]);
  const orgDirty = branding != null && orgName.trim().length > 0 && orgName.trim() !== branding.display_name;
  const saveOrgM = useMutation({
    mutationFn: () => api.branding.update({ display_name: orgName.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-branding"] });
      qc.invalidateQueries({ queryKey: ["tenant-branding"] });
      toast({ title: "Nombre actualizado", variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const { data: botsData, isLoading: botsLoading } = useQuery({
    queryKey: ["assigned-templates"],
    queryFn: api.promptTemplates.listAssigned,
  });

  useEffect(() => {
    if (botConfig) setBotDescription(botConfig.bot_description ?? "");
  }, [botConfig]);

  // Lectura por defecto, edición explícita (patrón del resto del sistema):
  // evita cambios accidentales en un texto que gobierna al bot en producción.
  const savedDescription = botConfig?.bot_description ?? "";
  const descriptionDirty = botConfig != null && botDescription !== savedDescription;

  const saveDescriptionM = useMutation({
    mutationFn: () => api.tenants.updateBotConfig(tenantId!, {
      bot_description: botDescription.trim() || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      setEditingDescription(false);
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
  const activePersonality = templates.find(t => t.is_active) ?? null;

  return (
    // Estilo nuevo (referencia Text) al ancho de Canales → Todos (max-w-5xl):
    // hero de identidad + secciones que aprovechan el ancho, sin quedar básicas.
    <div className="mx-auto w-full max-w-5xl space-y-4">

      {/* ── Hero: identidad del asistente ── */}
      <Card className="overflow-hidden rounded-2xl">
        <div className="grid items-stretch sm:grid-cols-[1fr_minmax(0,300px)]">
          <div className="p-6">
            <div className="flex items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-light to-brand-dark shadow-sm">
                <Bot className="h-7 w-7 text-brand-foreground" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold tracking-tight text-foreground">
                  {orgName.trim() || "Tu asistente"}
                </h2>
                <p className="text-sm text-muted-foreground">Asistente virtual</p>
              </div>
            </div>
            {activePersonality && (
              <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-action/30 bg-action/[0.06] px-3 py-1 text-xs font-medium text-action">
                <Drama className="h-3.5 w-3.5" /> {activePersonality.nombre}
              </span>
            )}
            <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
              Definí cómo se presenta, qué sabe y con qué tono responde. Los cambios se aplican al instante en el chat web y en los canales conectados.
            </p>
          </div>
          {/* Preview de conversación (decorativo, theme-aware) */}
          <div className="relative hidden overflow-hidden bg-gradient-to-br from-violet-100 via-indigo-50 to-transparent p-5 sm:flex sm:flex-col sm:justify-center dark:from-violet-500/15 dark:via-indigo-500/10 dark:to-transparent">
            <div className="space-y-2" aria-hidden>
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-xs leading-relaxed text-slate-600 shadow-sm dark:bg-white/10 dark:text-slate-200">
                ¡Hola! ¿En qué puedo ayudarte hoy?
              </div>
              <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-gradient-to-br from-brand to-brand-dark px-3 py-2 text-xs leading-relaxed text-brand-foreground shadow-sm">
                Quiero hacer una consulta
              </div>
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-xs leading-relaxed text-slate-600 shadow-sm dark:bg-white/10 dark:text-slate-200">
                ¡Con gusto! Contame de qué se trata.
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Nombre de la organización (control angosto → header/control a lo ancho) ── */}
      <Card className="rounded-2xl">
        <CardContent className="grid gap-4 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-center">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Building2 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Nombre de la organización</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">El nombre visible para tus usuarios y operadores.</p>
            </div>
          </div>
          <div className="flex gap-2 lg:justify-end">
            <Input
              value={orgName}
              onChange={e => setOrgName(e.target.value)}
              maxLength={200}
              placeholder="Ej. Mutualyf S.A."
              disabled={branding == null}
            />
            <Button size="sm" className="shrink-0" disabled={!orgDirty || saveOrgM.isPending} onClick={() => saveOrgM.mutate()}>
              {saveOrgM.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>

      <SectionCard
        icon={Bot}
        title="Instrucciones del asistente"
        description="Guían al asistente en cada conversación. Definen quién es, a quién atiende y cómo se comporta."
      >
        {editingDescription ? (
          <div className="space-y-3">
            <Textarea
              autoFocus
              value={botDescription}
              onChange={e => setBotDescription(e.target.value)}
              // Alto adaptable en vez de rows fijo: en mobile (390px) 10 filas
              // empujaban el guardar contra el textarea; crece desde sm.
              className="min-h-[9rem] sm:min-h-[13rem] text-sm resize-none leading-relaxed"
              placeholder="Quién es el asistente, a quién atiende y cómo se comporta…"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setBotDescription(savedDescription); setEditingDescription(false); }}>
                Cancelar
              </Button>
              <Button size="sm" disabled={!descriptionDirty || saveDescriptionM.isPending} onClick={() => saveDescriptionM.mutate()}>
                {saveDescriptionM.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Guardar
              </Button>
            </div>
          </div>
        ) : (
          /* Lápiz discreto en la esquina — no roba altura ni compite con el texto */
          <div className="group relative rounded-xl border bg-muted/30">
            <div className={cn(
              "px-4 py-3.5 pr-12 text-sm leading-relaxed whitespace-pre-wrap",
              !savedDescription && "italic text-muted-foreground",
            )}>
              {savedDescription || "Sin instrucciones aún. Completá el onboarding o escribilas acá."}
            </div>
            <button
              type="button"
              title="Editar instrucciones"
              aria-label="Editar instrucciones"
              disabled={botConfig == null}
              onClick={() => setEditingDescription(true)}
              className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground group-hover:text-muted-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </SectionCard>

      <SectionCard
        icon={Drama}
        title="Personalidad"
        description="El tono con el que responde. Una sola activa a la vez."
      >
        {botsLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : templates.length === 0 ? (
          <EmptyState
            title="Sin personalidades disponibles"
            description="El administrador de la plataforma puede habilitarte opciones."
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map(t => {
                const isActive = t.is_active;
                const isPending = activateM.isPending && activateM.variables === t.id;
                return (
                  <button
                    key={t.id}
                    disabled={isActive || activateM.isPending}
                    onClick={() => !isActive && activateM.mutate(t.id)}
                    className={cn(
                      "relative flex items-start gap-3 overflow-hidden rounded-xl border p-3.5 text-left transition-all",
                      isActive
                        ? "cursor-default border-transparent bg-gradient-to-br from-action/[0.14] via-action/[0.06] to-transparent shadow-sm ring-1 ring-action/40"
                        : "border-border hover:border-action/40 hover:bg-muted/50 card-interactive"
                    )}
                  >
                    <div className="mt-0.5 shrink-0">
                      {isActive
                        ? <span className="flex h-5 w-5 items-center justify-center rounded-full bg-action-gradient text-white shadow-sm">
                            <Check className="h-3 w-3" strokeWidth={3} />
                          </span>
                        : isPending
                          ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                          : <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/30" />
                      }
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={cn("truncate text-sm font-semibold", isActive ? "text-action" : "text-foreground")}>{t.nombre}</p>
                        {isActive && (
                          <span className="shrink-0 rounded-full bg-action/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-action">Activa</span>
                        )}
                      </div>
                      {t.descripcion && <p className="mt-0.5 text-xs leading-snug text-muted-foreground line-clamp-2">{t.descripcion}</p>}
                    </div>
                  </button>
                );
              })}
          </div>
        )}
      </SectionCard>

    </div>
  );
}
