"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Settings, Key, Copy, Check, RefreshCw, Loader2, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";

export default function SettingsPage() {
  const { tenantId, userEmail: email, userRole: role } = useAuthStore();
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="h-6 w-6 text-primary" />
          Configuración
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Configuración del tenant y herramientas de integración
        </p>
      </div>

      {/* Info del tenant */}
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

      {/* Widget Token */}
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

      {/* API Docs */}
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
