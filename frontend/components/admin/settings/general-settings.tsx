"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Copy, Check, RefreshCw, Loader2, ExternalLink, Bot, Save, Zap, Scale, Target, Shield, Code2, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

const SCORE_PRESETS = [
  {
    key: "amplio",
    label: "Amplio",
    value: 0.50,
    icon: Zap,
    description: "Responde con contexto general. Útil si los documentos son variados.",
  },
  {
    key: "equilibrado",
    label: "Equilibrado",
    value: 0.70,
    icon: Scale,
    description: "Buen balance entre cobertura y precisión. Recomendado para la mayoría.",
  },
  {
    key: "preciso",
    label: "Preciso",
    value: 0.77,
    icon: Target,
    description: "Solo responde cuando el contexto es claramente relevante.",
  },
  {
    key: "estricto",
    label: "Estricto",
    value: 0.85,
    icon: Shield,
    description: "Solo responde con información muy específica. Reduce respuestas ambiguas.",
  },
] as const;

export function GeneralSettings() {
  const qc = useQueryClient();
  const { tenantId, userEmail: email, userRole: role } = useAuthStore();
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });
  const [botDescription, setBotDescription] = useState("");
  const [botScope, setBotScope] = useState("");
  const [greetingMessage, setGreetingMessage] = useState("");
  const [promptQuery, setPromptQuery] = useState("");
  const [promptQualityGate, setPromptQualityGate] = useState("");
  const [promptClusterLabel, setPromptClusterLabel] = useState("");
  const [minScore, setMinScore] = useState(0.77);

  useEffect(() => {
    if (botConfig) {
      setBotDescription(botConfig.bot_description ?? "");
      setBotScope(botConfig.bot_scope ?? "");
      setGreetingMessage(botConfig.greeting_message ?? "");
      setPromptQuery(botConfig.prompt_query ?? "");
      setPromptQualityGate(botConfig.prompt_quality_gate ?? "");
      setPromptClusterLabel(botConfig.prompt_cluster_label ?? "");
      const stored = botConfig.min_retrieval_score;
      const nearest = SCORE_PRESETS.reduce((a, b) =>
        Math.abs(b.value - stored) < Math.abs(a.value - stored) ? b : a
      );
      setMinScore(nearest.value);
    }
  }, [botConfig]);

  const botConfigMutation = useMutation({
    mutationFn: () => api.tenants.updateBotConfig(tenantId!, {
      bot_description: botDescription || null,
      bot_scope: botScope || null,
      min_retrieval_score: minScore,
      greeting_message: greetingMessage || null,
      prompt_query: promptQuery || null,
      prompt_quality_gate: promptQualityGate || null,
      prompt_cluster_label: promptClusterLabel || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      toast({ title: "Configuración guardada", variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const tokenMutation = useMutation({
    mutationFn: () => api.tenants.generateWidgetToken(tenantId!),
    onSuccess: (data) => {
      setWidgetToken(data.widget_token);
      toast({ title: "Token generado", description: `Válido por ${data.expires_in_days} días.`, variant: "success" });
    },
    onError: () => {
      toast({ title: "Error", description: "No se pudo generar el token.", variant: "destructive" });
    },
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

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Información del tenant</h2>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Tenant ID" value={tenantId ?? "—"} mono />
          <Separator />
          <Row label="Email admin" value={email ?? "—"} />
          <Separator />
          <Row label="Rol" value={
            <Badge variant={role === "super_admin" ? "default" : "secondary"} className="text-xs">
              {role ?? "—"}
            </Badge>
          } />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <Key className="h-4 w-4" />
                Widget Token
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Token de 90 días para embeber el widget en tu sitio. Solo lectura, solo consultas.
              </p>
            </div>
            <Button
              size="sm"
              variant={widgetToken ? "outline" : "default"}
              onClick={() => tokenMutation.mutate()}
              disabled={tokenMutation.isPending}
            >
              {tokenMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <RefreshCw className="h-4 w-4 mr-1" />}
              {widgetToken ? "Regenerar" : "Generar token"}
            </Button>
          </div>
        </CardHeader>

        {widgetToken && (
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Token JWT</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-muted rounded px-3 py-2 break-all font-mono leading-relaxed">
                  {widgetToken.slice(0, 60)}…
                </code>
                <Button size="icon" variant="outline" className="shrink-0 h-8 w-8" onClick={copyToken}>
                  {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Código de instalación</p>
              <pre className="text-xs bg-muted rounded p-3 overflow-x-auto text-foreground whitespace-pre">
                {widgetScript}
              </pre>
              <p className="text-xs text-muted-foreground mt-2">
                Pegá este script antes del cierre del tag{" "}
                <code className="font-mono bg-muted px-1 rounded">&lt;/body&gt;</code> en tu sitio.
              </p>
            </div>

            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800 space-y-0.5">
              <p className="font-medium">Importante</p>
              <p>Al regenerar, el token anterior queda invalidado inmediatamente. Actualizá tu sitio antes de regenerar.</p>
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Comportamiento del bot
          </h2>
          <p className="text-xs text-muted-foreground">
            Definí qué temas puede responder y qué tan estricto es al buscar contexto relevante.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Mensaje de saludo del chat</label>
            <Textarea
              value={greetingMessage}
              onChange={e => setGreetingMessage(e.target.value)}
              placeholder={"¡Hola! 👋 Soy tu asistente virtual. ¿En qué área puedo ayudarte?"}
              rows={2}
              className="text-sm resize-none"
            />
            <p className="text-xs text-muted-foreground">
              Texto que aparece al abrir el chat widget, antes de elegir un sector.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Descripción del asistente</label>
            <Textarea
              value={botDescription}
              onChange={e => setBotDescription(e.target.value)}
              placeholder="Ej: Asistente de conocimiento interno de Acme Corp."
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Alcance del bot (scope)</label>
            <Textarea
              value={botScope}
              onChange={e => setBotScope(e.target.value)}
              placeholder="Ej: Responde únicamente sobre políticas internas, procedimientos de RRHH y manuales operativos. No responde preguntas de conocimiento general."
              rows={3}
              className="text-sm resize-none"
            />
            <p className="text-xs text-muted-foreground">
              Este texto se incluye en el system prompt del LLM en cada consulta.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium">Umbral mínimo de relevancia</label>
            <p className="text-xs text-muted-foreground">
              Si ningún fragmento supera este umbral, el bot responde que no tiene información — sin llamar al LLM.
            </p>
            <div className="grid grid-cols-2 gap-2 pt-1">
              {SCORE_PRESETS.map((preset) => {
                const Icon = preset.icon;
                const active = minScore === preset.value;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => setMinScore(preset.value)}
                    className={cn(
                      "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border hover:border-primary/40 hover:bg-muted/50"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className={cn("flex items-center gap-1.5", active ? "text-primary" : "text-muted-foreground")}>
                        <Icon className="h-3.5 w-3.5" />
                        <span className="text-xs font-semibold">{preset.label}</span>
                      </div>
                      <span className={cn(
                        "text-[10px] font-mono px-1.5 py-0.5 rounded",
                        active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                      )}>
                        {Math.round(preset.value * 100)}%
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug">{preset.description}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <Button
            size="sm"
            onClick={() => botConfigMutation.mutate()}
            disabled={botConfigMutation.isPending}
          >
            {botConfigMutation.isPending
              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
              : <Save className="h-4 w-4 mr-1" />}
            Guardar configuración
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Code2 className="h-4 w-4" />
            Prompts del sistema
          </h2>
          <p className="text-xs text-muted-foreground">
            Instrucciones que recibe la IA en cada operación. Dejá el campo vacío para usar el comportamiento por defecto del sistema.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <PromptField
            label="Prompt principal del asistente"
            description="Controla cómo responde el bot a cada consulta. Se aplica en tiempo real — no requiere reingesta."
            value={promptQuery}
            onChange={setPromptQuery}
            defaultText={DEFAULT_PROMPT_QUERY}
            rows={10}
          />
          <PromptField
            label="Prompt de validación de documentos (Quality Gate)"
            description="Se usa al ingestar documentos para decidir si un chunk es útil o ruido. Solo afecta ingestas futuras."
            value={promptQualityGate}
            onChange={setPromptQualityGate}
            defaultText={DEFAULT_PROMPT_QUALITY_GATE}
            rows={6}
          />
          <PromptField
            label="Prompt de etiquetado de intenciones"
            description="Se usa para sugerir nombres a los clusters de consultas detectados automáticamente."
            value={promptClusterLabel}
            onChange={setPromptClusterLabel}
            defaultText={DEFAULT_PROMPT_CLUSTER_LABEL}
            rows={4}
          />
          <Button
            size="sm"
            onClick={() => botConfigMutation.mutate()}
            disabled={botConfigMutation.isPending}
          >
            {botConfigMutation.isPending
              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
              : <Save className="h-4 w-4 mr-1" />}
            Guardar prompts
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Documentación de la API</p>
              <p className="text-xs text-muted-foreground">Swagger UI disponible en desarrollo</p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href="http://localhost:8000/docs" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-1" />
                Abrir docs
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Prompt defaults (mirror of backend DEFAULT_PROMPT_* constants) ─────────────

const DEFAULT_PROMPT_QUERY = `Eres un asistente de conocimiento institucional.
Tenés dos modos de respuesta según el tipo de mensaje:
MODO CONVERSACIONAL: Si el usuario saluda, agradece, hace un comentario informal o no formula una consulta concreta (ej: 'hola', 'gracias', '¿cómo estás?'), respondé de forma natural y amigable, e invitalo a hacer su consulta sobre los temas de la organización. En este modo ignorá el contexto.
MODO CONSULTA: Si el usuario hace una pregunta concreta, aplicá estas reglas:
1. Respondé DIRECTO y CONCISO, sin rodeos.
2. Usá SOLO la información del contexto proporcionado. Nunca inventes datos.
3. Para datos puntuales (número, fecha, nombre), respondé en una sola oración.
4. No repitas la pregunta ni agregues aclaraciones obvias.
5. Si la información no está en el contexto, decí: 'No encontré esa información en los documentos.'`;

const DEFAULT_PROMPT_QUALITY_GATE = `You are a document quality evaluator for institutional knowledge bases. Determine if the provided text chunk contains useful information that could answer questions from employees or members of an organization. Mark as coherent (true) if the chunk contains ANY of: policies, procedures, contact info, names and roles, schedules, benefits, or operational guidelines — even if it's part of a larger document. Mark as incoherent (false) ONLY if the chunk is pure noise: page numbers, repeated headers, garbled text, or completely empty content. Respond ONLY with valid JSON: {"is_coherent": true/false, "reason": "one sentence"}.`;

const DEFAULT_PROMPT_CLUSTER_LABEL = `Eres un asistente que nombra intenciones de usuario para un chatbot corporativo. Dado un grupo de consultas similares, devuelve UN nombre corto (2-5 palabras) en español que describa la intención común, en formato snake_case. Responde SOLO con el nombre, sin comillas ni explicaciones. Ejemplo: "consulta_vacaciones"`;

// ── PromptField component ──────────────────────────────────────────────────────

function PromptField({
  label, description, value, onChange, defaultText, rows,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  defaultText: string;
  rows: number;
}) {
  const isCustom = value.trim().length > 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <label className="text-xs font-medium">{label}</label>
          {isCustom && (
            <span className="ml-2 text-[10px] font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5">
              personalizado
            </span>
          )}
        </div>
        {isCustom && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Restaurar prompt por defecto"
          >
            <RotateCcw className="h-3 w-3" />
            Restaurar default
          </button>
        )}
      </div>
      <Textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={defaultText}
        rows={rows}
        className="text-sm font-mono resize-y"
      />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      {typeof value === "string"
        ? <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
        : value}
    </div>
  );
}
