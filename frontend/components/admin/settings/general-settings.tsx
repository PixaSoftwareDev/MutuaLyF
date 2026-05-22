"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Copy, Check, RefreshCw, Loader2, Save, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

export function GeneralSettings() {
  const qc = useQueryClient();
  const { tenantId } = useAuthStore();
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [botName, setBotName] = useState("");
  const [botDescription, setBotDescription] = useState("");
  const [greetingMessage, setGreetingMessage] = useState("");

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });

  const { data: botsData, isLoading: botsLoading } = useQuery({
    queryKey: ["assigned-templates"],
    queryFn: api.promptTemplates.listAssigned,
  });

  useEffect(() => {
    if (botConfig) {
      setBotName(botConfig.bot_name ?? "");
      setBotDescription(botConfig.bot_description ?? "");
      setGreetingMessage(botConfig.greeting_message ?? "");
    }
  }, [botConfig]);

  // Dirty flags por sección — guardado independiente
  const identityDirty    = botConfig != null && (botName.trim() !== (botConfig.bot_name ?? ""));
  const descriptionDirty = botConfig != null && (botDescription !== (botConfig.bot_description ?? ""));
  const greetingDirty    = botConfig != null && (greetingMessage !== (botConfig.greeting_message ?? ""));

  const saveIdentityM = useMutation({
    mutationFn: () => api.tenants.updateBotConfig(tenantId!, {
      bot_name: botName.trim() || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      toast({ title: "Nombre actualizado", variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const saveDescriptionM = useMutation({
    mutationFn: () => api.tenants.updateBotConfig(tenantId!, {
      bot_description: botDescription.trim() || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      toast({ title: "Descripción actualizada", variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const saveGreetingM = useMutation({
    mutationFn: () => api.tenants.updateBotConfig(tenantId!, {
      greeting_message: greetingMessage || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      toast({ title: "Mensaje de saludo actualizado", variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const activateM = useMutation({
    mutationFn: (id: string) => api.promptTemplates.activate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assigned-templates"] });
      toast({ title: "Personalidad activada", variant: "success" });
    },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al activar", variant: "destructive" }),
  });

  const tokenMutation = useMutation({
    mutationFn: () => api.tenants.generateWidgetToken(tenantId!),
    onSuccess: (data) => {
      setWidgetToken(data.widget_token);
      toast({ title: "Token generado", variant: "success" });
    },
    onError: () => toast({ title: "Error", description: "No se pudo generar el token.", variant: "destructive" }),
  });

  const copyToken = () => {
    if (!widgetToken) return;
    navigator.clipboard.writeText(widgetToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Copiado", description: "Token copiado al portapapeles.", variant: "success" });
  };

  const widgetScript = widgetToken
    ? `<script\n  src="${window.location.origin}/widget/widget.js"\n  data-token="${widgetToken}"\n  data-title="Asistente"\n  data-placeholder="Hacé tu consulta..."\n></script>`
    : null;

  const templates = botsData?.templates ?? [];
  const activeTemplate = templates.find(t => t.is_active);

  return (
    <div className="space-y-6">

      {/* ── Identidad del bot ── */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Identidad del bot</h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5 max-w-md">
            <Label htmlFor="bot-name" className="text-xs">Nombre del bot</Label>
            <Input
              id="bot-name"
              value={botName}
              onChange={e => setBotName(e.target.value)}
              maxLength={80}
              placeholder="Ej. Aria, Asistente, Bot Soporte"
            />
          </div>

          {identityDirty && (
            <Button
              size="sm"
              onClick={() => saveIdentityM.mutate()}
              disabled={saveIdentityM.isPending}
            >
              {saveIdentityM.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <Save className="h-4 w-4 mr-1" />}
              Guardar
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ── Descripción del bot ── */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Descripción del bot</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Guía al asistente en cada conversación. Editala con cuidado: define quién es, a quién atiende y cómo se comporta.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={botDescription}
            onChange={e => setBotDescription(e.target.value)}
            rows={10}
            placeholder="Sin descripción aún. Completá el onboarding o escribila acá."
            className="text-sm resize-none leading-relaxed"
          />
          {descriptionDirty && (
            <Button
              size="sm"
              onClick={() => saveDescriptionM.mutate()}
              disabled={saveDescriptionM.isPending}
            >
              {saveDescriptionM.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <Save className="h-4 w-4 mr-1" />}
              Guardar
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ── Mensaje de saludo ── */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Mensaje de saludo</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={greetingMessage}
            onChange={e => setGreetingMessage(e.target.value)}
            placeholder="¡Hola! Soy tu asistente virtual. ¿En qué puedo ayudarte?"
            rows={2}
            className="text-sm resize-none"
          />
          {greetingDirty && (
            <Button
              size="sm"
              onClick={() => saveGreetingM.mutate()}
              disabled={saveGreetingM.isPending}
            >
              {saveGreetingM.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <Save className="h-4 w-4 mr-1" />}
              Guardar
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ── Personalidad ── */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Personalidad</h2>
        </CardHeader>
        <CardContent>
          {botsLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : templates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Sin personalidades disponibles. El administrador de la plataforma puede habilitarte opciones.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map(t => {
                const isActive = t.is_active;
                const isPending = activateM.isPending && activateM.variables === t.id;
                return (
                  <button
                    key={t.id}
                    disabled={isActive || activateM.isPending}
                    onClick={() => !isActive && activateM.mutate(t.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                      isActive
                        ? "border-primary bg-primary/5 ring-1 ring-primary cursor-default"
                        : "border-border hover:border-primary/40 hover:bg-muted/50"
                    )}
                  >
                    <div className="mt-0.5 shrink-0">
                      {isActive
                        ? <CheckCircle2 className="h-4 w-4 text-primary" />
                        : isPending
                          ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          : <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
                      }
                    </div>
                    <div className="min-w-0">
                      <p className={cn("text-sm font-medium truncate", isActive && "text-primary")}>{t.nombre}</p>
                      {t.descripcion && <p className="text-xs text-muted-foreground mt-0.5 leading-snug line-clamp-2">{t.descripcion}</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Widget Token ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-semibold text-sm flex items-center gap-2">
              <Key className="h-4 w-4" /> Widget Token
            </h2>
            <Button
              size="sm"
              variant={widgetToken ? "outline" : "default"}
              onClick={() => tokenMutation.mutate()}
              disabled={tokenMutation.isPending}
            >
              {tokenMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <RefreshCw className="h-4 w-4 mr-1" />}
              {widgetToken ? "Regenerar" : "Generar"}
            </Button>
          </div>
        </CardHeader>

        {widgetToken && (
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted rounded px-3 py-2 break-all font-mono">
                {widgetToken.slice(0, 60)}…
              </code>
              <Button size="icon" variant="outline" className="shrink-0 h-8 w-8" onClick={copyToken}>
                {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <pre className="text-xs bg-muted rounded p-3 overflow-x-auto whitespace-pre">{widgetScript}</pre>
            <p className="text-[11px] text-amber-700">
              Al regenerar, el token anterior queda invalidado.
            </p>
          </CardContent>
        )}
      </Card>

    </div>
  );
}
