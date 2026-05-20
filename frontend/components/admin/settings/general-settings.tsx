"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Copy, Check, RefreshCw, Loader2, Save, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

const SCORE_PRESETS = [
  { key: "amplio",      label: "Amplio",      value: 0.50 },
  { key: "equilibrado", label: "Equilibrado", value: 0.70 },
  { key: "preciso",     label: "Preciso",     value: 0.77 },
  { key: "estricto",    label: "Estricto",    value: 0.85 },
] as const;

export function GeneralSettings() {
  const qc = useQueryClient();
  const { tenantId } = useAuthStore();
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [greetingMessage, setGreetingMessage] = useState("");
  const [minScore, setMinScore] = useState(0.77);

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
      setGreetingMessage(botConfig.greeting_message ?? "");
      const stored = botConfig.min_retrieval_score;
      const nearest = SCORE_PRESETS.reduce((a, b) =>
        Math.abs(b.value - stored) < Math.abs(a.value - stored) ? b : a
      );
      setMinScore(nearest.value);
    }
  }, [botConfig]);

  const botConfigMutation = useMutation({
    mutationFn: () => api.tenants.updateBotConfig(tenantId!, {
      min_retrieval_score: minScore,
      greeting_message: greetingMessage || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      toast({ title: "Configuración guardada", variant: "success" });
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

      {/* ── Comportamiento ── */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Comportamiento</h2>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Mensaje de saludo</label>
            <Textarea
              value={greetingMessage}
              onChange={e => setGreetingMessage(e.target.value)}
              placeholder="¡Hola! Soy tu asistente virtual. ¿En qué puedo ayudarte?"
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium">Umbral mínimo de relevancia</label>
            <div className="grid grid-cols-4 gap-2">
              {SCORE_PRESETS.map((preset) => {
                const active = minScore === preset.value;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => setMinScore(preset.value)}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-md border px-2 py-2 text-center transition-colors",
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border hover:border-primary/40 hover:bg-muted/50"
                    )}
                  >
                    <span className={cn("text-xs font-semibold", active ? "text-primary" : "")}>{preset.label}</span>
                    <span className={cn("text-[10px] font-mono", active ? "text-primary/80" : "text-muted-foreground")}>
                      {Math.round(preset.value * 100)}%
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Define qué tan estricto es el bot al exigir relevancia del contexto antes de responder.
            </p>
          </div>

          <Button
            size="sm"
            onClick={() => botConfigMutation.mutate()}
            disabled={botConfigMutation.isPending}
          >
            {botConfigMutation.isPending
              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
              : <Save className="h-4 w-4 mr-1" />}
            Guardar
          </Button>
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

      {/* ── Identidad (read-only, contexto) ── */}
      {botConfig && (botConfig.bot_name || botConfig.bot_description) && (
        <Card>
          <CardHeader className="pb-3">
            <h2 className="font-semibold text-sm">Identidad del bot</h2>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {botConfig.bot_name && (
              <p><span className="text-muted-foreground">Nombre:</span> <span className="font-medium">{botConfig.bot_name}</span></p>
            )}
            {botConfig.bot_description && (
              <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{botConfig.bot_description}</p>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
