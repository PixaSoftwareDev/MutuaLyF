"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Trash2, FlaskConical, ChevronDown, CheckCircle2, XCircle,
  Globe, Lock, Link2, Wand2, FileUp, Database, Pencil, Plus, MoreVertical,
} from "lucide-react";
import { api, type ConnectorTool, type ConnectorTestResult, type DiscoveryProposal } from "@/lib/api";
import { cn, toSlug } from "@/lib/utils";
import { humanizeConnectorError, explainHttpStatus } from "@/lib/connector-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { DetailShell, BackLink } from "@/components/admin/detail-shell";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

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

function parseJson(s: string): Record<string, unknown> | null {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// Pastilla de estado con punto (mismo lenguaje que los canales).
function StatePill({ active }: { active: boolean }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
      active ? "border-success/30 bg-success/[0.08] text-success" : "border-border bg-muted/50 text-muted-foreground",
    )}>
      <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-success" : "bg-muted-foreground/40")} />
      {active ? "Activo" : "Inactivo"}
    </span>
  );
}

// Campo de configuración: etiqueta chica arriba, valor abajo. En grilla llena
// el ancho sin dejar huecos (mejor que label-izq / valor-der a lo ancho).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

// ── Propuesta de discovery: pill de estado + fila de una operación ────────────
type PropRoute = {
  path: string; path_template?: string | null; http_method?: string;
  display_name: string; include: boolean; discard_reason?: string;
  identity_kind?: string; is_lookup?: boolean;
  test?: { ok?: boolean; status?: number | string | null; latency_ms?: number; error?: string } | null;
};

function RouteStatus({ test }: { test?: PropRoute["test"] }) {
  if (!test) return <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">sin probar</span>;
  if (test.ok) return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
      <CheckCircle2 className="h-3 w-3" /> Anda
    </span>
  );
  // Razón en criollo ("no existe", "credencial") en vez del código pelado; el
  // status/error crudo queda en el tooltip para el que quiera el detalle.
  const ex = explainHttpStatus(test.status);
  const label = ex?.label ?? (test.error ? "revisar" : "revisar");
  return (
    <span
      title={ex?.hint ?? ([test.status, test.error].filter(Boolean).join(" ") || undefined)}
      className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning"
    >
      <XCircle className="h-3 w-3" /> Revisar · {label}
    </span>
  );
}

function RouteRow({ r, checked, onCheck, access, onToggleAccess, discarded }: {
  r: PropRoute; checked: boolean; onCheck: (v: boolean) => void;
  access: string; onToggleAccess: () => void; discarded?: boolean;
}) {
  const isPublic = access === "publico";
  return (
    <div className="flex items-start gap-3 py-2.5">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
        checked={checked}
        disabled={!r.path_template}
        onChange={e => onCheck(e.target.checked)}
        aria-label={`Incluir ${r.display_name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{r.display_name}</span>
          {r.is_lookup ? (
            <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">perfil (para el código)</span>
          ) : (
            <button
              type="button"
              onClick={onToggleAccess}
              title="Cambiá quién puede consultarla (Público = cualquiera · Personal = pide identificarse)"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                isPublic ? "border-border bg-muted/60 text-muted-foreground hover:bg-muted"
                         : "border-warning/30 bg-warning/[0.08] text-warning hover:bg-warning/15",
              )}
            >
              {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isPublic ? "Público" : "Personal"}
            </button>
          )}
          {!discarded && <RouteStatus test={r.test} />}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
          <span className="font-mono">{r.http_method ?? "GET"} {r.path_template ?? r.path}</span>
          {discarded && r.discard_reason ? <> · {r.discard_reason}</> : null}
        </p>
      </div>
    </div>
  );
}

// ── Usuarios autorizados (modo lista propia / platform_registry) ──────────────
function ConnectorUsersManager({ connectorId, idLabel = "documento" }: { connectorId: string; idLabel?: string }) {
  const qc = useQueryClient();
  const docLabel = idLabel.charAt(0).toUpperCase() + idLabel.slice(1);
  const [doc, setDoc]       = useState("");
  const [email, setEmail]   = useState("");
  const [nombre, setNombre] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["connector-users", connectorId],
    queryFn: () => api.connectors.listConnectorUsers(connectorId),
    staleTime: 15_000,
  });
  const users = data?.users ?? [];
  const inv = () => qc.invalidateQueries({ queryKey: ["connector-users", connectorId] });

  const addM = useMutation({
    mutationFn: () => api.connectors.createConnectorUser(connectorId, { documento: doc.trim(), email: email.trim(), nombre: nombre.trim() }),
    onSuccess: () => { inv(); setDoc(""); setEmail(""); setNombre(""); toast({ title: "Usuario agregado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo agregar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });
  const delM = useMutation({
    mutationFn: (uid: string) => api.connectors.deleteConnectorUser(uid),
    onSuccess: () => { inv(); toast({ title: "Usuario quitado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo quitar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  const canAdd = doc.trim().length >= 3 && /.+@.+\..+/.test(email.trim()) && nombre.trim().length >= 2;

  return (
    <div className="space-y-3 rounded-xl bg-muted/40 p-3.5">
      <div>
        <Label className="text-xs">Personas autorizadas</Label>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          Quiénes pueden consultar sus datos. En el chat se identifican con su {idLabel} y reciben el código en el email que cargues acá.
        </p>
      </div>

      {/* Agregar */}
      <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_1.4fr_auto]">
        <Input placeholder={docLabel} value={doc} onChange={e => setDoc(e.target.value)} className="h-9 font-mono" />
        <Input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} className="h-9" />
        <Input placeholder="Nombre" value={nombre} onChange={e => setNombre(e.target.value)} className="h-9" />
        <Button size="sm" className="h-9 gap-1.5" disabled={!canAdd || addM.isPending} onClick={() => addM.mutate()}>
          {addM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Agregar
        </Button>
      </div>

      {/* Lista */}
      {isLoading ? (
        <Skeleton className="h-14 rounded-lg" />
      ) : users.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">Todavía no cargaste usuarios autorizados.</p>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {users.map(u => (
            <div key={u.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {u.nombre} <span className="font-mono text-xs font-normal text-muted-foreground">· {u.documento}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">{u.email}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive"
                disabled={delM.isPending} onClick={() => delM.mutate(u.id)} aria-label={`Quitar ${u.nombre}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ConnectorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["connector", id] });
  const invAll = () => { inv(); qc.invalidateQueries({ queryKey: ["connectors"] }); };

  const { data: conn, isLoading } = useQuery({
    queryKey: ["connector", id],
    queryFn: () => api.connectors.get(id),
  });

  // ── editar conector (nombre / URL base / tipo de auth) ─────────────────────
  const [showEdit, setShowEdit]   = useState(false);
  const [eName, setEName]         = useState("");
  const [eBaseUrl, setEBaseUrl]   = useState("");
  const [eAuth, setEAuth]         = useState("none");
  const openEdit = () => {
    if (!conn) return;
    setEName(conn.display_name); setEBaseUrl(conn.base_url); setEAuth(conn.auth_type);
    setShowEdit(true);
  };
  const updateM = useMutation({
    mutationFn: () => api.connectors.update(id, {
      display_name: eName.trim(), base_url: eBaseUrl.trim(), auth_type: eAuth,
    } as never),
    onSuccess: () => {
      invAll(); setShowEdit(false);
      toast({ title: "Conector actualizado", description: "Si cambiaste la autenticación, revisá la credencial.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo actualizar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // ── credencial (write-only) ────────────────────────────────────────────────
  // Basic auth: el USUARIO va en auth_config (no es secreto) y la CONTRASEÑA es
  // el secreto cifrado. Por eso el guardado hace dos cosas cuando es basic.
  const [showCred, setShowCred] = useState(false);
  const [secret, setSecret] = useState("");
  const [basicUser, setBasicUser] = useState<string | null>(null);
  const saveCredM = useMutation({
    mutationFn: async () => {
      if (conn?.auth_type === "basic") {
        const username = (basicUser ?? String((conn?.auth_config as Record<string, unknown>)?.username ?? "")).trim();
        await api.connectors.update(id, { auth_config: { ...(conn?.auth_config ?? {}), username } } as never);
      }
      if (secret.trim()) await api.connectors.setSecret(id, secret.trim());
    },
    onSuccess: () => {
      invAll(); setSecret(""); setBasicUser(null); setShowCred(false);
      toast({ title: "Credencial guardada (cifrada)", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo guardar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // ── validación de identidad (quién valida el 2º factor) ───────────────────
  // El identificador (identity_label) NO se edita acá: lo detecta el discovery al
  // aplicar las operaciones (nombre + formato desde el parámetro real del proveedor).
  const [idVal, setIdVal]           = useState<string | null>(null);
  const [lookupPath, setLookupPath] = useState<string | null>(null);
  const idValM = useMutation({
    mutationFn: (vars: { flow: string; lookup: string }) =>
      api.connectors.update(id, {
        auth_config: {
          ...(conn?.auth_config ?? {}),
          identity_validation: vars.flow,
          identity_lookup_path: vars.lookup,
        },
      } as never),
    onSuccess: () => {
      invAll(); setIdVal(null); setLookupPath(null);
      toast({ title: "Validación de identidad guardada", description: "El conector quedó inactivo por el cambio de config — reactivalo cuando quieras.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo guardar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  const toggleM = useMutation({
    mutationFn: (active: boolean) => api.connectors.setActive(id, active),
    onSuccess: (_d, active) => { invAll(); toast({ title: active ? "Conector activado" : "Conector desactivado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo activar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // ── wizard: detección automática de operaciones ────────────────────────────
  const [showWizard, setShowWizard]   = useState(false);
  const [dragOver, setDragOver]       = useState(false);
  const [proposal, setProposal]       = useState<DiscoveryProposal | null>(null);
  const [selected, setSelected]       = useState<Record<string, boolean>>({});
  // Override del acceso (público/personal) por ruta: la IA lo propone pero el
  // admin puede corregirlo antes de crear (clave = path).
  const [routeKind, setRouteKind]     = useState<Record<string, string>>({});
  const [showDiscarded, setShowDiscarded] = useState(false);
  // Por defecto TODO nace personal (privado): más seguro. El admin marca públicas
  // solo las que decida exponer sin identificación.
  const accessOf = (r: { path: string; identity_kind?: string }) =>
    routeKind[r.path] ?? "personal";
  // Cuenta lo tildado (las descartadas por la IA también se pueden re-incluir).
  // El perfil (is_lookup) se cuenta aparte: no se crea como operación de chat,
  // se convierte en la config del OTP — el botón lo dice para que el número cierre.
  const selectedRoutes = (proposal?.routes ?? []).filter(r => selected[r.path] && r.path_template);
  const selectedCount  = selectedRoutes.filter(r => !r.is_lookup).length;
  const lookupSelected = selectedRoutes.some(r => r.is_lookup);

  const acceptProposal = (p: DiscoveryProposal) => {
    setProposal(p);
    const sel: Record<string, boolean> = {};
    p.routes.forEach(r => { if (r.include) sel[r.path] = true; });
    setSelected(sel);
  };

  const discoverM = useMutation({
    mutationFn: () => api.connectors.discover(id, ""),
    onSuccess: acceptProposal,
    onError: (e) => toast({ title: "No pude analizar el API", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // Alternativa sin OpenAPI: el admin sube la doc del proveedor (PDF/Word/TXT/JSON)
  // y el backend extrae las rutas con IA. Desemboca en la MISMA propuesta.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const discoverFileM = useMutation({
    mutationFn: (file: File) => api.connectors.discoverFromFile(id, file, ""),
    onSuccess: acceptProposal,
    onError: (e) => toast({ title: "No pude interpretar el archivo", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });
  const wizBusy = discoverM.isPending || discoverFileM.isPending;

  const applyM = useMutation({
    mutationFn: () => api.connectors.apply(id, selectedRoutes.map(r => ({
      ...r, identity_kind: accessOf(r),
    }))),
    onSuccess: (d) => {
      invAll(); setShowWizard(false); setProposal(null);
      toast({
        title: `${d.created.length} ${d.created.length === 1 ? "operación creada" : "operaciones creadas"}`,
        description: d.identity_lookup_path ? "Validación por código (OTP propio) configurada automáticamente." : undefined,
        variant: "success",
      });
    },
    onError: (e) => toast({ title: "No se pudo crear", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const deleteToolM = useMutation({
    mutationFn: (toolId: string) => api.connectors.deleteTool(toolId),
    onSuccess: () => { inv(); toast({ title: "Operación eliminada", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo eliminar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });


  // Alta manual de una operación (además de la detección automática).
  const [showManual, setShowManual] = useState(false);
  const [mName, setMName]     = useState("");
  const [mMethod, setMMethod] = useState("GET");
  const [mPath, setMPath]     = useState("");
  const [mAccess, setMAccess] = useState("personal");
  const mSlug = toSlug(mName.trim());
  const mNeedsIdentity = mAccess === "personal" && !mPath.includes("{identity}");
  const createToolM = useMutation({
    mutationFn: () => api.connectors.createTool(id, {
      slug: mSlug, display_name: mName.trim(), http_method: mMethod, path_template: mPath.trim(),
      identity_kind: mAccess, is_read_only: true,
      roles: mAccess === "publico" ? ["publico"] : [mAccess],
    }),
    onSuccess: () => {
      inv(); setShowManual(false);
      setMName(""); setMMethod("GET"); setMPath(""); setMAccess("personal");
      toast({ title: "Operación creada", description: "Probala y activala cuando esté lista.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo crear", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  if (isLoading || !conn) {
    return (
      <DetailShell leading={<BackLink href="/admin/connectors" label="Volver a Fuentes de datos" />} title="Fuente de datos">
        <div className="space-y-4">
          <Skeleton className="h-52 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </DetailShell>
    );
  }

  const needsAuth = conn.auth_type !== "none";
  const isBasic   = conn.auth_type === "basic";
  const authLabel =
    conn.auth_type === "api_key" ? "API key" :
    conn.auth_type === "bearer"  ? "Bearer token" :
    isBasic                      ? "Usuario + contraseña" : "Sin autenticación";
  // Basic: el usuario vive en auth_config; la contraseña es el secreto.
  const currentUser = String((conn.auth_config as Record<string, unknown>)?.username ?? "");
  const userVal     = basicUser ?? currentUser;
  const credLabel   = isBasic ? "Contraseña" : conn.auth_type === "bearer" ? "Bearer token" : "API key";
  const credDisabled = saveCredM.isPending ||
    (isBasic ? (!userVal.trim() || (!conn.has_secret && !secret.trim())) : !secret.trim());
  const hosts = conn.egress_allow?.join(", ") || "—";

  return (
    <DetailShell
      leading={<BackLink href="/admin/connectors" label="Volver a Fuentes de datos" />}
      title={conn.display_name}
      actions={
        <div className="flex shrink-0 items-center gap-2">
          <StatePill active={conn.is_active} />
          <Button size="sm" variant="ghost" onClick={openEdit} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" /> Editar
          </Button>
          <Button
            size="sm"
            variant={conn.is_active ? "outline" : "default"}
            disabled={toggleM.isPending || (!conn.is_active && conn.tools.length === 0)}
            onClick={() => toggleM.mutate(!conn.is_active)}
            title={!conn.is_active && conn.tools.length === 0 ? "Necesitás al menos una operación para activar" : undefined}
          >
            {toggleM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {conn.is_active ? "Desactivar" : "Activar"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">

        {/* ── Configuración ── */}
        <Card className="rounded-2xl">
          <CardContent className="p-5 sm:p-6">
            {/* Configuración — grilla compacta */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Field label="URL base">
                <span className="break-all font-mono text-xs">{conn.base_url}</span>
              </Field>
              <Field label="Autenticación">{authLabel}</Field>
              {needsAuth && (
                <Field label={isBasic ? "Usuario y contraseña" : "Credencial"}>
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {isBasic && currentUser && (
                      <span className="font-mono text-xs text-foreground">{currentUser} ·</span>
                    )}
                    {conn.has_secret
                      ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {isBasic ? "contraseña ok" : "Cargada"}</span>
                      : <span className="text-muted-foreground">{isBasic ? "sin contraseña" : "Sin cargar"}</span>}
                    <button
                      onClick={() => setShowCred(v => !v)}
                      className="text-xs font-medium text-action transition-colors hover:underline"
                    >
                      {showCred ? "Cancelar" : conn.has_secret ? "Cambiar" : "Cargar"}
                    </button>
                  </span>
                </Field>
              )}
              <Field label="Hosts permitidos">
                <span className="break-all font-mono text-xs">{hosts}</span>
              </Field>
            </div>

            {/* Editor de credencial — aparece inline al tocar Cargar/Cambiar.
                Basic pide Usuario (auth_config) + Contraseña (secreto). */}
            {needsAuth && showCred && (
              <div className="mt-3 space-y-3 rounded-xl bg-muted/40 p-3.5 animate-fade-in">
                {isBasic && (
                  <div className="max-w-sm space-y-1.5">
                    <Label className="text-xs">Usuario</Label>
                    <Input
                      autoFocus
                      placeholder="usuario del proveedor"
                      value={userVal}
                      onChange={e => setBasicUser(e.target.value)}
                    />
                  </div>
                )}
                <div className="max-w-sm space-y-1.5">
                  <Label className="text-xs">{credLabel}</Label>
                  <Input
                    type="password"
                    autoFocus={!isBasic}
                    placeholder={conn.has_secret ? "•••••••• (reemplazar)" : credLabel.toLowerCase()}
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">Se guarda cifrada y nunca se vuelve a mostrar.</p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setShowCred(false); setSecret(""); setBasicUser(null); }}>Cancelar</Button>
                  <Button size="sm" disabled={credDisabled} onClick={() => saveCredM.mutate()}>
                    {saveCredM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                    Guardar
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Operaciones (una sola card) ── */}
        <Card className="rounded-2xl">
          <CardContent className="p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-foreground">
                Operaciones <span className="font-normal text-muted-foreground">({conn.tools.length})</span>
              </h2>
              {conn.tools.length > 0 && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setShowManual(true)}>Carga manual</Button>
                  <Button size="sm" variant="outline" onClick={() => setShowWizard(true)}>Detectar</Button>
                </div>
              )}
            </div>

            {/* Wizard de detección — en modal centrado */}
            <Dialog open={showWizard} onOpenChange={setShowWizard}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <div className="flex items-start gap-3 text-left">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      <Link2 className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 space-y-1 pt-0.5">
                      <DialogTitle>Detectar operaciones</DialogTitle>
                      <DialogDescription className="sr-only">Subí la documentación del proveedor para detectar sus operaciones.</DialogDescription>
                    </div>
                  </div>
                </DialogHeader>

                <div className="-mx-1.5 max-h-[min(70vh,42rem)] space-y-4 overflow-y-auto px-1.5 py-1">
                  {/* Dropzone: subir o arrastrar la documentación */}
                  <div
                    onClick={() => !wizBusy && fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f && !wizBusy) discoverFileM.mutate(f); }}
                    className={cn(
                      "flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
                      wizBusy ? "cursor-default opacity-70" : dragOver ? "border-action bg-action/5" : "border-border hover:border-action/40 hover:bg-muted/30",
                    )}
                  >
                    {discoverFileM.isPending ? (
                      <>
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Leyendo la documentación…</p>
                      </>
                    ) : (
                      <>
                        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                          <FileUp className="h-5 w-5 text-muted-foreground" />
                        </span>
                        <p className="text-sm font-medium text-foreground">Arrastrá o subí la documentación</p>
                        <p className="text-xs text-muted-foreground">PDF, Word, TXT, MD o JSON</p>
                      </>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt,.md,.json,.html"
                      className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (f) discoverFileM.mutate(f);
                        e.target.value = "";
                      }}
                    />
                  </div>

                  {/* Alternativa discreta: catálogo OpenAPI en vivo */}
                  <div className="text-center">
                    <button
                      type="button"
                      disabled={wizBusy}
                      onClick={() => discoverM.mutate()}
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                    >
                      {discoverM.isPending ? "Analizando el catálogo…" : "¿El proveedor publica su catálogo (OpenAPI)? Detectar del servidor"}
                    </button>
                  </div>

                {proposal && !proposal.spec_found && (
                  <p className="text-sm text-destructive">{proposal.hint}</p>
                )}

                {proposal?.spec_found && (() => {
                  const routes = (proposal.routes ?? []) as PropRoute[];
                  const gReady = routes.filter(r => r.include && (!r.test || r.test.ok));
                  const gWarn  = routes.filter(r => r.include && r.test && !r.test.ok);
                  const gDisc  = routes.filter(r => !r.include);
                  const toggleKind = (r: PropRoute) =>
                    setRouteKind(k => ({ ...k, [r.path]: accessOf(r) === "publico" ? "personal" : "publico" }));
                  const rowProps = (r: PropRoute) => ({
                    r, checked: !!selected[r.path],
                    onCheck: (v: boolean) => setSelected(s => ({ ...s, [r.path]: v })),
                    access: accessOf(r), onToggleAccess: () => toggleKind(r),
                  });
                  const Group = ({ list, discarded }: { list: PropRoute[]; discarded?: boolean }) => (
                    <div className="divide-y rounded-lg border">
                      {list.map(r => <div key={r.path} className="px-3"><RouteRow {...rowProps(r)} discarded={discarded} /></div>)}
                    </div>
                  );
                  return (
                    <div className="space-y-4">
                      {/* Resumen + acciones rápidas */}
                      <div className="rounded-xl border bg-card p-3.5">
                        <p className="text-sm leading-relaxed text-foreground">
                          Detectamos <strong>{routes.length}</strong> operaciones:{" "}
                          <span className="font-medium text-success">{gReady.length} listas</span> ·{" "}
                          <span className="font-medium text-warning">{gWarn.length} con avisos</span> ·{" "}
                          <span className="text-muted-foreground">{gDisc.length} descartadas</span>. Tildá las que quieras usar y confirmá.
                        </p>
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => setSelected(s => {
                            const n = { ...s }; gReady.forEach(r => { if (r.path_template) n[r.path] = true; }); return n;
                          })}>Seleccionar las que andan</Button>
                          <Button size="sm" variant="ghost" onClick={() => setSelected({})}>Ninguna</Button>
                        </div>
                        <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground/50">fuente: {proposal.spec_url}</p>
                      </div>

                      {gReady.length > 0 && (
                        <div>
                          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Listas para usar ({gReady.length})
                          </p>
                          <Group list={gReady} />
                        </div>
                      )}

                      {gWarn.length > 0 && (
                        <div>
                          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-warning">
                            <XCircle className="h-3.5 w-3.5" /> Necesitan un vistazo ({gWarn.length})
                          </p>
                          <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">
                            Fallaron al probarlas: puede que pidan un dato obligatorio, o que probamos con un id de ejemplo que no existe.
                            Igual podés incluirlas — en uso real el bot usa datos válidos.
                          </p>
                          <Group list={gWarn} />
                        </div>
                      )}

                      {gDisc.length > 0 && (
                        <div>
                          <button
                            type="button"
                            onClick={() => setShowDiscarded(v => !v)}
                            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showDiscarded && "rotate-180")} />
                            Descartadas por la IA ({gDisc.length})
                          </button>
                          {showDiscarded && <div className="mt-1.5"><Group list={gDisc} discarded /></div>}
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-3 border-t pt-3">
                        {lookupSelected && (
                          <span className="text-xs text-muted-foreground">el perfil no cuenta como operación: configura la verificación por código (OTP)</span>
                        )}
                        <Button disabled={applyM.isPending || selectedRoutes.length === 0} onClick={() => applyM.mutate()}>
                          {applyM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                          Crear {selectedCount} {selectedCount === 1 ? "operación" : "operaciones"}{lookupSelected ? " + OTP" : ""}
                        </Button>
                      </div>
                    </div>
                  );
                })()}
                </div>
              </DialogContent>
            </Dialog>

            {/* Lista de operaciones — filas divididas, no una card por item */}
            {conn.tools.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <Link2 className="h-4 w-4 text-muted-foreground" />
                </span>
                <p className="text-sm font-medium text-foreground/80">Todavía no hay operaciones</p>
                <Button size="sm" className="mt-2" onClick={() => setShowWizard(true)}>Detectar automáticamente</Button>
                <button type="button" onClick={() => setShowManual(true)}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline">
                  o cargala manualmente
                </button>
              </div>
            ) : (
              <div className="mt-4 divide-y border-t">
                {conn.tools.map(tool => (
                  <ToolCard key={tool.id} connectorId={id} tool={tool}
                    onDelete={() => deleteToolM.mutate(tool.id)} onChanged={inv} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Ajustes avanzados — validación de identidad (disclosure plano) ── */}
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setAdvancedOpen(v => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={advancedOpen}
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
            Ajustes avanzados
          </button>

          {advancedOpen && (
            <div className="mt-4 animate-fade-in">
              {(() => {
                const currentFlow = String((conn.auth_config as Record<string, unknown>)?.identity_validation ?? "provider");
                const currentLookup = String((conn.auth_config as Record<string, unknown>)?.identity_lookup_path ?? "/afiliados/{identity}");
                const flow = idVal ?? currentFlow;
                const lookup = lookupPath ?? currentLookup;
                // Identificador detectado por el discovery (read-only): nombre real del
                // parámetro del proveedor, ya humanizado. Sin operaciones aún → sin dato.
                const detectedLabel = String((conn.auth_config as Record<string, unknown>)?.identity_label ?? "").trim();
                const idLabel = detectedLabel || "documento";
                const dirty = flow !== currentFlow || (flow === "platform_otp" && lookup !== currentLookup);
                return (
                  <Card className="rounded-2xl">
                    <CardContent className="p-5 sm:p-6">
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                          <Lock className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-foreground">Validación de identidad</h3>
                          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                            Solo para datos personales: quién valida el código cuando alguien consulta sus propios datos.
                          </p>
                        </div>
                      </div>

                      <div className="mt-5 space-y-4">
                        {/* 1 · Quién valida — la decisión principal */}
                        <div className="space-y-1.5">
                          <Label className="text-xs">¿Quién valida que sea esa persona?</Label>
                          <div className="w-full sm:max-w-sm">
                            <Select value={flow} onValueChange={setIdVal}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="provider">El proveedor lo valida</SelectItem>
                                <SelectItem value="platform_otp">La plataforma — email leído del proveedor</SelectItem>
                                <SelectItem value="platform_registry">La plataforma — lista propia que vos cargás</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="max-w-2xl text-[11px] leading-snug text-muted-foreground">
                            {flow === "platform_otp"
                              ? `La plataforma lee el email de la persona desde el proveedor (con su ${idLabel}), le envía un código de 6 dígitos y lo valida.`
                              : flow === "platform_registry"
                              ? `Cargás abajo quiénes pueden consultar. Al identificarse con su ${idLabel}, reciben un código en el email que les asignes y acceden a sus datos.`
                              : `El backend le pasa el ${idLabel} + el código al endpoint de validación del proveedor.`}
                          </p>
                        </div>

                        {/* 2a · Ruta del perfil (solo OTP leído del proveedor) */}
                        {flow === "platform_otp" && (
                          <div className="space-y-1.5">
                            <Label className="text-xs">Ruta del perfil de la persona</Label>
                            <Input className="w-full font-mono sm:max-w-md" value={lookup} onChange={e => setLookupPath(e.target.value)} />
                            <p className="text-[11px] leading-snug text-muted-foreground">De dónde leemos su email para enviarle el código.</p>
                          </div>
                        )}

                        {/* 2b · Lista de personas autorizadas (solo lista propia) */}
                        {flow === "platform_registry" && <ConnectorUsersManager connectorId={id} idLabel={idLabel} />}

                        {/* 3 · Identificador — detectado automáticamente, read-only */}
                        <div className="border-t pt-4">
                          {detectedLabel ? (
                            <p className="text-[11px] leading-snug text-muted-foreground">
                              En el chat el bot lo pide como <span className="font-medium text-foreground">{idLabel}</span>, detectado automáticamente del parámetro que usa el proveedor. No hay que configurarlo.
                            </p>
                          ) : (
                            <p className="text-[11px] leading-snug text-muted-foreground">
                              El dato con que se identifica la persona se detecta solo al crear las operaciones personales. No hay que configurarlo.
                            </p>
                          )}
                        </div>

                        {dirty && (
                          <Button size="sm" disabled={idValM.isPending} onClick={() => idValM.mutate({ flow, lookup })}>
                            {idValM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                            Guardar
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Editar conector — modal centrado (mismo formato que "Conectar una fuente") */}
      <Dialog open={showEdit} onOpenChange={(v) => !v && setShowEdit(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Database className="h-5 w-5" />
              </span>
              <div className="min-w-0 space-y-1 pt-0.5">
                <DialogTitle>Editar conector</DialogTitle>
                <DialogDescription>Cambiá el nombre, la URL base o el tipo de autenticación.</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Nombre</Label>
              <Input value={eName} onChange={e => setEName(e.target.value)} placeholder="Ej. CRM Pixs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">URL base del API</Label>
              <Input className="font-mono" value={eBaseUrl} onChange={e => setEBaseUrl(e.target.value)} placeholder="https://api.proveedor.com" />
              <p className="text-[11px] leading-snug text-muted-foreground">
                Sin barra final. Si las rutas del proveedor ya empiezan con /api, no lo repitas acá.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Autenticación</Label>
              <Select value={eAuth} onValueChange={setEAuth}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AUTH_TYPES.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {eAuth !== conn.auth_type && eAuth !== "none" && (
                <p className="text-[11px] leading-snug text-warning">
                  Cambiaste el tipo de auth: después vas a tener que cargar la credencial ({eAuth === "basic" ? "usuario + contraseña" : eAuth === "bearer" ? "token" : "API key"}) en la fila Credencial.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>Cancelar</Button>
            <Button disabled={!eName.trim() || !eBaseUrl.trim() || updateM.isPending} onClick={() => updateM.mutate()}>
              {updateM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Guardar cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Agregar operación a mano — además de la detección automática */}
      <Dialog open={showManual} onOpenChange={setShowManual}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Plus className="h-5 w-5" />
              </span>
              <div className="min-w-0 space-y-1 pt-0.5">
                <DialogTitle>Agregar operación manual</DialogTitle>
                <DialogDescription>Definí un endpoint del proveedor sin pasar por la detección automática.</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Nombre</Label>
              <Input value={mName} onChange={e => setMName(e.target.value)} placeholder="Ej. Pedidos del cliente" />
            </div>
            <div className="grid grid-cols-[110px_1fr] gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Método</Label>
                <Select value={mMethod} onValueChange={setMMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Ruta</Label>
                <Input className="font-mono" value={mPath} onChange={e => setMPath(e.target.value)} placeholder="/clientes/{identity}/pedidos" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Acceso</Label>
              <Select value={mAccess} onValueChange={setMAccess}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="publico">Público — cualquiera puede consultarla</SelectItem>
                  <SelectItem value="personal">Personal — pide identificarse</SelectItem>
                </SelectContent>
              </Select>
              {mAccess === "personal" ? (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Usá <code className="font-mono">{"{identity}"}</code> en la ruta donde va el dato de la persona (se reemplaza solo, del lado seguro).
                </p>
              ) : (
                <p className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[11px] leading-snug text-warning">
                  Pública: <strong>cualquiera podrá consultarla sin identificarse</strong>. Asegurate de que no exponga datos privados.
                </p>
              )}
              {mNeedsIdentity && (
                <p className="text-[11px] leading-snug text-warning">Una operación personal necesita <code className="font-mono">{"{identity}"}</code> en la ruta.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowManual(false)}>Cancelar</Button>
            <Button
              disabled={!mSlug || !mPath.trim().startsWith("/") || mNeedsIdentity || createToolM.isPending}
              onClick={() => createToolM.mutate()}
            >
              {createToolM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Crear operación
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </DetailShell>
  );
}

// ── Fila de operación: config + probar + vincular intención ───────────────────

function ToolCard({ connectorId, tool, onDelete, onChanged }: {
  connectorId: string; tool: ConnectorTool; onDelete: () => void; onChanged: () => void;
}) {
  const [showTest, setShowTest]   = useState(false);
  const [identity, setIdentity]   = useState("");
  const [paramsStr, setParamsStr] = useState("");
  const [result, setResult]       = useState<ConnectorTestResult | null>(null);


  const testM = useMutation({
    mutationFn: () => {
      const params = parseJson(paramsStr);
      if (params === null) throw new Error("json");
      return api.connectors.testTool(connectorId, tool.id, { identity: identity.trim(), params });
    },
    onSuccess: setResult,
    onError: (e) => toast({
      title: "No se pudo probar",
      description: (e as Error).message === "json" ? "Los params no son JSON válido" : errDetail(e),
      variant: "destructive",
    }),
  });

  const applySuggestionM = useMutation({
    mutationFn: () => api.connectors.updateTool(tool.id, { response_map: result?.suggested_response_map ?? {} }),
    onSuccess: () => { onChanged(); toast({ title: "response_map aplicado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo aplicar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // Activar/desactivar la operación (fino, por operación — el bot solo usa las activas).
  const toggleActiveM = useMutation({
    mutationFn: (active: boolean) => api.connectors.updateTool(tool.id, { is_active: active }),
    onSuccess: () => onChanged(),
    onError: (e) => toast({ title: "No se pudo cambiar el estado", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // Editar la operación (nombre / método / ruta / acceso).
  const [showEditOp, setShowEditOp] = useState(false);
  const [eName, setEName]     = useState(tool.display_name);
  const [eMethod, setEMethod] = useState(tool.http_method);
  const [ePath, setEPath]     = useState(tool.path_template);
  const [eAccess, setEAccess] = useState(tool.identity_kind === "publico" ? "publico" : "personal");
  const openEditOp = () => {
    setEName(tool.display_name); setEMethod(tool.http_method); setEPath(tool.path_template);
    setEAccess(tool.identity_kind === "publico" ? "publico" : "personal");
    setShowEditOp(true);
  };
  const eNeedsIdentity = eAccess === "personal" && !ePath.includes("{identity}");
  const editOpM = useMutation({
    mutationFn: () => api.connectors.updateTool(tool.id, {
      display_name: eName.trim(), http_method: eMethod, path_template: ePath.trim(),
      identity_kind: eAccess, roles: eAccess === "publico" ? ["publico"] : [eAccess],
    }),
    onSuccess: () => { onChanged(); setShowEditOp(false); toast({ title: "Operación actualizada", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo guardar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  const isPublic = tool.identity_kind === "publico";
  const needsIdentity = tool.path_template.includes("{identity}");

  return (
    <div className="py-4 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{tool.display_name}</p>
            <Badge variant="secondary" className="max-w-full whitespace-normal break-all font-mono text-[11px]">{tool.http_method} {tool.path_template}</Badge>
            <Badge variant="outline" className="inline-flex items-center gap-1">
              {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isPublic ? "pública" : "personal"}
            </Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>Acceso: {tool.roles.join(", ") || "—"}</span>
            <span aria-hidden>·</span>
            <span className={Object.keys(tool.response_map).length ? "" : "text-warning"}>
              Respuesta: {Object.keys(tool.response_map).length ? "mapeada" : "sin mapear — probala"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Switch sutil por operación (patrón role="switch" de la app). */}
          <button
            type="button"
            role="switch"
            aria-checked={tool.is_active}
            disabled={toggleActiveM.isPending}
            onClick={() => toggleActiveM.mutate(!tool.is_active)}
            title={tool.is_active ? "Activa — tocá para desactivar" : "Desactivada — tocá para activar"}
            className="inline-flex h-8 items-center gap-1.5 rounded-md pl-1.5 pr-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            <span className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", tool.is_active ? "bg-success" : "bg-muted-foreground/30")}>
              <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all", tool.is_active ? "left-[14px]" : "left-0.5")} />
            </span>
            {tool.is_active ? "Activa" : "Inactiva"}
          </button>

          {/* Acciones secundarias en 3 puntitos. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground" aria-label="Más acciones">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="gap-2" onSelect={() => { setResult(null); setShowTest(true); }}>
                <FlaskConical className="h-3.5 w-3.5" /> Probar
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onSelect={openEditOp}>
                <Pencil className="h-3.5 w-3.5" /> Editar
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-destructive focus:text-destructive" onSelect={onDelete}>
                <Trash2 className="h-3.5 w-3.5" /> Eliminar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Panel Probar — modal (cierra con click afuera / Esc) */}
      <Dialog open={showTest} onOpenChange={(v) => { setShowTest(v); if (!v) setResult(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="break-words">Probar “{tool.display_name}”</DialogTitle>
            <DialogDescription>
              Ejecuta la operación contra el proveedor y te muestra la respuesta cruda.{needsIdentity ? " Poné un identificador de prueba real que exista en el proveedor." : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
            {needsIdentity && (
              <div className="w-44 space-y-1.5">
                <Label className="text-xs">Identificador de prueba</Label>
                <Input className="h-8 font-mono text-sm" placeholder="30111222" value={identity} onChange={e => setIdentity(e.target.value)} />
              </div>
            )}
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <Label className="text-xs">Parámetros (JSON, opcional)</Label>
              <Input className="h-8 font-mono text-sm" placeholder='{"campo": "valor"}' value={paramsStr} onChange={e => setParamsStr(e.target.value)} />
            </div>
            <Button size="sm" disabled={testM.isPending || (needsIdentity && !identity.trim())} onClick={() => testM.mutate()}>
              {testM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Ejecutar
            </Button>
          </div>

          {result && (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {result.ok
                  ? <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-4 w-4" /> {result.status} OK · {result.latency_ms}ms</span>
                  : <span className="inline-flex items-center gap-1 font-medium text-destructive"><XCircle className="h-4 w-4" /> {result.error || result.status}{result.detail ? ` — ${result.detail}` : ""}</span>}
                <code className="text-xs text-muted-foreground">{result.method} {result.url}</code>
              </div>
              {!result.ok && (() => {
                const ex = explainHttpStatus(result.status);
                return ex ? <p className="text-xs leading-snug text-muted-foreground">{ex.hint}</p> : null;
              })()}
              {result.mapped && (
                <p className="text-xs"><span className="font-semibold">Mapeado:</span> outcome=<code>{result.mapped.outcome}</code></p>
              )}
              {result.raw !== undefined && (
                <pre className="max-h-56 overflow-x-auto rounded-lg border bg-background p-3 text-xs">{JSON.stringify(result.raw, null, 2)}</pre>
              )}
              {result.suggested_response_map && Object.keys(result.suggested_response_map).length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded border bg-background px-2 py-1 text-xs">{JSON.stringify(result.suggested_response_map)}</code>
                  <Button size="sm" variant="outline" disabled={applySuggestionM.isPending} onClick={() => applySuggestionM.mutate()}>
                    <Wand2 className="h-3.5 w-3.5 mr-1" /> Usar como response_map
                  </Button>
                </div>
              )}
            </div>
          )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Editar operación */}
      <Dialog open={showEditOp} onOpenChange={setShowEditOp}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="break-words">Editar operación</DialogTitle>
            <DialogDescription>Ajustá el nombre, la ruta o el acceso de esta operación.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Nombre</Label>
              <Input value={eName} onChange={e => setEName(e.target.value)} />
            </div>
            <div className="grid grid-cols-[110px_1fr] gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Método</Label>
                <Select value={eMethod} onValueChange={setEMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Ruta</Label>
                <Input className="font-mono" value={ePath} onChange={e => setEPath(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Acceso</Label>
              <Select value={eAccess} onValueChange={setEAccess}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal — pide identificarse</SelectItem>
                  <SelectItem value="publico">Público — cualquiera puede consultarla</SelectItem>
                </SelectContent>
              </Select>
              {eAccess === "publico" && (
                <p className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[11px] leading-snug text-warning">
                  Al hacerla pública, <strong>cualquiera podrá consultarla sin identificarse</strong>. Asegurate de que no exponga datos privados.
                </p>
              )}
              {eNeedsIdentity && (
                <p className="text-[11px] leading-snug text-warning">Una operación personal necesita <code className="font-mono">{"{identity}"}</code> en la ruta.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditOp(false)}>Cancelar</Button>
            <Button disabled={!eName.trim() || !ePath.trim().startsWith("/") || eNeedsIdentity || editOpM.isPending} onClick={() => editOpM.mutate()}>
              {editOpM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
