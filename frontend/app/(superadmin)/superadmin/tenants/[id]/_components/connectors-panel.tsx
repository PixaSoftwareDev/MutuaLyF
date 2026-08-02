"use client";

// Conectores del cliente: qué fuentes externas tiene enchufadas ESTE tenant,
// sus RUTAS a la vista (el superadmin aprueba con fundamento: ve exactamente
// qué endpoints van a llamarse), y el estado de aprobación de cada host de
// egress — lo no aprobado grita en ámbar. El pedido de activación pendiente
// (si lo hay) va arriba de todo. La aprobación es POR TENANT (PK tenant+host
// en public.approved_connector_hosts): aprobar o quitar acá afecta SOLO a
// esta organización — independencia de datos, este panel es el único lugar.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Plug, ShieldAlert, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill } from "@/components/ui/state-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/superadmin/panel";
import { relAge } from "@/components/superadmin/shared";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

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
    queryKey: ["approved-hosts", tenantId],
    queryFn: () => api.connectors.approvedHosts(tenantId),
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

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["approved-hosts", tenantId] });
    qc.invalidateQueries({ queryKey: ["activation-requests"] });
  };

  const approveM = useMutation({
    mutationFn: (host: string) => api.connectors.addApprovedHost(host, tenantId, "aprobado desde la ficha del cliente"),
    onSuccess: (_d, host) => {
      inv();
      toast({ title: "Host aprobado", description: `${host} quedó habilitado solo para esta organización.`, variant: "success" });
    },
    onError: () => toast({ title: "No se pudo aprobar el host", variant: "destructive" }),
  });

  // Denegar una solicitud: la marca (no la borra) para que el admin del tenant
  // vea el veredicto con su motivo en el panel — nunca un silencio.
  const [denying, setDenying] = useState<{ id: string; name: string } | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const denyM = useMutation({
    mutationFn: (connectorId: string) =>
      api.connectors.denyActivationRequest(tenantId, connectorId, denyReason.trim() || undefined),
    onSuccess: () => {
      inv();
      setDenying(null);
      toast({ title: "Solicitud denegada", description: "El admin del cliente va a ver el motivo en su panel.", variant: "success" });
    },
    onError: () => toast({ title: "No se pudo denegar", variant: "destructive" }),
  });

  // Revocación: también por tenant y también acá — quitar un host solo apaga
  // el egreso de ESTA organización, ningún otro cliente se entera.
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const removeM = useMutation({
    mutationFn: (host: string) => api.connectors.removeApprovedHost(host, tenantId),
    onSuccess: (d, host) => {
      inv();
      // El estado Activo/Inactivo vive en el overview — refrescarlo para que
      // la fila muestre el apagado sin recargar.
      qc.invalidateQueries({ queryKey: ["platform-connectors-overview"] });
      setConfirmDel(null);
      const off = d?.deactivated ?? [];
      toast({
        title: "Host quitado",
        description: off.length > 0
          ? `Se desactivó ${off.join(", ")} — usaba ese host.`
          : `${host} ya no está aprobado para esta organización.`,
        variant: "success",
      });
    },
    onError: () => toast({ title: "No se pudo quitar el host", variant: "destructive" }),
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
          <>
            <StatePill tone="success">Aprobado</StatePill>
            <button
              type="button"
              onClick={() => setConfirmDel(host)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Quitar aprobación de ${host}`}
              title="Quitar aprobación"
            >
              <X className="h-3 w-3" />
            </button>
          </>
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
        pendingHosts.size > 0 ? (
          <StatePill tone="warning">
            {pendingHosts.size === 1 ? "1 host sin aprobar" : `${pendingHosts.size} hosts sin aprobar`}
          </StatePill>
        ) : undefined
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
            const reqPending = req?.status === "pending";
            return (
            <div key={c.id} className={cn("space-y-2.5 px-4 py-3", reqPending && "border-l-2 border-warning bg-warning/[0.05]")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{c.display_name}</span>
                <StatePill tone={c.is_active ? "success" : "muted"}>{c.is_active ? "Activo" : "Inactivo"}</StatePill>
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{c.base_url}</code>
              </div>

              {reqPending && (() => {
                // Corto y al punto: qué pasó y cuándo. El quién queda en el
                // tooltip; el qué hacer ya lo gritan los chips ámbar de abajo.
                const when = req!.requested_at ? new Date(req!.requested_at!) : null;
                return (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 text-[13px]" title={req!.requested_by ? `Pedida por ${req!.requested_by}` : undefined}>
                      <ShieldAlert className="mr-1.5 inline h-3.5 w-3.5 text-warning" />
                      <span className="font-medium">Pidió activación</span>
                      {when && (
                        <span className="text-muted-foreground">
                          {" "}· {when.toLocaleDateString("es-AR", { day: "numeric", month: "short" })}
                          {" "}({relAge((Date.now() - when.getTime()) / 3_600_000)})
                        </span>
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => { setDenyReason(""); setDenying({ id: req!.connector_id, name: c.display_name }); }}
                      className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-destructive hover:underline"
                    >
                      Denegar
                    </button>
                  </div>
                );
              })()}

              {req && req.status === "denied" && (
                // El veredicto queda a la vista del super-admin también: si no,
                // "desaparece" la solicitud y parece que nunca pasó nada.
                <p className="text-[13px] text-muted-foreground"
                   title={req.resolved_at ? `Denegada ${relAge((Date.now() - new Date(req.resolved_at).getTime()) / 3_600_000)}` : undefined}>
                  <ShieldAlert className="mr-1.5 inline h-3.5 w-3.5 text-destructive/70" />
                  Denegaste su solicitud{req.denied_reason ? <> — “{req.denied_reason}”</> : ""}.
                  {" "}El admin puede corregir y volver a pedirla.
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
            La aprobación es por organización: aprobar o quitar un host acá afecta solo a este cliente.
          </p>
        </div>
      )}

      {/* Denegar solicitud — con motivo opcional que el admin va a leer */}
      <Dialog open={!!denying} onOpenChange={o => !o && setDenying(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>¿Denegar la activación de “{denying?.name}”?</DialogTitle>
            <DialogDescription>
              El admin del cliente va a ver la solicitud como denegada, con tu motivo si lo escribís.
              Puede corregir el conector y volver a pedirla.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={denyReason}
            onChange={e => setDenyReason(e.target.value)}
            placeholder="Motivo (opcional) — ej. el host no es del proveedor declarado"
            maxLength={500}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDenying(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={denyM.isPending} onClick={() => denying && denyM.mutate(denying.id)}>
              {denyM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Denegar solicitud
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmar quitar — apaga el egreso de esta organización hacia ese host */}
      <Dialog open={!!confirmDel} onOpenChange={o => !o && setConfirmDel(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>¿Quitar “{confirmDel}” de los aprobados?</DialogTitle>
            <DialogDescription>
              Los conectores <strong>activos</strong> de esta organización que apunten a este host van a
              dejar de funcionar (el sistema bloquea el egreso). Ningún otro cliente se ve afectado.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={removeM.isPending} onClick={() => confirmDel && removeM.mutate(confirmDel)}>
              {removeM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Quitar host
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
