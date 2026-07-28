"use client";

// Asistente del cliente: qué personalidad responde HOY, en una línea, y un
// solo botón "Configurar" que abre el sheet con todo junto y explicado:
// (1) cuál está activa, (2) cuáles puede ver/elegir el admin del cliente,
// (3) el cupo. Reemplaza al viejo BotSelector de selects encadenados.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import { api, type PromptTemplate } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FormSheet } from "@/components/layout/form-sheet";
import { StatePill } from "@/components/ui/state-pill";
import { Panel } from "@/components/superadmin/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const STANDARD = "__estandar__";

export function AssistantPanel({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [showSheet, setShowSheet] = useState(false);

  const { data: botsData, isLoading } = useQuery({
    queryKey: ["tenant-bots", tenantId],
    queryFn: () => api.tenantBots.list(tenantId),
    staleTime: 30_000,
  });
  const { data: catalog = [] } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: api.promptTemplates.list,
    staleTime: 60_000,
  });

  const bots = botsData?.bots ?? [];
  const activeBot = bots.find(b => b.is_active) ?? null;
  const activeDesc = activeBot
    ? (catalog.find((c: PromptTemplate) => c.id === activeBot.id)?.descripcion ?? activeBot.descripcion ?? null)
    : null;

  return (
    <>
      <Panel
        title="Asistente"
        action={
          <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setShowSheet(true)}>
            Configurar
          </Button>
        }
      >
        {isLoading ? (
          <div className="p-4"><Skeleton className="h-10 rounded-lg" /></div>
        ) : (
          <div className="space-y-1 px-4 py-3.5">
            <p className="flex items-center gap-2 text-sm">
              <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
              {activeBot ? (
                <span className="min-w-0">
                  <span className="font-semibold">{activeBot.nombre}</span>
                  <span className="text-muted-foreground"> es la personalidad activa</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Modo estándar — sin personalidad.</span>
              )}
            </p>
            {activeDesc && <p className="pl-6 text-xs leading-snug text-muted-foreground">{activeDesc}</p>}
            <p className="pl-6 text-[11px] text-muted-foreground/70">
              El cliente puede elegir entre {bots.length} {bots.length === 1 ? "personalidad habilitada" : "personalidades habilitadas"}.
            </p>
          </div>
        )}
      </Panel>

      {showSheet && botsData && (
        <AssistantSheet
          tenantId={tenantId}
          bots={bots}
          maxTemplates={botsData.max_prompt_templates ?? 1}
          catalog={catalog}
          onClose={() => setShowSheet(false)}
          onSaved={() => { setShowSheet(false); qc.invalidateQueries({ queryKey: ["tenant-bots", tenantId] }); }}
        />
      )}
    </>
  );
}

// ── El sheet: todo el asistente en un solo lugar, con Guardar explícito ───────
function AssistantSheet({ tenantId, bots, maxTemplates, catalog, onClose, onSaved }: {
  tenantId: string;
  bots: Array<{ id: string; nombre: string; descripcion: string | null; is_active: boolean }>;
  maxTemplates: number;
  catalog: PromptTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const activeCatalog = useMemo(() => catalog.filter(c => c.is_active), [catalog]);
  const initialActive = bots.find(b => b.is_active)?.id != null ? String(bots.find(b => b.is_active)!.id) : STANDARD;
  const initialVisible = useMemo(() => new Set(bots.map(b => String(b.id))), [bots]);

  const [active, setActive]   = useState<string>(initialActive);
  const [visible, setVisible] = useState<Set<string>>(new Set(initialVisible));
  const [maxStr, setMaxStr]   = useState(String(maxTemplates));
  const [saving, setSaving]   = useState(false);

  const toggleVisible = (id: string) => {
    setVisible(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Elegir una activa la hace visible sola (no puede estar activa y oculta).
  const pickActive = (id: string) => {
    setActive(id);
    if (id !== STANDARD) setVisible(prev => new Set(prev).add(id));
  };

  const saveM = useMutation({
    mutationFn: async () => {
      setSaving(true);
      const wasVisible = initialVisible;
      const toAssign   = [...visible].filter(id => !wasVisible.has(id));
      const toUnassign = [...wasVisible].filter(id => !visible.has(id) && id !== active);

      // 1. Habilitar nuevas (incluida la que se va a activar, si hace falta).
      for (const id of toAssign) {
        const res = await api.promptTemplates.assignToTenants(id, [tenantId]);
        if (res.errors?.length) throw new Error(res.errors[0].error);
      }
      // 2. Activar / volver a estándar.
      if (active !== initialActive) {
        if (active === STANDARD) await api.tenantBots.deactivate(tenantId);
        else await api.tenantBots.activate(tenantId, active);
      }
      // 3. Quitar las deshabilitadas (nunca la activa).
      for (const id of toUnassign) {
        await api.promptTemplates.unassign(tenantId, id);
      }
      // 4. Cupo.
      const max = Math.max(0, Number(maxStr) || 0);
      if (max !== maxTemplates) {
        await api.promptTemplates.setMaxTemplates(tenantId, max);
      }
    },
    onSuccess: () => { toast({ title: "Asistente actualizado", variant: "success" }); onSaved(); },
    onError: (e: any) => {
      setSaving(false);
      toast({ title: "No se pudo guardar", description: e?.response?.data?.detail ?? e?.message, variant: "destructive" });
    },
  });

  const overCap = visible.size > Math.max(0, Number(maxStr) || 0);

  return (
    <FormSheet
      open
      onOpenChange={v => !v && onClose()}
      icon={Bot}
      title="Configurar asistente"
      description="Qué personalidad responde y cuáles puede elegir el cliente."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => saveM.mutate()} disabled={saving || overCap}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </>
      }
    >
      {activeCatalog.length === 0 ? (
        <EmptyState icon={Bot} title="No hay personalidades en la plataforma" description="Crealas en Personalidades y volvé acá." />
      ) : (
        <div className="space-y-6">

          {/* ── 1. Personalidad activa ── */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Personalidad activa</p>
            <label className={cn(
              "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
              active === STANDARD ? "border-action/50 bg-action/[0.05]" : "hover:bg-muted/40",
            )}>
              <input type="radio" name="active" checked={active === STANDARD} onChange={() => pickActive(STANDARD)} className="mt-0.5" />
              <span>
                <span className="text-sm font-medium">Estándar</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">Sin personalidad — el comportamiento base del asistente.</span>
              </span>
            </label>
            {activeCatalog.map(c => {
              const id = String(c.id);
              return (
                <label key={id} className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                  active === id ? "border-action/50 bg-action/[0.05]" : "hover:bg-muted/40",
                )}>
                  <input type="radio" name="active" checked={active === id} onChange={() => pickActive(id)} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {c.nombre}
                      {!initialVisible.has(id) && active === id && <StatePill tone="info">se habilita al guardar</StatePill>}
                    </span>
                    {c.descripcion && <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{c.descripcion}</span>}
                  </span>
                </label>
              );
            })}
          </div>

          {/* ── 2. Qué puede elegir el cliente ── */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visibles para el cliente</p>
            <p className="text-xs leading-snug text-muted-foreground">
              El admin de la organización puede cambiar entre estas personalidades desde su panel.
            </p>
            {activeCatalog.map(c => {
              const id = String(c.id);
              const isActiveChoice = active === id;
              return (
                <label key={id} className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                  isActiveChoice ? "cursor-default opacity-90" : "hover:bg-muted/40",
                )}>
                  <input
                    type="checkbox"
                    checked={visible.has(id) || isActiveChoice}
                    disabled={isActiveChoice}
                    onChange={() => toggleVisible(id)}
                    className="h-4 w-4"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{c.nombre}</span>
                  {isActiveChoice && <StatePill tone="success">activa</StatePill>}
                </label>
              );
            })}
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
              <span className="text-sm">
                Cupo
                <span className="block text-[11px] text-muted-foreground">máximo de personalidades habilitadas</span>
              </span>
              <Input
                type="number" min={0} max={99}
                value={maxStr}
                onChange={e => setMaxStr(e.target.value)}
                className="h-8 w-20 text-right text-sm tabular-nums"
              />
            </div>
            {overCap && (
              <p className="text-xs font-medium text-warning">
                Marcaste {visible.size} personalidades pero el cupo es {Math.max(0, Number(maxStr) || 0)} — subí el cupo o desmarcá alguna.
              </p>
            )}
          </div>

        </div>
      )}
    </FormSheet>
  );
}
