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

const MESSAGE_KEYS: Array<{ key: string; label: string; description: string }> = [
  { key: "handoff_offer",           label: "Ofrecimiento de pase a operador",  description: "Cuando el bot detecta que no puede ayudar." },
  { key: "handoff_auto",            label: "Pase a operador automático",       description: "Cuando el afiliado pide hablar con un humano de forma explícita." },
  { key: "human_assigned",          label: "Operador conectado",               description: "Cuando un operador acepta la conversación." },
  { key: "sector_transferred",      label: "Derivado a otro sector",           description: "Cuando se transfiere la conversación a otra área." },
  { key: "operator_inactive_alert", label: "Aviso de espera prolongada",       description: "Cuando el afiliado lleva mucho tiempo sin respuesta del operador." },
  { key: "conversation_closed",     label: "Conversación cerrada",             description: "Al cerrar la conversación." },
];

export function HandoffSettings() {
  const { data: config, isLoading } = useQuery({
    queryKey: ["handoff-config"],
    queryFn: api.handoffConfig.get,
  });

  const [timeout, setTimeout_]   = useState(15);
  const [threshold, setThreshold] = useState(2);
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
    onError:   () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const addPhrase = () => {
    const p = newPhrase.trim().toLowerCase();
    if (p && !phrases.includes(p)) { setPhrases([...phrases, p]); setDirty(true); }
    setNewPhrase("");
  };

  const removePhrase = (phrase: string) => { setPhrases(phrases.filter(p => p !== phrase)); setDirty(true); };
  const setMessage   = (key: string, value: string) => { setMessages({ ...messages, [key]: value }); setDirty(true); };

  if (isLoading) return (
    <div className="space-y-4 max-w-2xl">
      {[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-lg" />)}
    </div>
  );

  return (
    <div className="space-y-6 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Definí cuándo el bot debe pasar la conversación a un operador humano y los mensajes que ve el afiliado durante esa transición.
      </p>

      {/* Reglas de activación */}
      <Card>
        <CardHeader className="pb-3"><h2 className="font-semibold text-sm">Cuándo derivar a un operador</h2></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-sm">Después de respuestas insuficientes consecutivas</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number" min={1} max={10}
                value={threshold}
                onChange={e => { setThreshold(Number(e.target.value)); setDirty(true); }}
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">turnos sin respuesta útil → ofrecer pase a operador</span>
            </div>
          </div>
          <Separator />
          <div className="space-y-1.5">
            <Label className="text-sm">Tiempo máximo de espera del afiliado</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number" min={1} max={120}
                value={timeout}
                onChange={e => { setTimeout_(Number(e.target.value)); setDirty(true); }}
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">minutos sin atención → avisar al afiliado</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Frases de frustración */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Frases que disparan el pase inmediato</h2>
          <p className="text-xs text-muted-foreground">
            Si el afiliado escribe alguna de estas frases, el bot ofrece hablar con un operador en ese mismo momento.
          </p>
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

      {/* Mensajes de transición */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Mensajes que ve el afiliado</h2>
          <p className="text-xs text-muted-foreground">
            Estos textos aparecen en el chat del afiliado durante la transición del bot al operador humano.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {MESSAGE_KEYS.map(({ key, label, description }) => (
            <div key={key} className="space-y-1.5">
              <Label className="text-sm font-medium">{label}</Label>
              <p className="text-xs text-muted-foreground">{description}</p>
              <Input
                value={messages[key] || ""}
                onChange={e => setMessage(key, e.target.value)}
                placeholder={`Mensaje de ${label.toLowerCase()}...`}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {dirty && (
        <Button className="w-full" onClick={() => updateM.mutate()} disabled={updateM.isPending}>
          {updateM.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Guardar todos los cambios
        </Button>
      )}
    </div>
  );
}
