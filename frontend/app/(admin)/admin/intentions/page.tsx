"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search, Play, BrainCircuit, Check, X, MoreHorizontal, Inbox, Layers, Tag, ChevronUp, ChevronDown } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { FormSheet } from "@/components/layout/form-sheet";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntentionRow } from "@/components/intentions/intention-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { PendingIntention } from "@/lib/api";
import { toast } from "@/components/ui/toast";

export default function IntentionsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  // Tab controlado: arranca en null y cae al default del flujo (Sugeridos →
  // Pendientes → Activos) hasta que el usuario elija. Controlado para que la
  // barra guía pueda saltar de pestaña.
  const [tab, setTab] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [pendingDetail, setPendingDetail] = useState<PendingIntention | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newExamples, setNewExamples] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["intentions"],
    queryFn: api.intentions.list,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  // Pre-fill suggested labels only for clusters the user hasn't touched yet
  useEffect(() => {
    if (!data?.discovered_clusters) return;
    setClusterLabel((prev) => {
      const next = { ...prev };
      for (const c of data.discovered_clusters) {
        if (next[c.cluster_id] === undefined && c.suggested_label) {
          next[c.cluster_id] = c.suggested_label;
        }
      }
      return next;
    });
  }, [data?.discovered_clusters]);

  const inv = () => queryClient.invalidateQueries({ queryKey: ["intentions"] });

  const approveMutation = useMutation({
    mutationFn: api.intentions.approve,
    onSuccess: () => { inv(); toast({ title: "Intención aprobada", description: "El clasificador se reentrenará en segundo plano.", variant: "success" }); },
    onError: () => toast({ title: "Error al aprobar", variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: api.intentions.reject,
    onSuccess: () => { inv(); toast({ title: "Intención descartada", variant: "default" }); },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.intentions.toggleActive(id, isActive),
    onSuccess: () => { inv(); toast({ title: "Estado actualizado", variant: "success" }); },
  });

  const deleteMutation = useMutation({
    mutationFn: api.intentions.delete,
    onSuccess: () => { inv(); toast({ title: "Intención eliminada", variant: "default" }); },
    onError: () => toast({ title: "Error al eliminar", variant: "destructive" }),
  });

  const clusterMutation = useMutation({
    mutationFn: api.intentions.triggerClustering,
    onSuccess: () => {
      toast({ title: "Clustering iniciado", description: "El panel se actualizará en unos minutos.", variant: "success" });
      setTimeout(inv, 5000);
    },
    onError: () => toast({ title: "Error al iniciar clustering", variant: "destructive" }),
  });

  const retrainMutation = useMutation({
    mutationFn: api.intentions.triggerRetrain,
    onSuccess: () => toast({ title: "Reentrenamiento iniciado", description: "Se actualizará si la precisión mejora. Rollback automático si baja.", variant: "success" }),
    onError: () => toast({ title: "Error al reentrenar", variant: "destructive" }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.intentions.create(
        newLabel.trim(),
        newDescription.trim() || undefined,
        newExamples
          .split("\n")
          .map((e) => e.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      inv();
      setShowCreate(false);
      setNewLabel("");
      setNewDescription("");
      setNewExamples("");
      toast({ title: "Intención creada", variant: "success" });
    },
    onError: () => toast({ title: "Error al crear intención", variant: "destructive" }),
  });

  const [clusterLabel, setClusterLabel] = useState<Record<string, string>>({});

  const intentions = (data?.intentions ?? []).filter((i) =>
    !search || i.label.toLowerCase().includes(search.toLowerCase())
  );
  const active = intentions.filter((i) => i.is_active);
  const inactive = intentions.filter((i) => !i.is_active);

  // Orden de la pestaña Activos: por uso (consultas 7d), dirección según el
  // header clickeable de la columna Consultas.
  const sortThemes = <T extends { queries_7d?: number }>(list: T[]) =>
    [...list].sort((a, b) => {
      const d = (a.queries_7d ?? 0) - (b.queries_7d ?? 0);
      return sortDir === "desc" ? -d : d;
    });
  const sortedActive = sortThemes(active);
  const sortedInactive = sortThemes(inactive);
  const maxQueries = Math.max(1, ...active.map((i) => i.queries_7d ?? 0), ...inactive.map((i) => i.queries_7d ?? 0));
  // Conteo sin filtrar por búsqueda → distingue "no hay temas" de "sin resultados".
  const totalActive = (data?.intentions ?? []).filter((i) => i.is_active).length;
  const pending = data?.pending_review ?? [];
  const clusters = data?.discovered_clusters ?? [];

  // Tab por defecto = primer paso del flujo con trabajo pendiente. Se respeta
  // la elección del usuario (tab !== null) una vez que interactúa.
  const activeTab = tab ?? (clusters.length > 0 ? "clusters" : pending.length > 0 ? "pending" : "active");

  const approveClusterMutation = useMutation({
    mutationFn: ({ clusterId, label }: { clusterId: string; label: string }) =>
      api.intentions.approveCluster(clusterId, label),
    onSuccess: (_data, vars) => {
      inv();
      setSelectedClusterId((cur) => (cur === vars.clusterId ? null : cur));
      setClusterLabel((prev) => { const n = { ...prev }; delete n[vars.clusterId]; return n; });
      toast({ title: "Intención creada", description: "El clasificador se reentrenará en segundo plano.", variant: "success" });
    },
    onError: () => toast({ title: "Error al aprobar cluster", variant: "destructive" }),
  });

  const dismissClusterMutation = useMutation({
    mutationFn: (clusterId: string) => api.intentions.dismissCluster(clusterId),
    onSuccess: (_data, clusterId) => {
      inv();
      setSelectedClusterId((cur) => (cur === clusterId ? null : cur));
      toast({ title: "Grupo descartado", variant: "default" });
    },
  });

  // Cluster en vivo (derivado de la lista): así el panel de detalle refleja los
  // refetches — al quitar un outlier o descartar, se actualiza solo.
  const selectedCluster = clusters.find((c) => c.cluster_id === selectedClusterId) ?? null;

  // El label efectivo de un grupo = lo que el admin tipeó, o la sugerencia de la
  // IA. Aprobar sin label no tiene sentido, así que el botón queda deshabilitado.
  const clusterEffectiveLabel = (c: import("@/lib/api").DiscoveredCluster) =>
    ((clusterLabel[c.cluster_id] ?? c.suggested_label ?? "").trim());
  const approveCluster = (c: import("@/lib/api").DiscoveredCluster) => {
    const label = clusterEffectiveLabel(c);
    if (label) approveClusterMutation.mutate({ clusterId: c.cluster_id, label });
  };

  return (
    <PageShell width="wide">
      <PageHeader
        title="Temas reconocidos"
        description="El bot detecta temas en las consultas y vos los revisás y aprobás."
      />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <div className="text-center py-20 text-destructive text-sm">
          Error al cargar intenciones
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setTab}>
          {/* Fila de pestañas + acciones a la derecha (misma altura). Orden =
              flujo de trabajo: primero lo que hay para revisar, después lo ya
              resuelto. La mirada cae a la izquierda → ahí va la bandeja. */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <TabsList>
              <TabsTrigger value="clusters">
                Sugeridos
                {clusters.length > 0 && <TabCount count={clusters.length} />}
              </TabsTrigger>
              <TabsTrigger value="pending">
                Pendientes
                {pending.length > 0 && <TabCount count={pending.length} />}
              </TabsTrigger>
              <TabsTrigger value="active">
                Activos
                {active.length > 0 && <TabCount count={active.length} />}
              </TabsTrigger>
            </TabsList>

            <div className="flex items-center gap-2">
              <Button size="sm" className="group" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4 mr-1 transition-transform group-hover:rotate-90" />
                Nuevo tema
              </Button>
              {/* Acciones secundarias/automáticas en el overflow */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="Más acciones" title="Más acciones">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem
                    onSelect={() => clusterMutation.mutate()}
                    disabled={clusterMutation.isPending}
                  >
                    {clusterMutation.isPending
                      ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      : <Play className="h-4 w-4 mr-2" />}
                    Detectar temas nuevos
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => retrainMutation.mutate()}
                    disabled={retrainMutation.isPending}
                  >
                    {retrainMutation.isPending
                      ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      : <BrainCircuit className="h-4 w-4 mr-2" />}
                    Reentrenar clasificador
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Activas — inventario que se administra: buscar, ordenar por uso,
              tabla que escala a cientos de temas. */}
          <TabsContent value="active" className="mt-4 space-y-4">
            {totalActive === 0 ? (
              <EmptyState
                icon={Tag}
                title="No hay temas activos"
                description="Creá un tema con 'Nuevo tema' (arriba) o aprobá los que el bot detectó en las pestañas Sugeridos y Pendientes."
              />
            ) : (
              <>
                {/* Toolbar: buscar · ver inactivos · ordenar · toggle */}
                <div className="flex items-center justify-between gap-2.5 flex-wrap">
                  <div className="relative w-full max-w-xs min-w-0">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Buscar tema..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-8 h-10"
                    />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {inactive.length > 0 && (
                      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowInactive(v => !v)}>
                        {showInactive ? "Ocultar inactivos" : `Ver inactivos (${inactive.length})`}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Contenido: sin resultados / tabla */}
                {sortedActive.length === 0 ? (
                  <EmptyState icon={Search} title="Sin resultados" description={`Ningún tema coincide con "${search}".`} />
                ) : (
                  <ThemeTable
                    items={sortedActive}
                    maxQueries={maxQueries}
                    sortDir={sortDir}
                    onToggleSort={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
                    onToggle={(id, current) => toggleMutation.mutate({ id, isActive: current })}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                )}

                {/* Inactivos — plegados dentro de Activos (sin pestaña propia) */}
                {showInactive && inactive.length > 0 && (
                  <div className="pt-2 space-y-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      Inactivos · no se usan para clasificar
                    </p>
                    <ThemeTable
                      items={sortedInactive}
                      maxQueries={maxQueries}
                      sortDir={sortDir}
                      onToggleSort={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
                      onToggle={(id, current) => toggleMutation.mutate({ id, isActive: current })}
                      onDelete={(id) => deleteMutation.mutate(id)}
                    />
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* Pendientes */}
          <TabsContent value="pending" className="mt-4 space-y-3">
            {pending.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No hay temas pendientes"
                description="Cuando el bot detecte consultas que necesitan tu validación, van a aparecer acá."
              />
            ) : (
              <PendingTable
                items={pending}
                approving={approveMutation.isPending}
                rejecting={rejectMutation.isPending}
                onApprove={(id) => approveMutation.mutate(id)}
                onReject={(id) => rejectMutation.mutate(id)}
                onSelect={setPendingDetail}
              />
            )}
          </TabsContent>

          {/* Grupos sugeridos (clusters descubiertos automáticamente) */}
          <TabsContent value="clusters" className="mt-4 space-y-3">
            {clusters.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="Sin grupos sugeridos"
                description="Usá 'Detectar temas nuevos' (arriba) para que el sistema agrupe consultas similares y te proponga temas."
              />
            ) : (
              <ClusterTable
                clusters={clusters}
                getLabel={(id) => clusterLabel[id] ?? ""}
                onLabelChange={(id, v) => setClusterLabel((prev) => ({ ...prev, [id]: v }))}
                effectiveLabel={clusterEffectiveLabel}
                approving={approveClusterMutation.isPending}
                dismissing={dismissClusterMutation.isPending}
                onApprove={approveCluster}
                onDismiss={(c) => dismissClusterMutation.mutate(c.cluster_id)}
                onSelect={(c) => setSelectedClusterId(c.cluster_id)}
              />
            )}
          </TabsContent>

        </Tabs>
      )}

      {/* Panel de detalle de un pendiente: sus consultas + decisión */}
      <PendingDetailSheet
        item={pendingDetail}
        onClose={() => setPendingDetail(null)}
        approving={approveMutation.isPending}
        rejecting={rejectMutation.isPending}
        onApprove={(id) => approveMutation.mutate(id)}
        onReject={(id) => rejectMutation.mutate(id)}
      />

      {/* Panel de detalle de un grupo sugerido: nombrar, revisar consultas,
          quitar outliers y decidir. Mismo patrón que el de Pendientes. */}
      <ClusterDetailSheet
        cluster={selectedCluster}
        onClose={() => setSelectedClusterId(null)}
        label={selectedCluster ? clusterLabel[selectedCluster.cluster_id] ?? "" : ""}
        onLabelChange={(v) => selectedCluster && setClusterLabel((prev) => ({ ...prev, [selectedCluster.cluster_id]: v }))}
        canApprove={selectedCluster ? clusterEffectiveLabel(selectedCluster).length > 0 : false}
        approving={approveClusterMutation.isPending}
        dismissing={dismissClusterMutation.isPending}
        onApprove={() => selectedCluster && approveCluster(selectedCluster)}
        onDismiss={() => selectedCluster && dismissClusterMutation.mutate(selectedCluster.cluster_id)}
      />

      {/* Panel crear tema */}
      <FormSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        icon={Tag}
        title="Nuevo tema"
        description="Un tema que el bot va a reconocer en las consultas."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!newLabel.trim() || createMutation.isPending}
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Crear tema
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="new-intent-label">Nombre</Label>
            <Input
              id="new-intent-label"
              placeholder="Ej. vacaciones"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-intent-desc">
              Descripción <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Input
              id="new-intent-desc"
              placeholder="Para qué se usa este tema"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-intent-examples">
              Ejemplos <span className="font-normal text-muted-foreground">(uno por línea)</span>
            </Label>
            <Textarea
              id="new-intent-examples"
              rows={4}
              className="text-sm resize-none"
              placeholder={"¿Cuántos días de vacaciones tengo?\n¿Cómo pido vacaciones?"}
              value={newExamples}
              onChange={(e) => setNewExamples(e.target.value)}
            />
          </div>
        </div>
      </FormSheet>
    </PageShell>
  );
}

/** Tabla de grupos sugeridos: misma cola de decisiones que Pendientes. Cada
 *  fila es un grupo con su nombre editable inline (el bot sugiere uno), el
 *  conteo de consultas y las acciones Aprobar / Descartar. Al clickear la fila
 *  se abre el panel de detalle para ver las consultas y quitar outliers. */
function ClusterTable({
  clusters, getLabel, onLabelChange, effectiveLabel, approving, dismissing, onApprove, onDismiss, onSelect,
}: {
  clusters: import("@/lib/api").DiscoveredCluster[];
  getLabel: (clusterId: string) => string;
  onLabelChange: (clusterId: string, v: string) => void;
  effectiveLabel: (c: import("@/lib/api").DiscoveredCluster) => string;
  approving: boolean;
  dismissing: boolean;
  onApprove: (c: import("@/lib/api").DiscoveredCluster) => void;
  onDismiss: (c: import("@/lib/api").DiscoveredCluster) => void;
  onSelect: (c: import("@/lib/api").DiscoveredCluster) => void;
}) {
  return (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Tema sugerido</TableHead>
            <TableHead className="text-right whitespace-nowrap">Consultas</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clusters.map((c) => (
            <TableRow key={c.cluster_id} className="cursor-pointer" onClick={() => onSelect(c)}>
              <TableCell>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-action-gradient-soft">
                    <Tag className="h-4 w-4 text-action" />
                  </div>
                  {/* El input frena la propagación: tipear/clickear no abre el panel */}
                  <Input
                    value={getLabel(c.cluster_id)}
                    placeholder={c.suggested_label || "Escribí un nombre…"}
                    onChange={(e) => onLabelChange(c.cluster_id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-9 text-sm font-medium max-w-xs"
                  />
                </div>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                <span className="font-semibold text-foreground">{c.query_count}</span>
              </TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                <div className="inline-flex items-center gap-1.5">
                  <Button
                    variant="ghost" size="sm"
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => onDismiss(c)}
                    disabled={dismissing}
                  >
                    <X className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Descartar</span>
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => onApprove(c)}
                    disabled={approving || !effectiveLabel(c)}
                    title={!effectiveLabel(c) ? "Ponele un nombre al tema para aprobarlo" : undefined}
                  >
                    <Check className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Aprobar</span>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Panel lateral de un grupo sugerido: nombre editable, las consultas que el
 *  sistema agrupó, y la posibilidad de quitar las que sobran (outliers) antes
 *  de decidir. Mismo patrón que el panel de Pendientes — coherencia de sistema. */
function ClusterDetailSheet({
  cluster, onClose, label, onLabelChange, canApprove, approving, dismissing, onApprove, onDismiss,
}: {
  cluster: import("@/lib/api").DiscoveredCluster | null;
  onClose: () => void;
  label: string;
  onLabelChange: (v: string) => void;
  canApprove: boolean;
  approving: boolean;
  dismissing: boolean;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const open = cluster !== null;
  const queryClient = useQueryClient();
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  // Reset del set optimista al cambiar de grupo — cada panel arranca limpio.
  const clusterId = cluster?.cluster_id;
  useEffect(() => { setRemoved(new Set()); }, [clusterId]);

  const removeQuery = useMutation({
    mutationFn: (queryId: string) => api.intentions.removeQueryFromCluster(clusterId!, queryId),
    onMutate: (queryId) => setRemoved((prev) => new Set([...prev, queryId])),
    onError: (_err, queryId) => setRemoved((prev) => { const n = new Set(prev); n.delete(queryId); return n; }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intentions"] }),
  });

  const queries = cluster ? cluster.queries.filter((q) => !removed.has(q.id)) : [];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg p-0 gap-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-5 border-b border-border/70 space-y-0 text-left">
          <SheetTitle className="sr-only">Grupo sugerido</SheetTitle>
          {/* pr-8 reserva lugar para la X de cerrar del sheet — que no se pise
              con el input. Icono + input en la misma fila, a la misma altura. */}
          <div className="flex items-center gap-3 pr-8">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
              <Tag className="h-5 w-5 text-action" />
            </div>
            <Input
              value={label}
              placeholder={cluster?.suggested_label || "Escribí un nombre para este tema…"}
              onChange={(e) => onLabelChange(e.target.value)}
              className="h-10 flex-1 min-w-0 text-[15px] font-medium"
            />
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-3">
            Consultas del grupo · quitá las que no encajen
          </p>
          {queries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No quedan consultas en este grupo. Descartalo.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {queries.map((q) => (
                <li key={q.id} className="group/q flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted/40">
                  <span className="text-action/40 text-base leading-5 shrink-0 font-serif">“</span>
                  <span className="text-sm text-foreground flex-1 leading-relaxed">{q.text}</span>
                  <button
                    onClick={() => removeQuery.mutate(q.id)}
                    disabled={removeQuery.isPending}
                    aria-label={`Quitar "${q.text}" del grupo`}
                    title="Quitar del grupo"
                    className="opacity-0 group-hover/q:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5 text-muted-foreground hover:text-destructive shrink-0 transition-opacity mt-0.5"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer: decisión con contexto a la vista */}
        <div className="px-6 py-4 border-t border-border/70 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={onDismiss}
            disabled={dismissing}
          >
            {dismissing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <X className="h-4 w-4 mr-1.5" />}
            Descartar
          </Button>
          <Button
            className="min-w-[140px]"
            onClick={onApprove}
            disabled={approving || !canApprove || queries.length === 0}
            title={!canApprove ? "Ponele un nombre al tema para aprobarlo" : undefined}
          >
            {approving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Check className="h-4 w-4 mr-1.5" />}
            Aprobar tema
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Tabla de temas (vista Lista de Activos). Escala a cientos de filas con
 *  columna de uso ordenable. */
function ThemeTable({
  items, maxQueries, sortDir, onToggleSort, onToggle, onDelete,
}: {
  items: Array<{ id: string; label: string; description?: string | null; is_active: boolean; queries_7d?: number }>;
  maxQueries: number;
  sortDir: "asc" | "desc";
  onToggleSort: () => void;
  onToggle: (id: string, current: boolean) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Tema</TableHead>
            <TableHead className="p-0">
              {/* Header clickeable: ordena por uso, alterna asc/desc con la flecha */}
              <button
                type="button"
                onClick={onToggleSort}
                className="inline-flex items-center gap-1 h-9 px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
              >
                Consultas · 7 días
                {sortDir === "desc"
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronUp className="h-3.5 w-3.5" />}
              </button>
            </TableHead>
            <TableHead className="hidden md:table-cell">Estado</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((intent) => (
            <IntentionRow
              key={intent.id}
              id={intent.id}
              label={intent.label}
              description={intent.description}
              isActive={intent.is_active}
              queries7d={intent.queries_7d}
              maxQueries={maxQueries}
              onToggleActive={onToggle}
              onDelete={onDelete}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Tabla de temas pendientes: cola de decisiones. Cada fila con sus acciones
 *  Aprobar / Descartar inline. */
function PendingTable({
  items, approving, rejecting, onApprove, onReject, onSelect,
}: {
  items: PendingIntention[];
  approving: boolean;
  rejecting: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onSelect: (p: PendingIntention) => void;
}) {
  return (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Tema detectado</TableHead>
            <TableHead className="text-right whitespace-nowrap">Consultas</TableHead>
            <TableHead className="hidden md:table-cell text-right whitespace-nowrap">Confianza</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((p) => (
            <TableRow key={p.id} className="cursor-pointer" onClick={() => onSelect(p)}>
              <TableCell>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/15">
                    <Tag className="h-4 w-4 text-warning" />
                  </div>
                  <span className="font-medium text-foreground truncate">{p.label}</span>
                </div>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                <span className="font-semibold text-foreground">{p.query_count}</span>
              </TableCell>
              <TableCell className="hidden md:table-cell text-right whitespace-nowrap">
                <span className="text-sm tabular-nums font-medium text-warning">{Math.round(p.avg_confidence * 100)}%</span>
              </TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                <div className="inline-flex items-center gap-1.5">
                  <Button
                    variant="ghost" size="sm"
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => onReject(p.id)}
                    disabled={rejecting}
                  >
                    <X className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Descartar</span>
                  </Button>
                  <Button size="sm" onClick={() => onApprove(p.id)} disabled={approving}>
                    <Check className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Aprobar</span>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Panel lateral de un tema pendiente: muestra las consultas reales que lo
 *  dispararon y permite decidir (Aprobar / Descartar) con contexto. */
function PendingDetailSheet({
  item, onClose, onApprove, onReject, approving, rejecting,
}: {
  item: PendingIntention | null;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  approving: boolean;
  rejecting: boolean;
}) {
  const open = item !== null;
  const { data, isLoading } = useQuery({
    queryKey: ["pending-examples", item?.label],
    queryFn: () => api.intentions.getPendingExamples(item!.label),
    enabled: open,
    staleTime: 30_000,
  });
  const examples = data?.examples ?? [];
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "short" });

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg p-0 gap-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-5 border-b border-border/70 space-y-0 text-left">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/15">
              <Tag className="h-5 w-5 text-warning" />
            </div>
            <div className="min-w-0 space-y-1">
              <SheetTitle className="truncate">{item?.label}</SheetTitle>
              <p className="text-[13px] text-muted-foreground">
                {item?.query_count} {item?.query_count === 1 ? "consulta" : "consultas"}
                {item != null && <> · {Math.round(item.avg_confidence * 100)}% de confianza</>}
              </p>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-3">
            Consultas que dispararon este tema
          </p>
          {isLoading ? (
            <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : examples.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Sin consultas para mostrar.</p>
          ) : (
            <ul className="space-y-0.5">
              {examples.map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-muted/40">
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-foreground leading-snug">
                      {e.question_text ?? <span className="italic text-muted-foreground">Sin texto</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">{fmt(e.created_at)}</span>
                  </span>
                  {e.intent_confidence != null && (
                    <span className="shrink-0 mt-0.5 text-xs tabular-nums font-medium text-warning">
                      {Math.round(e.intent_confidence * 100)}%
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer: decisión con contexto a la vista */}
        <div className="px-6 py-4 border-t border-border/70 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={() => { if (item) { onReject(item.id); onClose(); } }}
            disabled={rejecting}
          >
            <X className="h-4 w-4 mr-1.5" /> Descartar
          </Button>
          <Button
            className="min-w-[140px]"
            onClick={() => { if (item) { onApprove(item.id); onClose(); } }}
            disabled={approving}
          >
            <Check className="h-4 w-4 mr-1.5" /> Aprobar tema
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Contador chico al lado del título de cada tab. Usa el acento del panel
 *  (Intellix índigo, tenue) — no el color del tenant, que vive solo de cara
 *  al afiliado. */
function TabCount({ count }: { count: number }) {
  return (
    <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-action/10 text-action text-[10px] font-semibold tabular-nums">
      {count}
    </span>
  );
}
