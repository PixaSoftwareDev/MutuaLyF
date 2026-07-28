"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Plug, Loader2, KeyRound, Database, ArrowRight, SearchX, Trash2 } from "lucide-react";
import { api, type ConnectorRow } from "@/lib/api";

// "hace 5 min" / "hace 2 h" / "hace 3 d" — para la línea de salud del conector.
function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "hace segundos";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}

// Salud del conector (derivada de tool_call_audit en el backend). Muestra de un
// vistazo lo que antes solo aparecía grepeando logs: upstream roto = "Fallando desde…".
function HealthLine({ health }: { health: ConnectorRow["health"] }) {
  if (!health) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" /> Sin llamadas registradas
      </span>
    );
  }
  if (health.status === "failing") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
        <span className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
        Fallando desde {timeAgo(health.failing_since ?? health.last_call_at)}
        <span className="font-normal text-muted-foreground">· {health.errors_24h} error{health.errors_24h === 1 ? "" : "es"} en 24 h</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      <span className="font-medium text-emerald-600">OK</span> · última llamada {timeAgo(health.last_call_at)}
      {health.errors_24h > 0 && <span>· {health.errors_24h} error{health.errors_24h === 1 ? "" : "es"} en 24 h</span>}
    </span>
  );
}
import { cn, toSlug } from "@/lib/utils";
import { humanizeConnectorError } from "@/lib/connector-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { useTableSort, applySort, SortHeader } from "@/components/admin/sortable";
import {
  AUTH_TYPES, CredentialFields, credentialIncomplete, credentialEmpty,
  emptyCredentialValues, buildAuthConfigPatch, type CredentialValues,
} from "@/components/admin/connector-credential-fields";

function errDetail(e: unknown): string {
  const anyE = e as { response?: { data?: { detail?: string } } };
  return anyE?.response?.data?.detail || "Ocurrió un error";
}

// Pastilla de estado con punto — verde al estar activo (mismo lenguaje que
// sectores/canales). Ámbar cuando la activación espera al super-admin.
function StatePill({ active, pending }: { active: boolean; pending?: boolean }) {
  if (active) return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/[0.08] px-2 py-0.5 text-[11px] font-semibold text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" /> Activo
    </span>
  );
  if (pending) return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/[0.08] px-2 py-0.5 text-[11px] font-semibold text-warning">
      <span className="h-1.5 w-1.5 rounded-full bg-warning" /> Esperando aprobación
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" /> Inactivo
    </span>
  );
}

type SortKey = "nombre" | "operaciones";

export default function ConnectorsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["connectors"] });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName]             = useState("");
  const [baseUrl, setBaseUrl]       = useState("");
  const [authType, setAuthType]     = useState("none");
  // Credencial inline en el alta: se carga acá mismo (opcional — si queda
  // vacía se puede cargar después desde el detalle). Campos compartidos con
  // el editor del detalle.
  const [cred, setCred]             = useState<CredentialValues>(emptyCredentialValues);
  const [search, setSearch]         = useState("");
  const [deleting, setDeleting]     = useState<ConnectorRow | null>(null);
  const { sort, toggle } = useTableSort<SortKey>({ nombre: "asc" });

  // El identificador (slug) se deriva del nombre automáticamente y no se edita a
  // mano: es un detalle interno. El host de egress se infiere de la URL base.
  const slug = toSlug(name.trim());

  const { data, isLoading } = useQuery({
    queryKey: ["connectors"],
    queryFn: api.connectors.list,
    staleTime: 15_000,
  });
  const connectors = data?.connectors ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connectors;
    return connectors.filter(c =>
      c.display_name.toLowerCase().includes(q) || c.base_url.toLowerCase().includes(q));
  }, [connectors, search]);

  const sorted = useMemo(() => applySort(filtered, sort, (a, b, key) =>
    key === "operaciones" ? a.tool_count - b.tool_count : a.display_name.localeCompare(b.display_name),
  ), [filtered, sort]);

  const createM = useMutation({
    mutationFn: async () => {
      // Egress = el host de la URL base (el único destino que promete la UI).
      const inferredHost = (() => {
        try { return new URL(baseUrl).hostname; } catch { return ""; }
      })();
      const { id } = await api.connectors.create({
        slug, display_name: name.trim(), base_url: baseUrl.trim(),
        egress_allow: inferredHost ? [inferredHost] : [], auth_type: authType,
      });
      // La credencial va aparte (el secreto tiene su propio endpoint). Si esta
      // parte falla el conector ya existe — no es un error del alta: se avisa
      // y se lleva al detalle para reintentar desde ahí.
      let credError: string | null = null;
      if (authType !== "none" && !credentialEmpty(authType, cred)) {
        try {
          const patch = buildAuthConfigPatch(authType, cred, {});
          if (patch) await api.connectors.update(id, { auth_config: patch } as never);
          if (cred.secret.trim()) await api.connectors.setSecret(id, cred.secret.trim());
        } catch (e) {
          credError = humanizeConnectorError(errDetail(e));
        }
      }
      return { id, credError };
    },
    onSuccess: ({ id, credError }) => {
      inv();
      setShowCreate(false);
      setName(""); setBaseUrl(""); setAuthType("none"); setCred(emptyCredentialValues);
      if (credError) {
        toast({ title: "Conector creado, pero la credencial no se guardó", description: credError, variant: "destructive" });
        router.push(`/admin/connectors/${id}`);
        return;
      }
      toast({ title: "Conector creado", description: "Configurá sus operaciones y probalo antes de activar.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo crear", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => api.connectors.delete(id),
    onSuccess: () => { inv(); setDeleting(null); toast({ title: "Fuente eliminada", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo eliminar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  const isEmpty = !isLoading && connectors.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar — mismo molde que Documentos / Equipo */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4 sm:px-6">
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">Fuentes de datos</h1>
        {!isEmpty && (
          <Button size="sm" className="shrink-0" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 sm:mr-1.5" />
            <span className="hidden sm:inline">Conectar una fuente</span>
            <span className="sm:hidden">Conectar</span>
          </Button>
        )}
      </div>

      {/* Contenido scrolleable */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4 sm:p-6">
        {isLoading ? (
          <Skeleton className="h-72 rounded-2xl" />
        ) : isEmpty ? (
          /* Estado inicial: hero centrado con el CTA, como Documentos */
          <div className="mx-auto w-full max-w-md text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Database className="h-6 w-6 text-muted-foreground" />
            </div>
            <h2 className="mt-4 text-lg font-semibold tracking-tight">Conectá una fuente de datos</h2>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              Enlazá un sistema externo —turnos, cuentas, órdenes— para que el asistente responda con
              datos en vivo. Primero lo probás; recién después se activa.
            </p>
            <Button className="mt-6" onClick={() => setShowCreate(true)}>
              <Plus className="mr-1.5 h-[18px] w-[18px]" /> Conectar una fuente
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <ListToolbar search={search} onSearch={setSearch} placeholder="Buscar fuente…" />

            {sorted.length === 0 ? (
              <EmptyState icon={SearchX} title="Sin resultados" description={`Ninguna fuente coincide con "${search}".`} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead><SortHeader label="Fuente" sortKey="nombre" sort={sort} onToggle={toggle} /></TableHead>
                    <TableHead className="hidden md:table-cell">Autenticación</TableHead>
                    <TableHead className="hidden w-[120px] text-right sm:table-cell">
                      <SortHeader label="Operaciones" sortKey="operaciones" sort={sort} onToggle={toggle} />
                    </TableHead>
                    <TableHead className="w-[130px]">Estado</TableHead>
                    <TableHead className="w-[40px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(c => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer group"
                      onClick={() => router.push(`/admin/connectors/${c.id}`)}
                      onMouseEnter={() => router.prefetch(`/admin/connectors/${c.id}`)}
                    >
                      <TableCell className="w-full max-w-0 py-2.5">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                            c.is_active ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>
                            <Plug className="h-[18px] w-[18px]" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-action">{c.display_name}</p>
                            <p className="truncate font-mono text-xs text-muted-foreground">{c.base_url}</p>
                            <HealthLine health={c.health} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                        <span className="inline-flex items-center gap-1">
                          <KeyRound className="h-3.5 w-3.5" />
                          {c.auth_type === "none" ? "Sin auth" : c.auth_type}
                        </span>
                        {c.has_secret && <span className="text-muted-foreground/60"> · credencial</span>}
                      </TableCell>
                      <TableCell className="hidden text-right text-sm tabular-nums text-muted-foreground sm:table-cell">{c.tool_count}</TableCell>
                      <TableCell><StatePill active={c.is_active} pending={c.pending_approval} /></TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            size="sm" variant="ghost"
                            className="h-8 w-8 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                            aria-label={`Eliminar ${c.display_name}`}
                            onClick={e => { e.stopPropagation(); setDeleting(c); }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <ArrowRight className="inline-block h-4 w-4 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-action" />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>

      {/* Crear conector — modal centrado */}
      <Dialog open={showCreate} onOpenChange={o => { setShowCreate(o); if (!o) setCred(emptyCredentialValues); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Database className="h-5 w-5" />
              </span>
              <div className="min-w-0 space-y-1 pt-0.5">
                <DialogTitle>Conectar una fuente de datos</DialogTitle>
                <DialogDescription>
                  Cargá los datos que te pasó el proveedor del API. Nace inactiva: primero probás, después activás.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* px/py 1.5 + margen negativo: da aire para el ring de foco (el
              overflow-y recorta también en horizontal) sin correr el contenido. */}
          <div className="-mx-1.5 -my-1.5 max-h-[min(60vh,32rem)] space-y-4 overflow-y-auto px-1.5 py-1.5">
            <div className="space-y-2">
              <Label>Nombre</Label>
              <Input placeholder="Ej. Proveedor de datos" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>URL base del API</Label>
              <Input placeholder="https://api.proveedor.com.ar" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
              {baseUrl.trim().length > 0 && !/^https?:\/\//i.test(baseUrl.trim()) && (
                <p className="text-[11px] leading-snug text-warning">Tiene que empezar con http:// o https:// — sin eso las llamadas al proveedor fallan.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Autenticación</Label>
              <Select value={authType} onValueChange={setAuthType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AUTH_TYPES.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {authType !== "none" && (
              <div className="space-y-3 rounded-xl bg-muted/40 p-3.5">
                <CredentialFields
                  authType={authType}
                  values={cred}
                  onChange={patch => setCred(c => ({ ...c, ...patch }))}
                />
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Si no la tenés a mano, podés dejarla vacía y cargarla después desde el conector.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setCred(emptyCredentialValues); }}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={
                !slug || !/^https?:\/\//i.test(baseUrl.trim()) || createM.isPending ||
                // Credencial a medias: o vacía del todo (se carga después) o completa.
                (authType !== "none" && !credentialEmpty(authType, cred) && credentialIncomplete(authType, cred, false))
              }
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Crear conector
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmar borrado */}
      <Dialog open={!!deleting} onOpenChange={o => !o && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>¿Eliminar “{deleting?.display_name}”?</DialogTitle>
            <DialogDescription>
              Se borran sus {deleting?.tool_count} operación(es) y su configuración. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={deleteM.isPending} onClick={() => deleting && deleteM.mutate(deleting.id)}>
              {deleteM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Eliminar fuente
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
