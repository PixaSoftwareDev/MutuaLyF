"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Plug, Loader2, KeyRound, Database, ArrowRight, SearchX } from "lucide-react";
import { api } from "@/lib/api";
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

const AUTH_TYPES = [
  { value: "none",    label: "Sin autenticación" },
  { value: "api_key", label: "API key" },
  { value: "bearer",  label: "Bearer token" },
  { value: "basic",   label: "Basic (usuario + contraseña)" },
];

function errDetail(e: unknown): string {
  const anyE = e as { response?: { data?: { detail?: string } } };
  return anyE?.response?.data?.detail || "Ocurrió un error";
}

// Pastilla de estado con punto — verde al estar activo (mismo lenguaje que sectores/canales).
function StatePill({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/[0.08] px-2 py-0.5 text-[11px] font-semibold text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" /> Activo
    </span>
  ) : (
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
  const [search, setSearch]         = useState("");
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
      return id;
    },
    onSuccess: () => {
      inv();
      setShowCreate(false);
      setName(""); setBaseUrl(""); setAuthType("none");
      toast({ title: "Conector creado", description: "Configurá sus operaciones y probalo antes de activar.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo crear", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
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
                      <TableCell><StatePill active={c.is_active} /></TableCell>
                      <TableCell className="text-right">
                        <ArrowRight className="inline-block h-4 w-4 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-action" />
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
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
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
              <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                La credencial ({authType === "basic" ? "usuario + contraseña" : authType === "bearer" ? "token" : "API key"}) se carga en el paso siguiente, al Configurar el conector.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!slug || !baseUrl.trim() || createM.isPending}
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Crear conector
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
