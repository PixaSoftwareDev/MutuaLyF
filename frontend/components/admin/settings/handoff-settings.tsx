"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Workflow, Repeat, Timer, MessagesSquare } from "lucide-react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { SectionHeader } from "@/components/admin/settings/section-header";
import { SettingsSaveBar } from "@/components/admin/settings/settings-save-bar";

// Tres mensajes que cubren los tres momentos del flujo:
//   1. Bot detecta que conviene derivar (insuficiente N veces) -> handoff_offer
//   2. Afiliado acepta el cartel con nombre + DNI -> handoff_confirmed
//   3. Espera prolongada en cola -> operator_inactive_alert
const MESSAGE_KEYS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "handoff_offer",
    label: "Oferta del bot",
    hint: "Texto del cartel amarillo. Aparece cuando el bot no encuentra la respuesta tras los intentos configurados arriba.",
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
  const { data: config, isLoading } = useQuery({
    queryKey: ["handoff-config"],
    queryFn: api.handoffConfig.get,
  });

  const [timeout, setTimeout_]   = useState(15);
  const [threshold, setThreshold] = useState(3);
  const [attentionHours, setAttentionHours] = useState("");
  const [contactInfo, setContactInfo] = useState("");
  const [messages, setMessages]   = useState<Record<string, string>>({});
  const [dirty, setDirty]         = useState(false);

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

  return (
    <div className="space-y-6">
      {/* ── Reglas de activación ── */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-4">
          <SectionHeader
            icon={Workflow}
            title="Cuándo derivar"
            description="Las condiciones que activan el pase de la conversación a un operador humano."
          />
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Dos disparadores numéricos como bloques destacados */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-action-gradient-soft">
                  <Repeat className="h-4 w-4 text-action" />
                </div>
                <span className="text-sm font-medium">Intentos del bot</span>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="number" min={2} max={10}
                  value={threshold}
                  onChange={e => { setThreshold(Number(e.target.value)); setDirty(true); }}
                  className="w-16 h-12 text-center text-xl font-semibold tabular-nums"
                  aria-label="Cantidad de respuestas insuficientes antes de derivar"
                />
                <span className="text-xs text-muted-foreground leading-snug">
                  respuestas insuficientes seguidas antes de ofrecer un operador
                </span>
              </div>
            </div>

            <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-action-gradient-soft">
                  <Timer className="h-4 w-4 text-action" />
                </div>
                <span className="text-sm font-medium">Espera en cola</span>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="number" min={1} max={120}
                  value={timeout}
                  onChange={e => { setTimeout_(Number(e.target.value)); setDirty(true); }}
                  className="w-16 h-12 text-center text-xl font-semibold tabular-nums"
                  aria-label="Minutos sin atención antes de avisar al usuario"
                />
                <span className="text-xs text-muted-foreground leading-snug">
                  minutos sin que un operador atienda antes de avisar al usuario
                </span>
              </div>
            </div>
          </div>

          {/* Horario + contacto, lado a lado con ícono en el label */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm">Horario de atención</Label>
              <Input
                value={attentionHours}
                onChange={e => { setAttentionHours(e.target.value); setDirty(true); }}
                placeholder="Ej: Lunes a viernes de 7:30 a 18 hs"
              />
              <p className="text-[11px] text-muted-foreground leading-snug">
                Sin operadores conectados, el asistente no ofrece derivar y muestra este horario. Vacío = no mostrar horario.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Datos de contacto</Label>
              <Input
                value={contactInfo}
                onChange={e => { setContactInfo(e.target.value); setDirty(true); }}
                placeholder="Ej: Tel. 0342 452 0074 · recepcion@organizacion.com"
              />
              <p className="text-[11px] text-muted-foreground leading-snug">
                Se muestra cuando no hay operadores o cuando el asistente no encuentra la respuesta. Vacío = mensaje genérico.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Mensajes de transición — timeline del flujo ── */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-4">
          <SectionHeader
            icon={MessagesSquare}
            title="Mensajes durante la transición"
            description="Lo que ve el usuario en cada momento del pase a un operador, en orden."
          />
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {MESSAGE_KEYS.map(({ key, label, hint }, i) => (
              <div key={key} className="relative flex gap-4 pb-6 last:pb-0">
                {/* Línea conectora del timeline */}
                {i < MESSAGE_KEYS.length - 1 && (
                  <span className="absolute left-[17px] top-10 bottom-1 w-px bg-border" aria-hidden />
                )}
                {/* Nodo numerado con gradient de marca */}
                <div className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-action-gradient text-action-foreground text-sm font-semibold shadow-sm">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0 space-y-1.5 pt-1">
                  <Label className="text-sm font-medium">{label}</Label>
                  <Input
                    value={messages[key] || ""}
                    onChange={e => setMessage(key, e.target.value)}
                    placeholder="Mensaje por defecto del sistema"
                    className="h-9 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">{hint}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <SettingsSaveBar
        dirty={dirty}
        pending={updateM.isPending}
        onSave={() => updateM.mutate()}
      />
    </div>
  );
}
