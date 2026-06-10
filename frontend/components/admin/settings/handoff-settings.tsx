"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Save, Eye } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import {
  ChatPreview, PreviewDialog,
  DEFAULT_BOT_NAME,
} from "@/components/admin/settings/chat-preview";

// Tres mensajes que cubren los tres momentos del flujo:
//   1. Bot detecta que conviene derivar (insuficiente N veces) -> handoff_offer
//   2. Afiliado acepta el cartel con nombre + DNI -> handoff_confirmed
//   3. Espera prolongada en cola -> operator_inactive_alert
const MESSAGE_KEYS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "handoff_offer",
    label: "Oferta del bot",
    hint: "Texto del cartel amarillo. Aparece cuando el bot no encuentra la respuesta tras N intentos seguidos (N se configura arriba).",
  },
  {
    key: "handoff_confirmed",
    label: "Confirmando derivación",
    hint: "Aparece cuando el afiliado acepta la oferta y completa nombre + DNI. La conversación pasa a la cola de operadores.",
  },
  {
    key: "operator_inactive_alert",
    label: "Espera prolongada",
    hint: "Recordatorio automático si el afiliado lleva varios minutos en cola sin que ningún operador acepte.",
  },
];

export function HandoffSettings() {
  const { tenantId } = useAuthStore();

  const { data: config, isLoading } = useQuery({
    queryKey: ["handoff-config"],
    queryFn: api.handoffConfig.get,
  });

  // Branding + identidad del bot solo para la vista previa.
  const { data: branding } = useQuery({
    queryKey: ["admin-branding"],
    queryFn: () => api.branding.getAdmin(),
    staleTime: 60_000,
  });
  const { data: botConfig } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });

  const [timeout, setTimeout_]   = useState(15);
  const [threshold, setThreshold] = useState(3);
  const [attentionHours, setAttentionHours] = useState("");
  const [contactInfo, setContactInfo] = useState("");
  const [messages, setMessages]   = useState<Record<string, string>>({});
  const [dirty, setDirty]         = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!config) return;
    setTimeout_(config.inactivity_timeout_minutes);
    setThreshold(config.consecutive_insufficient_count);
    setAttentionHours(config.attention_hours || "");
    setContactInfo(config.contact_info || "");
    setMessages(config.transition_messages || {});
  }, [config]);

  const updateM = useMutation({
    mutationFn: () => api.handoffConfig.update({
      inactivity_timeout_minutes:     timeout,
      consecutive_insufficient_count: threshold,
      attention_hours:                attentionHours,
      contact_info:                   contactInfo,
      transition_messages:            messages,
    }),
    onSuccess: () => { setDirty(false); toast({ title: "Configuración guardada", variant: "success" }); },
    onError:   (err: any) => {
      const detail = err?.response?.data?.detail || err?.message || "No se pudo guardar la configuración.";
      toast({
        title: "Error al guardar",
        description: typeof detail === "string" ? detail : "Intentá de nuevo.",
        variant: "destructive",
      });
    },
  });

  const setMessage = (key: string, value: string) => { setMessages({ ...messages, [key]: value }); setDirty(true); };

  if (isLoading) return (
    <div className="space-y-6">
      {[1, 2].map(i => <Skeleton key={i} className="h-48 rounded-2xl" />)}
    </div>
  );

  const previewConversation = [
    { from: "user" as const, text: "No encuentro lo que busco…" },
    { from: "bot" as const, note: "Oferta del bot",         text: messages["handoff_offer"] || "" },
    { from: "bot" as const, note: "Confirmando derivación", text: messages["handoff_confirmed"] || "" },
    { from: "bot" as const, note: "Espera prolongada",      text: messages["operator_inactive_alert"] || "" },
  ];

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
      {/* ── Columna izquierda: configuración ── */}
      <div className="space-y-6">
      {/* Reglas de activación */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-base tracking-tight">Cuándo derivar</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Las condiciones que activan el pase de la conversación a un operador humano.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Label className="text-sm whitespace-nowrap">Tras</Label>
            <Input
              type="number" min={2} max={10}
              value={threshold}
              onChange={e => { setThreshold(Number(e.target.value)); setDirty(true); }}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">respuestas insuficientes consecutivas del bot</span>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <Label className="text-sm whitespace-nowrap">Tras</Label>
            <Input
              type="number" min={1} max={120}
              value={timeout}
              onChange={e => { setTimeout_(Number(e.target.value)); setDirty(true); }}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">minutos sin atención del operador → avisar al usuario</span>
          </div>
          <Separator />
          <div className="space-y-1.5">
            <Label className="text-sm">Horario de atención</Label>
            <Input
              value={attentionHours}
              onChange={e => { setAttentionHours(e.target.value); setDirty(true); }}
              placeholder="Ej: Lunes a viernes de 7:30 a 18 hs"
              className="max-w-md"
            />
            <p className="text-[11px] text-muted-foreground leading-snug">
              Cuando no hay operadores conectados, el asistente no ofrece derivar y muestra este horario al afiliado. Dejalo vacío para no mostrar ningún horario.
            </p>
          </div>
          <Separator />
          <div className="space-y-1.5">
            <Label className="text-sm">Datos de contacto</Label>
            <Input
              value={contactInfo}
              onChange={e => { setContactInfo(e.target.value); setDirty(true); }}
              placeholder="Ej: Tel. 0342 452 0074 · recepcion@organizacion.com"
              className="max-w-md"
            />
            <p className="text-[11px] text-muted-foreground leading-snug">
              Teléfono o email de contacto. Se muestra al afiliado en dos casos: cuando no hay operadores disponibles, y cuando el asistente no encuentra la respuesta en los documentos (en vez de arriesgar un dato inventado). Dejalo vacío para usar un mensaje genérico.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Mensajes de transición — formato compacto: label + input lado a lado */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-semibold text-base tracking-tight">Mensajes durante la transición</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Lo que ve el usuario en cada momento del pase a un operador.
              </p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 xl:hidden" onClick={() => setShowPreview(true)}>
              <Eye className="h-4 w-4 mr-1.5" />
              Vista previa
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {MESSAGE_KEYS.map(({ key, label, hint }) => (
            <div key={key} className="grid grid-cols-1 sm:grid-cols-[220px,1fr] items-start gap-2 sm:gap-4">
              <div className="sm:pt-2">
                <Label className="text-xs text-foreground">{label}</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{hint}</p>
              </div>
              <Input
                value={messages[key] || ""}
                onChange={e => setMessage(key, e.target.value)}
                placeholder="Mensaje por defecto del sistema"
                className="h-9 text-sm"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Vista previa a demanda (pantallas chicas) — el flujo completo de
          derivación con los mensajes del form, aunque no estén guardados */}
      <PreviewDialog
        open={showPreview}
        onOpenChange={setShowPreview}
        hint="El flujo que ve el usuario cuando el bot deriva la conversación a un operador."
      >
        <ChatPreview
          botName={botConfig?.bot_name || DEFAULT_BOT_NAME}
          primaryColor={branding?.primary_color || "#4f46e5"}
          logoUrl={branding?.logo_url ?? null}
          conversation={previewConversation}
        />
      </PreviewDialog>

      {/* Guardar siempre visible (deshabilitado sin cambios) — mismo patrón que
          el resto de la app; el botón que aparecía y desaparecía era janky. */}
      <div className="flex justify-end">
        <Button onClick={() => updateM.mutate()} disabled={!dirty || updateM.isPending}>
          {updateM.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
          Guardar cambios
        </Button>
      </div>
      </div>

      {/* ── Columna derecha: réplica del flujo, fija (pantallas grandes) ── */}
      <aside className="hidden xl:block xl:sticky xl:top-6">
        <Card className="rounded-2xl">
          <CardHeader className="pb-3">
            <h2 className="font-semibold text-base tracking-tight">Vista previa</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              El flujo que ve el usuario al derivarse a un operador. Se actualiza con tus cambios.
            </p>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl bg-muted/30 border border-border/50 px-4 py-7">
              <div className="mx-auto max-w-[330px]">
                <ChatPreview
                  botName={botConfig?.bot_name || DEFAULT_BOT_NAME}
                  primaryColor={branding?.primary_color || "#4f46e5"}
                  logoUrl={branding?.logo_url ?? null}
                  conversation={previewConversation}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
