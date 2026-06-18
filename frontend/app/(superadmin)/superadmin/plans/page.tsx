"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Layers, Plus, Loader2, Pencil, Users, FileText, MessageSquare, HardDrive, DollarSign,
} from "lucide-react";
import { api, type PlanRow, type PlanBody } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { cn, toSlug } from "@/lib/utils";

function fmtLimit(n: number): string {
  if (n === -1)        return "Ilimitado";
  if (n >= 1_000_000)  return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
  if (n >= 1_000)      return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + "K";
  return String(n);
}

export default function PlansPage() {
  const qc = useQueryClient();
  const [editing, setEditing]   = useState<PlanRow | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["platform-plans"],
    queryFn: api.tenants.listPlans,
    staleTime: 30_000,
  });
  const plans = data?.plans ?? [];

  const close = () => { setEditing(null); setCreating(false); };

  return (
    <>
      <PageShell>
        <PageHeader
          eyebrow="Plataforma"
          title="Planes"
          badge={!isLoading ? <CountChip>{plans.length} {plans.length === 1 ? "plan" : "planes"}</CountChip> : undefined}
          description="Los planes de la plataforma: límites de uso y precio. Editá los actuales o creá uno nuevo."
          actions={
            <Button size="sm" onClick={() => setCreating(true)} className="h-9 gap-1.5">
              <Plus className="h-4 w-4" /> Nuevo plan
            </Button>
          }
        />

        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-56 rounded-2xl" />)}
          </div>
        ) : plans.length === 0 ? (
          <EmptyState icon={Layers} title="Sin planes" description="Creá el primer plan de la plataforma." className="rounded-2xl border bg-card" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map(p => <PlanCard key={p.id} plan={p} onEdit={() => setEditing(p)} />)}
          </div>
        )}
      </PageShell>

      {(editing || creating) && (
        <PlanModal
          plan={editing}
          onClose={close}
          onSaved={() => { close(); qc.invalidateQueries({ queryKey: ["platform-plans"] }); qc.invalidateQueries({ queryKey: ["tenants"] }); }}
        />
      )}
    </>
  );
}

// ── Card de plan ────────────────────────────────────────────────────────────
function PlanCard({ plan: p, onEdit }: { plan: PlanRow; onEdit: () => void }) {
  const rows: Array<{ icon: typeof Users; label: string; value: string }> = [
    { icon: Users,         label: "Usuarios",      value: fmtLimit(p.users) },
    { icon: FileText,      label: "Documentos",    value: fmtLimit(p.documents) },
    { icon: MessageSquare, label: "Consultas/mes", value: fmtLimit(p.queries_month) },
    { icon: HardDrive,     label: "Tamaño máx",    value: `${p.max_mb} MB` },
  ];
  return (
    <div className={cn("flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm", !p.is_active && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{p.name}</h3>
            {!p.is_active && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Inactivo</span>}
          </div>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{p.id}</p>
        </div>
        <Button size="sm" variant="ghost" className="h-8 shrink-0 gap-1.5 text-xs" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" /> Editar
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {rows.map(r => {
          const Icon = r.icon;
          return (
            <div key={r.label} className="rounded-lg border bg-muted/20 px-3 py-2">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Icon className="h-3 w-3 shrink-0" /> {r.label}
              </p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">{r.value}</p>
            </div>
          );
        })}
      </div>

      {p.price_usd != null && (
        <p className="flex items-center gap-1 text-sm font-semibold tabular-nums">
          <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
          {p.price_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          <span className="text-xs font-normal text-muted-foreground"> / mes</span>
        </p>
      )}
    </div>
  );
}

// ── Modal editar / crear ────────────────────────────────────────────────────
function PlanModal({ plan, onClose, onSaved }: { plan: PlanRow | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = plan != null;
  const [name, setName]                 = useState(plan?.name ?? "");
  const [users, setUsers]               = useState(plan?.users ?? -1);
  const [documents, setDocuments]       = useState(plan?.documents ?? -1);
  const [queriesMonth, setQueriesMonth] = useState(plan?.queries_month ?? -1);
  const [maxMb, setMaxMb]               = useState(plan?.max_mb ?? 200);
  const [price, setPrice]               = useState(plan?.price_usd != null ? String(plan.price_usd) : "");
  const [isActive, setIsActive]         = useState(plan?.is_active ?? true);
  const [error, setError]               = useState("");

  const buildBody = (): PlanBody => ({
    name: name.trim(),
    users, documents, queries_month: queriesMonth, max_mb: maxMb,
    price_usd: price.trim() ? Number(price) : null,
    is_active: isActive,
    sort_order: plan?.sort_order ?? 99,
  });

  const saveM = useMutation({
    mutationFn: () => isEdit
      ? api.tenants.updatePlan(plan!.id, buildBody())
      : api.tenants.createPlan(toSlug(name), buildBody()),
    onSuccess: () => { toast({ title: isEdit ? "Plan actualizado" : "Plan creado", variant: "success" }); onSaved(); },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      setError(typeof d === "string" ? d : "Error al guardar el plan.");
    },
  });

  const submit = () => {
    setError("");
    if (!name.trim()) { setError("El nombre del plan es obligatorio."); return; }
    saveM.mutate();
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="flex max-h-[90vh] w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-primary" />
            {isEdit ? `Editar ${plan!.name}` : "Nuevo plan"}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Nombre</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Ej. Professional" className="h-9" />
            {!isEdit && name.trim() && (
              <p className="text-[11px] text-muted-foreground">ID: <code className="font-mono">{toSlug(name)}</code></p>
            )}
          </div>

          <LimitField label="Usuarios" value={users} onChange={setUsers} allowUnlimited />
          <LimitField label="Documentos" value={documents} onChange={setDocuments} allowUnlimited />
          <LimitField label="Consultas / mes" value={queriesMonth} onChange={setQueriesMonth} allowUnlimited />
          <LimitField label="Tamaño máx. por archivo (MB)" value={maxMb} onChange={setMaxMb} />

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Precio mensual (USD) <span className="font-normal text-muted-foreground">· opcional</span></Label>
            <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="—" min={0} step="0.01" className="h-9" />
          </div>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border bg-muted/20 px-3 py-2.5">
            <span className="text-sm font-medium">Plan activo</span>
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="h-4 w-4" />
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="shrink-0 flex-col gap-2 border-t px-5 py-4 sm:flex-row">
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>Cancelar</Button>
          <Button className="w-full sm:w-auto" onClick={submit} disabled={saveM.isPending}>
            {saveM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {isEdit ? "Guardar cambios" : "Crear plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Campo numérico con opción "Ilimitado" (-1).
function LimitField({ label, value, onChange, allowUnlimited }: {
  label: string; value: number; onChange: (n: number) => void; allowUnlimited?: boolean;
}) {
  const unlimited = value === -1;
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={unlimited ? "" : value}
          onChange={e => onChange(e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))}
          disabled={unlimited}
          placeholder={unlimited ? "Ilimitado" : "0"}
          min={0}
          className="h-9 flex-1"
        />
        {allowUnlimited && (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <input type="checkbox" checked={unlimited} onChange={e => onChange(e.target.checked ? -1 : 0)} className="h-3.5 w-3.5" />
            Ilimitado
          </label>
        )}
      </div>
    </div>
  );
}
