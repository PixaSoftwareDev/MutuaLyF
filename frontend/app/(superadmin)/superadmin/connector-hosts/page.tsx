"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Plus, Loader2, Trash2, SearchX } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

function errDetail(e: unknown): string {
  const anyE = e as { response?: { data?: { detail?: string } } };
  return anyE?.response?.data?.detail || "Ocurrió un error";
}

export default function ConnectorHostsPage() {
  const qc = useQueryClient();
  const [host, setHost] = useState("");
  const [note, setNote] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["approved-hosts"],
    queryFn: api.connectors.approvedHosts,
    staleTime: 30_000,
  });
  const hosts = data?.hosts ?? [];
  const inv = () => qc.invalidateQueries({ queryKey: ["approved-hosts"] });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter(h =>
      h.host.toLowerCase().includes(q) || (h.note ?? "").toLowerCase().includes(q),
    );
  }, [hosts, search]);

  const addM = useMutation({
    mutationFn: () => api.connectors.addApprovedHost(host.trim().toLowerCase(), note.trim() || undefined),
    onSuccess: () => { inv(); setHost(""); setNote(""); toast({ title: "Host aprobado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo aprobar", description: errDetail(e), variant: "destructive" }),
  });

  const removeM = useMutation({
    mutationFn: (h: string) => api.connectors.removeApprovedHost(h),
    onSuccess: () => { inv(); setConfirmDel(null); toast({ title: "Host quitado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo quitar", description: errDetail(e), variant: "destructive" }),
  });

  return (
    <PageShell>
      <PageHeader
        eyebrow="Plataforma"
        title="Hosts aprobados"
        badge={!isLoading ? <CountChip>{hosts.length} {hosts.length === 1 ? "host" : "hosts"}</CountChip> : undefined}
        description="Los servidores externos a los que se les permite llamar a los conectores. Un admin arma y prueba su fuente de datos libremente, pero para activarla el host tiene que estar aprobado acá. Es la barrera que evita que la plataforma llame a destinos no autorizados."
      />

      {/* Aprobar un host */}
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <p className="mb-3 text-sm font-semibold text-foreground">Aprobar un host</p>
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label className="text-xs">Host o dominio</Label>
            <Input value={host} onChange={e => setHost(e.target.value)} placeholder="api.proveedor.com o 149.50.152.218" className="font-mono" />
          </div>
          <div className="min-w-[180px] flex-1 space-y-1.5">
            <Label className="text-xs">Nota <span className="font-normal text-muted-foreground">· opcional</span></Label>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Ej. CRM de MutuaLyF" />
          </div>
          <Button onClick={() => addM.mutate()} disabled={!host.trim() || addM.isPending} className="gap-1.5">
            {addM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Aprobar
          </Button>
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          Solo el host, sin <code className="font-mono">http://</code> ni rutas. En desarrollo los mocks internos ya están permitidos.
        </p>
      </div>

      {/* Lista */}
      {isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : hosts.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Sin hosts aprobados"
          description="Aprobá un host para que los admins puedan activar sus conectores hacia ese servicio."
          className="rounded-2xl border bg-card"
        />
      ) : (
        <div className="space-y-4">
          <ListToolbar search={search} onSearch={setSearch} placeholder="Buscar host o nota…" />

          {visible.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="Sin resultados"
              description={`Ningún host coincide con "${search}".`}
            />
          ) : (
            <div className="overflow-hidden rounded-2xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Host</TableHead>
                    <TableHead>Nota</TableHead>
                    <TableHead className="hidden md:table-cell">Aprobado por</TableHead>
                    <TableHead className="hidden whitespace-nowrap sm:table-cell">Fecha</TableHead>
                    <TableHead className="w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map(h => (
                    <TableRow key={h.host}>
                      <TableCell className="font-mono text-sm text-foreground">{h.host}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{h.note || "—"}</TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{h.approved_by || "—"}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground sm:table-cell">
                        {h.created_at
                          ? new Date(h.created_at).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" })
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setConfirmDel(h.host)}
                          aria-label={`Quitar ${h.host}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* Confirmar quitar */}
      <Dialog open={!!confirmDel} onOpenChange={o => !o && setConfirmDel(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>¿Quitar “{confirmDel}” de los aprobados?</DialogTitle>
            <DialogDescription>
              Los conectores <strong>activos</strong> que apunten a este host van a dejar de funcionar (el sistema bloquea el egreso). El admin va a tener que pedir la aprobación de nuevo para reactivarlos.
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
    </PageShell>
  );
}
