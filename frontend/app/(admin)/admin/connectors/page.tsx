"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Plug, Loader2, Trash2, ShieldCheck, ShieldAlert, KeyRound, ChevronRight, ChevronDown, Database } from "lucide-react";
import { api, type ConnectorRow } from "@/lib/api";
import { cn, toSlug } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

const AUTH_TYPES = [
  { value: "none",    label: "Sin autenticación" },
  { value: "api_key", label: "API key (header)" },
  { value: "bearer",  label: "Bearer token" },
  { value: "basic",   label: "Basic (usuario + contraseña)" },
];

function errDetail(e: unknown): string {
  const anyE = e as { response?: { data?: { detail?: string } } };
  return anyE?.response?.data?.detail || "Ocurrió un error";
}

export default function ConnectorsPage() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["connectors"] });

  const [showCreate, setShowCreate] = useState(false);
  const [slug, setSlug]             = useState("");
  const [slugEdited, setSlugEdited] = useState(false);   // el usuario lo tocó a mano
  const [name, setName]             = useState("");
  const [baseUrl, setBaseUrl]       = useState("");
  const [hosts, setHosts]           = useState("");
  const [authType, setAuthType]     = useState("none");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [deleting, setDeleting]     = useState<ConnectorRow | null>(null);

  // El slug se deriva del Nombre salvo que el usuario lo haya editado a mano.
  const onNameChange = (v: string) => {
    setName(v);
    if (!slugEdited) setSlug(toSlug(v));
  };

  const { data, isLoading } = useQuery({
    queryKey: ["connectors"],
    queryFn: api.connectors.list,
    staleTime: 15_000,
  });
  const connectors = data?.connectors ?? [];

  const createM = useMutation({
    mutationFn: async () => {
      const inferredHost = (() => {
        try { return new URL(baseUrl).hostname; } catch { return ""; }
      })();
      const egress = hosts.trim()
        ? hosts.split(",").map(h => h.trim()).filter(Boolean)
        : (inferredHost ? [inferredHost] : []);
      const { id } = await api.connectors.create({
        slug: slug.trim(), display_name: name.trim(), base_url: baseUrl.trim(),
        egress_allow: egress, auth_type: authType,
      });
      return id;
    },
    onSuccess: () => {
      inv();
      setShowCreate(false);
      setSlug(""); setSlugEdited(false); setName(""); setBaseUrl(""); setHosts("");
      setAuthType("none"); setShowAdvanced(false);
      toast({ title: "Conector creado", description: "Configurá sus operaciones y probalo antes de activar.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo crear", description: errDetail(e), variant: "destructive" }),
  });

  const toggleM = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.connectors.setActive(id, active),
    onSuccess: (_d, v) => { inv(); toast({ title: v.active ? "Conector activado" : "Conector desactivado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo activar", description: errDetail(e), variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => api.connectors.delete(id),
    onSuccess: () => { inv(); setDeleting(null); toast({ title: "Conector eliminado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo eliminar", description: errDetail(e), variant: "destructive" }),
  });

  return (
    <PageShell width="wide">
      {/* Mismo molde que Configuración → Canales (WhatsApp): título "Configuración"
          que cruza el ancho completo + contenido centrado a max-w-5xl. Así Fuentes
          de datos queda idéntico a las demás pestañas de esta sección. */}
      <PageHeader title="Configuración" />

      <div className="mx-auto w-full max-w-5xl">
      {isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {[1, 2].map(i => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : connectors.length === 0 ? (
        /* Estado inicial: hero centrado con el CTA en el medio (patrón WhatsApp).
           Ocupa el ancho del shell (content) para no quedar más angosto que el resto. */
        <div className="w-full">
          <Card className="rounded-2xl">
            <CardContent className="flex flex-col items-center px-6 py-14 text-center">
              {/* Ícono neutro, igual que el resto de los estados vacíos (EmptyState). */}
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Database className="h-6 w-6 text-muted-foreground" />
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
                Conectá una fuente de datos
              </h3>
              <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
                Enlazá un sistema externo —turnos, cuentas, órdenes— para que el asistente
                responda con datos en vivo. Primero lo probás; recién después se activa. Nada se conecta solo.
              </p>
              <Button className="mt-6" onClick={() => setShowCreate(true)}>
                <Plus className="mr-1.5 h-[18px] w-[18px]" /> Conectar una fuente
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {connectors.map(c => (
            <div key={c.id} className="rounded-2xl border bg-card p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={cn("h-9 w-9 rounded-xl grid place-items-center shrink-0",
                    c.is_active ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground")}>
                    <Plug className="h-[18px] w-[18px]" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{c.display_name}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{c.base_url}</p>
                  </div>
                </div>
                <Badge variant={c.is_active ? "default" : "secondary"}>
                  {c.is_active ? "Activo" : "Inactivo"}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{c.tool_count} operación{c.tool_count === 1 ? "" : "es"}</span>
                <span className="inline-flex items-center gap-1">
                  <KeyRound className="h-3 w-3" /> {c.auth_type === "none" ? "sin auth" : c.auth_type}{c.has_secret && " · credencial cargada"}
                </span>
                <span className="inline-flex items-center gap-1">
                  {c.is_active
                    ? <><ShieldCheck className="h-3 w-3 text-emerald-600" /> hosts: {c.egress_allow.join(", ") || "—"}</>
                    : <><ShieldAlert className="h-3 w-3" /> hosts: {c.egress_allow.join(", ") || "—"}</>}
                </span>
              </div>

              <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={c.is_active ? "outline" : "default"}
                    disabled={toggleM.isPending}
                    onClick={() => toggleM.mutate({ id: c.id, active: !c.is_active })}
                  >
                    {toggleM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                    {c.is_active ? "Desactivar" : "Activar"}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(c)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Button size="sm" variant="ghost" asChild>
                  <Link href={`/admin/connectors/${c.id}`}>
                    Configurar <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                  </Link>
                </Button>
              </div>
            </div>
          ))}

          {/* Agregar otra fuente — reemplaza el botón de arriba */}
          <button
            onClick={() => setShowCreate(true)}
            className="group flex min-h-[172px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-5 text-muted-foreground transition-colors hover:border-action/40 hover:bg-muted/30 hover:text-foreground"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:bg-action/10 group-hover:text-action">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-sm font-medium">Conectar otra fuente</span>
          </button>
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
              <Input placeholder="Ej. Proveedor de datos" value={name} onChange={e => onNameChange(e.target.value)} />
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

            {/* Opciones avanzadas — el identificador se autogenera del nombre y el
                egress se infiere de la URL; sólo se tocan si hace falta. */}
            <div className="border-t pt-3">
              <button
                type="button"
                onClick={() => setShowAdvanced(v => !v)}
                className="flex w-full items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={showAdvanced}
              >
                <ChevronDown className={cn("h-4 w-4 transition-transform", showAdvanced && "rotate-180")} />
                Opciones avanzadas
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-4 animate-fade-in">
                  <div className="space-y-2">
                    <Label>Identificador (slug)</Label>
                    <Input
                      placeholder="proveedor"
                      value={slug}
                      onChange={e => { setSlug(toSlug(e.target.value)); setSlugEdited(true); }}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">Se genera del nombre. Minúsculas, números y guiones. No se puede cambiar después de crear.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Hosts permitidos (egress)</Label>
                    <Input placeholder="api.proveedor.com.ar (separados por coma)" value={hosts} onChange={e => setHosts(e.target.value)} />
                    <p className="text-xs leading-relaxed text-muted-foreground">Si lo dejás vacío, se usa el host de la URL base. Activar hacia un host nuevo requiere aprobación del super-admin.</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!slug.trim() || !name.trim() || !baseUrl.trim() || createM.isPending}
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Crear conector
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmar borrado */}
      <Dialog open={!!deleting} onOpenChange={o => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Eliminar “{deleting?.display_name}”?</DialogTitle>
            <DialogDescription>
              Se borran sus {deleting?.tool_count} operación(es) y vínculos con intenciones. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={deleteM.isPending} onClick={() => deleting && deleteM.mutate(deleting.id)}>
              {deleteM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
