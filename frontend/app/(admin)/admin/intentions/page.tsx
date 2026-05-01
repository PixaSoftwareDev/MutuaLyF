"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Zap, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntentionCard } from "@/components/intentions/intention-card";

export default function IntentionsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["intentions"],
    queryFn: api.intentions.list,
    refetchInterval: 30_000,
  });

  const approveMutation = useMutation({
    mutationFn: api.intentions.approve,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intentions"] }),
  });

  const rejectMutation = useMutation({
    mutationFn: api.intentions.reject,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intentions"] }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["intentions"] });

  const intentions = data?.intentions ?? [];
  const pending = data?.pending_review ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="h-6 w-6 text-primary" />
            Intenciones
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Intenciones detectadas automáticamente en las consultas de tu organización
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Actualizar
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="text-center py-16 text-destructive text-sm">
          Error al cargar intenciones
        </div>
      ) : (
        <Tabs defaultValue={pending.length > 0 ? "pending" : "all"}>
          <TabsList>
            <TabsTrigger value="all">
              Todas ({intentions.length})
            </TabsTrigger>
            <TabsTrigger value="pending">
              Pendientes{pending.length > 0 ? ` (${pending.length})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="all" className="mt-4">
            {intentions.length === 0 ? (
              <EmptyState text="Todavía no hay intenciones detectadas. A medida que los usuarios hagan consultas, el sistema las irá descubriendo." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {intentions.map((intent) => (
                  <IntentionCard
                    key={intent.id}
                    id={intent.id}
                    label={intent.label}
                    description={intent.description}
                    exampleCount={intent.example_count}
                    autoLearnedCount={intent.auto_learned_count}
                    isActive={intent.is_active}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="pending" className="mt-4">
            {pending.length === 0 ? (
              <EmptyState text="No hay intenciones pendientes de revisión." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pending.map((intent) => (
                  <IntentionCard
                    key={intent.id}
                    id={intent.id}
                    label={intent.label}
                    description={null}
                    exampleCount={intent.example_count}
                    autoLearnedCount={0}
                    isActive={false}
                    isPending
                    onApprove={(id) => approveMutation.mutate(id)}
                    onReject={(id) => rejectMutation.mutate(id)}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
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
