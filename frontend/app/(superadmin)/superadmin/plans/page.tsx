"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Layers, Plus, Loader2, Pencil, Users, FileText, MessageSquare, HardDrive, Coins,
} from "lucide-react";
import { api, type PlanRow, type PlanBody } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormSheet } from "@/components/layout/form-sheet";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { StatePill } from "@/components/ui/state-pill";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
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
          <Skeleton className="h-64 rounded-2xl" />
        ) : plans.length === 0 ? (
          <EmptyState icon={Layers} title="Sin planes" description="Creá el primer plan de la plataforma." className="rounded-2xl border bg-card" />
        ) : (
          <PlansComparison plans={plans} onEdit={setEditing} />
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

// ── Tabla comparativa de planes ───────────────────────────────────────────────
// Planes en columnas, límites en filas: la forma más simple de comparar y leer.
function PlansComparison({ plans, onEdit }: { plans: PlanRow[]; onEdit: (p: PlanRow) => void }) {
  const price = (p: PlanRow) => p.price_usd != null
    ? `US$ ${p.price_usd.toLocaleString("en-US", { minimumFractionDigits: p.price_usd % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`
    : "—";
  const features: Array<{ icon: typeof Users; label: string; get: (p: PlanRow) => string; strong?: boolean }> = [
    { icon: Coins,         label: "Precio / mes",    get: price,                             strong: true },
    { icon: Users,         label: "Usuarios",        get: p => fmtLimit(p.users) },
    { icon: FileText,      label: "Documentos",      get: p => fmtLimit(p.documents) },
    { icon: MessageSquare, label: "Consultas / mes", get: p => fmtLimit(p.queries_month) },
    { icon: HardDrive,     label: "Tamaño máx. / archivo", get: p => `${p.max_mb} MB` },
  ];
  return (
    <div className="overflow-x-auto rounded-2xl border bg-card scrollbar-slim">
      <Table className="min-w-[520px]">
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead className="w-44 px-4">Plan</TableHead>
            {plans.map(p => (
              <TableHead key={p.id} className={cn("min-w-[150px] px-4 py-3 align-top normal-case tracking-normal", !p.is_active && "opacity-55")}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{p.name}</span>
                  <StatePill tone={p.is_active ? "success" : "muted"}>{p.is_active ? "Activo" : "Inactivo"}</StatePill>
                </div>
                <div className="mt-0.5 font-mono text-[10px] font-normal text-muted-foreground/60">{p.id}</div>
                <button
                  onClick={() => onEdit(p)}
                  className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-action transition-colors hover:bg-action/10"
                >
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {features.map(f => {
            const Icon = f.icon;
            return (
              <TableRow key={f.label}>
                <TableCell className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground/60" /> {f.label}
                  </span>
                </TableCell>
                {plans.map(p => {
                  const v = f.get(p);
                  const unlimited = v === "Ilimitado";
                  return (
                    <TableCell key={p.id} className={cn("px-4 py-3 tabular-nums", !p.is_active && "opacity-55")}>
                      <span className={cn(
                        f.strong ? "text-base font-bold text-foreground" : "font-semibold text-foreground",
                        unlimited && "text-action",
                      )}>{v}</span>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
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
    <FormSheet
      open
      onOpenChange={v => !v && onClose()}
      icon={Layers}
      title={isEdit ? `Editar ${plan!.name}` : "Nuevo plan"}
      description={isEdit ? plan!.id : "Definí los límites del nuevo plan."}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={submit} disabled={saveM.isPending}>
            {saveM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {isEdit ? "Guardar cambios" : "Crear plan"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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
    </FormSheet>
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
