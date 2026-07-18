"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Loader2, Trash2, KeyRound, FlaskConical,
  CheckCircle2, XCircle, Globe, Lock, Link2, Wand2, Sparkles, FileUp, Database,
} from "lucide-react";
import { api, type ConnectorTool, type ConnectorTestResult, type DiscoveryProposal } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { SectionCard } from "@/components/admin/settings/section-card";

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

const IDENTITY_KINDS = [
  { value: "publico",     label: "Pública (sin login)" },
  { value: "afiliado",    label: "Personal — afiliado (login DNI + código)" },
  { value: "profesional", label: "Personal — profesional (login CUIT + código)" },
];

export default function ConnectorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["connector", id] });
  const invAll = () => { inv(); qc.invalidateQueries({ queryKey: ["connectors"] }); };

  const { data: conn, isLoading } = useQuery({
    queryKey: ["connector", id],
    queryFn: () => api.connectors.get(id),
  });

  // ── credencial (write-only) ────────────────────────────────────────────────
  const [secret, setSecret] = useState("");
  const secretM = useMutation({
    mutationFn: () => api.connectors.setSecret(id, secret.trim()),
    onSuccess: () => { inv(); setSecret(""); toast({ title: "Credencial guardada (cifrada)", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo guardar", description: errDetail(e), variant: "destructive" }),
  });

  // ── validación de identidad (quién valida el 2º factor) ───────────────────
  const [idVal, setIdVal]           = useState<string | null>(null);
  const [lookupPath, setLookupPath] = useState<string | null>(null);
  const [idLabel, setIdLabel]       = useState<string | null>(null);
  const idValM = useMutation({
    mutationFn: (vars: { flow: string; lookup: string; label: string }) =>
      api.connectors.update(id, {
        auth_config: {
          ...(conn?.auth_config ?? {}),
          identity_validation: vars.flow,
          identity_lookup_path: vars.lookup,
          identity_label: vars.label.trim(),
        },
      } as never),
    onSuccess: () => {
      invAll(); setIdVal(null); setLookupPath(null); setIdLabel(null);
      toast({ title: "Validación de identidad guardada", description: "El conector quedó inactivo por el cambio de config — reactivalo cuando quieras.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo guardar", description: errDetail(e), variant: "destructive" }),
  });

  const toggleM = useMutation({
    mutationFn: (active: boolean) => api.connectors.setActive(id, active),
    onSuccess: (_d, active) => { invAll(); toast({ title: active ? "Conector activado" : "Conector desactivado", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo activar", description: errDetail(e), variant: "destructive" }),
  });

  // ── wizard: conexión automática con IA ─────────────────────────────────────
  const [showWizard, setShowWizard]   = useState(false);
  const [wizIdentity, setWizIdentity] = useState("");
  const [proposal, setProposal]       = useState<DiscoveryProposal | null>(null);
  const [selected, setSelected]       = useState<Record<string, boolean>>({});
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
    mutationFn: () => api.connectors.discover(id, wizIdentity.trim()),
    onSuccess: acceptProposal,
    onError: (e) => toast({ title: "No pude analizar el API", description: errDetail(e), variant: "destructive" }),
  });

  // Alternativa sin OpenAPI: el admin sube la doc del proveedor (PDF/Word/TXT/JSON)
  // y el backend extrae las rutas con IA. Desemboca en la MISMA propuesta.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const discoverFileM = useMutation({
    mutationFn: (file: File) => api.connectors.discoverFromFile(id, file, wizIdentity.trim()),
    onSuccess: acceptProposal,
    onError: (e) => toast({ title: "No pude interpretar el archivo", description: errDetail(e), variant: "destructive" }),
  });
  const wizBusy = discoverM.isPending || discoverFileM.isPending;

  const applyM = useMutation({
    mutationFn: () => api.connectors.apply(id, selectedRoutes),
    onSuccess: (d) => {
      invAll(); setShowWizard(false); setProposal(null);
      toast({
        title: `${d.created.length} ${d.created.length === 1 ? "operación creada" : "operaciones creadas"}`,
        description: d.identity_lookup_path ? "Validación por código (OTP propio) configurada automáticamente." : undefined,
        variant: "success",
      });
    },
    onError: (e) => toast({ title: "No se pudo crear", description: errDetail(e), variant: "destructive" }),
  });

  // ── nueva operación ────────────────────────────────────────────────────────
  const [showTool, setShowTool]   = useState(false);
  const [tSlug, setTSlug]         = useState("");
  const [tName, setTName]         = useState("");
  const [tMethod, setTMethod]     = useState("GET");
  const [tPath, setTPath]         = useState("");
  const [tKind, setTKind]         = useState("publico");
  const [tParams, setTParams]     = useState("");
  const [tMap, setTMap]           = useState("");

  const createToolM = useMutation({
    mutationFn: () => {
      const params = parseJson(tParams); const rmap = parseJson(tMap);
      if (params === null || rmap === null) throw new Error("json");
      const roles = tKind === "publico" ? ["publico", "afiliado"] : [tKind];
      return api.connectors.createTool(id, {
        slug: tSlug.trim(), display_name: tName.trim(), http_method: tMethod,
        path_template: tPath.trim(), params_schema: params, response_map: rmap,
        identity_kind: tKind, roles,
      });
    },
    onSuccess: () => {
      inv(); setShowTool(false);
      setTSlug(""); setTName(""); setTMethod("GET"); setTPath(""); setTKind("publico"); setTParams(""); setTMap("");
      toast({ title: "Operación creada", description: "Probala antes de vincularla a una intención.", variant: "success" });
    },
    onError: (e) => toast({
      title: "No se pudo crear",
      description: (e as Error).message === "json" ? "params_schema o response_map no son JSON válido (objeto)" : errDetail(e),
      variant: "destructive",
    }),
  });

  const deleteToolM = useMutation({
    mutationFn: (toolId: string) => api.connectors.deleteTool(toolId),
    onSuccess: () => { inv(); toast({ title: "Operación eliminada", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo eliminar", description: errDetail(e), variant: "destructive" }),
  });

  if (isLoading || !conn) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-64 mb-6" />
        <Skeleton className="h-40 rounded-2xl mb-4" />
        <Skeleton className="h-64 rounded-2xl" />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader back={{ href: "/admin/connectors", label: "Volver a Fuentes de datos" }} title="Fuente de datos" />

      {/* ── Estado del conector ── */}
      <div className="rounded-2xl border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Database className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight text-foreground break-words">{conn.display_name}</h1>
              <p className="break-all font-mono text-xs text-muted-foreground">{conn.base_url}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={conn.is_active ? "default" : "secondary"}>{conn.is_active ? "Activo" : "Inactivo"}</Badge>
            <Button
              size="sm"
              variant={conn.is_active ? "outline" : "default"}
              disabled={toggleM.isPending}
              onClick={() => toggleM.mutate(!conn.is_active)}
            >
              {toggleM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {conn.is_active ? "Desactivar" : "Activar"}
            </Button>
          </div>
        </div>

        {/* Banner de estado en una frase (patrón WhatsApp) */}
        <div className={cn(
          "mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3",
          conn.is_active ? "border-success/30 bg-success/[0.06]" : "border-border bg-muted/40",
        )}>
          {conn.is_active
            ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            : <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />}
          <span className="text-sm font-medium text-foreground">
            {conn.is_active
              ? "Activo — el asistente puede consultar esta fuente en vivo."
              : conn.tools.length === 0
                ? "Todavía sin operaciones. Detectá o creá al menos una para poder activarlo."
                : "Inactivo — probá las operaciones y activalo cuando esté listo."}
          </span>
        </div>
      </div>

      {/* ── Credencial ── */}
      {conn.auth_type !== "none" && (
        <SectionCard
          icon={KeyRound}
          title="Credencial"
          description="La clave o token que te dio el proveedor. Se cifra al guardarse y nunca se vuelve a mostrar."
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <Label className="text-xs">
                {conn.has_secret ? <span className="text-success">Credencial cargada · reemplazala si querés</span> : "API key / token / contraseña"}
              </Label>
              <Input
                type="password"
                placeholder={conn.has_secret ? "•••••••• (reemplazar)" : "API key / token / contraseña"}
                value={secret}
                onChange={e => setSecret(e.target.value)}
              />
            </div>
            <Button size="sm" disabled={!secret.trim() || secretM.isPending} onClick={() => secretM.mutate()}>
              {secretM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Guardar credencial
            </Button>
          </div>
        </SectionCard>
      )}

      {/* ── Validación de identidad (2º factor de los datos personales) ── */}
      {(() => {
        const currentFlow = String((conn.auth_config as Record<string, unknown>)?.identity_validation ?? "provider");
        const currentLookup = String((conn.auth_config as Record<string, unknown>)?.identity_lookup_path ?? "/afiliados/{identity}");
        const currentLabel = String((conn.auth_config as Record<string, unknown>)?.identity_label ?? "");
        const flow = idVal ?? currentFlow;
        const lookup = lookupPath ?? currentLookup;
        const label = idLabel ?? currentLabel;
        const dirty = flow !== currentFlow || (flow === "platform_otp" && lookup !== currentLookup)
          || label.trim() !== currentLabel;
        return (
          <SectionCard
            icon={Lock}
            title="Validación de identidad"
            description="Para datos personales: quién valida el segundo factor (el código) cuando el afiliado consulta lo suyo."
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-96">
                  <Select value={flow} onValueChange={setIdVal}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="provider">El proveedor valida el código (tiene endpoint propio)</SelectItem>
                      <SelectItem value="platform_otp">La plataforma envía y valida el código (OTP propio)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {flow === "platform_otp" && (
                  <div className="min-w-[240px] flex-1 space-y-1.5">
                    <Label className="text-xs">Ruta del perfil del afiliado (de dónde leemos el contacto)</Label>
                    <Input className="font-mono" value={lookup} onChange={e => setLookupPath(e.target.value)} />
                  </div>
                )}
                <div className="w-full space-y-1.5 sm:w-56">
                  <Label className="text-xs">Identificador que se le pide (vacío = DNI)</Label>
                  <Input placeholder="DNI · legajo · nro de socio…" value={label} onChange={e => setIdLabel(e.target.value)} />
                </div>
                {dirty && (
                  <Button size="sm" disabled={idValM.isPending} onClick={() => idValM.mutate({ flow, lookup, label })}>
                    {idValM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                    Guardar
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {flow === "platform_otp"
                  ? "La plataforma lee el email del afiliado desde el proveedor, le envía un código de 6 dígitos y lo valida. El proveedor no necesita construir nada."
                  : "El backend llama al endpoint de validación del proveedor con DNI + código."}
              </p>
            </div>
          </SectionCard>
        );
      })()}

      {/* ── Operaciones ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Operaciones <span className="text-muted-foreground">({conn.tools.length})</span></h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Lo más fácil: dejá que la IA lea la documentación del proveedor y arme las operaciones por vos.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setShowWizard(s => !s)}>
            <Sparkles className="h-4 w-4 mr-1" /> Detectar con IA
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowTool(true)}>
            <Plus className="h-4 w-4 mr-1" /> Crear manual
          </Button>
        </div>
      </div>

      {/* Wizard: la IA descubre, clasifica y prueba las rutas del proveedor */}
      {showWizard && (
        <div className="rounded-2xl border bg-card p-5 mb-4 space-y-4">
          <div>
            <p className="font-semibold inline-flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" /> Conexión automática
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Leemos el catálogo de rutas del proveedor, las clasificamos, las probamos en vivo
              y te proponemos las intenciones. Vos solo revisás y confirmás. Si el proveedor no
              publica su catálogo, subí la documentación que te pasó (PDF, Word, TXT o JSON).
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5 w-56">
              <Label className="text-xs">Identidad de prueba (DNI real de un afiliado)</Label>
              <Input className="h-9 font-mono" placeholder="30111222" value={wizIdentity}
                onChange={e => setWizIdentity(e.target.value)} />
            </div>
            <Button size="sm" disabled={wizBusy || !wizIdentity.trim()} onClick={() => discoverM.mutate()}>
              {discoverM.isPending
                ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Analizando el API…</>
                : <><Sparkles className="h-4 w-4 mr-1.5" /> Detectar</>}
            </Button>
            <Button size="sm" variant="outline" disabled={wizBusy || !wizIdentity.trim()}
              onClick={() => fileInputRef.current?.click()}>
              {discoverFileM.isPending
                ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Leyendo la documentación…</>
                : <><FileUp className="h-4 w-4 mr-1.5" /> Subir documentación</>}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.json,.html"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) discoverFileM.mutate(f);
                e.target.value = ""; // permite re-subir el mismo archivo
              }}
            />
          </div>

          {proposal && !proposal.spec_found && (
            <p className="text-sm text-destructive">{proposal.hint}</p>
          )}

          {proposal?.spec_found && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-mono">fuente: {proposal.spec_url}</p>
              {proposal.routes.map(r => (
                <div key={r.path} className={cn("rounded-xl border px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1",
                  !r.include && !selected[r.path] && "opacity-60")}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={!!selected[r.path]}
                    disabled={!r.path_template}
                    onChange={e => setSelected(s => ({ ...s, [r.path]: e.target.checked }))}
                    aria-label={`Incluir ${r.path}`}
                  />
                  <span className="font-medium">{r.display_name}</span>
                  <Badge variant="secondary" className="font-mono text-[11px]">GET {r.path_template ?? r.path}</Badge>
                  <Badge variant="outline" className="inline-flex items-center gap-1">
                    {r.identity_kind === "publico" ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                    {r.is_lookup ? "perfil (para el código)" : r.identity_kind}
                  </Badge>
                  {r.test && (r.test.ok
                    ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5" /> probada {r.test.status} · {r.test.latency_ms}ms</span>
                    : <span className="inline-flex items-center gap-1 text-xs text-destructive font-medium">
                        <XCircle className="h-3.5 w-3.5" /> falló ({r.test.status ?? r.test.error})</span>)}
                  {!r.include && (
                    <span className="w-full text-xs text-amber-600 pl-7">
                      la IA la descartó: {r.discard_reason} — podés tildarla igual si corresponde
                    </span>
                  )}
                  {r.include && r.intent_label && (
                    <span className="w-full text-xs text-muted-foreground pl-7">
                      intención: <code>{r.intent_label}</code> · {(r.examples ?? []).length} frases de ejemplo generadas
                    </span>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-end gap-3 pt-1">
                {lookupSelected && (
                  <span className="text-xs text-muted-foreground">
                    el perfil no cuenta como operación: configura la verificación por código (OTP)
                  </span>
                )}
                <Button disabled={applyM.isPending || selectedRoutes.length === 0} onClick={() => applyM.mutate()}>
                  {applyM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                  Crear {selectedCount} {selectedCount === 1 ? "operación" : "operaciones"}{lookupSelected ? " + OTP" : ""}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-4">
        {conn.tools.map(tool => (
          <ToolCard key={tool.id} connectorId={id} tool={tool}
            onDelete={() => deleteToolM.mutate(tool.id)} onChanged={inv} />
        ))}
        {conn.tools.length === 0 && (
          <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Sin operaciones. Cada operación es un endpoint del proveedor que el bot puede invocar.
          </div>
        )}
      </div>

      {/* Nueva operación — modal centrado */}
      <Dialog open={showTool} onOpenChange={setShowTool}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Link2 className="h-5 w-5" />
              </span>
              <div className="min-w-0 space-y-1 pt-0.5">
                <DialogTitle>Nueva operación</DialogTitle>
                <DialogDescription>
                  Un endpoint del API del proveedor. <code className="rounded bg-muted px-1 font-mono">{"{identity}"}</code> se reemplaza por el identificador de la sesión (DNI, CUIT, legajo…).
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="-mr-1 max-h-[min(60vh,34rem)] space-y-4 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label>Nombre</Label>
              <Input placeholder="Órdenes pendientes del afiliado" value={tName} onChange={e => setTName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Identificador (slug)</Label>
              <Input placeholder="ordenes_pendientes" value={tSlug} onChange={e => setTSlug(e.target.value.toLowerCase())} />
            </div>
            <div className="grid grid-cols-[110px_1fr] gap-3">
              <div className="space-y-2">
                <Label>Método</Label>
                <Select value={tMethod} onValueChange={setTMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["GET", "POST"].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Ruta (path template)</Label>
                <Input className="font-mono" placeholder="/afiliados/{identity}/ordenes" value={tPath} onChange={e => setTPath(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Acceso</Label>
              <Select value={tKind} onValueChange={setTKind}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IDENTITY_KINDS.map(k => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>params_schema (JSON, opcional)</Label>
              <Textarea className="font-mono text-xs" rows={4}
                placeholder='{"type":"object","required":["especialidad"],"properties":{"especialidad":{"type":"string"}}}'
                value={tParams} onChange={e => setTParams(e.target.value)} />
              <p className="text-xs leading-relaxed text-muted-foreground">Qué datos se extraen del mensaje del usuario y cómo se validan.</p>
            </div>
            <div className="space-y-2">
              <Label>response_map (JSON, opcional)</Label>
              <Textarea className="font-mono text-xs" rows={3}
                placeholder='{"items_path":"ordenes","empty_when_empty":true}'
                value={tMap} onChange={e => setTMap(e.target.value)} />
              <p className="text-xs leading-relaxed text-muted-foreground">De dónde sale la respuesta. Dejalo vacío: al Probar te sugerimos uno.</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTool(false)}>Cancelar</Button>
            <Button
              onClick={() => createToolM.mutate()}
              disabled={!tSlug.trim() || !tName.trim() || !tPath.trim() || createToolM.isPending}
            >
              {createToolM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Crear operación
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

// ── Tarjeta de operación: config + probar + vincular intención ─────────────────

function ToolCard({ connectorId, tool, onDelete, onChanged }: {
  connectorId: string; tool: ConnectorTool; onDelete: () => void; onChanged: () => void;
}) {
  const [showTest, setShowTest]   = useState(false);
  const [identity, setIdentity]   = useState("");
  const [paramsStr, setParamsStr] = useState("");
  const [result, setResult]       = useState<ConnectorTestResult | null>(null);

  const [showBind, setShowBind]   = useState(false);
  const [bLabel, setBLabel]       = useState("");
  const [bExamples, setBExamples] = useState("");

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
    onError: (e) => toast({ title: "No se pudo aplicar", description: errDetail(e), variant: "destructive" }),
  });

  const bindM = useMutation({
    mutationFn: () => api.connectors.upsertBinding(tool.id, {
      intent_label: bLabel.trim(),
      examples: bExamples.split("\n").map(s => s.trim()).filter(Boolean),
      min_confidence: 0.7, is_active: true,
    }),
    onSuccess: (d) => {
      onChanged(); setShowBind(false); setBLabel(""); setBExamples("");
      toast({ title: `Vinculada a “${d.intent_label}”`, description: "El bot disparará esta operación al reconocer la intención.", variant: "success" });
    },
    onError: (e) => toast({ title: "No se pudo vincular", description: errDetail(e), variant: "destructive" }),
  });

  const unbindM = useMutation({
    mutationFn: (bindingId: string) => api.connectors.deleteBinding(bindingId),
    onSuccess: () => { onChanged(); toast({ title: "Vínculo eliminado", variant: "success" }); },
  });

  const isPublic = tool.identity_kind === "publico";
  const needsIdentity = tool.path_template.includes("{identity}");

  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold">{tool.display_name}</p>
            <Badge variant="secondary" className="max-w-full whitespace-normal break-all font-mono text-[11px]">{tool.http_method} {tool.path_template}</Badge>
            <Badge variant="outline" className="inline-flex items-center gap-1">
              {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isPublic ? "pública" : tool.identity_kind}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            roles: {tool.roles.join(", ") || "—"} · response_map: {Object.keys(tool.response_map).length ? JSON.stringify(tool.response_map) : "vacío"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => { setShowTest(s => !s); setResult(null); }}>
            <FlaskConical className="h-3.5 w-3.5 mr-1" /> Probar
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowBind(s => !s)}>
            <Link2 className="h-3.5 w-3.5 mr-1" /> Vincular
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Intenciones vinculadas */}
      {tool.bindings.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tool.bindings.map(b => (
            <Badge key={b.id} variant="secondary" className="gap-1.5 font-mono text-[11px]">
              {b.intent_label} ≥{b.min_confidence}
              <button onClick={() => unbindM.mutate(b.id)} className="hover:text-destructive" aria-label="Quitar vínculo">×</button>
            </Badge>
          ))}
        </div>
      )}

      {/* Panel Probar */}
      {showTest && (
        <div className="mt-4 rounded-xl bg-muted/50 border p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {needsIdentity && (
              <div className="space-y-1.5 w-44">
                <Label className="text-xs">Identidad de prueba (DNI/CUIT)</Label>
                <Input className="h-8 font-mono text-sm" placeholder="30111222" value={identity} onChange={e => setIdentity(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-[200px]">
              <Label className="text-xs">Params (JSON, opcional)</Label>
              <Input className="h-8 font-mono text-sm" placeholder='{"especialidad":"Cardiología"}' value={paramsStr} onChange={e => setParamsStr(e.target.value)} />
            </div>
            <Button size="sm" disabled={testM.isPending || (needsIdentity && !identity.trim())} onClick={() => testM.mutate()}>
              {testM.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5 mr-1" />}
              Ejecutar
            </Button>
          </div>

          {result && (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                {result.ok
                  ? <span className="inline-flex items-center gap-1 text-emerald-600 font-medium"><CheckCircle2 className="h-4 w-4" /> {result.status} OK · {result.latency_ms}ms</span>
                  : <span className="inline-flex items-center gap-1 text-destructive font-medium"><XCircle className="h-4 w-4" /> {result.error || result.status}{result.detail ? ` — ${result.detail}` : ""}</span>}
                <code className="text-xs text-muted-foreground">{result.method} {result.url}</code>
              </div>
              {result.mapped && (
                <p className="text-xs"><span className="font-semibold">Mapeado:</span> outcome=<code>{result.mapped.outcome}</code></p>
              )}
              {result.raw !== undefined && (
                <pre className="text-xs bg-background border rounded-lg p-3 overflow-x-auto max-h-56">{JSON.stringify(result.raw, null, 2)}</pre>
              )}
              {result.suggested_response_map && Object.keys(result.suggested_response_map).length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-xs bg-background border rounded px-2 py-1">{JSON.stringify(result.suggested_response_map)}</code>
                  <Button size="sm" variant="outline" disabled={applySuggestionM.isPending} onClick={() => applySuggestionM.mutate()}>
                    <Wand2 className="h-3.5 w-3.5 mr-1" /> Usar como response_map
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Panel Vincular */}
      {showBind && (
        <div className="mt-4 rounded-xl bg-muted/50 border p-4 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Intención que dispara esta operación</Label>
            <Input className="h-8 font-mono text-sm" placeholder="consulta_ordenes_pendientes" value={bLabel} onChange={e => setBLabel(e.target.value.toLowerCase().replace(/\s+/g, "_"))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Frases de ejemplo (una por línea) — así el bot aprende a reconocerla</Label>
            <Textarea className="font-mono text-xs" rows={4}
              placeholder={"¿qué órdenes pendientes tengo?\nquiero ver mis órdenes\ntengo autorizaciones sin usar?"}
              value={bExamples} onChange={e => setBExamples(e.target.value)} />
          </div>
          <Button size="sm" disabled={!bLabel.trim() || bindM.isPending} onClick={() => bindM.mutate()}>
            {bindM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Vincular intención
          </Button>
        </div>
      )}
    </div>
  );
}
