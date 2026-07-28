"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layers, Plus, Loader2, Pencil, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { api, type PlanRow, type PlanBody } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormSheet } from "@/components/layout/form-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { StatePill } from "@/components/ui/state-pill";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { cn, toSlug } from "@/lib/utils";
import { SuperShell } from "@/components/superadmin/shell";

function fmtLimit(n: number): string {
  if (n === -1)        return "Ilimitado";
  if (n >= 1_000_000)  return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
  if (n >= 1_000)      return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + "K";
  return String(n);
}

export default function PlansPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing]   = useState<PlanRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["platform-plans"],
    queryFn: api.tenants.listPlans,
    staleTime: 30_000,
  });
  const plans = data?.plans ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["platform-plans"] });
    qc.invalidateQueries({ queryKey: ["tenants"] });
  };
  const close = () => { setCreating(false); setEditing(null); };

  return (
    <>
      <SuperShell
        title="Planes"
        actions={
          <Button size="sm" className="group" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 transition-transform group-hover:rotate-90 sm:mr-1.5" />
            <span className="hidden sm:inline">Nuevo plan</span>
          </Button>
        }
      >
          {isLoading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : plans.length === 0 ? (
            <EmptyState icon={Layers} title="Sin planes" description="Creá el primer plan de la plataforma." />
          ) : (
            <PlansComparison plans={plans} onEdit={setEditing} onReordered={invalidate} />
          )}
      </SuperShell>

      {(creating || editing) && (
        <PlanModal
          plan={editing}
          onClose={close}
          onSaved={() => { close(); invalidate(); }}
        />
      )}
    </>
  );
}

// ── Tabla de planes — un plan por fila; click abre el panel de edición ──────
function PlansComparison({ plans, onEdit, onReordered }: {
  plans: PlanRow[]; onEdit: (p: PlanRow) => void; onReordered: () => void;
}) {
  // Reordenar = intercambiar sort_order entre vecinos. Si dos planes viejos
  // comparten el mismo sort_order, usamos el índice como desempate.
  const swapM = useMutation({
    mutationFn: async ({ a, b }: { a: PlanRow; b: PlanRow }) => {
      const soA = a.sort_order === b.sort_order ? a.sort_order + 1 : a.sort_order;
      await api.tenants.updatePlan(a.id, { name: a.name, users: a.users, documents: a.documents, queries_month: a.queries_month, max_mb: a.max_mb, price_usd: a.price_usd, is_active: a.is_active, sort_order: b.sort_order });
      await api.tenants.updatePlan(b.id, { name: b.name, users: b.users, documents: b.documents, queries_month: b.queries_month, max_mb: b.max_mb, price_usd: b.price_usd, is_active: b.is_active, sort_order: soA });
    },
    onSuccess: onReordered,
    onError: () => toast({ title: "No se pudo reordenar", variant: "destructive" }),
  });
  const price = (p: PlanRow) => p.price_usd != null
    ? `US$ ${p.price_usd.toLocaleString("en-US", { minimumFractionDigits: p.price_usd % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`
    : "—";
  const lim = (n: number) => {
    const v = fmtLimit(n);
    return <span className={cn("tabular-nums", v === "Ilimitado" ? "text-muted-foreground" : "text-foreground")}>{v}</span>;
  };
  return (
    <div className="overflow-x-auto scrollbar-slim">
      <Table className="min-w-[640px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[160px]">Plan</TableHead>
            <TableHead className="text-right">Precio / mes</TableHead>
            <TableHead className="text-right">Usuarios</TableHead>
            <TableHead className="text-right">Documentos</TableHead>
            <TableHead className="text-right">Consultas / mes</TableHead>
            <TableHead className="text-right whitespace-nowrap">Máx. archivo</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead className="w-[40px]" />
            <TableHead className="w-[64px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((p, i) => (
            <TableRow key={p.id} className={cn("group cursor-pointer", !p.is_active && "opacity-55")} onClick={() => onEdit(p)}>
              <TableCell>
                <p className="text-sm font-medium text-foreground transition-colors group-hover:text-action">{p.name}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">{p.id}</p>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{price(p)}</TableCell>
              <TableCell className="text-right">{lim(p.users)}</TableCell>
              <TableCell className="text-right">{lim(p.documents)}</TableCell>
              <TableCell className="text-right">{lim(p.queries_month)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{p.max_mb} MB</TableCell>
              <TableCell>
                <StatePill tone={p.is_active ? "success" : "muted"}>{p.is_active ? "Activo" : "Inactivo"}</StatePill>
              </TableCell>
              <TableCell className="text-right">
                <Pencil className="inline-block h-3.5 w-3.5 text-muted-foreground/40 transition-colors group-hover:text-action" />
              </TableCell>
              <TableCell className="whitespace-nowrap text-right" onClick={e => e.stopPropagation()}>
                <button
                  disabled={i === 0 || swapM.isPending}
                  onClick={() => swapM.mutate({ a: p, b: plans[i - 1] })}
                  title="Subir"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  disabled={i === plans.length - 1 || swapM.isPending}
                  onClick={() => swapM.mutate({ a: p, b: plans[i + 1] })}
                  title="Bajar"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </TableCell>
            </TableRow>
          ))}
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
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Los 3 planes base viven como fallback hardcodeado — no se pueden eliminar
  // (reaparecerían); el backend los rechaza. Solo se borran los planes custom.
  const isDefaultPlan = isEdit && ["starter", "professional", "enterprise"].includes(plan!.id);

  const deleteM = useMutation({
    mutationFn: () => api.tenants.deletePlan(plan!.id),
    onSuccess: () => { toast({ title: "Plan eliminado", variant: "success" }); onSaved(); },
    onError: (e: any) => {
      setConfirmDelete(false);
      const d = e?.response?.data?.detail;
      setError(typeof d === "string" ? d : "No se pudo eliminar el plan.");
    },
  });

  // ¿Cuántas organizaciones están en este plan? — para avisar al desactivar.
  const { data: tenants = [] } = useQuery({
    queryKey: ["tenants"],
    queryFn: api.tenants.list,
    enabled: isEdit,
    staleTime: 60_000,
  });
  const orgsOnPlan = isEdit ? tenants.filter(t => t.plan === plan!.id).length : 0;

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
          {isEdit && !isDefaultPlan && (
            <Button
              variant="ghost"
              className="mr-auto gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={deleteM.isPending}
              onClick={() => {
                if (!confirmDelete) { setConfirmDelete(true); return; }
                deleteM.mutate();
              }}
            >
              {deleteM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {confirmDelete ? "¿Seguro? Click de nuevo" : "Eliminar"}
            </Button>
          )}
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
        {isEdit && !isActive && plan!.is_active && orgsOnPlan > 0 && (
          <p className="text-xs font-medium text-warning">
            {orgsOnPlan} {orgsOnPlan === 1 ? "organización usa" : "organizaciones usan"} este plan — al desactivarlo
            dejan de poder asignarse nuevas, pero las existentes lo conservan.
          </p>
        )}

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
