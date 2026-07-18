"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { WhatsAppIcon } from "@/components/layout/sidebar";
import { AppearanceSettings } from "@/components/admin/settings/appearance-settings";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Copy, Check, CheckCircle2, RefreshCw, Globe, MessageCircle,
  PlugZap, Pause, Play, Trash2, AlertTriangle, MoreVertical, Pencil, Eye, EyeOff, Lock,
  Database, Code2, X,
} from "lucide-react";
import { api, type ChannelsState } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/lib/errors";
import { DEFAULT_BOT_NAME } from "@/components/admin/settings/chat-preview";

// ── Helpers de UI ─────────────────────────────────────────────────────────────

function StatePill({ tone, children }: { tone: "success" | "muted" | "warning" | "destructive"; children: React.ReactNode }) {
  const cls = {
    success:     "border-success/30 bg-success/[0.08] text-success",
    warning:     "border-warning/30 bg-warning/[0.08] text-warning",
    destructive: "border-destructive/30 bg-destructive/[0.08] text-destructive",
    muted:       "border-border bg-muted/50 text-muted-foreground",
  }[tone];
  const dot = {
    success: "bg-success", warning: "bg-warning",
    destructive: "bg-destructive", muted: "bg-muted-foreground/40",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold shrink-0", cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} /> {children}
    </span>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-muted rounded-lg px-3 py-2 break-all font-mono">{value}</code>
        <Button
          size="icon" variant="outline" className="h-8 w-8 shrink-0"
          aria-label={`Copiar ${label}`}
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            toast({ title: "Copiado al portapapeles", variant: "success" });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

// Campo sensible: enmascarado por defecto, se revela un rato (auto-oculta a los
// 20s) y se puede copiar SIN revelar. El enmascarado es protección anti-mirada,
// no seguridad real (el valor igual viaja al cliente).
function SecretField({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(false), 20_000);
    return () => clearTimeout(t);
  }, [revealed]);

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-muted rounded-lg px-3 py-2 break-all font-mono">
          {revealed ? value : "•".repeat(24)}
        </code>
        <Button
          size="icon" variant="outline" className="h-8 w-8 shrink-0"
          aria-label={revealed ? "Ocultar" : "Revelar"}
          onClick={() => setRevealed(v => !v)}
        >
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </Button>
        <Button
          size="icon" variant="outline" className="h-8 w-8 shrink-0"
          aria-label={`Copiar ${label}`}
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            toast({ title: "Copiado al portapapeles", variant: "success" });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

// Badge para un secreto ya cargado: comunica "está guardado, oculto por seguridad".
function SavedBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Lock className="h-2.5 w-2.5" /> {children}
    </span>
  );
}

// ── Tab Canales ───────────────────────────────────────────────────────────────

export function ChannelsSettings() {
  const qc = useQueryClient();

  const { data: channels, isLoading, isError } = useQuery({
    queryKey: ["channels"],
    queryFn: api.channels.get,
    staleTime: 30_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["channels"] });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-72 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }

  if (isError || !channels) {
    return (
      <Card className="rounded-2xl p-8 text-center text-sm text-muted-foreground">
        No se pudo cargar el estado de los canales. Puede que el backend todavía no tenga esta versión desplegada.
      </Card>
    );
  }

  return <ChannelsSplit channels={channels} refresh={refresh} />;
}

/** Cada canal es su propia página: ?canal= la elige (la escribe el panel
 *  Sistema en desktop); en mobile un segmented local hace de selector. */
function ChannelsSplit({ channels, refresh }: { channels: ChannelsState; refresh: () => void }) {
  const params = useSearchParams();
  const raw = params.get("canal");
  const canal: "all" | "widget" | "whatsapp" = raw === "whatsapp" ? "whatsapp" : raw === "all" ? "all" : "widget";

  if (canal === "all") return <ChannelsOverview channels={channels} />;

  // Mobile: selector local Widget/WhatsApp (desktop usa el panel del Sistema).
  return <ChannelsWidgetOrWhatsApp channels={channels} refresh={refresh} initial={canal} />;
}

function ChannelsWidgetOrWhatsApp({ channels, refresh, initial }: {
  channels: ChannelsState; refresh: () => void; initial: "widget" | "whatsapp";
}) {
  const [localCanal, setLocalCanal] = useState<"widget" | "whatsapp">(initial);
  useEffect(() => { setLocalCanal(initial); }, [initial]);

  return (
    <div className="space-y-4">
      <div className="flex rounded-lg bg-muted/60 p-0.5 lg:hidden">
        {([["widget", "Widget web"], ["whatsapp", "WhatsApp"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setLocalCanal(key)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
              localCanal === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {localCanal === "widget"
        ? <WidgetSection channels={channels} refresh={refresh} />
        : <WhatsAppCard channels={channels} onChanged={refresh} />}
    </div>
  );
}

/** Vista "Todos" (patrón /settings/channels de la referencia): hero del canal
 *  principal arriba con ilustración, y los otros dos en cards chicas abajo. */
function ChannelsOverview({ channels }: { channels: ChannelsState }) {
  const wa = channels.whatsapp;
  const widgetState = channels.widget.enabled ? { tone: "success" as const, label: "Activo" } : { tone: "muted" as const, label: "Desactivado" };
  const waState = !wa ? { tone: "muted" as const, label: "Sin configurar" }
    : wa.enabled ? { tone: "success" as const, label: "Activo" }
    : { tone: "warning" as const, label: "Pendiente" };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      {/* ── Hero: Widget web ── */}
      <Card className="group overflow-hidden rounded-2xl transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-lg hover:shadow-black/[0.05]">
        <div className="grid items-stretch sm:grid-cols-[1fr_minmax(0,320px)]">
          <div className="p-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:bg-foreground/[0.07] group-hover:text-foreground">
                <Globe className="h-5 w-5" />
              </span>
              <h3 className="text-base font-semibold text-foreground">Widget web</h3>
              <StatePill tone={widgetState.tone}>{widgetState.label}</StatePill>
            </div>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              El chat embebido en tu sitio y la página de consulta. Se instala con un fragmento de código y atiende al instante.
            </p>
            <Button asChild className="mt-5">
              <Link href="/admin/settings?tab=canales&canal=widget">Configurar</Link>
            </Button>
          </div>
          {/* Ilustración con fondo (banco de imagen) — theme-aware */}
          <div className="relative hidden overflow-hidden bg-gradient-to-br from-violet-100 via-indigo-50 to-transparent p-5 sm:block dark:from-violet-500/15 dark:via-indigo-500/10 dark:to-transparent">
            <div className="overflow-hidden rounded-lg border shadow-md dark:border-white/10">
              <div className="flex items-center gap-1 bg-[#26272b] px-2 py-1.5">
                {[0, 1, 2].map(i => <span key={i} className="h-1.5 w-1.5 rounded-full bg-white/25" />)}
              </div>
              <div className="relative h-32 bg-white p-3 dark:bg-[#15181b]">
                <div className="space-y-1.5" aria-hidden>
                  <div className="h-12 rounded-md bg-slate-200/80 dark:bg-white/10" />
                  <div className="h-1.5 w-4/5 rounded-full bg-slate-200/80 dark:bg-white/10" />
                  <div className="h-1.5 w-3/5 rounded-full bg-slate-200/80 dark:bg-white/10" />
                </div>
                <span className="absolute bottom-2.5 right-2.5 flex h-9 w-9 items-center justify-center rounded-full bg-action-gradient text-white shadow-md">
                  <MessageCircle className="h-4 w-4" />
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Otros canales ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <ChannelMiniCard
          icon={<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#25D366] text-white"><WhatsAppIcon className="h-5 w-5" /></span>}
          title="WhatsApp"
          desc="Atendé por WhatsApp con el mismo asistente y operadores."
          state={waState}
          href="/admin/settings?tab=canales&canal=whatsapp"
        />
        <ChannelMiniCard
          icon={<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Database className="h-5 w-5" /></span>}
          title="Fuentes de datos"
          desc="APIs y bases externas que el asistente puede consultar."
          state={null}
          href="/admin/connectors"
        />
      </div>
    </div>
  );
}

function ChannelMiniCard({ icon, title, desc, state, href }: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  state: { tone: "success" | "muted" | "warning"; label: string } | null;
  href: string;
}) {
  return (
    <div className="group flex flex-col rounded-2xl border bg-card p-5 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-lg hover:shadow-black/[0.05]">
      <div className="flex items-start justify-between gap-3">
        {icon}
        {state && <StatePill tone={state.tone}>{state.label}</StatePill>}
      </div>
      <p className="mt-3 text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
      <Button asChild variant="outline" size="sm" className="mt-4 w-fit">
        <Link href={href}>Configurar</Link>
      </Button>
    </div>
  );
}

/** Canal Widget con dos vistas (patrón referencia): Instalar (conectar/embeber)
 *  y Personalizar (colores, tema, identidad — lo que era la pestaña Apariencia). */
function WidgetSection({ channels, refresh }: { channels: ChannelsState; refresh: () => void }) {
  const params = useSearchParams();
  const [sub, setSub] = useState<"instalar" | "personalizar">(
    params.get("sub") === "personalizar" ? "personalizar" : "instalar",
  );
  useEffect(() => {
    const s = params.get("sub");
    if (s === "personalizar" || s === "instalar") setSub(s);
  }, [params]);

  return (
    <div className="space-y-4">
      {/* En desktop el switch Instalar/Personalizar vive en la barra del título;
          acá queda solo para mobile (que no tiene esa barra de acciones). */}
      <div className="flex w-fit rounded-lg bg-muted/60 p-0.5 lg:hidden">
        {([["instalar", "Instalar"], ["personalizar", "Personalizar"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSub(key)}
            className={cn(
              "rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors",
              sub === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === "instalar"
        ? <WidgetCard channels={channels} onChanged={refresh} />
        : <AppearanceSettings />}
    </div>
  );
}

// ── Card: Chat web (widget) ───────────────────────────────────────────────────

function WidgetCard({ channels, onChanged }: { channels: ChannelsState; onChanged: () => void }) {
  const { tenantId } = useAuthStore();
  const enabled = channels.widget.enabled;
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });

  const toggleM = useMutation({
    mutationFn: () => api.channels.toggleWidget(!enabled),
    onSuccess: () => {
      onChanged();
      toast({ title: !enabled ? "Chat web activado" : "Chat web desactivado", variant: "success" });
    },
    onError: () => toast({ title: "Error al cambiar el estado", variant: "destructive" }),
  });

  const tokenM = useMutation({
    mutationFn: () => api.tenants.generateWidgetToken(tenantId!),
    onSuccess: (data) => {
      setWidgetToken(data.widget_token);
      toast({ title: "Token generado", variant: "success" });
    },
    onError: () => toast({ title: "No se pudo generar el token", variant: "destructive" }),
  });

  // Mostrar el token ACTUAL (descifrado) sin regenerar — no invalida el instalado.
  const showM = useMutation({
    mutationFn: () => api.tenants.getWidgetToken(tenantId!),
    onSuccess: (data) => { setWidgetToken(data.widget_token); },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast({
        title: status === 404
          ? "Regenerá el token una vez para poder copiarlo sin regenerar"
          : "No se pudo obtener el token",
        variant: status === 404 ? "default" : "destructive",
      });
    },
  });

  const widgetScript = widgetToken
    ? `<script\n  src="${window.location.origin}/widget/widget.js"\n  data-api-url="${window.location.origin}"\n  data-token="${widgetToken}"\n  data-title="${botConfig?.bot_name || DEFAULT_BOT_NAME}"\n  data-placeholder="Hacé tu consulta..."\n></script>`
    : null;

  const hasToken = channels.widget.has_token || !!widgetToken;

  return (
    // Centrado (patrón install de la referencia): un componente en el medio,
    // no una card estirada de lado a lado.
    <div className="mx-auto w-full max-w-3xl space-y-5 py-6 sm:py-8 xl:max-w-4xl xl:py-14">
      {/* ── Hero: conectar el asistente (patrón install de la referencia) ── */}
      <Card className="overflow-hidden rounded-2xl">
        <div className="grid items-center gap-6 p-6 sm:grid-cols-[1fr_auto] xl:gap-10 xl:p-9">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold tracking-tight text-foreground">Conectá el asistente a tu sitio</h3>
              <StatePill tone={enabled ? "success" : "muted"}>{enabled ? "Activo" : "Desactivado"}</StatePill>
            </div>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              Copiá el código y pegalo en tu web. En minutos el asistente atiende a tus visitantes.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {!hasToken ? (
                <Button onClick={() => tokenM.mutate()} disabled={tokenM.isPending}>
                  {tokenM.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Code2 className="mr-1.5 h-4 w-4" />}
                  Generar código
                </Button>
              ) : !widgetToken ? (
                <Button onClick={() => showM.mutate()} disabled={showM.isPending}>
                  {showM.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Code2 className="mr-1.5 h-4 w-4" />}
                  Ver código de instalación
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => toggleM.mutate()} disabled={toggleM.isPending}>
                {toggleM.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  : enabled ? <Pause className="mr-1.5 h-4 w-4" /> : <Play className="mr-1.5 h-4 w-4" />}
                {enabled ? "Desactivar" : "Activar"}
              </Button>
            </div>
          </div>
          <InstallMock />
        </div>
        <div className="border-t bg-muted/30 px-6 py-2.5 text-[11px] text-muted-foreground">
          Funciona en WordPress, Shopify, Google Tag Manager o cualquier sitio HTML.
        </div>
      </Card>

      {/* ── Código de instalación (cuando hay token descifrado) ── */}
      {widgetToken && widgetScript && (
        <Card className="animate-fade-in-up rounded-2xl">
          <CardContent className="space-y-4 p-6">
            <div className="flex items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Code2 className="h-4 w-4 text-muted-foreground" /> Código de instalación
              </h4>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground" onClick={() => tokenM.mutate()} disabled={tokenM.isPending}>
                  <RefreshCw className={cn("h-3.5 w-3.5", tokenM.isPending && "animate-spin")} /> Regenerar
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => setWidgetToken(null)} aria-label="Cerrar código" title="Ocultar código">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <ol className="space-y-1.5 text-xs text-muted-foreground">
              <li><span className="font-semibold text-foreground/80">1.</span> Copiá el código de abajo.</li>
              <li><span className="font-semibold text-foreground/80">2.</span> Pegalo antes de <code className="rounded bg-muted px-1 font-mono">&lt;/body&gt;</code> en todas las páginas de tu sitio.</li>
              <li><span className="font-semibold text-foreground/80">3.</span> Guardá y recargá — el asistente aparece solo.</li>
            </ol>

            <div className="relative">
              {/* Fondo oscuro FIJO (no bg-foreground, que en dark se vuelve blanco).
                  Wrap + scroll vertical: las líneas largas bajan, no van al costado. */}
              <pre className="max-h-72 overflow-y-auto scrollbar-slim whitespace-pre-wrap break-all rounded-xl bg-[#0f172a] p-4 pr-12 text-xs leading-relaxed text-slate-200">{widgetScript}</pre>
              <Button
                size="icon" variant="ghost"
                className="absolute right-2 top-2 h-8 w-8 text-slate-300 hover:bg-white/10 hover:text-white"
                onClick={() => { navigator.clipboard.writeText(widgetScript); setCopied(true); setTimeout(() => setCopied(false), 2000); toast({ title: "Código copiado", variant: "success" }); }}
                aria-label="Copiar código"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-[11px] text-warning">Al regenerar, el código anterior deja de funcionar.</p>
          </CardContent>
        </Card>
      )}

      <p className="text-center text-xs text-muted-foreground">
        ¿No sabés dónde pegarlo? Pedile a quien administra tu sitio que lo agregue antes del cierre del <code className="rounded bg-muted px-1 font-mono">&lt;/body&gt;</code>.
      </p>
    </div>
  );
}

/** Ilustración del hero: mini navegador con el widget en la esquina. */
function InstallMock() {
  return (
    <div className="hidden w-60 shrink-0 overflow-hidden rounded-xl border shadow-sm sm:block xl:w-72">
      <div className="flex items-center gap-1 bg-[#26272b] px-2.5 py-1.5">
        {[0, 1, 2].map(i => <span key={i} className="h-2 w-2 rounded-full bg-white/25" />)}
      </div>
      <div className="relative h-28 bg-white p-3 dark:bg-[#15181b] xl:h-40">
        <div className="space-y-1.5" aria-hidden>
          <div className="h-10 rounded-md bg-slate-200/80 dark:bg-white/10" />
          <div className="h-1.5 w-4/5 rounded-full bg-slate-200/80 dark:bg-white/10" />
          <div className="h-1.5 w-3/5 rounded-full bg-slate-200/80 dark:bg-white/10" />
        </div>
        <span className="absolute bottom-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-action-gradient text-white shadow-md">
          <MessageCircle className="h-4 w-4" />
        </span>
      </div>
    </div>
  );
}

// ── Panel visual del alta de WhatsApp ─────────────────────────────────────────
// Acompaña al formulario: un mini chat de WhatsApp (identidad) + un stepper que
// muestra en qué parte del proceso está. Sólo desktop (en mobile va la guía de texto).
function WhatsAppSetupAside({ editing }: { editing: boolean }) {
  const steps = [
    { n: 1, label: "Crear la app en Meta" },
    { n: 2, label: "Cargar credenciales" },
    { n: 3, label: "Configurar el webhook" },
    { n: 4, label: "Probar y activar" },
  ];
  // En alta: paso 2 activo (paso 1 ya hecho fuera de acá). En edición: todo hecho.
  const stateOf = (n: number): "done" | "active" | "pending" =>
    editing ? "done" : n < 2 ? "done" : n === 2 ? "active" : "pending";

  return (
    <aside className="hidden border-t bg-gradient-to-b from-[#25D366]/10 via-emerald-50/60 to-transparent p-5 lg:block lg:border-l lg:border-t-0 dark:from-[#25D366]/15 dark:via-emerald-500/[0.06] dark:to-transparent">
      {/* Mini chat de WhatsApp — identidad */}
      <div className="overflow-hidden rounded-xl border bg-white shadow-sm dark:border-white/10 dark:bg-[#15181b]">
        <div className="flex items-center gap-2 bg-[#075E54] px-3 py-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15">
            <WhatsAppIcon className="h-3.5 w-3.5 text-white" />
          </span>
          <div className="leading-tight">
            <p className="text-[11px] font-semibold text-white">Tu negocio</p>
            <p className="text-[9px] text-emerald-100/80">en línea</p>
          </div>
        </div>
        <div className="space-y-1.5 bg-[#ECE5DD] p-3 dark:bg-[#0b141a]">
          <div className="max-w-[85%] rounded-lg rounded-tl-sm bg-white px-2.5 py-1.5 text-[10px] leading-snug text-slate-700 shadow-sm dark:bg-white/10 dark:text-slate-200">
            Hola 👋 ¿Atienden por acá?
          </div>
          <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-sm bg-[#DCF8C6] px-2.5 py-1.5 text-[10px] leading-snug text-slate-800 shadow-sm dark:bg-[#005c4b] dark:text-slate-100">
            ¡Sí! Contame en qué te ayudo.
          </div>
        </div>
      </div>

      {/* Stepper del proceso */}
      <ol className="mt-5 space-y-3">
        {steps.map(s => {
          const st = stateOf(s.n);
          return (
            <li key={s.n} className="flex items-center gap-2.5">
              <span className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                st === "done"   ? "bg-success/15 text-success"
                : st === "active" ? "bg-[#25D366] text-white shadow-sm ring-2 ring-[#25D366]/25"
                :                   "border border-border bg-card text-muted-foreground/60",
              )}>
                {st === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : s.n}
              </span>
              <span className={cn(
                "text-xs",
                st === "active" ? "font-semibold text-foreground"
                : st === "done" ? "text-muted-foreground"
                :                 "text-muted-foreground/70",
              )}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

// ── Card: WhatsApp Business ───────────────────────────────────────────────────

function WhatsAppCard({ channels, onChanged }: { channels: ChannelsState; onChanged: () => void }) {
  const wa = channels.whatsapp;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Sin configurar: primero un hero simple (patrón referencia); el formulario
  // técnico recién aparece al tocar "Conectar".
  const [startedSetup, setStartedSetup] = useState(false);

  // Form de credenciales
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");

  const showForm = !wa || editing;

  const saveM = useMutation({
    mutationFn: () => api.channels.saveWhatsApp({
      phone_number_id: phoneNumberId.trim(),
      waba_id: wabaId.trim() || null,
      access_token: accessToken.trim() || null,  // vacío en edición = mantener el guardado
      app_secret: appSecret.trim() || null,      // vacío = mantener el guardado
    }),
    onSuccess: () => {
      onChanged();
      setEditing(false);
      setAccessToken(""); setAppSecret("");
      toast({ title: "Credenciales guardadas", description: "Configurá el webhook en Meta y probá la conexión.", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: extractErrorMessage(err, "No se pudieron guardar las credenciales."), variant: "destructive" });
    },
  });

  const testM = useMutation({
    mutationFn: api.channels.testWhatsApp,
    onSuccess: (data) => {
      onChanged();
      toast({
        title: "Conexión verificada",
        description: data.display_phone ? `Número: ${data.display_phone}` : undefined,
        variant: "success",
      });
    },
    onError: (err: any) => {
      onChanged();
      toast({ title: extractErrorMessage(err, "La prueba de conexión falló."), variant: "destructive" });
    },
  });

  const toggleM = useMutation({
    mutationFn: () => api.channels.toggleWhatsApp(!(wa?.enabled)),
    onSuccess: () => {
      onChanged();
      toast({ title: wa?.enabled ? "WhatsApp pausado" : "WhatsApp activado", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: extractErrorMessage(err, "No se pudo cambiar el estado."), variant: "destructive" });
    },
  });

  const deleteM = useMutation({
    mutationFn: api.channels.deleteWhatsApp,
    onSuccess: () => { onChanged(); setConfirmDelete(false); toast({ title: "Configuración eliminada", variant: "success" }); },
    onError: () => toast({ title: "Error al eliminar", variant: "destructive" }),
  });

  const pill = !wa
    ? <StatePill tone="muted">Sin configurar</StatePill>
    : wa.enabled
    ? <StatePill tone="success">Activo</StatePill>
    : wa.status === "active"
    ? <StatePill tone="muted">Pausado</StatePill>
    : wa.status === "error"
    ? <StatePill tone="destructive">Error</StatePill>
    : <StatePill tone="warning">Pendiente de prueba</StatePill>;

  // Mientras el canal no esté probado (pendiente/error), "Probar conexión" es el
  // paso previo obligatorio para activar → queda visible afuera (no escondido en el
  // menú), para no romper el onboarding. Una vez probado, pasa al menú ⋮.
  const needsTest = !!wa && !wa.enabled && wa.status !== "active";

  const startEditing = () => {
    if (!wa) return;
    setPhoneNumberId(wa.phone_number_id);
    setWabaId(wa.waba_id ?? "");
    setAccessToken(""); setAppSecret("");
    setEditing(true);
  };

  // ── Estado sin conectar: hero centrado (patrón referencia) ──────────────────
  // Cuando Intellix sea Tech Provider de Meta, el CTA pasa a ser el Embedded
  // Signup ("Continuar con Facebook") y este formulario queda como vía manual.
  if (!wa && !startedSetup) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center px-6 py-14 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#25D366] shadow-sm">
              <WhatsAppIcon className="h-9 w-9 text-white" />
            </span>
            <h3 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
              Traé WhatsApp a tu bandeja de entrada
            </h3>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              Los mensajes de WhatsApp aparecen como conversaciones: los responde el mismo
              asistente y, cuando hace falta, tus operadores.
            </p>
            <Button className="mt-6" onClick={() => setStartedSetup(true)}>
              Conectar WhatsApp Business
            </Button>
            <a
              href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
              target="_blank" rel="noopener noreferrer"
              className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              ¿Qué necesito? Ver la guía de Meta
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Estado de conexión resuelto en una frase clara (banner) para el modo conectado.
  const connState = !wa || showForm ? null
    : wa.enabled       ? { tone: "success" as const, text: "Conectado — recibiendo y respondiendo mensajes." }
    : needsTest        ? { tone: "warning" as const, text: "Falta probar la conexión para poder activar el canal." }
    :                    { tone: "muted"   as const, text: "Pausado — el canal no está recibiendo mensajes." };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">

      {/* ── Encabezado + estado del canal ── */}
      <Card className="rounded-2xl">
        <CardContent className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#25D366] shadow-sm">
                <WhatsAppIcon className="h-6 w-6 text-white" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-foreground">WhatsApp Business</h3>
                  {pill}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {wa?.display_phone
                    ? <>Número conectado: <span className="font-medium text-foreground/80">{wa.display_phone}</span></>
                    : "Atendé a tus clientes por WhatsApp con el mismo asistente y los mismos operadores."}
                </p>
              </div>
            </div>
            {wa && !showForm && (
              <div className="flex shrink-0 items-center gap-2">
                {needsTest && (
                  <Button variant="outline" size="sm" onClick={() => testM.mutate()} disabled={testM.isPending}>
                    {testM.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PlugZap className="mr-1.5 h-4 w-4" />}
                    Probar conexión
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={wa.enabled ? "outline" : "default"}
                  onClick={() => toggleM.mutate()}
                  disabled={toggleM.isPending || (!wa.enabled && (wa.status !== "active" || !wa.has_app_secret))}
                  title={
                    !wa.enabled && wa.status !== "active" ? "Probá la conexión antes de activar"
                    : !wa.enabled && !wa.has_app_secret ? "Configurá el App Secret antes de activar (es obligatorio)"
                    : undefined
                  }
                >
                  {toggleM.isPending
                    ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    : wa.enabled ? <Pause className="mr-1.5 h-4 w-4" /> : <Play className="mr-1.5 h-4 w-4" />}
                  {wa.enabled ? "Pausar" : "Activar"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Acciones del canal">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {!needsTest && (
                      <DropdownMenuItem onSelect={() => testM.mutate()} disabled={testM.isPending}>
                        <PlugZap className="mr-2 h-4 w-4" /> Probar conexión
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={startEditing}>
                      <Pencil className="mr-2 h-4 w-4" /> Editar credenciales
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setConfirmDelete(true)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> Eliminar configuración
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>

          {/* Banner de estado: dice en una frase si está conectado, pausado o falta probar */}
          {connState && (
            <div className={cn(
              "mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3",
              connState.tone === "success" ? "border-success/30 bg-success/[0.06]"
              : connState.tone === "warning" ? "border-warning/30 bg-warning/[0.08]"
              : "border-border bg-muted/40",
            )}>
              {connState.tone === "success"
                ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                : connState.tone === "warning"
                  ? <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                  : <Pause className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="text-sm font-medium text-foreground">{connState.text}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Formulario de conexión (alta o edición) ── */}
      {showForm ? (
        <Card className="overflow-hidden rounded-2xl">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
          <CardContent className="space-y-5 p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <PlugZap className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-foreground">
                  {editing ? "Editar credenciales" : "Conectá tu número de WhatsApp"}
                </h4>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Cargá los datos de tu app de WhatsApp Cloud API. Al guardar te damos la URL y el verify token para el webhook en Meta.
                </p>
              </div>
            </div>

            {/* Guía breve — sólo mobile (en desktop lo cubre el stepper visual del costado) */}
            {!editing && (
              <div className="rounded-xl border bg-muted/30 p-4 lg:hidden">
                <p className="text-xs font-semibold text-foreground">Cómo obtener estos datos</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground marker:text-muted-foreground/60">
                  <li>Creá una app en <span className="font-medium text-foreground/70">developers.facebook.com</span> con el producto WhatsApp y dá de alta tu número.</li>
                  <li>Copiá el <span className="font-medium text-foreground/70">Phone number ID</span> y generá un <span className="font-medium text-foreground/70">token permanente</span> (system user).</li>
                  <li>Guardá acá y pegá el webhook que te damos en Meta.</li>
                </ol>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wa-pnid">Phone number ID</Label>
                <Input id="wa-pnid" value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)}
                       placeholder="123456789012345" className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wa-waba">WABA ID <span className="font-normal text-muted-foreground">(opcional)</span></Label>
                <Input id="wa-waba" value={wabaId} onChange={e => setWabaId(e.target.value)}
                       placeholder="ID de la cuenta de WhatsApp Business" className="font-mono" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="wa-token" className="flex items-center gap-2">
                  Token de acceso permanente
                  {editing && <SavedBadge>Guardado</SavedBadge>}
                </Label>
                <Input id="wa-token" type="password" value={accessToken} onChange={e => setAccessToken(e.target.value)}
                       placeholder={editing ? "••••••••••••••••••••" : "EAAG…"} autoComplete="off"
                       className={cn("font-mono", editing && "placeholder:text-foreground/75 placeholder:tracking-wider")} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="wa-secret" className="flex flex-wrap items-center gap-2">
                  App secret
                  {editing && wa?.has_app_secret && <SavedBadge>Guardada</SavedBadge>}
                </Label>
                <Input id="wa-secret" type="password" value={appSecret} onChange={e => setAppSecret(e.target.value)}
                       placeholder={editing && wa?.has_app_secret ? "••••••••••••••••••••" : "Configuración de la app → Básica → Clave secreta"}
                       autoComplete="off"
                       className={cn("font-mono", editing && wa?.has_app_secret && "placeholder:text-foreground/75 placeholder:tracking-wider")} />
              </div>
            </div>

            {editing && (
              <p className="text-[11px] text-muted-foreground">
                Los valores guardados se ocultan por seguridad. Dejá el campo vacío para conservarlos.
              </p>
            )}

            <div className="flex justify-end gap-2">
              {editing ? (
                <Button variant="outline" onClick={() => setEditing(false)}>Cancelar</Button>
              ) : (
                <Button variant="outline" onClick={() => setStartedSetup(false)}>Volver</Button>
              )}
              <Button
                onClick={() => saveM.mutate()}
                disabled={
                  !phoneNumberId.trim()
                  || (!editing && accessToken.trim().length < 20)
                  || (accessToken.trim().length > 0 && accessToken.trim().length < 20)
                  || saveM.isPending
                }
              >
                {saveM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Guardar credenciales
              </Button>
            </div>
          </CardContent>

          {/* Panel visual: dónde estás en el proceso + identidad de WhatsApp */}
          <WhatsAppSetupAside editing={editing} />
          </div>
        </Card>
      ) : wa && (
        /* ── Conectado: datos del webhook para pegar en Meta ── */
        <Card className="rounded-2xl">
          <CardContent className="space-y-4 p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Code2 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-foreground">Webhook en Meta</h4>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Pegá estos dos datos en la configuración de webhooks de tu app de Meta.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <CopyField label="URL del webhook" value={channels.webhook_url} />
              <SecretField label="Verify token" value={wa.verify_token} />
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
              <span>Phone number ID: <code className="font-mono">{wa.phone_number_id}</code></span>
              {wa.waba_id && <span>WABA: <code className="font-mono">{wa.waba_id}</code></span>}
              {wa.last_verified_at && (
                <span>Última verificación: {new Date(wa.last_verified_at).toLocaleString("es-AR")}</span>
              )}
              {!wa.has_app_secret && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" /> Sin app secret: los webhooks no se validan por firma.
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Confirmación de borrado */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div className="min-w-0 space-y-1.5 pt-0.5">
                <DialogTitle>Eliminar configuración de WhatsApp</DialogTitle>
                <DialogDescription>
                  El canal deja de recibir y enviar mensajes. Las conversaciones existentes no se borran.
                  Vas a tener que volver a cargar las credenciales para reconectarlo.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={() => deleteM.mutate()} disabled={deleteM.isPending}>
              {deleteM.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
