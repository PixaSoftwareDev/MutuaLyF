"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Workflow, Repeat, Timer, MessagesSquare, CalendarClock, Bot, Headphones } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { SectionCard } from "@/components/admin/settings/section-card";
import { SettingsSaveBar } from "@/components/admin/settings/settings-save-bar";

// Tres mensajes que cubren los tres momentos del flujo:
//   1. Bot detecta que conviene derivar (insuficiente N veces) -> handoff_offer
//   2. Afiliado acepta el cartel con nombre + DNI -> handoff_confirmed
//   3. Espera prolongada en cola -> operator_inactive_alert
const MESSAGE_KEYS: Array<{ key: string; label: string; hint: string; sample: string }> = [
  {
    key: "handoff_offer",
    label: "El bot ofrece un operador",
    hint: "Cuando no logra resolver la consulta.",
    sample: "Parece que esto necesita una persona. ¿Querés que te conecte con un operador?",
  },
  {
    key: "handoff_confirmed",
    label: "El usuario aceptó",
    hint: "Dejó nombre y DNI; pasa a la cola.",
    sample: "¡Listo! Te estoy conectando con un operador…",
  },
  {
    key: "operator_inactive_alert",
    label: "La espera se hace larga",
    hint: "Nadie lo atendió tras varios minutos.",
    sample: "Seguimos buscando un operador disponible. Gracias por tu paciencia.",
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
  // Mensaje que el admin está editando → se resalta en el preview del costado.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

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
    // Estilo nuevo al ancho de Canales → Todos (max-w-5xl): una card limpia por
    // sección, tiles neutros, acento de marca solo en los realces (nodos/timeline).
    <div className="mx-auto w-full max-w-5xl space-y-4">

      <SectionCard
        icon={Workflow}
        title="Cuándo derivar"
        description="Los dos casos en que el bot ofrece pasar a un operador."
      >
        {/* Reglas escritas como frases: el número se lee en contexto, sin ayudas aparte */}
        <div className="space-y-2.5">
          <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Repeat className="h-[18px] w-[18px]" />
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-foreground">
              <span>Ofrecer un operador cuando el bot no resuelve</span>
              <Input
                type="number" min={2} max={10}
                value={threshold}
                onChange={e => { setThreshold(Number(e.target.value)); setDirty(true); }}
                className="h-8 w-14 px-1 text-center text-sm font-semibold tabular-nums"
                aria-label="Respuestas sin resolver antes de ofrecer un operador"
              />
              <span>consultas seguidas.</span>
            </p>
          </div>

          <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Timer className="h-[18px] w-[18px]" />
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-foreground">
              <span>Avisar al usuario si nadie lo atiende en</span>
              <Input
                type="number" min={1} max={120}
                value={timeout}
                onChange={e => { setTimeout_(Number(e.target.value)); setDirty(true); }}
                className="h-8 w-14 px-1 text-center text-sm font-semibold tabular-nums"
                aria-label="Minutos en cola antes de avisar al usuario"
              />
              <span>minutos.</span>
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        icon={CalendarClock}
        title="Sin operadores disponibles"
        description="Lo que ve el usuario cuando no hay nadie para atenderlo."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-sm">Horario de atención</Label>
            <Input
              value={attentionHours}
              onChange={e => { setAttentionHours(e.target.value); setDirty(true); }}
              placeholder="Lunes a viernes de 7:30 a 18 hs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Contacto alternativo</Label>
            <Input
              value={contactInfo}
              onChange={e => { setContactInfo(e.target.value); setDirty(true); }}
              placeholder="Tel. 0342 452 0074 · recepcion@…"
            />
          </div>
        </div>
      </SectionCard>

      {/* Timeline del flujo de transición */}
      <SectionCard
        icon={MessagesSquare}
        title="Mensajes durante la transición"
        description="El texto que ve el usuario en cada paso. Vacío = mensaje por defecto."
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Editor: timeline con los 3 mensajes */}
          <div className="space-y-0">
            {MESSAGE_KEYS.map(({ key, label, hint }, i) => (
              <div key={key} className="relative flex gap-4 pb-6 last:pb-0">
                {/* Línea conectora del timeline */}
                {i < MESSAGE_KEYS.length - 1 && (
                  <span className="absolute bottom-1 left-[17px] top-10 w-px bg-border" aria-hidden />
                )}
                {/* Nodo numerado — se ilumina cuando se edita ese mensaje */}
                <div className={cn(
                  "relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-action-gradient text-sm font-semibold text-action-foreground shadow-sm transition-all",
                  focusedKey === key && "ring-2 ring-action/30 ring-offset-2 ring-offset-card",
                )}>
                  {i + 1}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5 pt-1">
                  <Label className="text-sm font-medium">{label}</Label>
                  <Input
                    value={messages[key] || ""}
                    onChange={e => setMessage(key, e.target.value)}
                    onFocus={() => setFocusedKey(key)}
                    onBlur={() => setFocusedKey(null)}
                    placeholder="Mensaje por defecto del sistema"
                    className="h-9 text-sm"
                  />
                  <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Preview en vivo: cómo se ven esos mensajes en la conversación real */}
          <HandoffPreview messages={messages} focusedKey={focusedKey} />
        </div>
      </SectionCard>

      <SettingsSaveBar
        dirty={dirty}
        pending={updateM.isPending}
        onSave={() => updateM.mutate()}
      />
    </div>
  );
}

// ── Preview en vivo del flujo de transición ───────────────────────────────────
// Muestra los tres mensajes tal como se ven en la conversación real (la oferta
// como cartel ámbar con su botón, las otras como avisos del sistema). Refleja lo
// que se escribe (o el ejemplo si el campo está vacío) y resalta el que se edita.
function HandoffPreview({ messages, focusedKey }: {
  messages: Record<string, string>;
  focusedKey: string | null;
}) {
  const val = (k: string) => (messages[k]?.trim() || MESSAGE_KEYS.find(m => m.key === k)!.sample);
  const hl = (k: string) => focusedKey === k;

  const systemPill = (k: string) => (
    <div className="flex justify-center">
      <span className={cn(
        "max-w-[92%] rounded-full px-3 py-1 text-center text-[10px] leading-snug transition-all",
        hl(k)
          ? "bg-action/15 text-action ring-1 ring-action/30"
          : "bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300",
      )}>
        {val(k)}
      </span>
    </div>
  );

  // Avatar del bot (redondo, con punto "en línea") — igual que el chat real.
  const avatar = (
    <span className="relative h-6 w-6 shrink-0">
      <span className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark">
        <Bot className="h-3 w-3 text-brand-foreground" />
      </span>
      <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-white bg-emerald-500 dark:border-[#15181b]" />
    </span>
  );

  return (
    <div className="rounded-2xl border bg-muted/30 p-3.5 lg:sticky lg:top-4 lg:self-start">
      <p className="mb-2.5 px-1 text-[11px] font-medium text-muted-foreground">Vista previa</p>
      <div className="space-y-2.5 rounded-xl bg-white p-3 shadow-sm dark:bg-[#15181b]">
        {/* Contexto: mensaje del bot que dispara la oferta */}
        <div className="flex items-end gap-2">
          {avatar}
          <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-slate-100 px-2.5 py-1.5 text-[11px] leading-snug text-slate-600 dark:bg-white/10 dark:text-slate-200">
            No tengo esa información a mano.
          </div>
        </div>

        {/* 1. Oferta del bot — formato burbuja con botón de marca (igual que el chat) */}
        <div className="flex items-end gap-2">
          {avatar}
          <div className={cn(
            "flex max-w-[85%] flex-col gap-2 rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2.5 transition-all dark:bg-white/10",
            hl("handoff_offer") && "ring-2 ring-action/30",
          )}>
            <p className="text-[11px] leading-snug text-slate-700 dark:text-slate-200">{val("handoff_offer")}</p>
            <span className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-brand to-brand-dark px-2.5 py-1.5 text-[10px] font-semibold text-brand-foreground shadow-sm">
              <Headphones className="h-3 w-3" /> Conectarme con un operador
            </span>
            <span className="self-center text-[10px] text-slate-400">Seguir con el asistente</span>
          </div>
        </div>

        {/* 2 y 3. Avisos del sistema */}
        {systemPill("handoff_confirmed")}
        {systemPill("operator_inactive_alert")}
      </div>
    </div>
  );
}
