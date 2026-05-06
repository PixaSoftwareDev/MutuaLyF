"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Check, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api";
import { api, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface OperatorUser {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
}

async function listOperators(): Promise<OperatorUser[]> {
  const { data } = await apiClient.get("/admin/operators");
  return data;
}

export default function OperatorsPage() {
  const qc = useQueryClient();

  const { data: operators = [], isLoading: loadingOps } = useQuery({
    queryKey: ["operators"],
    queryFn: listOperators,
  });

  const { data: sectors = [], isLoading: loadingSectors } = useQuery({
    queryKey: ["sectors"],
    queryFn: api.sectors.list,
  });

  const operatorsFiltered = operators.filter(o =>
    ["operator", "admin"].includes(o.role) && o.is_active
  );

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="h-6 w-6 text-primary" />
          Operadores y sectores
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Asigná los sectores que puede atender cada operador.
          Sin sectores asignados, el operador solo ve "Consultas Generales".
        </p>
      </div>

      {loadingOps || loadingSectors ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 rounded-lg" />)}
        </div>
      ) : operatorsFiltered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No hay operadores activos. Creá usuarios con rol "operator" desde el panel de usuarios.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {operatorsFiltered.map(op => (
            <OperatorCard key={op.id} operator={op} sectors={sectors} />
          ))}
        </div>
      )}
    </div>
  );
}

function OperatorCard({ operator, sectors }: { operator: OperatorUser; sectors: SectorRow[] }) {
  const qc = useQueryClient();
  const activeSectors = sectors.filter(s => s.is_active);

  const { data: assignedSectors = [] } = useQuery({
    queryKey: ["operator-sectors", operator.id],
    queryFn: () => api.sectors.getOperatorSectors(operator.id),
  });

  const [selected, setSelected] = useState<Set<string>>(
    new Set(assignedSectors.map(s => s.id))
  );
  const [dirty, setDirty] = useState(false);

  // Sync when data loads
  if (assignedSectors.length > 0 && !dirty && selected.size === 0) {
    setSelected(new Set(assignedSectors.map(s => s.id)));
  }

  const saveM = useMutation({
    mutationFn: () => api.sectors.assignOperatorSectors(operator.id, Array.from(selected)),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["operator-sectors", operator.id] });
      qc.invalidateQueries({ queryKey: ["sectors"] });
      toast({ title: `Sectores de ${operator.name} actualizados`, variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const toggle = (sectorId: string) => {
    const next = new Set(selected);
    if (next.has(sectorId)) next.delete(sectorId);
    else next.add(sectorId);
    setSelected(next);
    setDirty(true);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-sm">{operator.name}</p>
            <p className="text-xs text-muted-foreground">{operator.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs capitalize">{operator.role}</Badge>
            {dirty && (
              <Button size="sm" onClick={() => saveM.mutate()} disabled={saveM.isPending}>
                {saveM.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  : <Check className="h-4 w-4 mr-1" />}
                Guardar
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground mb-3">
          Sectores asignados — el operador solo ve conversaciones de estos sectores:
        </p>
        <div className="flex flex-wrap gap-2">
          {activeSectors.map(sector => {
            const isSelected = selected.has(sector.id);
            return (
              <button
                key={sector.id}
                onClick={() => toggle(sector.id)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm border transition-colors",
                  isSelected
                    ? "bg-primary text-white border-primary"
                    : "bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground",
                )}
              >
                {sector.nombre}
              </button>
            );
          })}
        </div>
        {selected.size === 0 && (
          <p className="text-xs text-amber-600 mt-2">
            Sin sectores → solo ve "Consultas Generales"
          </p>
        )}
      </CardContent>
    </Card>
  );
}
