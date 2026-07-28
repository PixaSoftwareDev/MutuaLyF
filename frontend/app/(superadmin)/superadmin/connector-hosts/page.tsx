"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Plus, Loader2, Trash2, SearchX, BellRing } from "lucide-react";
import { api, type ConnectorChange } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SuperShell } from "@/components/superadmin/shell";
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

// Nombres técnicos de campos → castellano, para "editó X (cambió: ...)".
const FIELD_ES: Record<string, string> = {
  display_name: "nombre", base_url: "URL base", path_template: "ruta",
  http_method: "método", params_schema: "parámetros", response_map: "mapeo de respuesta",
  identity_kind: "tipo de acceso", roles: "acceso", is_active: "estado",
  egress_allow: "hosts permitidos", auth_type: "autenticación", auth_config: "config de auth",
  timeout_ms: "timeout", description: "descripción", auth_validate_path: "ruta de validación",
};

// Acción de auditoría → oración completa y legible para el feed de cambios.
function changeLabel(c: ConnectorChange): string {
  const who = c.actor_email || "alguien";
  const what = c.resource_label ? `«${c.resource_label}»` : "";
  const fields = Array.isArray(c.detail?.fields)
    ? (c.detail.fields as string[]).map(f => FIELD_ES[f] ?? f).join(", ")
    : null;
  switch (c.action) {
    case "connector_created":        return `${who} creó el conector ${what}`;
    case "connector_updated":        return `${who} editó el conector ${what}${fields ? ` (cambió: ${fields})` : ""}`;
    case "connector_deleted":        return `${who} eliminó un conector ${what}`;
    case "connector_active_changed": return `${who} ${c.detail?.is_active ? "activó" : "desactivó"} el conector ${what}`;
    case "connector_proposal_applied": {
      const n = Array.isArray(c.detail?.tools) ? (c.detail.tools as unknown[]).length : null;
      return `${who} detectó y cargó rutas en ${what}${n != null ? ` (${n} operaciones nuevas)` : ""}`;
    }
    case "connector_tool_created":   return `${who} agregó la operación ${what}`;
    case "connector_tool_updated":   return `${who} editó la operación ${what}${fields ? ` (cambió: ${fields})` : ""}`;
    case "connector_tool_deleted":   return `${who} eliminó una operación ${what}`;
    default:                         return `${who} — ${c.action} ${what}`;
  }
}

// Acciones del feed que significan "hay rutas nuevas expuestas": alta manual de
// una operación o carga masiva vía wizard. Son las que ameritan aviso al
// super-admin — una ruta nueva puede exponer datos que no vio al aprobar el host.
const NEW_ROUTE_ACTIONS = new Set(["connector_tool_created", "connector_proposal_applied"]);

// localStorage: hasta cuándo el super-admin ya revisó las altas de rutas. Es un
// aviso operativo por navegador, no data de negocio — no amerita backend.
const ROUTES_SEEN_KEY = "sa-connector-new-routes-seen";

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
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["approved-hosts"] });
    qc.invalidateQueries({ queryKey: ["activation-requests"] });
  };

  // Solicitudes de activación pendientes: qué tenant pide activar qué conector.
  const { data: reqData } = useQuery({
    queryKey: ["activation-requests"],
    queryFn: api.connectors.activationRequests,
    staleTime: 15_000,
  });
  const requests = reqData?.requests ?? [];
  const [openRoutes, setOpenRoutes] = useState<Record<string, boolean>>({});

  // Oversight: todos los conectores de la plataforma + feed de cambios (30 días).
  const { data: ovData, isLoading: ovLoading } = useQuery({
    queryKey: ["platform-connectors-overview"],
    queryFn: api.connectors.platformOverview,
    staleTime: 30_000,
  });
  const platformConnectors = ovData?.connectors ?? [];
  const changes = ovData?.changes ?? [];

  // Aviso de rutas nuevas: altas posteriores al último "visto" del super-admin.
  // Se lee localStorage en efecto (no en el initializer) para no romper la
  // hidratación; hasta que carga, el aviso no se muestra (evita el flash).
  const [routesSeenTs, setRoutesSeenTs] = useState<string | null>(null);
  const [routesSeenLoaded, setRoutesSeenLoaded] = useState(false);
  const [showNewRoutes, setShowNewRoutes] = useState(false);
  useEffect(() => {
    setRoutesSeenTs(localStorage.getItem(ROUTES_SEEN_KEY));
    setRoutesSeenLoaded(true);
  }, []);
  const newRouteChanges = useMemo(() => {
    if (!routesSeenLoaded) return [];
    // created_at es ISO → comparar como string respeta el orden cronológico.
    return changes.filter(ch =>
      NEW_ROUTE_ACTIONS.has(ch.action) && ch.created_at &&
      (!routesSeenTs || ch.created_at > routesSeenTs));
  }, [changes, routesSeenTs, routesSeenLoaded]);
  const newRouteTenants = useMemo(
    () => [...new Set(newRouteChanges.map(ch => ch.tenant_name))],
    [newRouteChanges],
  );
  const markRoutesSeen = () => {
    const ts = newRouteChanges[0]?.created_at || new Date().toISOString();
    localStorage.setItem(ROUTES_SEEN_KEY, ts);
    setRoutesSeenTs(ts);
    setShowNewRoutes(false);
  };

  const [openConn, setOpenConn] = useState<Record<string, boolean>>({});
  const [connSearch, setConnSearch] = useState("");
  const visibleConnectors = useMemo(() => {
    const q = connSearch.trim().toLowerCase();
    if (!q) return platformConnectors;
    return platformConnectors.filter(c =>
      c.tenant_name.toLowerCase().includes(q) || c.display_name.toLowerCase().includes(q) ||
      c.base_url.toLowerCase().includes(q) ||
      c.tools.some(t => t.path_template.toLowerCase().includes(q)),
    );
  }, [platformConnectors, connSearch]);
  const approveReqM = useMutation({
    mutationFn: (h: string) => api.connectors.addApprovedHost(h),
    onSuccess: (_d, h) => { inv(); toast({ title: `Host ${h} aprobado`, variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo aprobar", description: errDetail(e), variant: "destructive" }),
  });

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
    <SuperShell
      title="Hosts aprobados"
      badge={!isLoading
        ? <span className="text-xs text-muted-foreground tabular-nums">{hosts.length} {hosts.length === 1 ? "host" : "hosts"}</span>
        : undefined}
    >
      <div className="space-y-4">
      <p className="text-xs leading-snug text-muted-foreground">
        Los servidores externos a los que se les permite llamar a los conectores. Para activar una fuente
        de datos, su host tiene que estar aprobado acá — la barrera contra destinos no autorizados.
      </p>

      {/* Aviso: se agregaron rutas nuevas desde la última revisión. Reemplaza al
          historial permanente — el aviso aparece solo cuando hay algo que mirar
          y se descarta una vez visto. */}
      {newRouteChanges.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-action/40 bg-action/[0.05] px-4 py-3">
          <BellRing className="h-4 w-4 shrink-0 text-action" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            {newRouteChanges.length === 1 ? "Se agregó una ruta nueva" : "Se agregaron rutas nuevas"} en
            conectores de <strong>{newRouteTenants.join(", ")}</strong> desde tu última revisión.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowNewRoutes(true)}>Ver</Button>
            <button
              type="button"
              onClick={markRoutesSeen}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              Descartar
            </button>
          </div>
        </div>
      )}

      {/* Solicitudes de activación pendientes */}
      {requests.length > 0 && (
        <div className="rounded-2xl border border-warning/40 bg-warning/[0.04] p-4 sm:p-5">
          <p className="mb-1 text-sm font-semibold text-foreground">
            Solicitudes de activación ({requests.length})
          </p>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Estos tenants intentaron activar un conector y el host no está aprobado.
            Revisá las rutas que expone cada uno antes de aprobar.
          </p>
          <div className="space-y-3">
            {requests.map(r => {
              const key = `${r.tenant_id}:${r.connector_id}`;
              const open = !!openRoutes[key];
              return (
                <div key={key} className="rounded-xl border bg-card p-3.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold">{r.tenant_name}</span>
                    <span className="text-sm text-muted-foreground">pide activar</span>
                    <span className="text-sm font-medium">{r.connector_name}</span>
                    <code className="truncate font-mono text-[11px] text-muted-foreground">{r.base_url}</code>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {r.requested_by || "—"}{r.requested_at ? ` · ${new Date(r.requested_at).toLocaleString("es-AR")}` : ""}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {r.hosts.map(h => (
                      <span key={h.host} className="inline-flex items-center gap-1.5">
                        <code className="rounded border bg-background px-2 py-0.5 font-mono text-xs">{h.host}</code>
                        {h.approved ? (
                          <span className="text-xs font-medium text-success">aprobado ✓</span>
                        ) : (
                          <Button size="sm" variant="outline" className="h-7"
                                  disabled={approveReqM.isPending}
                                  onClick={() => approveReqM.mutate(h.host)}>
                            {approveReqM.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                            Aprobar host
                          </Button>
                        )}
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => setOpenRoutes(s => ({ ...s, [key]: !s[key] }))}
                      className="ml-auto text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                    >
                      {open ? "Ocultar rutas" : `Ver rutas (${r.tools.length})`}
                    </button>
                  </div>
                  {open && (
                    <div className="mt-2 divide-y rounded-lg border bg-background">
                      {r.tools.map(t => (
                        <div key={t.path_template} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                          <span className="min-w-0 flex-1 truncate">{t.display_name}</span>
                          <code className="shrink-0 font-mono text-[11px] text-muted-foreground">
                            {t.http_method} {t.path_template}
                          </code>
                        </div>
                      ))}
                      {r.tools.length === 0 && (
                        <p className="px-3 py-2 text-xs text-muted-foreground">Sin operaciones cargadas todavía.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Conectores de la plataforma — oversight continuo: qué está habilitado hoy */}
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">
            Conectores de la plataforma {!ovLoading && <span className="font-normal text-muted-foreground">({platformConnectors.length})</span>}
          </p>
          <Input
            value={connSearch} onChange={e => setConnSearch(e.target.value)}
            placeholder="Buscar tenant, conector o ruta…" className="h-8 w-56 text-sm"
          />
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Todos los conectores de todos los tenants, con sus rutas a la vista. La aprobación es por
          host; esto es visibilidad continua para auditar qué puede consultar cada bot.
        </p>
        {ovLoading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : visibleConnectors.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {connSearch ? `Nada coincide con "${connSearch}".` : "Ningún tenant configuró conectores todavía."}
          </p>
        ) : (
          <div className="divide-y rounded-xl border">
            {visibleConnectors.map(c => {
              const key = `${c.tenant_id}:${c.id}`;
              const open = !!openConn[key];
              return (
                <div key={key}>
                  <button
                    type="button"
                    onClick={() => setOpenConn(s => ({ ...s, [key]: !s[key] }))}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${c.is_active ? "bg-success" : "bg-muted-foreground/40"}`}
                          title={c.is_active ? "Activo" : "Inactivo"} />
                    <span className="shrink-0 font-medium">{c.tenant_name}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{c.display_name}</span>
                    <code className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground/70 md:inline">{c.base_url}</code>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {c.tools.length} {c.tools.length === 1 ? "ruta" : "rutas"}
                    </span>
                  </button>
                  {open && (
                    <div className="divide-y border-t bg-muted/20">
                      {c.tools.map(t => (
                        <div key={t.path_template} className="flex items-center gap-2 px-3 py-1.5 pl-8 text-xs">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.is_active ? "bg-success" : "bg-muted-foreground/40"}`} />
                          <span className="min-w-0 flex-1 truncate">{t.display_name}</span>
                          <code className="shrink-0 font-mono text-[11px] text-muted-foreground">{t.http_method} {t.path_template}</code>
                        </div>
                      ))}
                      {c.tools.length === 0 && (
                        <p className="px-3 py-2 pl-8 text-xs text-muted-foreground">Sin operaciones cargadas.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

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

      {/* Detalle de rutas nuevas — cerrarlo da el aviso por visto */}
      <Dialog open={showNewRoutes} onOpenChange={o => !o && markRoutesSeen()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rutas nuevas en conectores</DialogTitle>
            <DialogDescription>
              Altas de rutas desde tu última revisión. Al cerrar, el aviso se da por visto
              y no vuelve a aparecer para estos cambios.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">
            {newRouteChanges.map((ch, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">{ch.tenant_name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">
                    {ch.created_at ? new Date(ch.created_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{changeLabel(ch)}</p>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={markRoutesSeen}>Entendido</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
      </div>
    </SuperShell>
  );
}
