"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CONNECTORS_UI_ENABLED } from "@/lib/features";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Trash2, FlaskConical, ChevronDown, CheckCircle2, XCircle,
  Globe, Lock, Link2, Wand2, FileUp, Database, Pencil, Plus, MoreVertical,
} from "lucide-react";
import { api, type ConnectorTool, type ConnectorTestResult, type DiscoveryProposal, type ToolTestAllResult } from "@/lib/api";
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
import {
  AUTH_TYPES, CredentialFields, credentialIncomplete,
  credentialValuesFromConfig, emptyCredentialValues, buildAuthConfigPatch,
  type CredentialValues,
} from "@/components/admin/connector-credential-fields";

function errDetail(e: unknown): string {
  // Sin respuesta HTTP (timeout del cliente, red caída) el detail no existe:
  // el message de axios ("timeout of 300000ms exceeded") al menos dice qué pasó
  // y humanizeConnectorError sabe traducirlo.
  const anyE = e as { response?: { data?: { detail?: string } }; message?: string };
  return anyE?.response?.data?.detail || anyE?.message || "Ocurrió un error";
}

// Pastilla de estado con punto (mismo lenguaje que los canales). El tercer
// estado ("esperando aprobación") es un inactivo con solicitud enviada al
// super-admin — ámbar para que se lea como "en trámite", no como falla.
function StatePill({ active, pending }: { active: boolean; pending?: boolean }) {
  if (!active && pending) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/30 bg-warning/[0.08] px-2 py-0.5 text-[11px] font-semibold text-warning">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        Esperando aprobación
      </span>
    );
  }
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
  const label = ex?.label ?? (test.error ? "no respondió" : "sin respuesta");
  return (
    <span
      title={ex?.hint ?? ([test.status, test.error].filter(Boolean).join(" ") || undefined)}
      className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning"
    >
      <XCircle className="h-3 w-3" /> Revisar · {label}
    </span>
  );
}

// Estado persistido de la última prueba de una operación: verde (probada),
// rojo (falló, detalle en tooltip), gris (nunca probada).
function TestStatePill({ tool }: { tool: ConnectorTool }) {
  if (tool.last_test_ok === true) return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
      <CheckCircle2 className="h-3 w-3" /> Probada
    </span>
  );
  if (tool.last_test_ok === false) return (
    <span
      title={tool.last_test_detail ?? undefined}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive"
    >
      <XCircle className="h-3 w-3" /> Falló
    </span>
  );
  return <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Sin probar</span>;
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

// Flag de build por ambiente (ver lib/features.ts): sin conectores validados,
// ni por URL directa. Wrapper para respetar las reglas de hooks.
export default function ConnectorDetailPage() {
  if (!CONNECTORS_UI_ENABLED) return <ConnectorDetailDisabledRedirect />;
  return <ConnectorDetailInner />;
}

function ConnectorDetailDisabledRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/documents"); }, [router]);
  return null;
}

function ConnectorDetailInner() {
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
  // Campos y armado de auth_config viven en connector-credential-fields
  // (compartidos con el alta).
  const [showCred, setShowCred] = useState(false);
  const [cred, setCred] = useState<CredentialValues>(emptyCredentialValues);
  const openCred = () => {
    setCred(credentialValuesFromConfig(conn?.auth_config as Record<string, unknown>));
    setShowCred(true);
  };
  const closeCred = () => { setShowCred(false); setCred(emptyCredentialValues); };
  const saveCredM = useMutation({
    mutationFn: async () => {
      const patch = buildAuthConfigPatch(conn?.auth_type ?? "none", cred, conn?.auth_config as Record<string, unknown>);
      if (patch) await api.connectors.update(id, { auth_config: patch } as never);
      if (cred.secret.trim()) await api.connectors.setSecret(id, cred.secret.trim());
    },
    onSuccess: () => {
      invAll(); closeCred();
      toast({ title: "Credencial guardada (cifrada)", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo guardar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // Prueba de credencial sin tocar operaciones (oauth2: emisión real de token).
  const testAuthM = useMutation({
    mutationFn: () => api.connectors.testAuth(id),
    onSuccess: (r) => toast(r.ok
      ? { title: "Credencial válida", description: r.note ?? (r.latency_ms != null ? `Token emitido por el proveedor · ${r.latency_ms}ms` : undefined), variant: "success" }
      : { title: "La credencial no funciona", description: humanizeConnectorError(r.detail), variant: "destructive" }),
    onError: (e) => toast({ title: "No se pudo probar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
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
    onSuccess: (d, active) => {
      invAll();
      // Hosts sin aprobar: no es una falla — la solicitud quedó registrada y el
      // conector pasa a "esperando aprobación" hasta que el super-admin apruebe.
      if (d.pending_approval) {
        toast({
          title: "Esperando aprobación del super-admin",
          description: "Le enviamos la solicitud. Cuando apruebe, tocá Activar de nuevo — mientras tanto podés seguir probando las operaciones.",
        });
        return;
      }
      toast({ title: active ? "Conector activado" : "Conector desactivado", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo activar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // ── probar todas: dry-run masivo con estado persistido por operación ───────
  const [showTestAll, setShowTestAll] = useState(false);
  const [taIdentity, setTaIdentity]   = useState("");
  const [taResult, setTaResult]       = useState<ToolTestAllResult | null>(null);
  // Errores desplegables: el detalle completo no entra en una línea truncada.
  const [taOpen, setTaOpen]           = useState<Record<string, boolean>>({});
  const testAllM = useMutation({
    mutationFn: () => api.connectors.testAllTools(id, taIdentity.trim()),
    onSuccess: (r) => { setTaResult(r); invAll(); },
    onError: (e) => toast({ title: "No se pudieron probar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // ── wizard: detección automática de operaciones ────────────────────────────
  const [showWizard, setShowWizard]   = useState(false);
  const [dragOver, setDragOver]       = useState(false);
  const [proposal, setProposal]       = useState<DiscoveryProposal | null>(null);
  const [selected, setSelected]       = useState<Record<string, boolean>>({});
  // Override del acceso (público/personal) por ruta: la IA lo propone pero el
  // admin puede corregirlo antes de crear (clave = path).
  const [routeKind, setRouteKind]     = useState<Record<string, string>>({});
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

  // Al arrancar una detección nueva ("Subir otra documentación" incluido) se
  // limpia la propuesta anterior entera — rutas, tildes y accesos corregidos.
  // Sin esto, la lista vieja quedaba en pantalla mientras se leía el archivo
  // nuevo, y los overrides por path podían contaminar la propuesta siguiente.
  const resetProposal = () => { setProposal(null); setSelected({}); setRouteKind({}); };

  const discoverM = useMutation({
    mutationFn: () => api.connectors.discover(id, ""),
    onMutate: resetProposal,
    onSuccess: acceptProposal,
    onError: (e) => toast({ title: "No pude analizar el API", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  // Alternativa sin OpenAPI: el admin sube la doc del proveedor (PDF/Word/TXT/JSON)
  // y el backend extrae las rutas con IA. Desemboca en la MISMA propuesta.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const discoverFileM = useMutation({
    mutationFn: (file: File) => api.connectors.discoverFromFile(id, file, ""),
    onMutate: resetProposal,
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
      // Conservadas = rutas que ya existían: se preservan intactas (ejemplos,
      // descripciones y params curados sobreviven al re-detectar).
      const kept = d.kept?.length
        ? ` · ${d.kept.length} ya existían y se conservaron sin cambios`
        : "";
      const otp = d.identity_lookup_path ? " Validación por código (OTP propio) configurada." : "";
      toast({
        title: d.created.length
          ? `${d.created.length} ${d.created.length === 1 ? "operación creada" : "operaciones creadas"}`
          : "Sin operaciones nuevas",
        description: (kept + otp).trim() || undefined,
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
  const [mParams, setMParams] = useState<ParamRow[]>([]);
  const mSlug = toSlug(mName.trim());
  const mNeedsIdentity = mAccess === "personal" && !mPath.includes("{identity}");
  const createToolM = useMutation({
    mutationFn: () => api.connectors.createTool(id, {
      slug: mSlug, display_name: mName.trim(), http_method: mMethod, path_template: mPath.trim(),
      identity_kind: mAccess, is_read_only: true,
      roles: mAccess === "publico" ? ["publico"] : [mAccess],
      params_schema: paramRowsToSchema(mParams),
    }),
    onSuccess: () => {
      inv(); setShowManual(false);
      setMName(""); setMMethod("GET"); setMPath(""); setMAccess("personal"); setMParams([]);
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
  const isOauth   = conn.auth_type === "oauth2";
  const authLabel =
    conn.auth_type === "api_key" ? "API key" :
    conn.auth_type === "bearer"  ? "Bearer token" :
    isOauth                      ? "OAuth2 (token renovable)" :
    isBasic                      ? "Usuario + contraseña" : "Sin autenticación";
  // Basic: el usuario vive en auth_config; la contraseña es el secreto.
  const currentUser = String((conn.auth_config as Record<string, unknown>)?.username ?? "");
  // Con secreto ya cargado se puede guardar solo la config (ubicación de la api
  // key, o token_url/client_id de oauth2) sin re-tipear la clave.
  const credDisabled = saveCredM.isPending || credentialIncomplete(conn.auth_type, cred, conn.has_secret);
  const hosts = conn.egress_allow?.join(", ") || "—";

  return (
    <DetailShell
      leading={<BackLink href="/admin/connectors" label="Volver a Fuentes de datos" />}
      title={conn.display_name}
      actions={
        <div className="flex shrink-0 items-center gap-2">
          <StatePill active={conn.is_active} pending={conn.pending_approval} />
          <Button size="sm" variant="ghost" onClick={openEdit} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" /> Editar
          </Button>
          <Button
            size="sm"
            variant={conn.is_active ? "outline" : "default"}
            disabled={toggleM.isPending || (!conn.is_active && (conn.tools.length === 0 || conn.pending_approval))}
            onClick={() => toggleM.mutate(!conn.is_active)}
            title={
              !conn.is_active && conn.pending_approval
                ? "La solicitud ya está enviada — cuando el super-admin apruebe, el botón se habilita solo"
                : !conn.is_active && conn.tools.length === 0
                  ? "Necesitás al menos una operación para activar"
                  : undefined
            }
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
                      onClick={() => (showCred ? closeCred() : openCred())}
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
                Los campos son el mismo componente que usa el alta. */}
            {needsAuth && showCred && (
              <div className="mt-3 space-y-3 rounded-xl bg-muted/40 p-3.5 animate-fade-in">
                <CredentialFields
                  authType={conn.auth_type}
                  values={cred}
                  onChange={patch => setCred(c => ({ ...c, ...patch }))}
                  hasSecret={conn.has_secret}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  {isOauth && conn.has_secret && (
                    <Button variant="outline" size="sm" className="mr-auto" disabled={testAuthM.isPending}
                            onClick={() => testAuthM.mutate()}>
                      {testAuthM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                      Probar conexión
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={closeCred}>Cancelar</Button>
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
                  <Button size="sm" variant="outline" onClick={() => setShowTestAll(true)}>
                    <FlaskConical className="h-3.5 w-3.5 sm:mr-1" />
                    <span className="hidden sm:inline">Probar todas</span>
                  </Button>
                </div>
              )}
            </div>

            {/* Wizard de detección — en modal centrado */}
            <Dialog open={showWizard} onOpenChange={setShowWizard}>
              <DialogContent className="max-w-3xl">
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

                <div className="-mx-1.5 max-h-[min(78vh,52rem)] space-y-4 overflow-y-auto px-1.5 py-1">
                  {/* El input vive fuera del dropzone: sigue montado cuando el
                      dropzone se esconde (con resultados, "Subir otra" lo reusa). */}
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
                  {/* Analizando: skeleton con la forma de los resultados. La propuesta
                      anterior ya se limpió en onMutate — acá no queda lista vieja. */}
                  {wizBusy && (
                    <div className="space-y-4" aria-busy="true">
                      <div className="flex items-center justify-center gap-2 py-1">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                          {discoverFileM.isPending ? "Leyendo la documentación…" : "Analizando el catálogo…"}
                        </p>
                      </div>
                      <div className="rounded-xl border bg-card p-3.5">
                        <Skeleton className="h-4 w-3/4" />
                        <div className="mt-3 flex gap-2">
                          <Skeleton className="h-8 w-40" />
                          <Skeleton className="h-8 w-32" />
                        </div>
                      </div>
                      <div className="divide-y rounded-lg border">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <div key={i} className="flex items-center gap-3 px-3 py-3.5">
                            <Skeleton className="h-4 w-4 rounded" />
                            <div className="min-w-0 flex-1 space-y-1.5">
                              <Skeleton className="h-3.5 w-1/3" />
                              <Skeleton className="h-3 w-2/3" />
                            </div>
                            <Skeleton className="h-6 w-20 rounded-full" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Dropzone: subir o arrastrar la documentación. Con resultados
                      abajo se esconde — ocupaba media pantalla y empujaba la lista. */}
                  {!wizBusy && !proposal?.spec_found && (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) discoverFileM.mutate(f); }}
                    className={cn(
                      "flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
                      dragOver ? "border-action bg-action/5" : "border-border hover:border-action/40 hover:bg-muted/30",
                    )}
                  >
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                      <FileUp className="h-5 w-5 text-muted-foreground" />
                    </span>
                    <p className="text-sm font-medium text-foreground">Arrastrá o subí la documentación</p>
                    <p className="text-xs text-muted-foreground">PDF, Word, TXT, MD o JSON</p>
                  </div>
                  )}

                  {/* Alternativa discreta: catálogo OpenAPI en vivo */}
                  {!wizBusy && !proposal?.spec_found && (
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => discoverM.mutate()}
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                    >
                      ¿El proveedor publica su catálogo (OpenAPI)? Detectar del servidor
                    </button>
                  </div>
                  )}

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
                          <span className="text-muted-foreground">{gDisc.length} sugeridas afuera</span>. Tildá las que quieras usar y confirmá — ninguna se descarta sola.
                        </p>
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {/* "Las que andan" solo si alguna anduvo — con 0 listas era un botón que no hacía nada. */}
                          {gReady.length > 0 && (
                            <Button size="sm" variant="outline" onClick={() => setSelected(s => {
                              const n = { ...s }; gReady.forEach(r => { if (r.path_template) n[r.path] = true; }); return n;
                            })}>Seleccionar las que andan</Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => setSelected(s => {
                            const n = { ...s };
                            [...gReady, ...gWarn].forEach(r => { if (r.path_template) n[r.path] = true; });
                            return n;
                          })}>Seleccionar todas</Button>
                          <Button size="sm" variant="ghost" onClick={() => setSelected({})}>Ninguna</Button>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <p className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/50">fuente: {proposal.spec_url}</p>
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline"
                          >
                            Subir otra documentación
                          </button>
                        </div>
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
                          <p className="mb-1 text-xs font-semibold text-muted-foreground">
                            La IA las dejaría afuera ({gDisc.length})
                          </p>
                          <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">
                            Parecen rutas técnicas o de autenticación, no consultas para el bot. Es solo una
                            sugerencia: al lado de cada una está el motivo, y podés tildarlas para incluirlas igual.
                          </p>
                          <Group list={gDisc} discarded />
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-3 border-t pt-3">
                        {lookupSelected && (
                          <span className="max-w-[28rem] text-right text-xs leading-snug text-muted-foreground">
                            La operación de perfil no se suma a la lista: se usa para verificar la identidad
                            de la persona y mandarle el código por email (OTP).
                          </span>
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

            {/* Probar todas — dry-run masivo, deja cada operación marcada verde/rojo */}
            <Dialog open={showTestAll} onOpenChange={(v) => { setShowTestAll(v); if (!v) setTaResult(null); }}>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>Probar todas las operaciones</DialogTitle>
                  <DialogDescription>
                    Ejecuta cada operación contra el proveedor y guarda el resultado: la lista
                    queda marcada con Probada (verde) o Falló (rojo).
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  {conn.tools.some(t => t.path_template.includes("{identity}")) && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Identificador de prueba (para las operaciones personales)</Label>
                      <Input
                        className="h-8 font-mono text-sm" placeholder="30111222"
                        value={taIdentity} onChange={e => setTaIdentity(e.target.value)}
                      />
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        Un identificador real que exista en el proveedor. Si lo dejás vacío,
                        las operaciones personales se saltean (no cambian de estado).
                      </p>
                    </div>
                  )}
                  {taResult && (
                    <div className="space-y-2">
                      <p className="text-sm">
                        <span className="font-medium text-success">{taResult.ok} OK</span>
                        {" · "}
                        <span className={cn("font-medium", taResult.failed > 0 ? "text-destructive" : "text-muted-foreground")}>
                          {taResult.failed} {taResult.failed === 1 ? "falló" : "fallaron"}
                        </span>
                        {taResult.skipped > 0 && (
                          <span className="text-muted-foreground"> · {taResult.skipped} salteadas</span>
                        )}
                      </p>
                      <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
                        {taResult.results.map(r => {
                          const fail = r.ok === false;
                          const open = !!taOpen[r.tool_id];
                          return (
                            <div key={r.tool_id}>
                              {/* Las filas con error se despliegan: el detalle completo
                                  no entra truncado en una línea. */}
                              <button
                                type="button"
                                disabled={!fail}
                                onClick={() => setTaOpen(s => ({ ...s, [r.tool_id]: !s[r.tool_id] }))}
                                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                                  fail && "cursor-pointer transition-colors hover:bg-muted/40")}
                              >
                                {r.ok === true
                                  ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                                  : fail
                                    ? <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                                    : <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />}
                                <span className="min-w-0 flex-1 truncate font-medium">{r.display_name}</span>
                                <span className="max-w-[220px] shrink-0 truncate text-muted-foreground">
                                  {r.ok === true ? `${r.status} · ${r.latency_ms}ms` : r.detail}
                                </span>
                                {fail && <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />}
                              </button>
                              {fail && open && (
                                <p className="whitespace-pre-wrap break-words border-t bg-muted/30 px-3 py-2 pl-8 text-xs leading-relaxed text-muted-foreground">
                                  {r.detail}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowTestAll(false)}>Cerrar</Button>
                  <Button disabled={testAllM.isPending} onClick={() => testAllM.mutate()}>
                    {testAllM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    {testAllM.isPending ? "Probando…" : taResult ? "Probar de nuevo" : `Probar ${conn.tools.length} operaciones`}
                  </Button>
                </DialogFooter>
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
            <ParamsEditor rows={mParams} onChange={setMParams} />
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
  const [open, setOpen]           = useState(false);
  const [showTest, setShowTest]   = useState(false);
  const [identity, setIdentity]   = useState("");
  // Un campo por parámetro declarado en el schema — el admin escribe el valor
  // pelado y el objeto JSON lo armamos nosotros. Una operación sin parámetros
  // declarados no pide nada: en runtime el LLM tampoco puede mandarle nada.
  const [paramVals, setParamVals] = useState<Record<string, string>>({});
  const [result, setResult]       = useState<ConnectorTestResult | null>(null);

  const schemaProps = (tool.params_schema?.properties ?? {}) as Record<
    string, { type?: string; enum?: unknown[]; description?: string; "x-resource-id"?: boolean; "x-example"?: unknown }
  >;
  const schemaRequired = (tool.params_schema?.required ?? []) as string[];
  const hasDeclaredParams = Object.keys(schemaProps).length > 0;

  // Valores tipados según el schema: "3" en un param integer viaja como 3.
  const buildParams = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(schemaProps)) {
      const raw = (paramVals[name] ?? "").trim();
      if (!raw) continue;
      if (spec.type === "integer") { const n = parseInt(raw, 10); if (!Number.isNaN(n)) out[name] = n; }
      else if (spec.type === "number") { const n = parseFloat(raw); if (!Number.isNaN(n)) out[name] = n; }
      else if (spec.type === "boolean") out[name] = ["true", "sí", "si", "1"].includes(raw.toLowerCase());
      else out[name] = raw;
    }
    return out;
  };
  // Los x-resource-id no bloquean: si quedan vacíos, el backend hace el recorrido
  // (llama a la lista hermana y usa un id real) — por eso no cuentan como faltantes.
  const missingRequired = hasDeclaredParams
    ? schemaRequired.filter(r => !(paramVals[r] ?? "").trim() && !schemaProps[r]?.["x-resource-id"])
    : [];

  const testM = useMutation({
    mutationFn: () => api.connectors.testTool(connectorId, tool.id, { identity: identity.trim(), params: buildParams() }),
    // onChanged: el backend persistió el resultado → refrescar para que el
    // pill del acordeón (Probada/Falló) cambie sin recargar.
    onSuccess: (r) => { setResult(r); onChanged(); },
    onError: (e) => toast({
      title: "No se pudo probar",
      description: errDetail(e),
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
  const [eDesc, setEDesc]     = useState(tool.description ?? "");
  const [eMethod, setEMethod] = useState(tool.http_method);
  const [ePath, setEPath]     = useState(tool.path_template);
  const [eAccess, setEAccess] = useState(tool.identity_kind === "publico" ? "publico" : "personal");
  // Ejemplos: una frase por línea en el textarea; se guardan como lista.
  const [eExamples, setEExamples] = useState((tool.examples ?? []).join("\n"));
  const [eParams, setEParams]     = useState<ParamRow[]>([]);
  const openEditOp = () => {
    setEName(tool.display_name); setEDesc(tool.description ?? "");
    setEMethod(tool.http_method); setEPath(tool.path_template);
    setEAccess(tool.identity_kind === "publico" ? "publico" : "personal");
    setEExamples((tool.examples ?? []).join("\n"));
    setEParams(schemaToParamRows(tool.params_schema as Record<string, unknown> | undefined));
    setShowEditOp(true);
  };
  const eNeedsIdentity = eAccess === "personal" && !ePath.includes("{identity}");

  // Data flywheel: consultas reales que rutearon a esta operación y aún no son
  // ejemplos. El admin las suma con un clic (aprender del uso) o las descarta.
  const candQ = useQuery({
    queryKey: ["example-candidates", tool.id],
    queryFn: () => api.connectors.exampleCandidates(tool.id),
    enabled: showEditOp,
    staleTime: 10_000,
  });
  const candidates = candQ.data?.candidates ?? [];
  const approveCandM = useMutation({
    mutationFn: (id: string) => api.connectors.approveExampleCandidate(id),
    onSuccess: (d) => {
      // Reflejar de una en el textarea (aún sin guardar) + refrescar la lista.
      setEExamples(prev => (prev.trim() ? prev.trimEnd() + "\n" : "") + d.query);
      candQ.refetch(); onChanged();
    },
    onError: (e) => toast({ title: "No se pudo agregar", description: errDetail(e), variant: "destructive" }),
  });
  const dismissCandM = useMutation({
    mutationFn: (id: string) => api.connectors.dismissExampleCandidate(id),
    onSuccess: () => candQ.refetch(),
  });

  const editOpM = useMutation({
    mutationFn: () => api.connectors.updateTool(tool.id, {
      display_name: eName.trim(), description: eDesc.trim() || null,
      http_method: eMethod, path_template: ePath.trim(),
      identity_kind: eAccess, roles: eAccess === "publico" ? ["publico"] : [eAccess],
      examples: eExamples.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 20),
      params_schema: paramRowsToSchema(eParams),
    }),
    onSuccess: () => { onChanged(); setShowEditOp(false); toast({ title: "Operación actualizada", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo guardar", description: humanizeConnectorError(errDetail(e)), variant: "destructive" }),
  });

  const isPublic = tool.identity_kind === "publico";
  const needsIdentity = tool.path_template.includes("{identity}");

  const mapped = Object.keys(tool.response_map).length > 0;

  return (
    <div className="first:pt-0 last:pb-0">
      {/* Cabecera desplegable: con decenas de operaciones la lista expandida era
          inmanejable — colapsadas por default, el detalle se abre por operación. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-2.5 text-left transition-colors hover:bg-muted/40 rounded-lg px-1.5 -mx-1.5"
      >
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        {isPublic ? <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <Lock className="h-3.5 w-3.5 shrink-0 text-warning" />}
        <span className="text-sm font-semibold truncate">{tool.display_name}</span>
        <code className="hidden min-w-0 truncate text-[11px] text-muted-foreground sm:inline">{tool.http_method} {tool.path_template}</code>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Sin mapeo + nunca probada OK → aviso. Si ya probó OK sin mapeo, la
              respuesta directa es un estado válido (el mapeo se auto-aplica al
              probar cuando la heurística encuentra qué mapear). */}
          {!mapped && tool.last_test_ok !== true && (
            <span className="inline-flex items-center gap-1 text-[11px] text-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" /> sin mapear
            </span>
          )}
          <TestStatePill tool={tool} />
        </span>
      </button>

      {open && (
      <div className="animate-fade-in pb-4 pl-6">
      {/* Falló → el detalle completo acá (apretar la pastilla despliega y lo muestra). */}
      {tool.last_test_ok === false && tool.last_test_detail && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{tool.last_test_detail}</span>
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="max-w-full whitespace-normal break-all font-mono text-[11px]">{tool.http_method} {tool.path_template}</Badge>
            <Badge variant="outline" className="inline-flex items-center gap-1">
              {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isPublic ? "pública" : "personal"}
            </Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>Acceso: {tool.roles.join(", ") || "—"}</span>
            <span aria-hidden>·</span>
            <span className={mapped || tool.last_test_ok === true ? "" : "text-warning"}>
              Respuesta: {mapped ? "mapeada"
                : tool.last_test_ok === true ? "directa (no necesita mapeo)"
                : "sin mapear — probala"}
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
            {/* Un campo por parámetro del schema — sin JSON a mano. Sin
                parámetros declarados no se pide nada. La ayuda va VISIBLE bajo
                el campo (un tooltip nadie lo descubre) y el ejemplo del spec o
                del discovery es el placeholder. */}
            {hasDeclaredParams &&
              Object.entries(schemaProps).map(([name, spec]) => (
                <div key={name} className="w-44 space-y-1.5">
                  <Label className="text-xs">
                    {name}
                    {schemaRequired.includes(name)
                      ? <span className="text-destructive"> *</span>
                      : <span className="text-muted-foreground/60"> (opcional)</span>}
                  </Label>
                  {spec.enum?.length ? (
                    <Select value={paramVals[name] ?? ""} onValueChange={v => setParamVals(s => ({ ...s, [name]: v }))}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Elegí…" /></SelectTrigger>
                      <SelectContent>
                        {spec.enum.map(v => <SelectItem key={String(v)} value={String(v)}>{String(v)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : spec.type === "boolean" ? (
                    <Select value={paramVals[name] ?? ""} onValueChange={v => setParamVals(s => ({ ...s, [name]: v }))}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Elegí…" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">Sí</SelectItem>
                        <SelectItem value="false">No</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      className="h-8 font-mono text-sm"
                      placeholder={spec["x-resource-id"] ? "vacío → lo buscamos solos"
                        : spec["x-example"] != null ? `ej. ${String(spec["x-example"])}`
                        : (spec.type === "integer" || spec.type === "number") ? "123" : "valor"}
                      value={paramVals[name] ?? ""}
                      onChange={e => setParamVals(s => ({ ...s, [name]: e.target.value }))}
                    />
                  )}
                  {spec.description && !spec["x-resource-id"] && (
                    <p className="text-[10px] leading-snug text-muted-foreground line-clamp-3">{spec.description}</p>
                  )}
                  {spec["x-resource-id"] && (
                    <p className="text-[10px] leading-snug text-muted-foreground">Se completa solo con un id real del listado.</p>
                  )}
                </div>
              ))}
            {/* Autocompletar con los ejemplos disponibles (spec del proveedor o
                discovery) — solo llena campos vacíos, no pisa lo tipeado. */}
            {hasDeclaredParams && Object.values(schemaProps).some(s => s["x-example"] != null) && (
              <Button
                size="sm" variant="outline"
                onClick={() => setParamVals(prev => {
                  const next = { ...prev };
                  for (const [name, spec] of Object.entries(schemaProps)) {
                    if (spec["x-example"] != null && !(next[name] ?? "").trim()) next[name] = String(spec["x-example"]);
                  }
                  return next;
                })}
              >
                Completar con ejemplos
              </Button>
            )}
            <Button
              size="sm"
              disabled={testM.isPending || (needsIdentity && !identity.trim()) || missingRequired.length > 0}
              title={missingRequired.length > 0 ? `Falta completar: ${missingRequired.join(", ")}` : undefined}
              onClick={() => testM.mutate()}
            >
              {testM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Ejecutar
            </Button>
          </div>

          {result && (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {result.ok
                  ? <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-4 w-4" /> {result.status} OK · {result.latency_ms}ms</span>
                  : result.error === "resource_id_unavailable"
                    ? <span className="inline-flex items-center gap-1 font-medium text-destructive"><XCircle className="h-4 w-4" /> {result.detail}</span>
                    : <span className="inline-flex items-center gap-1 font-medium text-destructive"><XCircle className="h-4 w-4" /> {result.error || result.status}{result.detail ? ` — ${result.detail}` : ""}</span>}
                {result.url && <code className="text-xs text-muted-foreground">{result.method} {result.url}</code>}
              </div>
              {result.auto_filled?.map(a => (
                <p key={a.param} className="text-xs text-muted-foreground">
                  Probada con <code>{a.param}={a.value}</code>{a.label ? ` («${a.label}»)` : ""} — lo
                  conseguimos automáticamente de “{a.from}”.
                </p>
              ))}
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
              {result.response_map_applied ? (
                <p className="inline-flex items-center gap-1.5 text-xs text-success">
                  <Wand2 className="h-3.5 w-3.5" /> Mapeo de respuesta configurado automáticamente con esta prueba.
                </p>
              ) : result.suggested_response_map && Object.keys(result.suggested_response_map).length > 0 && (
                /* La tool ya tenía un mapeo distinto: la sugerencia queda como override manual. */
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
            <DialogDescription>Ajustá el nombre, la descripción, los ejemplos, la ruta o el acceso.</DialogDescription>
          </DialogHeader>
          <div className="-mx-1.5 max-h-[min(70vh,44rem)] space-y-4 overflow-y-auto px-1.5 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs">Nombre</Label>
              <Input value={eName} onChange={e => setEName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Descripción <span className="font-normal text-muted-foreground">· qué devuelve y cuándo usarla</span></Label>
              <Textarea rows={2} value={eDesc} onChange={e => setEDesc(e.target.value)}
                        placeholder="Ej. Cuentas por cobrar: cuánto nos deben los clientes. No es el valor del proyecto." />
              <p className="text-[11px] leading-snug text-muted-foreground">
                El asistente lee esto para decidir cuándo consultar esta operación. Cuanto más clara —y
                más aclare qué NO es—, mejor elige.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Ejemplos de consultas <span className="font-normal text-muted-foreground">· una por línea</span></Label>
              <Textarea rows={5} className="font-mono text-[13px]" value={eExamples}
                        onChange={e => setEExamples(e.target.value)}
                        placeholder={"¿cuánto nos debe tal cliente?\n¿quién nos debe plata?\n¿qué tenemos por cobrar?"} />
              <p className="text-[11px] leading-snug text-muted-foreground">
                Frases reales, como las diría la gente (con sinónimos y jerga). Ayudan al asistente a
                reconocer preguntas que suenan distinto pero van a esta operación. Ideal: 4-6.
                {" "}{eExamples.split("\n").map(s => s.trim()).filter(Boolean).length}/20
              </p>
            </div>
            {/* Sugerencias del uso real (data flywheel) */}
            {candidates.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-action/30 bg-action/[0.04] p-3">
                <p className="text-xs font-medium text-foreground">
                  Sugerencias del uso real <span className="font-normal text-muted-foreground">· preguntas que la gente hizo y rutearon acá</span>
                </p>
                <div className="space-y-1">
                  {candidates.map(c => (
                    <div key={c.id} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate">{c.query}</span>
                      {c.hits > 1 && <span className="shrink-0 text-[10px] text-muted-foreground">×{c.hits}</span>}
                      <button type="button" disabled={approveCandM.isPending}
                              onClick={() => approveCandM.mutate(c.id)}
                              className="shrink-0 rounded border border-success/40 px-1.5 py-0.5 text-[11px] font-medium text-success transition-colors hover:bg-success/10">
                        + Agregar
                      </button>
                      <button type="button" disabled={dismissCandM.isPending}
                              onClick={() => dismissCandM.mutate(c.id)}
                              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-destructive">
                        Descartar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
            <ParamsEditor rows={eParams} onChange={setEParams} />
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
      )}

    </div>
  );
}

// ── Editor de parámetros (sin JSON) ───────────────────────────────────────────
// Filas nombre/tipo/requerido/descripción/ejemplo ↔ params_schema. Las claves
// que el editor no maneja (enum, x-resource-id) se preservan intactas en cada
// fila para no romper lo que armó el discovery.

type ParamRow = {
  name: string; type: string; required: boolean;
  description: string; example: string;
  extra: Record<string, unknown>;
};

const PARAM_TYPES = [
  { value: "string", label: "Texto" },
  { value: "integer", label: "Entero" },
  { value: "number", label: "Número" },
  { value: "boolean", label: "Sí/No" },
];

function schemaToParamRows(schema: Record<string, unknown> | null | undefined): ParamRow[] {
  const props = ((schema as { properties?: Record<string, Record<string, unknown>> } | null)?.properties) ?? {};
  const req = new Set(((schema as { required?: string[] } | null)?.required) ?? []);
  return Object.entries(props).map(([name, p]) => {
    const { type, description, ["x-example"]: example, ...extra } = p;
    return {
      name,
      type: typeof type === "string" ? type : "string",
      required: req.has(name),
      description: typeof description === "string" ? description : "",
      example: example != null ? String(example) : "",
      extra,
    };
  });
}

function paramRowsToSchema(rows: ParamRow[]): Record<string, unknown> {
  const clean = rows.filter(r => r.name.trim());
  if (!clean.length) return {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const r of clean) {
    const prop: Record<string, unknown> = { ...r.extra, type: r.type };
    if (r.description.trim()) prop.description = r.description.trim();
    const ex = r.example.trim();
    if (ex) {
      const n = r.type === "integer" ? parseInt(ex, 10) : r.type === "number" ? parseFloat(ex) : NaN;
      prop["x-example"] = Number.isNaN(n) ? ex : n;
    }
    properties[r.name.trim()] = prop;
    if (r.required) required.push(r.name.trim());
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function ParamsEditor({ rows, onChange }: { rows: ParamRow[]; onChange: (rows: ParamRow[]) => void }) {
  const set = (i: number, patch: Partial<ParamRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        Parámetros <span className="font-normal text-muted-foreground">· lo que la operación acepta en la consulta</span>
      </Label>
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <div className="flex items-center gap-1.5">
                <Input className="h-8 w-36 font-mono text-xs" placeholder="nombre" value={r.name}
                       onChange={e => set(i, { name: e.target.value })} />
                <Select value={r.type} onValueChange={v => set(i, { type: v })}>
                  <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PARAM_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={r.required}
                         onChange={e => set(i, { required: e.target.checked })} />
                  requerido
                </label>
                <button type="button" aria-label="Quitar parámetro"
                        className="ml-auto shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                        onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <Input className="h-8 flex-1 text-xs" placeholder="Qué es y qué formato espera (lo ve el asistente y el panel Probar)"
                       value={r.description} onChange={e => set(i, { description: e.target.value })} />
                <Input className="h-8 w-28 font-mono text-xs" placeholder="ejemplo" value={r.example}
                       onChange={e => set(i, { example: e.target.value })} />
              </div>
            </div>
          ))}
        </div>
      )}
      <Button type="button" size="sm" variant="outline" className="h-7 text-xs"
              onClick={() => onChange([...rows, { name: "", type: "string", required: false, description: "", example: "", extra: {} }])}>
        <Plus className="mr-1 h-3 w-3" /> Agregar parámetro
      </Button>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Sin parámetros, el asistente consulta la ruta tal cual. La descripción y el ejemplo
        alimentan el panel Probar y ayudan al asistente a armar bien la consulta.
      </p>
    </div>
  );
}
