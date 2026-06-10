"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Copy, Check, RefreshCw, Key, Globe, MessageCircle,
  PlugZap, Pause, Play, Trash2, AlertTriangle,
} from "lucide-react";
import { api, type ChannelsState } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
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
        <Skeleton className="h-56 rounded-2xl" />
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

  return (
    <div className="space-y-6">
      <WidgetCard channels={channels} onChanged={refresh} />
      <WhatsAppCard channels={channels} onChanged={refresh} />
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

  const widgetScript = widgetToken
    ? `<script\n  src="${window.location.origin}/widget/widget.js"\n  data-api-url="${window.location.origin}"\n  data-token="${widgetToken}"\n  data-title="${botConfig?.bot_name || DEFAULT_BOT_NAME}"\n  data-placeholder="Hacé tu consulta..."\n></script>`
    : null;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
              <Globe className="h-5 w-5 text-action" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-base">Chat web (widget)</CardTitle>
                <StatePill tone={enabled ? "success" : "muted"}>{enabled ? "Activo" : "Desactivado"}</StatePill>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                El chat embebido en tu sitio web y la página de consulta.
              </p>
            </div>
          </div>
          <Button
            variant="outline" size="sm" className="shrink-0"
            onClick={() => toggleM.mutate()}
            disabled={toggleM.isPending}
          >
            {toggleM.isPending
              ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : enabled ? <Pause className="h-4 w-4 mr-1.5" /> : <Play className="h-4 w-4 mr-1.5" />}
            {enabled ? "Desactivar" : "Activar"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <Key className="h-4 w-4 text-muted-foreground" /> Token e instalación
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Generá el token y pegá el snippet en tu web para incrustar el asistente.
            </p>
          </div>
          <Button
            size="sm"
            variant={widgetToken ? "outline" : "default"}
            onClick={() => tokenM.mutate()}
            disabled={tokenM.isPending}
            className="shrink-0"
          >
            {tokenM.isPending
              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
              : <RefreshCw className="h-4 w-4 mr-1" />}
            {widgetToken || channels.widget.has_token ? "Regenerar token" : "Generar token"}
          </Button>
        </div>

        {widgetToken && widgetScript && (
          <>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted rounded-lg px-3 py-2 break-all font-mono">
                {widgetToken.slice(0, 60)}…
              </code>
              <Button
                size="icon" variant="outline" className="shrink-0 h-8 w-8" aria-label="Copiar token"
                onClick={() => {
                  navigator.clipboard.writeText(widgetToken);
                  setCopied(true); setTimeout(() => setCopied(false), 2000);
                  toast({ title: "Copiado al portapapeles", variant: "success" });
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <div className="relative">
              <pre className="text-xs bg-foreground text-background/90 rounded-xl p-4 pr-12 overflow-x-auto whitespace-pre leading-relaxed">{widgetScript}</pre>
              <Button
                size="icon" variant="ghost"
                className="absolute top-2 right-2 h-8 w-8 text-background/70 hover:text-background hover:bg-background/10"
                onClick={() => { navigator.clipboard.writeText(widgetScript); toast({ title: "Snippet copiado", variant: "success" }); }}
                aria-label="Copiar snippet"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-[11px] text-warning">Al regenerar, el token anterior queda invalidado.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card: WhatsApp Business ───────────────────────────────────────────────────

function WhatsAppCard({ channels, onChanged }: { channels: ChannelsState; onChanged: () => void }) {
  const wa = channels.whatsapp;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      access_token: accessToken.trim(),
      app_secret: appSecret.trim() || null,
    }),
    onSuccess: () => {
      onChanged();
      setEditing(false);
      setAccessToken(""); setAppSecret("");
      toast({ title: "Credenciales guardadas", description: "Configurá el webhook en Meta y probá la conexión.", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: typeof detail === "string" ? detail : "Error al guardar", variant: "destructive" });
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
      const detail = err?.response?.data?.detail ?? "La prueba falló";
      toast({ title: typeof detail === "string" ? detail : "La prueba falló", variant: "destructive" });
    },
  });

  const toggleM = useMutation({
    mutationFn: () => api.channels.toggleWhatsApp(!(wa?.enabled)),
    onSuccess: () => {
      onChanged();
      toast({ title: wa?.enabled ? "WhatsApp pausado" : "WhatsApp activado", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al cambiar el estado";
      toast({ title: typeof detail === "string" ? detail : "Error", variant: "destructive" });
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

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
              <MessageCircle className="h-5 w-5 text-action" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-base">WhatsApp Business</CardTitle>
                {pill}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {wa?.display_phone
                  ? <>Número conectado: <span className="font-medium text-foreground/80">{wa.display_phone}</span></>
                  : "Atendé a tus clientes por WhatsApp con el mismo asistente y los mismos operadores."}
              </p>
            </div>
          </div>
          {wa && !showForm && (
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => testM.mutate()} disabled={testM.isPending}>
                {testM.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PlugZap className="h-4 w-4 mr-1.5" />}
                Probar conexión
              </Button>
              <Button
                size="sm"
                variant={wa.enabled ? "outline" : "default"}
                onClick={() => toggleM.mutate()}
                disabled={toggleM.isPending || (!wa.enabled && wa.status !== "active")}
                title={!wa.enabled && wa.status !== "active" ? "Probá la conexión antes de activar" : undefined}
              >
                {toggleM.isPending
                  ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  : wa.enabled ? <Pause className="h-4 w-4 mr-1.5" /> : <Play className="h-4 w-4 mr-1.5" />}
                {wa.enabled ? "Pausar" : "Activar"}
              </Button>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {showForm ? (
          <>
            {/* Pasos del alta — el cliente da de alta el número en Meta y carga acá */}
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Creá la app en <span className="font-medium text-foreground/70">developers.facebook.com</span> con el producto WhatsApp y dá de alta tu número.</li>
              <li>Cargá acá el <span className="font-medium text-foreground/70">Phone number ID</span> y un <span className="font-medium text-foreground/70">token permanente</span> (system user).</li>
              <li>Configurá el webhook en Meta con la URL y el verify token que te damos al guardar.</li>
              <li>Probá la conexión y activá el canal.</li>
            </ol>

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
                <Label htmlFor="wa-token">Token de acceso permanente</Label>
                <Input id="wa-token" type="password" value={accessToken} onChange={e => setAccessToken(e.target.value)}
                       placeholder="EAAG…" autoComplete="off" className="font-mono" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="wa-secret">App secret <span className="font-normal text-muted-foreground">(recomendado — firma los webhooks)</span></Label>
                <Input id="wa-secret" type="password" value={appSecret} onChange={e => setAppSecret(e.target.value)}
                       placeholder="Configuración de la app → Básica → Clave secreta" autoComplete="off" className="font-mono" />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              {editing && (
                <Button variant="outline" onClick={() => setEditing(false)}>Cancelar</Button>
              )}
              <Button
                onClick={() => saveM.mutate()}
                disabled={!phoneNumberId.trim() || accessToken.trim().length < 20 || saveM.isPending}
              >
                {saveM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Guardar credenciales
              </Button>
            </div>
          </>
        ) : wa && (
          <>
            {/* Datos para configurar el webhook en Meta */}
            <div className="grid gap-4 sm:grid-cols-2">
              <CopyField label="URL del webhook (pegala en Meta)" value={channels.webhook_url} />
              <CopyField label="Verify token" value={wa.verify_token} />
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>Phone number ID: <code className="font-mono">{wa.phone_number_id}</code></span>
              {wa.waba_id && <span>WABA: <code className="font-mono">{wa.waba_id}</code></span>}
              {wa.last_verified_at && (
                <span>Última verificación: {new Date(wa.last_verified_at).toLocaleString("es-AR")}</span>
              )}
              {!wa.has_app_secret && (
                <span className="text-warning inline-flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" /> Sin app secret: los webhooks no se validan por firma.
                </span>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 pt-1 border-t border-border/60">
              <Button
                variant="ghost" size="sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4 mr-1.5" /> Eliminar configuración
              </Button>
              <Button variant="outline" size="sm" onClick={() => {
                setPhoneNumberId(wa.phone_number_id);
                setWabaId(wa.waba_id ?? "");
                setAccessToken(""); setAppSecret("");
                setEditing(true);
              }}>
                Editar credenciales
              </Button>
            </div>
          </>
        )}
      </CardContent>

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
              {deleteM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
