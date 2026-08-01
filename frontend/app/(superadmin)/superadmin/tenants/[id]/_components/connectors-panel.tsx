"use client";

// Conectores del cliente: qué fuentes externas tiene enchufadas ESTE tenant y
// el estado de aprobación de cada host de egress, con el pedido de activación
// pendiente (si lo hay) arriba de todo. OJO con la semántica: la aprobación
// vive en el registro GLOBAL de la plataforma (public.approved_connector_hosts)
// — aprobar acá habilita el host para TODAS las organizaciones; por eso el
// panel lo dice y la revocación queda en la pantalla global (cross-tenant).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Loader2, Plug, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill } from "@/components/ui/state-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/superadmin/panel";
import { toast } from "@/components/ui/toast";

export function ConnectorsPanel({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();

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

  const approveM = useMutation({
    mutationFn: (host: string) => api.connectors.addApprovedHost(host, `aprobado desde la ficha de ${tenantId}`),
    onSuccess: (_d, host) => {
      qc.invalidateQueries({ queryKey: ["approved-hosts"] });
      qc.invalidateQueries({ queryKey: ["activation-requests"] });
      toast({ title: "Host aprobado", description: `${host} quedó habilitado para toda la plataforma.`, variant: "success" });
    },
    onError: () => toast({ title: "No se pudo aprobar el host", variant: "destructive" }),
  });

  const HostChip = ({ host }: { host: string }) => (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 py-1 pl-2.5 pr-1.5 text-xs">
      <code className="font-mono">{host}</code>
      {approved.has(host) ? (
        <StatePill tone="success">Aprobado</StatePill>
      ) : (
        <Button
          size="sm" variant="outline" className="h-6 px-2 text-[11px]"
          disabled={approveM.isPending}
          onClick={() => approveM.mutate(host)}
        >
          {approveM.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          Aprobar
        </Button>
      )}
    </span>
  );

  return (
    <Panel
      title="Conectores"
      sub={conns.length > 0 ? `${conns.length} ${conns.length === 1 ? "configurado" : "configurados"}` : undefined}
      action={
        <Link href="/superadmin/connector-hosts" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
          Gestión global de hosts →
        </Link>
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
          {/* Pedidos de activación pendientes de ESTE cliente — lo accionable primero. */}
          {requests.map(r => (
            <div key={r.connector_id} className="space-y-2 bg-warning/[0.05] px-4 py-3">
              <p className="text-[13px]">
                <ShieldCheck className="mr-1.5 inline h-3.5 w-3.5 text-warning" />
                <span className="font-medium">{r.connector_name}</span>
                <span className="text-muted-foreground"> — pidió activarse{r.requested_by ? ` (${r.requested_by})` : ""} y espera aprobación de hosts:</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {r.hosts.map(h => <HostChip key={h.host} host={h.host} />)}
              </div>
            </div>
          ))}

          {conns.map(c => (
            <div key={c.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{c.display_name}</span>
                <StatePill tone={c.is_active ? "success" : "muted"}>{c.is_active ? "Activo" : "Inactivo"}</StatePill>
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{c.base_url}</code>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {c.tools.length} {c.tools.length === 1 ? "operación" : "operaciones"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {c.egress_allow.length === 0
                  ? <span className="text-xs text-muted-foreground">Sin hosts declarados.</span>
                  : c.egress_allow.map(h => <HostChip key={h} host={h} />)}
              </div>
            </div>
          ))}

          <p className="px-4 py-2.5 text-[11px] leading-snug text-muted-foreground">
            La aprobación es de plataforma: habilita el host para todas las organizaciones.
            Para revocar un host usá la gestión global (impacta a todos los clientes que lo usen).
          </p>
        </div>
      )}
    </Panel>
  );
}
