"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Zap, Loader2, RefreshCw, Plus, Search, Play, BrainCircuit } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { IntentionCard } from "@/components/intentions/intention-card";
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
    refetchInterval: 30_000,
  });

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

  const intentions = (data?.intentions ?? []).filter((i) =>
    !search || i.label.toLowerCase().includes(search.toLowerCase())
  );
  const active = intentions.filter((i) => i.is_active);
  const inactive = intentions.filter((i) => !i.is_active);
  const pending = data?.pending_review ?? [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="h-6 w-6 text-primary" />
            Intenciones
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Intenciones detectadas en las consultas de tu organización.
            Aprobá las correctas para mejorar la clasificación automática.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ["intentions"] })}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Actualizar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => clusterMutation.mutate()}
            disabled={clusterMutation.isPending}
            title="Ejecutar clustering ahora (normalmente corre automáticamente a las 2AM)"
          >
            {clusterMutation.isPending
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <Play className="h-4 w-4 mr-1" />}
            Detectar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => retrainMutation.mutate()}
            disabled={retrainMutation.isPending}
            title="Reentrenar clasificador con los ejemplos aprobados (con rollback automático si baja la precisión)"
          >
            {retrainMutation.isPending
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <BrainCircuit className="h-4 w-4 mr-1" />}
            Reentrenar
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva
          </Button>
        </div>
      </div>

      {/* Stats summary */}
      {data && (
        <div className="flex gap-6 text-sm">
          <div>
            <span className="font-semibold text-foreground">{data.total}</span>
            <span className="text-muted-foreground ml-1">intenciones</span>
          </div>
          <div>
            <span className="font-semibold text-foreground">{active.length}</span>
            <span className="text-muted-foreground ml-1">activas</span>
          </div>
          {data.pending_total > 0 && (
            <div>
              <span className="font-semibold text-amber-600">{data.pending_total}</span>
              <span className="text-muted-foreground ml-1">pendientes de revisión</span>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="text-center py-20 text-destructive text-sm">
          Error al cargar intenciones
        </div>
      ) : (
        <Tabs defaultValue={pending.length > 0 ? "pending" : "active"}>
          <TabsList>
            <TabsTrigger value="active">
              Activas
              {active.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs px-1.5">{active.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="pending">
              Pendientes
              {pending.length > 0 && (
                <Badge className="ml-1.5 text-xs px-1.5 bg-amber-500 hover:bg-amber-500">{pending.length}</Badge>
              )}
            </TabsTrigger>
            {inactive.length > 0 && (
              <TabsTrigger value="inactive">
                Inactivas
                <Badge variant="secondary" className="ml-1.5 text-xs px-1.5">{inactive.length}</Badge>
              </TabsTrigger>
            )}
          </TabsList>

          {/* Activas */}
          <TabsContent value="active" className="mt-4 space-y-4">
            {intentions.length > 4 && (
              <div className="relative max-w-xs">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar intención..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
            )}
            {active.length === 0 ? (
              <EmptyState text="No hay intenciones activas todavía. Creá una manualmente o aprobá las pendientes." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {active.map((intent) => (
                  <IntentionCard
                    key={intent.id}
                    id={intent.id}
                    label={intent.label}
                    description={intent.description}
                    exampleCount={intent.example_count}
                    autoLearnedCount={intent.auto_learned_count}
                    isActive={intent.is_active}
                    queries7d={intent.queries_7d}
                    avgConfidence7d={intent.avg_confidence_7d}
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
              <EmptyState text="No hay intenciones pendientes de revisión. El sistema las genera automáticamente cuando detecta patrones repetidos en las consultas." />
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  El sistema detectó estos grupos de consultas similares. Aprobá los que correspondan a intenciones reales de tu organización.
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {pending.map((intent) => (
                    <IntentionCard
                      key={intent.id}
                      id={intent.id}
                      label={intent.label}
                      description={null}
                      exampleCount={0}
                      autoLearnedCount={0}
                      isActive={false}
                      isPending
                      pendingQueryCount={intent.query_count}
                      pendingAvgConfidence={intent.avg_confidence}
                      onApprove={(id) => approveMutation.mutate(id)}
                      onReject={(id) => rejectMutation.mutate(id)}
                    />
                  ))}
                </div>
              </>
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
                    exampleCount={intent.example_count}
                    autoLearnedCount={intent.auto_learned_count}
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

      {/* Modal crear intención */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nueva intención</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Nombre *</label>
              <Input
                placeholder="ej: consulta_vacaciones"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Descripción (opcional)</label>
              <Input
                placeholder="ej: Preguntas sobre política de licencias y vacaciones"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Ejemplos de consultas (uno por línea, opcional)</label>
              <textarea
                className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                placeholder={"¿Cuántos días de vacaciones tengo?\n¿Cómo solicito una licencia?\n¿Quién aprueba las vacaciones?"}
                value={newExamples}
                onChange={(e) => setNewExamples(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Los ejemplos se usan para que el clasificador reconozca esta intención automáticamente.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!newLabel.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Crear intención
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-center py-16 text-muted-foreground text-sm max-w-sm mx-auto">
      <Zap className="h-8 w-8 mx-auto mb-3 opacity-30" />
      {text}
    </div>
  );
}
