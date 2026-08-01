"use client";

// Conectores del cliente: qué fuentes externas tiene enchufadas ESTE tenant,
// sus RUTAS a la vista (el superadmin aprueba con fundamento: ve exactamente
// qué endpoints van a llamarse), y el estado de aprobación de cada host de
// egress — lo no aprobado grita en ámbar. El pedido de activación pendiente
// (si lo hay) va arriba de todo. OJO con la semántica: la aprobación vive en
// el registro GLOBAL de la plataforma (public.approved_connector_hosts) —
// aprobar acá habilita el host para TODAS las organizaciones; por eso el
// panel lo dice y la revocación queda en la pantalla global (cross-tenant).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronDown, Loader2, Plug, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill } from "@/components/ui/state-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/superadmin/panel";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

export function ConnectorsPanel({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  // Rutas desplegables por conector — colapsadas por defecto: el panel se lee
  // de un vistazo y el detalle se abre solo cuando hay que decidir.
  const [openRoutes, setOpenRoutes] = useState<Record<string, boolean>>({});

  const ov = useQuery({
    queryKey: ["platform-connectors-overview"],
    queryFn: api.connectors.platformOverview,
    staleTime: 30_000,
  });
  const hostsQ = useQuery({
    queryKey: ["approved-hosts"],
    queryFn: api.connectors.approvedHosts,
    staleTime: 30_000,
  });
  const reqQ = useQuery({
    queryKey: ["activation-requests"],
    queryFn: api.connectors.activationRequests,
    staleTime: 30_000,
  });

  const approved = new Set((hostsQ.data?.hosts ?? []).map(h => h.host));
  const conns = (ov.data?.connectors ?? []).filter(c => c.tenant_id === tenantId);
  const requests = (reqQ.data?.requests ?? []).filter(r => r.tenant_id === tenantId);
  const loading = ov.isLoading || hostsQ.isLoading;

  const pendingHosts = new Set<string>();
  conns.forEach(c => c.egress_allow.forEach(h => { if (!approved.has(h)) pendingHosts.add(h); }));

  const approveM = useMutation({
    mutationFn: (host: string) => api.connectors.addApprovedHost(host, `aprobado desde la ficha de ${tenantId}`),
    onSuccess: (_d, host) => {
      qc.invalidateQueries({ queryKey: ["approved-hosts"] });
      qc.invalidateQueries({ queryKey: ["activation-requests"] });
      toast({ title: "Host aprobado", description: `${host} quedó habilitado para toda la plataforma.`, variant: "success" });
    },
    onError: () => toast({ title: "No se pudo aprobar el host", variant: "destructive" }),
  });

  const HostChip = ({ host }: { host: string }) => {
    const ok = approved.has(host);
    return (
      <span className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border py-1 pl-2.5 pr-1.5 text-xs",
        ok ? "border-border/70" : "border-warning/50 bg-warning/[0.07]",
      )}>
        <code className="font-mono">{host}</code>
        {ok ? (
          <StatePill tone="success">Aprobado</StatePill>
        ) : (
          <>
            <StatePill tone="warning">Sin aprobar</StatePill>
            <Button
              size="sm" className="h-6 px-2.5 text-[11px]"
              disabled={approveM.isPending}
              onClick={() => approveM.mutate(host)}
            >
              {approveM.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Aprobar
            </Button>
          </>
        )}
      </span>
    );
  };

  return (
    <Panel
      title="Conectores"
      sub={conns.length > 0 ? `${conns.length} ${conns.length === 1 ? "configurado" : "configurados"}` : undefined}
      action={
        <span className="flex items-center gap-2">
          {pendingHosts.size > 0 && (
            <StatePill tone="warning">
              {pendingHosts.size === 1 ? "1 host sin aprobar" : `${pendingHosts.size} hosts sin aprobar`}
            </StatePill>
          )}
          <Link href="/superadmin/connector-hosts" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            Gestión global →
          </Link>
        </span>
      }
    >
      {loading ? (
        <div className="space-y-2 p-4">
          {[1, 2].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      ) : conns.length === 0 ? (
        <EmptyState icon={Plug} title="Sin conectores configurados" />
      ) : (
        <div className="divide-y divide-border/60">
          {conns.map(c => {
            // El pedido de activación se integra a la fila de SU conector —
            // un solo lugar por conector, sin repetir hosts ni botones.
            const req = requests.find(r => r.connector_id === c.id);
            return (
            <div key={c.id} className={cn("space-y-2.5 px-4 py-3", req && "border-l-2 border-warning bg-warning/[0.05]")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{c.display_name}</span>
                <StatePill tone={c.is_active ? "success" : "muted"}>{c.is_active ? "Activo" : "Inactivo"}</StatePill>
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{c.base_url}</code>
              </div>

              {req && (
                <p className="text-[13px]">
                  <ShieldAlert className="mr-1.5 inline h-3.5 w-3.5 text-warning" />
                  <span className="text-muted-foreground">
                    Pidió activarse{req.requested_by ? ` (${req.requested_by})` : ""} — espera que apruebes sus hosts.
                  </span>
                </p>
              )}

              <div className="flex flex-wrap gap-1.5">
                {c.egress_allow.length === 0
                  ? <span className="text-xs text-muted-foreground">Sin hosts declarados.</span>
                  : c.egress_allow.map(h => <HostChip key={h} host={h} />)}
              </div>

              {/* Las rutas concretas que el bot podrá llamar — la base de la
                  decisión de aprobar. Desplegable: colapsado se lee el resumen,
                  abierto se audita ruta por ruta. */}
              {c.tools.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border/60">
                  <button
                    type="button"
                    aria-expanded={!!openRoutes[c.id]}
                    onClick={() => setOpenRoutes(s => ({ ...s, [c.id]: !s[c.id] }))}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  >
                    <span className="font-medium">
                      {c.tools.length} {c.tools.length === 1 ? "ruta" : "rutas"}
                    </span>
                    <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", openRoutes[c.id] && "rotate-180")} />
                  </button>
                  {openRoutes[c.id] && c.tools.map((t, i) => (
                    <div key={`${t.http_method}-${t.path_template}-${i}`}
                         className="flex items-center gap-2 border-t border-border/50 px-2.5 py-1.5 text-xs">
                      <code className="shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">{t.http_method}</code>
                      <code className="min-w-0 truncate font-mono text-[11px]">{t.path_template}</code>
                      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">{t.display_name}</span>
                      {!t.is_active && <StatePill tone="muted">inactiva</StatePill>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            );
          })}

          <p className="px-4 py-2.5 text-[11px] leading-snug text-muted-foreground">
            La aprobación es de plataforma: habilita el host para todas las organizaciones.
            Para revocar un host usá la gestión global (impacta a todos los clientes que lo usen).
          </p>
        </div>
      )}
    </Panel>
  );
}
