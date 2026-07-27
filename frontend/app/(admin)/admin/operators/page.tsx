"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Trash2, Pencil, AlertTriangle, Users, UserPlus, SearchX, PanelRight, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FormDialog } from "@/components/ui/form-dialog";
import { api, apiClient, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, initials } from "@/lib/utils";
import { extractErrorMessage } from "@/lib/errors";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { ListDetailShell, DetailPanelHeader, PanelIconButton } from "@/components/admin/list-detail-shell";
import { useTableSort, applySort, SortHeader } from "@/components/admin/sortable";

interface OperatorUser {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
}
type AssignedSector = { id: string; nombre: string };
type SortKey = "nombre" | "estado";

// Validación mínima de email en el cliente: algo@dominio.tld. El backend valida
// en serio (Pydantic); esto solo evita mandar un email sin @ y recibir un 422.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

async function listOperators(): Promise<OperatorUser[]> {
  const { data } = await apiClient.get("/admin/operators");
  return data;
}

export default function OperatorsPage() {
  const qc = useQueryClient();

  const [showCreate, setShowCreate]       = useState(false);
  const [name, setName]                   = useState("");
  const [email, setEmail]                 = useState("");
  // Se valida al apretar "Crear", no mientras se escribe (el aviso en vivo molesta).
  const [emailError, setEmailError]       = useState(false);
  const [password, setPassword]           = useState("");
  const [inviteMode, setInviteMode]       = useState(true);
  const [createSectors, setCreateSectors] = useState<Set<string>>(new Set());

  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [panelOpen, setPanelOpen]         = useState(false);
  const [editOpen, setEditOpen]           = useState(false);
  const [deleting, setDeleting]           = useState(false);

  const [search, setSearch]               = useState("");
  const { sort, toggle } = useTableSort<SortKey>({ estado: "desc" });

  const { data: operators = [], isLoading: loadingOps } = useQuery({ queryKey: ["operators"], queryFn: listOperators, staleTime: 30_000 });
  const { data: sectors = [], isLoading: loadingSectors } = useQuery({ queryKey: ["sectors"], queryFn: api.sectors.list, staleTime: 30_000 });
  const { data: presenceData } = useQuery({ queryKey: ["operator-presence"], queryFn: api.operator.presence, refetchInterval: 15_000 });
  const { data: sectorsMap = {}, isLoading: loadingMap } = useQuery({ queryKey: ["operators-sectors-map"], queryFn: api.sectors.getOperatorsSectorsMap, staleTime: 30_000 });

  const onlineIds = useMemo(() => new Set((presenceData?.operators ?? []).map(o => o.user_id)), [presenceData]);
  const activeSectors = useMemo(() => sectors.filter(s => s.is_active), [sectors]);
  const defaultSectorId = useMemo(() => activeSectors.find(s => s.is_default)?.id ?? null, [activeSectors]);

  useEffect(() => {
    if (showCreate) {
      setCreateSectors(defaultSectorId ? new Set([defaultSectorId]) : new Set());
      setEmailError(false);
    }
  }, [showCreate, defaultSectorId]);

  const createM = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post("/admin/operators", {
        name: name.trim(), email: email.trim(), ...(inviteMode ? {} : { password }),
      });
      const newId = data?.id;
      const selected = Array.from(createSectors);
      const isDefaultOnly = selected.length === 1 && selected[0] === defaultSectorId;
      if (newId && selected.length > 0 && !isDefaultOnly) await api.sectors.assignOperatorSectors(newId, selected);
      return data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["operators-sectors-map"] });
      if (data?.invitation_sent === true) {
        toast({ title: "Invitación enviada", description: `${data.email} va a recibir un email para definir su contraseña.`, variant: "success" });
      } else if (data?.invitation_sent === false) {
        toast({ title: "Operador creado, pero el email no salió", description: "Pedile que use «¿Olvidaste tu contraseña?» en el login.", variant: "destructive" });
      } else {
        toast({ title: "Operador creado", variant: "success" });
      }
      setShowCreate(false); setName(""); setEmail(""); setPassword(""); setInviteMode(true);
    },
    onError: (err: any) => {
      toast({ title: "Error al crear operador", description: extractErrorMessage(err, "Revisá los datos e intentá de nuevo."), variant: "destructive" });
    },
  });

  const emailValid = EMAIL_RE.test(email.trim());

  const toggleCreateSector = (id: string) => setCreateSectors(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const operatorsFiltered = operators.filter(o => o.role === "operator" && o.is_active);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return operatorsFiltered;
    return operatorsFiltered.filter(o => o.name.toLowerCase().includes(q) || o.email.toLowerCase().includes(q));
  }, [operatorsFiltered, search]);

  // Orden base: en línea primero. El clic en un header lo sobrescribe.
  const sorted = useMemo(() => {
    const base = [...visible].sort((a, b) => (onlineIds.has(b.id) ? 1 : 0) - (onlineIds.has(a.id) ? 1 : 0));
    return applySort(base, sort, (a, b, key) =>
      key === "nombre"
        ? a.name.localeCompare(b.name, "es")
        : (onlineIds.has(a.id) ? 1 : 0) - (onlineIds.has(b.id) ? 1 : 0),
    );
  }, [visible, sort, onlineIds]);

  const selectedOp = operatorsFiltered.find(o => o.id === selectedId) ?? null;
  const loading = loadingOps || loadingSectors;

  return (
    <>
      <ListDetailShell
        title="Operadores"
        actions={
          <Button size="sm" className="shrink-0" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Nuevo operador
          </Button>
        }
        panelTitle="operador"
        open={panelOpen}
        hasSelection={!!selectedOp}
        onExpand={() => setPanelOpen(true)}
        panel={selectedOp ? (
          <OperatorDetailPanel
            operator={selectedOp}
            isOnline={onlineIds.has(selectedOp.id)}
            assignedSectors={sectorsMap[selectedOp.id] ?? []}
            assignedLoading={loadingMap}
            onCollapse={() => setPanelOpen(false)}
            onEdit={() => setEditOpen(true)}
            onDelete={() => setDeleting(true)}
          />
        ) : null}
      >
        {loading ? (
          <Skeleton className="h-72 rounded-2xl" />
        ) : (
          <div className="space-y-4">
            {operatorsFiltered.length > 0 && (
              <ListToolbar search={search} onSearch={setSearch} placeholder="Buscar operador…" />
            )}

            {operatorsFiltered.length === 0 ? (
              <EmptyState icon={Users} title="No hay operadores activos"
                description="Creá el primero para empezar a asignar sectores y atender consultas." />
            ) : visible.length === 0 ? (
              <EmptyState icon={SearchX} title="Sin resultados" description={`Ningún operador coincide con "${search}".`} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {/* Reparto proporcional: el nombre no acapara todo el ancho,
                        los sectores reciben el resto sin amontonarse. */}
                    <TableHead className="md:w-[45%]"><SortHeader label="Operador" sortKey="nombre" sort={sort} onToggle={toggle} /></TableHead>
                    <TableHead>Sectores que atiende</TableHead>
                    {/* Estado al final, pegado al borde derecho — patrón de la app */}
                    <TableHead className="hidden w-[110px] whitespace-nowrap text-right md:table-cell">
                      <SortHeader label="Estado" sortKey="estado" sort={sort} onToggle={toggle} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(op => (
                    <OperatorRowItem
                      key={op.id}
                      operator={op}
                      isOnline={onlineIds.has(op.id)}
                      assignedSectors={sectorsMap[op.id] ?? []}
                      assignedLoading={loadingMap}
                      selected={op.id === selectedId}
                      onSelect={() => { setSelectedId(op.id); setPanelOpen(true); }}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </ListDetailShell>

      {/* Crear operador */}
      <FormDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        icon={UserPlus}
        title="Nuevo operador"
        description="Datos de acceso y los sectores que va a atender."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => {
                if (!emailValid) { setEmailError(true); return; }
                setEmailError(false);
                createM.mutate();
              }}
              disabled={!name.trim() || !email.trim() || (!inviteMode && password.length < 8) || createSectors.size === 0 || createM.isPending}
            >
              {createM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Crear operador
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="op-name">Nombre</Label>
            <Input id="op-name" placeholder="María García" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="op-email">Email</Label>
            <Input id="op-email" type="email" placeholder="maria@empresa.com" value={email} onChange={e => setEmail(e.target.value)} />
            {emailError && !emailValid && (
              <p className="text-xs text-warning">Ese email no es válido — revisá que tenga «@» y dominio (ej: maria@empresa.com).</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Sectores que puede atender</Label>
          {activeSectors.length === 0 ? (
            <p className="text-xs text-muted-foreground">No hay sectores activos. Creá sectores primero desde la sección "Sectores".</p>
          ) : (
            <SectorSelect sectors={activeSectors} selected={createSectors} onToggle={toggleCreateSector} />
          )}
          {createSectors.size === 0 && activeSectors.length > 0 && (
            <p className="text-xs text-warning">Seleccioná al menos un sector. Sin sectores el operador no recibe consultas.</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Acceso</Label>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
            <input type="radio" name="op-access" checked={inviteMode} onChange={() => setInviteMode(true)} className="mt-0.5" />
            <span className="text-sm">
              <span className="font-medium">Enviar invitación por email</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Recibe un enlace para definir su contraseña (vence en 72 hs).</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
            <input type="radio" name="op-access" checked={!inviteMode} onChange={() => setInviteMode(false)} className="mt-0.5" />
            <span className="flex-1 text-sm">
              <span className="font-medium">Definir contraseña ahora</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Vos se la comunicás al operador por otro medio.</span>
            </span>
          </label>
          {!inviteMode && (
            <Input id="op-password" type="password" placeholder="Mínimo 8 caracteres" value={password} onChange={e => setPassword(e.target.value)} className="animate-fade-in" />
          )}
        </div>
      </FormDialog>

      {/* Editar (datos + sectores) / eliminar — sobre el operador seleccionado */}
      {selectedOp && (
        <>
          <EditOperatorDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            operator={selectedOp}
            activeSectors={activeSectors}
            initialAssigned={(sectorsMap[selectedOp.id] ?? []).map(s => s.id)}
          />
          <DeactivateDialog open={deleting} onOpenChange={setDeleting} operator={selectedOp}
            onDeactivated={() => { qc.invalidateQueries({ queryKey: ["operators"] }); setSelectedId(null); }} />
        </>
      )}
    </>
  );
}

// ── Fila de la tabla ──────────────────────────────────────────────────────────

function OperatorRowItem({ operator, isOnline, assignedSectors, assignedLoading, selected, onSelect }: {
  operator: OperatorUser;
  isOnline: boolean;
  assignedSectors: AssignedSector[];
  assignedLoading: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <TableRow onClick={onSelect} aria-selected={selected} className={cn("cursor-pointer", selected && "bg-muted/60")}>
      <TableCell className="w-full max-w-0 md:w-[45%]">
        <div className="flex min-w-0 items-center gap-3">
          <OperatorAvatar name={operator.name} isOnline={isOnline} size="sm" showPresence />
          <div className="min-w-0">
            <span className="block truncate font-medium text-foreground">{operator.name}</span>
            <span className="block truncate text-xs text-muted-foreground md:hidden">{operator.email}</span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {assignedLoading ? <Skeleton className="h-5 w-36 rounded-full" /> : <SectorTags assignedSectors={assignedSectors} compact />}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-right md:table-cell"><StatusPill isOnline={isOnline} /></TableCell>
    </TableRow>
  );
}

// ── Panel de detalle ──────────────────────────────────────────────────────────

function OperatorDetailPanel({ operator, isOnline, assignedSectors, assignedLoading, onCollapse, onEdit, onDelete }: {
  operator: OperatorUser;
  isOnline: boolean;
  assignedSectors: AssignedSector[];
  assignedLoading: boolean;
  onCollapse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="w-full bg-card">
      <DetailPanelHeader label="Operador">
        <PanelIconButton onClick={onEdit} label="Editar operador"><Pencil className="h-4 w-4" /></PanelIconButton>
        <PanelIconButton onClick={onCollapse} label="Ocultar panel"><PanelRight className="h-4 w-4" /></PanelIconButton>
      </DetailPanelHeader>

      {/* Identidad */}
      <div className="border-b px-4 py-4">
        <div className="flex items-start gap-3">
          <OperatorAvatar name={operator.name} isOnline={isOnline} showPresence />
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-[15px] font-semibold leading-tight text-foreground">{operator.name}</h3>
            <div className="mt-1.5"><StatusPill isOnline={isOnline} /></div>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="space-y-5 p-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Email</p>
          <p className="mt-1.5 break-all text-sm text-foreground">{operator.email}</p>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Sectores que atiende</p>
          <div className="mt-2">
            {assignedLoading ? (
              <Skeleton className="h-5 w-40" />
            ) : assignedSectors.length === 0 ? (
              <p className="flex items-center gap-1.5 rounded-lg border border-dashed border-warning/30 bg-warning/[0.06] px-3 py-2.5 text-xs text-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Sin sectores — solo "Consultas Generales".
              </p>
            ) : (
              <SectorTags assignedSectors={assignedSectors} />
            )}
          </div>
        </div>
      </div>

      {/* Acciones — editar datos (lápiz arriba) y sectores (link) ya están; acá solo eliminar */}
      <div className="border-t p-4">
        <Button variant="ghost" size="sm" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}>
          <Trash2 className="mr-1.5 h-4 w-4" /> Eliminar operador
        </Button>
      </div>
    </div>
  );
}

// ── Piezas compartidas ────────────────────────────────────────────────────────

function OperatorAvatar({ name, isOnline, size = "md", showPresence = false }: {
  name: string; isOnline: boolean; size?: "sm" | "md"; showPresence?: boolean;
}) {
  const dim = size === "sm" ? "h-8 w-8 text-[11px]" : "h-10 w-10 text-[13px]";
  return (
    <div className="relative shrink-0">
      <div className={cn("flex items-center justify-center rounded-xl bg-action-gradient-soft font-semibold text-action", dim)}>
        {initials(name)}
      </div>
      {showPresence && (
        <span className={cn("absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card", isOnline ? "bg-success" : "bg-muted-foreground/30")} aria-hidden />
      )}
    </div>
  );
}

function StatusPill({ isOnline }: { isOnline: boolean }) {
  return isOnline ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success/[0.08] px-2 py-0.5 text-[11px] font-semibold text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" /> En línea
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" /> Desconectado
    </span>
  );
}

function SectorTags({ assignedSectors, compact }: { assignedSectors: AssignedSector[]; compact?: boolean }) {
  if (assignedSectors.length === 0) {
    return <span className="inline-flex items-center gap-1.5 text-xs text-warning"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Sin sectores</span>;
  }
  // Tabla: inline separado por "·" (hasta 3 + resto). Panel: uno debajo del otro.
  if (compact) {
    const shown = assignedSectors.slice(0, 3);
    const rest = assignedSectors.length - shown.length;
    return (
      <span className="text-sm text-muted-foreground">
        {shown.map(s => s.nombre).join(" · ")}
        {rest > 0 && <span className="text-muted-foreground/60"> · +{rest}</span>}
      </span>
    );
  }
  return (
    <div className="space-y-1">
      {assignedSectors.map(s => (
        <div key={s.id} className="flex items-center gap-2 text-sm text-foreground">
          <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
          <span className="truncate">{s.nombre}</span>
        </div>
      ))}
    </div>
  );
}

/** Desplegable multi-select de sectores (trigger tipo input + checklist). */
function SectorSelect({ sectors, selected, onToggle }: {
  sectors: SectorRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const chosen = sectors.filter(s => selected.has(s.id));
  const summary = chosen.length === 0 ? "Seleccioná sectores…" : chosen.map(s => s.nombre).join(" · ");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm ring-offset-background transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={cn("truncate", chosen.length === 0 && "text-muted-foreground")}>{summary}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto scrollbar-slim">
        {sectors.map(s => {
          const on = selected.has(s.id);
          return (
            <DropdownMenuItem key={s.id} onSelect={e => { e.preventDefault(); onToggle(s.id); }} className="gap-2.5">
              <span className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                on ? "border-action bg-action text-action-foreground" : "border-muted-foreground/40",
              )}>
                {on && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
              <span className="flex-1 truncate">{s.nombre}</span>
              {s.is_default && <span className="shrink-0 text-[10px] text-muted-foreground">predet.</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Modal: editar operador (datos + sectores, todo junto) ─────────────────────

function EditOperatorDialog({ open, onOpenChange, operator, activeSectors, initialAssigned }: {
  open: boolean; onOpenChange: (v: boolean) => void; operator: OperatorUser; activeSectors: SectorRow[]; initialAssigned: string[];
}) {
  const qc = useQueryClient();
  const [name, setName]         = useState(operator.name);
  const [email, setEmail]       = useState(operator.email);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialAssigned));
  // Se valida al apretar "Guardar", no mientras se escribe.
  const [emailError, setEmailError] = useState(false);
  useEffect(() => {
    if (open) { setName(operator.name); setEmail(operator.email); setSelected(new Set(initialAssigned)); setEmailError(false); }
  }, [open, operator.name, operator.email, initialAssigned]);

  const initialSet = useMemo(() => new Set(initialAssigned), [initialAssigned]);
  const sectorsDirty = useMemo(() => {
    if (selected.size !== initialSet.size) return true;
    for (const id of selected) if (!initialSet.has(id)) return true;
    return false;
  }, [selected, initialSet]);
  const dataDirty = name.trim() !== operator.name || email.trim().toLowerCase() !== operator.email.toLowerCase();
  const dirty = dataDirty || sectorsDirty;

  const saveM = useMutation({
    mutationFn: async () => {
      if (dataDirty) {
        const payload: { name?: string; email?: string } = {};
        if (name.trim() !== operator.name) payload.name = name.trim();
        if (email.trim().toLowerCase() !== operator.email.toLowerCase()) payload.email = email.trim();
        await apiClient.patch(`/admin/operators/${operator.id}`, payload);
      }
      if (sectorsDirty) await api.sectors.assignOperatorSectors(operator.id, Array.from(selected));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["operators-sectors-map"] });
      toast({ title: "Operador actualizado", variant: "success" });
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({ title: "No se pudo guardar", description: extractErrorMessage(err, "Revisá los datos e intentá de nuevo."), variant: "destructive" });
    },
  });

  const emailValid = EMAIL_RE.test(email.trim());
  const toggle = (id: string) => setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange} icon={Pencil}
      title="Editar operador"
      description={<>Datos y sectores de <span className="font-medium text-foreground">{operator.name}</span>.</>}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            onClick={() => {
              if (!emailValid) { setEmailError(true); return; }
              setEmailError(false);
              saveM.mutate();
            }}
            disabled={!dirty || !name.trim() || !email.trim() || selected.size === 0 || saveM.isPending}
          >
            {saveM.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
            Guardar cambios
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="edit-name">Nombre</Label>
          <Input id="edit-name" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-email">Email</Label>
          <Input id="edit-email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
          {emailError && !emailValid && (
            <p className="text-xs text-warning">Ese email no es válido — revisá que tenga «@» y dominio (ej: maria@empresa.com).</p>
          )}
        </div>
      </div>
      <div className="space-y-2">
        <Label>Sectores que puede atender</Label>
        {activeSectors.length === 0 ? (
          <p className="text-xs text-muted-foreground">No hay sectores activos. Creá sectores primero desde la sección "Sectores".</p>
        ) : (
          <SectorSelect sectors={activeSectors} selected={selected} onToggle={toggle} />
        )}
        {selected.size === 0 && activeSectors.length > 0 && (
          <p className="text-xs text-warning">Asigná al menos un sector. Sin sectores el operador no recibe consultas.</p>
        )}
      </div>
    </FormDialog>
  );
}

// ── Confirmación de eliminación ──────────────────────────────────────────────

function DeactivateDialog({ open, onOpenChange, operator, onDeactivated }: {
  open: boolean; onOpenChange: (v: boolean) => void; operator: OperatorUser; onDeactivated: () => void;
}) {
  const deleteM = useMutation({
    mutationFn: () => apiClient.delete(`/admin/operators/${operator.id}`),
    onSuccess: () => { toast({ title: `${operator.name} eliminado`, variant: "success" }); onDeactivated(); onOpenChange(false); },
    onError: () => toast({ title: "Error al eliminar", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <DialogTitle>Eliminar operador</DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">{operator.name}</span> ya no va a recibir conversaciones.
                Las que tenga abiertas vuelven a la cola.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleteM.isPending}>Cancelar</Button>
          <Button variant="destructive" onClick={() => deleteM.mutate()} disabled={deleteM.isPending}>
            {deleteM.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Eliminar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
