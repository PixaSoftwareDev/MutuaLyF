"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";

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
  const { data: config, isLoading } = useQuery({
    queryKey: ["handoff-config"],
    queryFn: api.handoffConfig.get,
  });

  const [timeout, setTimeout_]   = useState(15);
  const [threshold, setThreshold] = useState(3);
  const [attentionHours, setAttentionHours] = useState("");
  const [messages, setMessages]   = useState<Record<string, string>>({});
  const [dirty, setDirty]         = useState(false);

  useEffect(() => {
    if (!config) return;
    setTimeout_(config.inactivity_timeout_minutes);
    setThreshold(config.consecutive_insufficient_count);
    setAttentionHours(config.attention_hours || "");
    setMessages(config.transition_messages || {});
  }, [config]);

  const updateM = useMutation({
    mutationFn: () => api.handoffConfig.update({
      inactivity_timeout_minutes:     timeout,
      consecutive_insufficient_count: threshold,
      attention_hours:                attentionHours,
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
    <div className="space-y-4">
      {[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-lg" />)}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Reglas de activación */}
      <Card>
        <CardHeader className="pb-3"><h2 className="font-semibold text-sm">Cuándo derivar</h2></CardHeader>
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
        </CardContent>
      </Card>

      {/* Mensajes de transición — formato compacto: label + input lado a lado */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Mensajes durante la transición</h2>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {MESSAGE_KEYS.map(({ key, label, hint }) => (
            <div key={key} className="grid grid-cols-1 sm:grid-cols-[200px,1fr] items-start gap-2">
              <div className="pt-2">
                <Label className="text-xs text-foreground">{label}</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{hint}</p>
              </div>
              <Input
                value={messages[key] || ""}
                onChange={e => setMessage(key, e.target.value)}
                placeholder="—"
                className="h-9 text-sm"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {dirty && (
        <Button className="w-full" onClick={() => updateM.mutate()} disabled={updateM.isPending}>
          {updateM.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Guardar cambios
        </Button>
      )}
    </div>
  );
}
