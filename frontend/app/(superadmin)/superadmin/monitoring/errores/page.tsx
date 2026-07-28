"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { SuperShell } from "@/components/superadmin/shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorRow, ErrorSummary } from "@/components/superadmin/shared";
import { Panel } from "@/components/superadmin/panel";

/**
 * Monitoreo → Errores. UNA pregunta: "¿qué está fallando y por qué?".
 * Primero el resumen por dominio en palabras; después la lista, cada error
 * explicado en claro con el log técnico plegado detrás de "Ver detalle".
 */

export default function MonitoringErrorsPage() {
  const qc = useQueryClient();
  const [levelFilter, setLevelFilter] = useState<string>("");

  const { data: errorsData, isLoading } = useQuery({
    queryKey: ["platform-errors"], queryFn: () => api.tenants.platformErrors(100),
    refetchInterval: 30_000, staleTime: 15_000,
  });

  const errors = (errorsData?.errors ?? []).filter(e => !levelFilter || e.level === levelFilter);

  return (
    <SuperShell
      title="Errores"
      actions={
        <div className="flex items-center gap-1.5">
          <Select value={levelFilter || "all"} onValueChange={v => setLevelFilter(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los niveles</SelectItem>
              <SelectItem value="ERROR">Solo errores</SelectItem>
              <SelectItem value="WARNING">Solo warnings</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost" size="icon" className="h-8 w-8" title="Actualizar"
            onClick={() => qc.invalidateQueries({ queryKey: ["platform-errors"] })}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      }
    >
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 rounded-lg" />)}
          </div>
        ) : errors.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            Sin registros recientes del backend.
          </p>
        ) : (
          <div className="space-y-4 pb-6">
            {/* Qué está fallando, agrupado en palabras */}
            <Panel title="Qué está fallando" sub="agrupado por dominio">
              <div className="px-4 py-3">
                <ErrorSummary errors={errors} inline />
              </div>
            </Panel>

            {/* La lista — cada error explicado; el log crudo, plegado */}
            <Panel title="Detalle" sub="×N = veces que se repitió">
              <div className="divide-y divide-border/50">
                {errors.map((e, i) => <ErrorRow key={i} e={e} />)}
              </div>
            </Panel>
          </div>
        )}
    </SuperShell>
  );
}
