"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search, Play, BrainCircuit, ChevronRight, Check, X, MoreHorizontal, Inbox, Sparkles, Tag } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { FormSheet } from "@/components/layout/form-sheet";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntentionCard } from "@/components/intentions/intention-card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";

export default function IntentionsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
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
  const pending = data?.pending_review ?? [];
  const clusters = data?.discovered_clusters ?? [];

  const approveClusterMutation = useMutation({
    mutationFn: ({ clusterId, label }: { clusterId: string; label: string }) =>
      api.intentions.approveCluster(clusterId, label),
    onSuccess: (_data, vars) => {
      inv();
      setClusterLabel((prev) => { const n = { ...prev }; delete n[vars.clusterId]; return n; });
      toast({ title: "Intención creada", description: "El clasificador se reentrenará en segundo plano.", variant: "success" });
    },
    onError: () => toast({ title: "Error al aprobar cluster", variant: "destructive" }),
  });

  const dismissClusterMutation = useMutation({
    mutationFn: (clusterId: string) => api.intentions.dismissCluster(clusterId),
    onSuccess: () => { inv(); toast({ title: "Cluster descartado", variant: "default" }); },
  });

  return (
    <PageShell>
      <PageHeader
        title="Temas reconocidos"
        badge={!isLoading && !error
          ? <CountChip>{active.length} {active.length === 1 ? "activo" : "activos"}</CountChip>
          : undefined}
        description="Los temas que el bot identifica en las consultas. Aprobá los que correspondan a tu organización."
        actions={
          <>
            {/* "Detectar temas nuevos" es el primer paso del flujo (sin esto no
                aparecen Sugeridos) → visible, no escondido en el menú. */}
            {/* "Detectar temas nuevos" es el primer paso del flujo (sin esto no
                aparecen Sugeridos) → visible. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => clusterMutation.mutate()}
              disabled={clusterMutation.isPending}
            >
              {clusterMutation.isPending
                ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                : <Play className="h-4 w-4 mr-1.5" />}
              Detectar temas nuevos
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Nuevo tema
            </Button>
            {/* Overflow al EXTREMO (convención). Acciones avanzadas/raras: hoy
                solo "Reentrenar" (normalmente es automático tras aprobar temas). */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label="Más acciones" title="Más acciones">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
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
          </>
        }
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
        <Tabs defaultValue={clusters.length > 0 ? "clusters" : pending.length > 0 ? "pending" : "active"}>
          {/* Orden = flujo de trabajo: primero lo que hay para revisar
              (Sugeridos/Pendientes), después lo ya resuelto (Activos/Inactivos).
              La mirada cae primero a la izquierda → ahí va la bandeja de trabajo. */}
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
            {inactive.length > 0 && (
              <TabsTrigger value="inactive">
                Inactivos
                <TabCount count={inactive.length} />
              </TabsTrigger>
            )}
          </TabsList>

          {/* Activas */}
          <TabsContent value="active" className="mt-4 space-y-4">
            {intentions.length > 4 && (
              <div className="relative max-w-xs">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar tema..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
            )}
            {active.length === 0 ? (
              <EmptyState
                icon={Tag}
                title="No hay temas activos"
                description="Creá un tema con 'Nuevo tema' (arriba) o aprobá los que el bot detectó en las pestañas Sugeridos y Pendientes."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {active.map((intent) => (
                  <IntentionCard
                    key={intent.id}
                    id={intent.id}
                    label={intent.label}
                    description={intent.description}
                    isActive={intent.is_active}
                    queries7d={intent.queries_7d}
                    onToggleActive={(id, current) => toggleMutation.mutate({ id, isActive: current })}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </div>
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
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {pending.map((intent) => (
                    <IntentionCard
                      key={intent.id}
                      id={intent.id}
                      label={intent.label}
                      description={null}
                      isActive={false}
                      isPending
                      pendingQueryCount={intent.query_count}
                      onApprove={(id) => approveMutation.mutate(id)}
                      onReject={(id) => rejectMutation.mutate(id)}
                    />
                  ))}
              </div>
            )}
          </TabsContent>

          {/* Grupos sugeridos (clusters descubiertos automáticamente) */}
          <TabsContent value="clusters" className="mt-4 space-y-3">
            {clusters.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="Sin grupos sugeridos"
                description="Usá 'Detectar temas nuevos' (arriba) para que el sistema agrupe consultas similares y te proponga temas."
              />
            ) : (
              <ClusterReview
                clusters={clusters}
                getLabel={(id) => clusterLabel[id] ?? ""}
                onLabelChange={(id, v) => setClusterLabel((prev) => ({ ...prev, [id]: v }))}
                onApprove={(cluster) => {
                  const label = (clusterLabel[cluster.cluster_id] ?? cluster.suggested_label ?? "").trim();
                  if (label) approveClusterMutation.mutate({ clusterId: cluster.cluster_id, label });
                }}
                onDismiss={(cluster) => dismissClusterMutation.mutate(cluster.cluster_id)}
                isApproving={approveClusterMutation.isPending}
                isDismissing={dismissClusterMutation.isPending}
              />
            )}
          </TabsContent>

          {/* Inactivas */}
          {inactive.length > 0 && (
            <TabsContent value="inactive" className="mt-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {inactive.map((intent) => (
                  <IntentionCard
                    key={intent.id}
                    id={intent.id}
                    label={intent.label}
                    description={intent.description}
                    isActive={false}
                    queries7d={intent.queries_7d}
                    onToggleActive={(id, current) => toggleMutation.mutate({ id, isActive: current })}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </div>
            </TabsContent>
          )}
        </Tabs>
      )}

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

/**
 * Revisión de grupos sugeridos — patrón master-detail (split view), como las
 * colas de triage de Linear/Gmail/GitHub. La lista izquierda deja escanear TODOS
 * los grupos de un vistazo; el panel derecho muestra el grupo activo con UN solo
 * par de acciones (aprobar/descartar). Evita el "muro de N botones repetidos" de
 * una grilla de cards. Al resolver un grupo, salta solo al siguiente.
 */
function ClusterReview({
  clusters, getLabel, onLabelChange, onApprove, onDismiss, isApproving, isDismissing,
}: {
  clusters: import("@/lib/api").DiscoveredCluster[];
  getLabel: (clusterId: string) => string;
  onLabelChange: (clusterId: string, v: string) => void;
  onApprove: (cluster: import("@/lib/api").DiscoveredCluster) => void;
  onDismiss: (cluster: import("@/lib/api").DiscoveredCluster) => void;
  isApproving: boolean;
  isDismissing: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(clusters[0]?.cluster_id ?? null);

  // Mantener una selección válida: si el grupo activo se aprueba/descarta y
  // desaparece de la lista, saltar al primero disponible (flujo continuo).
  useEffect(() => {
    if (clusters.length === 0) { setSelectedId(null); return; }
    if (!clusters.some((c) => c.cluster_id === selectedId)) {
      setSelectedId(clusters[0].cluster_id);
    }
  }, [clusters, selectedId]);

  const selected = clusters.find((c) => c.cluster_id === selectedId) ?? clusters[0] ?? null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 lg:h-[calc(100dvh-13rem)] lg:min-h-[480px]">
      {/* ── Lista de grupos (escaneo, sin acciones repetidas) ──────────────── */}
      <div className="rounded-xl border bg-card overflow-hidden flex flex-col min-h-0">
        <div className="px-3 py-2.5 border-b bg-muted/30 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide shrink-0">
          {clusters.length} {clusters.length === 1 ? "grupo para revisar" : "grupos para revisar"}
        </div>
        <div className="overflow-y-auto scrollbar-slim flex-1 min-h-0 p-1.5 space-y-0.5 max-h-64 lg:max-h-none">
          {clusters.map((c) => {
            const name = (getLabel(c.cluster_id) || c.suggested_label || "").trim();
            const isSel = c.cluster_id === selected?.cluster_id;
            return (
              <button
                key={c.cluster_id}
                onClick={() => setSelectedId(c.cluster_id)}
                aria-current={isSel ? "true" : undefined}
                className={cn(
                  "w-full text-left rounded-lg px-3 py-2.5 transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSel ? "bg-action/10 ring-1 ring-action/20" : "hover:bg-muted/60",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm truncate", name ? "font-medium text-foreground" : "text-muted-foreground italic")}>
                    {name || "Grupo sin nombre"}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {c.queries.length} {c.queries.length === 1 ? "consulta" : "consultas"}
                  </p>
                </div>
                <ChevronRight className={cn("h-4 w-4 shrink-0", isSel ? "text-action" : "text-muted-foreground/40")} />
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Detalle del grupo seleccionado ─────────────────────────────────── */}
      {selected ? (
        <ClusterDetail
          key={selected.cluster_id}
          cluster={selected}
          label={getLabel(selected.cluster_id)}
          onLabelChange={(v) => onLabelChange(selected.cluster_id, v)}
          onApprove={() => onApprove(selected)}
          onDismiss={() => onDismiss(selected)}
          isApproving={isApproving}
          isDismissing={isDismissing}
        />
      ) : (
        <div className="rounded-xl border bg-card flex items-center justify-center text-sm text-muted-foreground">
          Seleccioná un grupo
        </div>
      )}
    </div>
  );
}

function ClusterDetail({
  cluster, label, onLabelChange, onApprove, onDismiss, isApproving, isDismissing,
}: {
  cluster: import("@/lib/api").DiscoveredCluster;
  label: string;
  onLabelChange: (v: string) => void;
  onApprove: () => void;
  onDismiss: () => void;
  isApproving: boolean;
  isDismissing: boolean;
}) {
  // `removed` se resetea al cambiar de grupo gracias al key={cluster_id} arriba.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const allQueries = cluster.queries.filter((q) => !removed.has(q.id));
  const effectiveLabel = (label.trim() || cluster.suggested_label || "").trim();

  const removeQuery = useMutation({
    mutationFn: (queryId: string) => api.intentions.removeQueryFromCluster(cluster.cluster_id, queryId),
    onMutate: (queryId) => setRemoved((prev) => new Set([...prev, queryId])),
    onError: (_err, queryId) => setRemoved((prev) => { const n = new Set(prev); n.delete(queryId); return n; }),
  });

  return (
    <div className="rounded-xl border bg-card overflow-hidden flex flex-col min-h-0">
      {/* Nombre del tema — editable directo, con la sugerencia de la IA ya puesta.
          Al ser UN grupo a la vez, un input visible no abruma (no hay 7 campos). */}
      <div className="px-5 py-4 border-b shrink-0">
        <label htmlFor="cluster-name" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          Nombre del tema
        </label>
        <Input
          id="cluster-name"
          value={label}
          placeholder={cluster.suggested_label || "Escribí un nombre para este tema…"}
          onChange={(e) => onLabelChange(e.target.value)}
          className="mt-1.5 h-10 text-base font-medium max-w-md"
        />
        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
          {allQueries.length} {allQueries.length === 1 ? "consulta agrupada" : "consultas agrupadas"} por el sistema.
          Quitá las que no correspondan antes de aprobar.
        </p>
      </div>

      {/* Consultas de ejemplo */}
      <div className="flex-1 overflow-y-auto scrollbar-slim px-4 py-3 min-h-0 max-h-72 lg:max-h-none">
        {allQueries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            No quedan consultas en este grupo. Descartalo o agregá ejemplos desde otro lado.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {allQueries.map((q) => (
              <li key={q.id} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <span className="text-action/40 text-base leading-5 shrink-0 font-serif">“</span>
                <span className="text-sm text-foreground flex-1 leading-relaxed">{q.text}</span>
                <button
                  onClick={() => removeQuery.mutate(q.id)}
                  disabled={removeQuery.isPending}
                  aria-label={`Quitar "${q.text}" del grupo`}
                  className="opacity-40 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5 text-muted-foreground hover:text-destructive shrink-0 transition-opacity mt-0.5"
                  title="Quitar del grupo"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Acciones — UN solo par para el grupo activo */}
      <div className="px-5 py-3.5 border-t bg-muted/20 flex items-center justify-between gap-3 shrink-0">
        <Button
          variant="ghost"
          className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDismiss}
          disabled={isDismissing}
        >
          {isDismissing ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          Descartar grupo
        </Button>
        <Button
          className="gap-1.5 min-w-[150px]"
          onClick={onApprove}
          disabled={!effectiveLabel || isApproving || allQueries.length === 0}
        >
          {isApproving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Aprobar tema
        </Button>
      </div>
    </div>
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
