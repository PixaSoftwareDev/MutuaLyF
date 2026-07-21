"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Trash2, FlaskConical, ChevronDown, CheckCircle2, XCircle,
  Globe, Lock, Link2, Wand2, FileUp, Database,
} from "lucide-react";
import { api, type ConnectorTool, type ConnectorTestResult, type DiscoveryProposal } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

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
  const [showCred, setShowCred] = useState(false);
  const [secret, setSecret] = useState("");
  const secretM = useMutation({
    mutationFn: () => api.connectors.setSecret(id, secret.trim()),
    onSuccess: () => { inv(); setSecret(""); setShowCred(false); toast({ title: "Credencial guardada (cifrada)", variant: "success" }); },
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

  // ── wizard: detección automática de operaciones ────────────────────────────
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

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const deleteToolM = useMutation({
    mutationFn: (toolId: string) => api.connectors.deleteTool(toolId),
    onSuccess: () => { inv(); toast({ title: "Operación eliminada", variant: "success" }); },
    onError: (e) => toast({ title: "No se pudo eliminar", description: errDetail(e), variant: "destructive" }),
  });

  if (isLoading || !conn) {
    return (
      <PageShell width="wide">
        <PageHeader back={{ href: "/admin/connectors", label: "Volver a Fuentes de datos" }} title="Fuente de datos" />
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <Skeleton className="h-52 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </PageShell>
    );
  }

  const needsAuth = conn.auth_type !== "none";
  const authLabel =
    conn.auth_type === "api_key" ? "API key (header)" :
    conn.auth_type === "bearer"  ? "Bearer token" :
    conn.auth_type === "basic"   ? "Usuario + contraseña" : "Sin autenticación";
  const hosts = conn.egress_allow?.join(", ") || "—";

  const statusMsg = conn.is_active
    ? "Activo — el asistente puede consultar esta fuente en vivo."
    : conn.tools.length === 0
      ? "Todavía sin operaciones. Detectá al menos una para poder activarlo."
      : "Inactivo — probá las operaciones y activalo cuando esté listo.";

  return (
    <PageShell>
      <PageHeader back={{ href: "/admin/connectors", label: "Volver a Fuentes de datos" }} title="Fuente de datos" />

      <div className="mx-auto w-full max-w-5xl space-y-4">

        {/* ── Encabezado + estado + configuración (una sola card) ── */}
        <Card className="rounded-2xl">
          <CardContent className="p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Database className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-base font-semibold leading-tight text-foreground break-words">{conn.display_name}</h1>
                    <StatePill active={conn.is_active} />
                  </div>
                  <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{conn.base_url}</p>
                </div>
              </div>
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

            {/* Estado en una frase */}
            <div className={cn(
              "mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3",
              conn.is_active ? "border-success/30 bg-success/[0.06]" : "border-border bg-muted/40",
            )}>
              {conn.is_active
                ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                : <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />}
              <span className="text-sm text-foreground">{statusMsg}</span>
            </div>

            {/* Configuración — grilla compacta; la URL ya está en el encabezado */}
            <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 sm:grid-cols-3">
              <Field label="Autenticación">{authLabel}</Field>
              {needsAuth && (
                <Field label="Credencial">
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {conn.has_secret
                      ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="h-3.5 w-3.5" /> Cargada</span>
                      : <span className="text-muted-foreground">Sin cargar</span>}
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

            {/* Editor de credencial — aparece inline al tocar Cargar/Cambiar */}
            {needsAuth && showCred && (
              <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-muted/40 p-3.5 animate-fade-in">
                <div className="min-w-[220px] flex-1 space-y-1.5">
                  <Label className="text-xs">La clave o token que te dio el proveedor. Se cifra al guardarse.</Label>
                  <Input
                    type="password"
                    autoFocus
                    placeholder={conn.has_secret ? "•••••••• (reemplazar)" : "API key / token / contraseña"}
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                  />
                </div>
                <Button size="sm" disabled={!secret.trim() || secretM.isPending} onClick={() => secretM.mutate()}>
                  {secretM.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                  Guardar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Operaciones (una sola card) ── */}
        <Card className="rounded-2xl">
          <CardContent className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">
                  Operaciones <span className="font-normal text-muted-foreground">({conn.tools.length})</span>
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Cada operación es un endpoint del proveedor que el bot puede consultar. Detectalas automáticamente y el sistema las arma por vos.
                </p>
              </div>
              <Button size="sm" onClick={() => setShowWizard(s => !s)}>Detectar automáticamente</Button>
            </div>

            {/* Wizard — inline, separado por un divisor, sin caja propia */}
            {showWizard && (
              <div className="mt-4 space-y-4 border-t pt-4 animate-fade-in">
                <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Detectamos las rutas del proveedor, las probamos en vivo y te proponemos las intenciones.
                  Si no publica su catálogo, subí la documentación que te pasó (PDF, Word, TXT o JSON).
                </p>

                <div className="w-full space-y-1.5 sm:max-w-sm">
                  <Label className="text-xs">Dato de prueba</Label>
                  <Input className="h-9 font-mono" placeholder="Ej. 30111222" value={wizIdentity}
                    onChange={e => setWizIdentity(e.target.value)} />
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Un dato real que exista en el proveedor (DNI, legajo, nº de socio) para probar las consultas.
                    No es la clave del API.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={wizBusy || !wizIdentity.trim()} onClick={() => discoverM.mutate()}>
                    {discoverM.isPending
                      ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Analizando…</>
                      : "Detectar"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={wizBusy || !wizIdentity.trim()}
                    onClick={() => fileInputRef.current?.click()}>
                    {discoverFileM.isPending
                      ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Leyendo…</>
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
                      e.target.value = "";
                    }}
                  />
                </div>

                {proposal && !proposal.spec_found && (
                  <p className="text-sm text-destructive">{proposal.hint}</p>
                )}

                {proposal?.spec_found && (
                  <div className="space-y-3">
                    <p className="font-mono text-xs text-muted-foreground">fuente: {proposal.spec_url}</p>
                    <div className="divide-y">
                      {proposal.routes.map(r => (
                        <div key={r.path} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5",
                          !r.include && !selected[r.path] && "opacity-60")}>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary"
                            checked={!!selected[r.path]}
                            disabled={!r.path_template}
                            onChange={e => setSelected(s => ({ ...s, [r.path]: e.target.checked }))}
                            aria-label={`Incluir ${r.path}`}
                          />
                          <span className="text-sm font-medium">{r.display_name}</span>
                          <Badge variant="secondary" className="font-mono text-[11px]">GET {r.path_template ?? r.path}</Badge>
                          <Badge variant="outline" className="inline-flex items-center gap-1">
                            {r.identity_kind === "publico" ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                            {r.is_lookup ? "perfil (para el código)" : r.identity_kind}
                          </Badge>
                          {r.test && (r.test.ok
                            ? <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                                <CheckCircle2 className="h-3.5 w-3.5" /> probada {r.test.status} · {r.test.latency_ms}ms</span>
                            : <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                                <XCircle className="h-3.5 w-3.5" /> falló ({r.test.status ?? r.test.error})</span>)}
                          {!r.include && (
                            <span className="w-full pl-7 text-xs text-warning">
                              la IA la descartó: {r.discard_reason} — podés tildarla igual si corresponde
                            </span>
                          )}
                          {r.include && r.intent_label && (
                            <span className="w-full pl-7 text-xs text-muted-foreground">
                              intención: <code>{r.intent_label}</code> · {(r.examples ?? []).length} frases de ejemplo generadas
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-end gap-3">
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

            {/* Lista de operaciones — filas divididas, no una card por item */}
            {conn.tools.length === 0 ? (
              !showWizard && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Todavía sin operaciones. Tocá “Detectar automáticamente” para que el sistema las arme.
                </p>
              )
            ) : (
              <div className="mt-2 divide-y border-t">
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
                const currentLabel = String((conn.auth_config as Record<string, unknown>)?.identity_label ?? "");
                const flow = idVal ?? currentFlow;
                const lookup = lookupPath ?? currentLookup;
                const label = idLabel ?? currentLabel;
                const dirty = flow !== currentFlow || (flow === "platform_otp" && lookup !== currentLookup)
                  || label.trim() !== currentLabel;
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
                            Solo para datos personales: quién valida el código cuando el afiliado consulta lo suyo.
                          </p>
                        </div>
                      </div>

                      <div className="mt-5 space-y-4">
                        {/* 1 · Quién valida el código */}
                        <div className="space-y-1.5">
                          <Label className="text-xs">¿Quién valida el código?</Label>
                          <div className="w-full sm:max-w-sm">
                            <Select value={flow} onValueChange={setIdVal}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="provider">El proveedor lo valida</SelectItem>
                                <SelectItem value="platform_otp">La plataforma lo valida (OTP)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="max-w-2xl text-[11px] leading-snug text-muted-foreground">
                            {flow === "platform_otp"
                              ? "La plataforma lee el email del afiliado, le envía un código de 6 dígitos y lo valida. El proveedor no construye nada."
                              : "El backend le pasa el DNI + el código al endpoint de validación del proveedor."}
                          </p>
                        </div>

                        {/* 2 · Ruta del perfil (solo OTP propio) */}
                        {flow === "platform_otp" && (
                          <div className="space-y-1.5">
                            <Label className="text-xs">Ruta del perfil del afiliado</Label>
                            <Input className="w-full font-mono sm:max-w-md" value={lookup} onChange={e => setLookupPath(e.target.value)} />
                            <p className="text-[11px] leading-snug text-muted-foreground">De dónde leemos su email para enviarle el código.</p>
                          </div>
                        )}

                        {/* 3 · Identificador que se le pide */}
                        <div className="space-y-1.5">
                          <Label className="text-xs">Identificador que se le pide</Label>
                          <Input className="w-full sm:max-w-xs" placeholder="DNI · legajo · nº de socio…" value={label} onChange={e => setIdLabel(e.target.value)} />
                          <p className="text-[11px] leading-snug text-muted-foreground">Vacío = DNI.</p>
                        </div>

                        {dirty && (
                          <Button size="sm" disabled={idValM.isPending} onClick={() => idValM.mutate({ flow, lookup, label })}>
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
    </PageShell>
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
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{tool.display_name}</p>
            <Badge variant="secondary" className="max-w-full whitespace-normal break-all font-mono text-[11px]">{tool.http_method} {tool.path_template}</Badge>
            <Badge variant="outline" className="inline-flex items-center gap-1">
              {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isPublic ? "pública" : tool.identity_kind}
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
        <div className="mt-3 space-y-3 rounded-xl bg-muted/40 p-3.5">
          <div className="flex flex-wrap items-end gap-3">
            {needsIdentity && (
              <div className="w-44 space-y-1.5">
                <Label className="text-xs">Identificador de prueba</Label>
                <Input className="h-8 font-mono text-sm" placeholder="30111222" value={identity} onChange={e => setIdentity(e.target.value)} />
              </div>
            )}
            <div className="min-w-[200px] flex-1 space-y-1.5">
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
              <div className="flex flex-wrap items-center gap-2">
                {result.ok
                  ? <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-4 w-4" /> {result.status} OK · {result.latency_ms}ms</span>
                  : <span className="inline-flex items-center gap-1 font-medium text-destructive"><XCircle className="h-4 w-4" /> {result.error || result.status}{result.detail ? ` — ${result.detail}` : ""}</span>}
                <code className="text-xs text-muted-foreground">{result.method} {result.url}</code>
              </div>
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
      )}

      {/* Panel Vincular */}
      {showBind && (
        <div className="mt-3 space-y-3 rounded-xl bg-muted/40 p-3.5">
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
