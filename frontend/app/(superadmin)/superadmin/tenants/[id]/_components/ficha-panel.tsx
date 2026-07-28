"use client";

// Ficha de la organización: quién es y qué contrata. Toda la gestión
// comercial vive acá — plan (con sheet de confirmación, nunca un select que
// dispara solo), estado (suspender/reactivar con confirmación) y el reset
// de onboarding escondido detrás del menú ⋮ con typing-guard.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AlertTriangle, Layers, Loader2, MoreVertical, PauseCircle, PlayCircle, RefreshCw, Trash2 } from "lucide-react";
import { api, type PlanRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FormSheet } from "@/components/layout/form-sheet";
import { StatePill, type StatePillTone } from "@/components/ui/state-pill";
import { Panel, KVRow } from "@/components/superadmin/panel";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const STATUS_META: Record<string, { label: string; tone: StatePillTone }> = {
  active:     { label: "Activa",     tone: "success" },
  onboarding: { label: "Onboarding", tone: "info" },
  suspended:  { label: "Suspendida", tone: "destructive" },
};

function fmtLimit(n: number): string {
  if (n === -1)       return "ilimitado";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + "K";
  return String(n);
}

export function FichaPanel({ tenant: t, onChanged }: {
  tenant: { id: string; name: string; plan: string; status: string; admin_email: string; created_at: string | null };
  onChanged: () => void;
}) {
  const [showPlan, setShowPlan]       = useState(false);
  const [showSuspend, setShowSuspend] = useState(false);
  const [showReset, setShowReset]     = useState(false);
  const [showDelete, setShowDelete]   = useState(false);

  const isActive = t.status === "active" || t.status === "onboarding";
  const isSuspended = t.status === "suspended";
  const statusMeta = STATUS_META[t.status] ?? { label: t.status, tone: "muted" as StatePillTone };

  const activateM = useMutation({
    mutationFn: () => api.tenants.activateTenant(t.id),
    onSuccess: () => { onChanged(); toast({ title: "Organización reactivada", variant: "success" }); },
    onError: () => toast({ title: "Error al reactivar", variant: "destructive" }),
  });

  return (
    <>
      <Panel
        title="Ficha"
        action={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" title="Más acciones">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setShowReset(true)} className="text-destructive focus:text-destructive">
                <RefreshCw className="mr-2 h-4 w-4" />
                Resetear onboarding
              </DropdownMenuItem>
              {/* Eliminar exige suspender primero — dos pasos deliberados. */}
              <DropdownMenuItem
                disabled={!isSuspended}
                onSelect={() => isSuspended && setShowDelete(true)}
                className="text-destructive focus:text-destructive"
                title={isSuspended ? undefined : "Suspendé la organización antes de eliminarla"}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {isSuspended ? "Eliminar organización" : "Eliminar (suspender primero)"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <div className="divide-y divide-border/50">
          <KVRow label="ID" value={<code className="font-mono text-xs">{t.id}</code>} />
          <KVRow label="Email del admin" value={<span className="max-w-[180px] truncate text-sm font-medium sm:max-w-[220px]" title={t.admin_email}>{t.admin_email}</span>} />
          <KVRow
            label="Creada"
            value={t.created_at ? new Date(t.created_at).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
          />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-[13px] text-muted-foreground">Plan</span>
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold capitalize">{t.plan}</span>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setShowPlan(true)}>
                Cambiar
              </Button>
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-[13px] text-muted-foreground">Estado</span>
            <span className="flex items-center gap-2">
              <StatePill tone={statusMeta.tone}>{statusMeta.label}</StatePill>
              {isActive ? (
                <Button
                  size="sm" variant="outline"
                  className="h-7 gap-1 border-warning/25 px-2.5 text-xs text-warning hover:bg-warning/10"
                  onClick={() => setShowSuspend(true)}
                >
                  <PauseCircle className="h-3.5 w-3.5" /> Suspender
                </Button>
              ) : (
                <Button
                  size="sm" variant="outline"
                  className="h-7 gap-1 border-success/25 px-2.5 text-xs text-success hover:bg-success/10"
                  disabled={activateM.isPending}
                  onClick={() => activateM.mutate()}
                >
                  {activateM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
                  Reactivar
                </Button>
              )}
            </span>
          </div>
        </div>
      </Panel>

      {showPlan && (
        <PlanSheet
          tenantId={t.id}
          tenantName={t.name}
          currentPlan={t.plan}
          onClose={() => setShowPlan(false)}
          onSaved={() => { setShowPlan(false); onChanged(); }}
        />
      )}
      {showSuspend && (
        <SuspendDialog tenant={t} onClose={() => setShowSuspend(false)} onDone={() => { setShowSuspend(false); onChanged(); }} />
      )}
      {showReset && (
        <ResetDialog tenant={t} onClose={() => setShowReset(false)} onDone={() => { setShowReset(false); onChanged(); }} />
      )}
      {showDelete && (
        <DeleteDialog tenant={t} onClose={() => setShowDelete(false)} />
      )}
    </>
  );
}

// ── Eliminar organización (destructivo total — typing-guard) ─────────────────
function DeleteDialog({ tenant: t, onClose }: {
  tenant: { id: string; name: string }; onClose: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [confirmText, setConfirmText] = useState("");

  const deleteM = useMutation({
    mutationFn: () => api.tenants.deleteTenant(t.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["platform-traffic"] });
      qc.invalidateQueries({ queryKey: ["platform-health"] });
      toast({ title: "Organización eliminada", description: `${t.name} y todos sus datos fueron borrados.`, variant: "success" });
      router.push("/superadmin/orgs");
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      toast({ title: "No se pudo eliminar", description: typeof d === "string" ? d : undefined, variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="mx-4 w-full max-w-md sm:mx-auto">
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </div>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <DialogTitle>Eliminar organización</DialogTitle>
              <p className="text-sm text-muted-foreground">
                Se borra <span className="font-medium text-foreground">TODO</span> lo de{" "}
                <span className="font-medium text-foreground">{t.name}</span>, de forma{" "}
                <span className="font-medium text-destructive">irreversible</span>:
              </p>
            </div>
          </div>
        </DialogHeader>
        <ul className="space-y-1.5 pl-1 text-sm text-muted-foreground">
          <li className="flex gap-2"><span className="shrink-0 text-destructive">•</span> Usuarios, conversaciones y todo el historial</li>
          <li className="flex gap-2"><span className="shrink-0 text-destructive">•</span> La base de conocimiento completa (documentos y vectores)</li>
          <li className="flex gap-2"><span className="shrink-0 text-destructive">•</span> Archivos adjuntos, configuración y canales</li>
        </ul>
        <p className="border-t pt-3 text-xs text-muted-foreground">
          No hay vuelta atrás desde el panel — solo un backup podría recuperarlo. Verificá que el
          backup diario esté al día antes de seguir (Monitoreo → Backups).
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="del-confirm" className="text-xs font-medium">
            Escribí el ID <span className="font-mono font-semibold text-foreground">{t.id}</span> para confirmar
          </Label>
          <Input
            id="del-confirm"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            placeholder={t.id}
            autoComplete="off"
          />
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>Cancelar</Button>
          <Button
            variant="destructive" className="w-full sm:w-auto"
            disabled={deleteM.isPending || confirmText.trim() !== t.id}
            onClick={() => deleteM.mutate()}
          >
            {deleteM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Eliminar definitivamente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Cambiar plan: los planes reales como opciones, con Guardar explícito ──────
function PlanSheet({ tenantId, tenantName, currentPlan, onClose, onSaved }: {
  tenantId: string; tenantName: string; currentPlan: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [selected, setSelected] = useState(currentPlan);

  const { data, isLoading } = useQuery({
    queryKey: ["platform-plans"],
    queryFn: api.tenants.listPlans,
    staleTime: 60_000,
  });
  const plans = (data?.plans ?? []).filter(p => p.is_active || p.id === currentPlan);

  const saveM = useMutation({
    mutationFn: () => api.tenants.changePlan(tenantId, selected),
    onSuccess: () => { toast({ title: "Plan actualizado", description: `${tenantName} ahora está en ${selected}.`, variant: "success" }); onSaved(); },
    onError: () => toast({ title: "No se pudo cambiar el plan", variant: "destructive" }),
  });

  const price = (p: PlanRow) => p.price_usd != null
    ? `US$ ${p.price_usd.toLocaleString("en-US", { minimumFractionDigits: p.price_usd % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}/mes`
    : "Sin precio definido";

  return (
    <FormSheet
      open
      onOpenChange={v => !v && onClose()}
      icon={Layers}
      title="Cambiar plan"
      description={<>De <span className="font-medium text-foreground">{tenantName}</span> — los límites aplican de inmediato.</>}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => saveM.mutate()} disabled={saveM.isPending || selected === currentPlan}>
            {saveM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Guardar plan
          </Button>
        </>
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando planes…
        </div>
      ) : (
        <div className="space-y-2">
          {plans.map(p => (
            <label
              key={p.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors",
                selected === p.id ? "border-action/50 bg-action/[0.05]" : "hover:bg-muted/40",
              )}
            >
              <input
                type="radio" name="plan" value={p.id}
                checked={selected === p.id}
                onChange={() => setSelected(p.id)}
                className="mt-1"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{p.name}</span>
                  {p.id === currentPlan && <StatePill tone="info">actual</StatePill>}
                  {!p.is_active && <StatePill tone="muted">inactivo</StatePill>}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{price(p)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {fmtLimit(p.users)} usuarios · {fmtLimit(p.documents)} docs · {fmtLimit(p.queries_month)} consultas/mes · {p.max_mb} MB/archivo
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </FormSheet>
  );
}

// ── Suspender (confirmación) ──────────────────────────────────────────────────
function SuspendDialog({ tenant: t, onClose, onDone }: {
  tenant: { id: string; name: string }; onClose: () => void; onDone: () => void;
}) {
  const suspendM = useMutation({
    mutationFn: () => api.tenants.suspend(t.id),
    onSuccess: () => { toast({ title: "Organización suspendida" }); onDone(); },
    onError: () => toast({ title: "Error al suspender", variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="mx-4 w-full max-w-md sm:mx-auto">
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10">
              <PauseCircle className="h-5 w-5 text-warning" />
            </div>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <DialogTitle>Suspender organización</DialogTitle>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{t.name}</span> va a quedar sin acceso:
                sus usuarios no van a poder iniciar sesión y el asistente deja de responder a los afiliados.
              </p>
            </div>
          </div>
        </DialogHeader>
        <p className="border-t pt-3 text-xs text-muted-foreground">
          Es reversible — la podés reactivar cuando quieras desde acá. No se borra ningún dato.
        </p>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>Cancelar</Button>
          <Button
            className="w-full bg-warning text-warning-foreground hover:bg-warning/90 sm:w-auto"
            disabled={suspendM.isPending}
            onClick={() => suspendM.mutate()}
          >
            {suspendM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Suspender
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Resetear onboarding (destructivo — typing-guard) ─────────────────────────
function ResetDialog({ tenant: t, onClose, onDone }: {
  tenant: { id: string; name: string }; onClose: () => void; onDone: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const resetM = useMutation({
    mutationFn: () => api.tenants.resetOnboarding(t.id),
    onSuccess: () => { toast({ title: "Onboarding reseteado", description: "El tenant arranca desde el asistente de configuración.", variant: "success" }); onDone(); },
    onError: () => toast({ title: "Error al resetear", variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="mx-4 w-full max-w-md sm:mx-auto">
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <DialogTitle>Resetear onboarding</DialogTitle>
              <p className="text-sm text-muted-foreground">
                Esta acción borra de forma <span className="font-medium text-foreground">irreversible</span> en{" "}
                <span className="font-medium text-foreground">{t.name}</span>:
              </p>
            </div>
          </div>
        </DialogHeader>
        <ul className="space-y-1.5 pl-1 text-sm text-muted-foreground">
          <li className="flex gap-2"><span className="shrink-0 text-destructive">•</span> La configuración del bot (nombre, instrucciones, saludo)</li>
          <li className="flex gap-2"><span className="shrink-0 text-destructive">•</span> Todos los sectores y sus asignaciones de operadores</li>
          <li className="flex gap-2"><span className="shrink-0 text-destructive">•</span> <span><span className="font-medium text-foreground">Todas las conversaciones</span> con sus mensajes</span></li>
        </ul>
        <p className="border-t pt-3 text-xs text-muted-foreground">
          Los documentos y los usuarios no se tocan. Antes de hacerlo con datos reales, verificá que el
          backup diario esté al día (Monitoreo → Backups).
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="reset-confirm" className="text-xs font-medium">
            Escribí <span className="font-semibold text-foreground">{t.name}</span> para confirmar
          </Label>
          <Input
            id="reset-confirm"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            placeholder={t.name}
            autoComplete="off"
          />
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>Cancelar</Button>
          <Button
            variant="destructive" className="w-full sm:w-auto"
            disabled={resetM.isPending || confirmText.trim() !== t.name}
            onClick={() => resetM.mutate()}
          >
            {resetM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sí, resetear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
