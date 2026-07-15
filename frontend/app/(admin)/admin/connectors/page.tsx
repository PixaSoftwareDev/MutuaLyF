"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Plug, Loader2, Trash2, ShieldCheck, ShieldAlert, KeyRound, ChevronRight } from "lucide-react";
import { api, type ConnectorRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { FormSheet } from "@/components/layout/form-sheet";

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
  const [name, setName]             = useState("");
  const [baseUrl, setBaseUrl]       = useState("");
  const [hosts, setHosts]           = useState("");
  const [authType, setAuthType]     = useState("none");
  const [secret, setSecret]         = useState("");
  const [deleting, setDeleting]     = useState<ConnectorRow | null>(null);

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
      if (secret.trim() && authType !== "none") await api.connectors.setSecret(id, secret.trim());
      return id;
    },
    onSuccess: () => {
      inv();
      setShowCreate(false);
      setSlug(""); setName(""); setBaseUrl(""); setHosts(""); setAuthType("none"); setSecret("");
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

  const active = connectors.filter(c => c.is_active).length;

  return (
    <PageShell>
      <PageHeader
        title="Conectores"
        badge={!isLoading ? <CountChip>{connectors.length} {connectors.length === 1 ? "conector" : "conectores"} · {active} activo{active === 1 ? "" : "s"}</CountChip> : undefined}
        description={
          <>APIs de terceros que el asistente puede consultar en vivo (órdenes, cuentas, turnos).
          Configurá y <span className="font-semibold text-foreground">probá</span> libremente; activar hacia un host nuevo requiere aprobación del super-admin.</>
        }
        actions={
          <Button onClick={() => setShowCreate(true)} className="shrink-0">
            <Plus className="h-[18px] w-[18px] mr-1.5" /> Nuevo conector
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {[1, 2].map(i => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : connectors.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="Sin conectores todavía"
          description="Conectá el primer sistema externo para que el bot responda con datos en vivo."
        />
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
        </div>
      )}

      {/* Crear conector */}
      <FormSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        icon={Plug}
        title="Nuevo conector"
        description="Los datos que te pasa el proveedor del API. Todo nace inactivo: primero probás, después activás."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!slug.trim() || !name.trim() || !baseUrl.trim() || createM.isPending}
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Crear conector
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Nombre</Label>
            <Input placeholder="Ej. Proveedor de datos" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Identificador (slug)</Label>
            <Input placeholder="proveedor" value={slug} onChange={e => setSlug(e.target.value.toLowerCase())} />
            <p className="text-xs text-muted-foreground">Minúsculas, números, guiones. No se puede cambiar después.</p>
          </div>
          <div className="space-y-2">
            <Label>URL base del API</Label>
            <Input placeholder="https://api.proveedor.com.ar" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Hosts permitidos (egress)</Label>
            <Input placeholder="api.proveedor.com.ar (separados por coma)" value={hosts} onChange={e => setHosts(e.target.value)} />
            <p className="text-xs text-muted-foreground">Si lo dejás vacío, se usa el host de la URL base. Activar hacia un host nuevo requiere aprobación del super-admin.</p>
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
            <div className="space-y-2">
              <Label>Credencial</Label>
              <Input type="password" placeholder={authType === "basic" ? "contraseña" : "API key / token"} value={secret} onChange={e => setSecret(e.target.value)} />
              <p className="text-xs text-muted-foreground">Se guarda cifrada y nunca se vuelve a mostrar. Podés cargarla o cambiarla después.</p>
            </div>
          )}
        </div>
      </FormSheet>

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
