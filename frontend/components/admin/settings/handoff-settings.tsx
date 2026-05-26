"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, X, Loader2, Save } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";

// Solo incluimos keys que el backend realmente lee. Antes habia 3 keys de adorno
// (human_assigned, sector_transferred, conversation_closed) que se podian editar
// pero nunca afectaban nada. Quedan en la columna JSONB por compat, salen del UI.
const MESSAGE_KEYS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "handoff_offer",
    label: "Bot no puede ayudar",
    hint: "Aparece cuando el bot no encontró respuesta tras varios intentos o el usuario pide hablar con un operador.",
  },
  {
    key: "handoff_auto",
    label: "Pide operador explícitamente",
    hint: "Mensaje del sistema cuando el usuario pide humano dos veces seguidas — derivación automática sin confirmar.",
  },
  {
    key: "handoff_confirmed",
    label: "Confirmando derivación",
    hint: "Aparece cuando el afiliado confirma la oferta del bot tras completar nombre y DNI.",
  },
  {
    key: "operator_inactive_alert",
    label: "Espera prolongada",
    hint: "Recordatorio automático que se le manda al afiliado si lleva 15+ min en cola sin atención.",
  },
];

export function HandoffSettings() {
  const { data: config, isLoading } = useQuery({
    queryKey: ["handoff-config"],
    queryFn: api.handoffConfig.get,
  });

  const [timeout, setTimeout_]   = useState(15);
  const [threshold, setThreshold] = useState(3);
  const [phrases, setPhrases]     = useState<string[]>([]);
  const [messages, setMessages]   = useState<Record<string, string>>({});
  const [newPhrase, setNewPhrase] = useState("");
  const [dirty, setDirty]         = useState(false);

  useEffect(() => {
    if (!config) return;
    setTimeout_(config.inactivity_timeout_minutes);
    setThreshold(config.consecutive_insufficient_count);
    setPhrases(config.frustration_phrases || []);
    setMessages(config.transition_messages || {});
  }, [config]);

  const updateM = useMutation({
    mutationFn: () => api.handoffConfig.update({
      inactivity_timeout_minutes:     timeout,
      consecutive_insufficient_count: threshold,
      frustration_phrases:            phrases,
      transition_messages:            messages,
    }),
    onSuccess: () => { setDirty(false); toast({ title: "Configuración guardada", variant: "success" }); },
    onError:   (err: any) => {
      // Mostrar el detail real del backend en vez de "Error al guardar"
      // generico (feedback dijo: 'agregar manejo de error descriptivo').
      const detail = err?.response?.data?.detail || err?.message || "No se pudo guardar la configuración.";
      toast({
        title: "Error al guardar",
        description: typeof detail === "string" ? detail : "Intentá de nuevo.",
        variant: "destructive",
      });
    },
  });

  const addPhrase = () => {
    const p = newPhrase.trim().toLowerCase();
    if (p && !phrases.includes(p)) { setPhrases([...phrases, p]); setDirty(true); }
    setNewPhrase("");
  };

  const removePhrase = (phrase: string) => { setPhrases(phrases.filter(p => p !== phrase)); setDirty(true); };
  const setMessage   = (key: string, value: string) => { setMessages({ ...messages, [key]: value }); setDirty(true); };

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
        </CardContent>
      </Card>

      {/* Frases de frustración */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Frases que disparan el pase inmediato</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {phrases.map(p => (
              <Badge key={p} variant="secondary" className="gap-1 pr-1">
                {p}
                <button onClick={() => removePhrase(p)} className="hover:text-destructive ml-1">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Agregar frase..."
              value={newPhrase}
              onChange={e => setNewPhrase(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addPhrase()}
              className="h-8"
            />
            <Button size="sm" variant="outline" onClick={addPhrase} disabled={!newPhrase.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
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
