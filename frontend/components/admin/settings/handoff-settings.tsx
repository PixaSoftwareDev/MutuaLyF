"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Workflow, Repeat, Timer, MessagesSquare, CalendarClock, Headphones, Tags, X, Plus, Info } from "lucide-react";
import { api, type KeywordTriggerGroup } from "@/lib/api";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/lib/errors";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { SectionCard } from "@/components/admin/settings/section-card";
import { SettingsSaveBar } from "@/components/admin/settings/settings-save-bar";
import { BotAvatar } from "@/components/admin/settings/chat-mock";

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

// Serialización estable (claves ordenadas) para comparar estado vs. server.
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) && v > 0 ? v : min));

export function HandoffSettings() {
  const qc = useQueryClient();
  const { data: config, isLoading } = useQuery({
    queryKey: ["handoff-config"],
    queryFn: api.handoffConfig.get,
  });

  const [inactivityMinutes, setInactivityMinutes] = useState(15);
  const [threshold, setThreshold] = useState(3);
  const [attentionHours, setAttentionHours] = useState("");
  const [contactInfo, setContactInfo] = useState("");
  const [messages, setMessages]   = useState<Record<string, string>>({});
  const [kwGroups, setKwGroups]   = useState<KeywordTriggerGroup[]>([]);
  // Mensaje que el admin está editando → se resalta en el preview del costado.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  // Snapshot del server con la MISMA forma que el estado local → dirty se
  // computa por comparación (deshacer a mano vuelve a "Todo guardado") y el
  // formulario solo se re-sincroniza cuando el VALOR del server cambia — un
  // refetch de window-focus con los mismos datos no pisa lo que se edita.
  const snapshot = useMemo(() => config ? stable({
    t: config.inactivity_timeout_minutes,
    th: config.consecutive_insufficient_count,
    ah: config.attention_hours || "",
    ci: config.contact_info || "",
    m: config.transition_messages || {},
    kw: config.keyword_triggers || [],
  }) : null, [config]);

  useEffect(() => {
    if (!config) return;
    setInactivityMinutes(config.inactivity_timeout_minutes);
    setThreshold(config.consecutive_insufficient_count);
    setAttentionHours(config.attention_hours || "");
    setContactInfo(config.contact_info || "");
    setMessages(config.transition_messages || {});
    setKwGroups(config.keyword_triggers || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const dirty = snapshot != null && stable({
    t: inactivityMinutes, th: threshold, ah: attentionHours, ci: contactInfo, m: messages, kw: kwGroups,
  }) !== snapshot;

  const updateM = useMutation({
    // Clamp al guardar: borrar el campo numérico deja 0 en pantalla, pero jamás
    // se persiste fuera de rango (el min/max del input HTML es solo decorativo).
    mutationFn: () => api.handoffConfig.update({
      inactivity_timeout_minutes:     clamp(inactivityMinutes, 1, 120),
      consecutive_insufficient_count: clamp(threshold, 2, 10),
      attention_hours:                attentionHours,
      contact_info:                   contactInfo,
      transition_messages:            messages,
      keyword_triggers:               kwGroups.filter(g => g.words.length > 0),
    }),
    onSuccess: () => {
      // El refetch trae el snapshot guardado → dirty vuelve a false solo.
      qc.invalidateQueries({ queryKey: ["handoff-config"] });
      toast({ title: "Configuración guardada", variant: "success" });
    },
    onError: (err: any) => toast({
      title: "Error al guardar",
      description: extractErrorMessage(err, "No se pudo guardar la configuración. Intentá de nuevo."),
      variant: "destructive",
    }),
  });

  const setMessage = (key: string, value: string) => setMessages({ ...messages, [key]: value });

  if (isLoading) return (
    <div className="space-y-6">
      {[1, 2].map(i => <Skeleton key={i} className="h-48 rounded-2xl" />)}
    </div>
  );

  return (
    // Estilo nuevo al ancho de Canales → Todos (max-w-6xl): una card limpia por
    // sección, tiles neutros, acento de marca solo en los realces (nodos/timeline).
    <div className="mx-auto w-full max-w-6xl space-y-4">

      <SectionCard
        icon={Workflow}
        title="Cuándo derivar"
        description="Los dos casos en que el bot ofrece pasar a un operador."
      >
        {/* Reglas escritas como frases: el número se lee en contexto, sin ayudas
            aparte. Filas simples — la card exterior ya delimita; sin cajas anidadas. */}
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Repeat className="h-[18px] w-[18px]" />
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-foreground">
              <span>Ofrecer un operador cuando el bot no resuelve</span>
              <Input
                type="number" min={2} max={10}
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                className="h-8 w-14 px-1 text-center text-sm font-semibold tabular-nums"
                aria-label="Respuestas sin resolver antes de ofrecer un operador"
              />
              <span>consultas seguidas.</span>
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Timer className="h-[18px] w-[18px]" />
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-foreground">
              <span>Avisar al usuario si nadie lo atiende en</span>
              <Input
                type="number" min={1} max={120}
                value={inactivityMinutes}
                onChange={e => setInactivityMinutes(Number(e.target.value))}
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
              onChange={e => setAttentionHours(e.target.value)}
              placeholder="Lunes a viernes de 7:30 a 18 hs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Contacto alternativo</Label>
            <Input
              value={contactInfo}
              onChange={e => setContactInfo(e.target.value)}
              placeholder="Tel. 0000 000 0000 · contacto@tuempresa.com"
            />
          </div>
        </div>
      </SectionCard>

      {/* Regla 5: temas que ofrecen derivación proactiva */}
      <SectionCard
        icon={Tags}
        title="Temas que ofrecen derivación"
        description="El bot ofrece un operador cuando la conversación toca estos temas."
      >
        <div className="space-y-5">
          {kwGroups.map((group, gi) => (
            <KeywordGroupEditor
              key={gi}
              group={group}
              onChange={g => setKwGroups(kwGroups.map((x, i) => (i === gi ? g : x)))}
              onRemove={() => setKwGroups(kwGroups.filter((_, i) => i !== gi))}
            />
          ))}
          {kwGroups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Sin temas configurados — el bot solo ofrece operador cuando no logra resolver la consulta.
            </p>
          )}
          <button
            type="button"
            onClick={() => setKwGroups([...kwGroups, { words: [], message: "" }])}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-action hover:underline"
          >
            <Plus className="h-4 w-4" /> Agregar tema
          </button>
        </div>
      </SectionCard>

      {/* Timeline del flujo de transición */}
      <SectionCard
        icon={MessagesSquare}
        title="Mensajes durante la transición"
        description="El texto que ve el usuario en cada paso."
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Editor: timeline con los 3 mensajes */}
          <div className="space-y-0">
            {MESSAGE_KEYS.map(({ key, label, hint, sample }, i) => (
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
                    placeholder={sample}
                    className="h-9 text-sm"
                  />
                  {/* Ayuda en foco, no permanente: el contexto de cada paso aparece
                      solo mientras se edita ese campo — el resto queda limpio. */}
                  {focusedKey === key && (
                    <p className="text-[11px] leading-snug text-muted-foreground animate-fade-in">{hint}</p>
                  )}
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

// ── Editor de un grupo de palabras (Regla 5) ──────────────────────────────────
// Chips de palabras/frases + mensaje opcional de la oferta. Sin cajas anidadas:
// cada grupo es una fila con sus dos campos, separada por el espacio vertical.

function KeywordGroupEditor({ group, onChange, onRemove }: {
  group: KeywordTriggerGroup;
  onChange: (g: KeywordTriggerGroup) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");

  const addWord = () => {
    const w = draft.trim();
    if (!w) return;
    if (!group.words.some(x => x.toLowerCase() === w.toLowerCase())) {
      onChange({ ...group, words: [...group.words, w] });
    }
    setDraft("");
  };

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5 text-sm">
          Palabras o frases
          {/* Detalle técnico en tooltip: info de referencia, no de lectura diaria */}
          <span title="Coincide como palabra completa, sin distinguir tildes ni mayúsculas." className="inline-flex cursor-help">
            <Info className="h-3.5 w-3.5 text-muted-foreground/60" />
          </span>
        </Label>
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
          {group.words.map(w => (
            <span key={w} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
              {w}
              <button type="button" aria-label={`Quitar ${w}`}
                      onClick={() => onChange({ ...group, words: group.words.filter(x => x !== w) })}
                      className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addWord(); }
              // Backspace con el input vacío borra la última chip — patrón estándar
              if (e.key === "Backspace" && !draft && group.words.length) {
                onChange({ ...group, words: group.words.slice(0, -1) });
              }
            }}
            onBlur={addWord}
            placeholder={group.words.length ? "" : "Escribí y Enter: turno, agenda…"}
            className="min-w-[120px] flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm">Mensaje de la oferta <span className="font-normal text-muted-foreground">(opcional)</span></Label>
        <Input
          value={group.message}
          onChange={e => onChange({ ...group, message: e.target.value })}
          placeholder="¿Querés que te derive con un operador?"
          className="h-9 text-sm"
        />
      </div>
      <button
        type="button" aria-label="Quitar tema" title="Quitar tema" onClick={onRemove}
        className="mt-0 inline-flex h-8 w-8 items-center justify-center self-start rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive sm:mt-7"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ── Preview en vivo del flujo de transición ───────────────────────────────────
// Una ESCENA por paso (no los tres mensajes apilados — saturaba el chat): en
// reposo muestra la oferta; al enfocar un campo, transiciona con fade a la
// escena de ese paso. Los puntitos 1·2·3 permiten recorrerlas a mano. Refleja
// lo que se escribe (o el ejemplo si el campo está vacío).
function HandoffPreview({ messages, focusedKey }: {
  messages: Record<string, string>;
  focusedKey: string | null;
}) {
  // La escena persiste al desenfocar (no "rebota" a la primera al salir del campo).
  const [scene, setScene] = useState<string>(MESSAGE_KEYS[0].key);
  useEffect(() => { if (focusedKey) setScene(focusedKey); }, [focusedKey]);

  const val = (k: string) => (messages[k]?.trim() || MESSAGE_KEYS.find(m => m.key === k)!.sample);
  const avatar = <BotAvatar size={24} online />;

  const botBubble = (text: string, muted = false) => (
    <div className="flex items-end gap-2">
      {avatar}
      <div className={cn(
        "max-w-[80%] rounded-2xl rounded-bl-md bg-slate-100 px-2.5 py-1.5 text-[11px] leading-snug dark:bg-white/10",
        muted ? "text-slate-400 dark:text-slate-400" : "text-slate-600 dark:text-slate-200",
      )}>
        {text}
      </div>
    </div>
  );

  const userBubble = (text: string) => (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-brand to-brand-dark px-2.5 py-1.5 text-[11px] leading-snug text-brand-foreground">
        {text}
      </div>
    </div>
  );

  const systemPill = (text: string) => (
    <div className="flex justify-center">
      <span className="max-w-[92%] rounded-full bg-slate-100 px-3 py-1 text-center text-[10px] leading-snug text-slate-500 dark:bg-white/10 dark:text-slate-300">
        {text}
      </span>
    </div>
  );

  return (
    // Fondo suave sin borde: la tarjeta blanca del chat ya se recorta sola.
    <div className="rounded-2xl bg-muted/40 p-3.5 lg:sticky lg:top-4 lg:self-start">
      <div className="mb-2.5 flex items-center justify-between px-1">
        <p className="text-[11px] font-medium text-muted-foreground">Vista previa</p>
        {/* Navegación de escenas — sincronizada con el campo enfocado */}
        <div className="flex items-center gap-1">
          {MESSAGE_KEYS.map(({ key }, i) => (
            <button
              key={key}
              type="button"
              aria-label={`Ver paso ${i + 1}`}
              onClick={() => setScene(key)}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-all",
                scene === key
                  ? "bg-action-gradient text-action-foreground shadow-sm"
                  : "text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground",
              )}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>

      {/* key={scene} remonta el contenido → cada cambio de escena entra con fade.
          Alto FIJO (el de la escena más alta) y contenido centrado: cambiar de
          escena no mueve el layout de alrededor. */}
      <div key={scene} className="flex min-h-[235px] animate-fade-in flex-col justify-center gap-2.5 rounded-xl bg-white p-3 shadow-sm dark:bg-[#15181b]">
        {scene === "handoff_offer" && (
          <>
            {botBubble("No tengo esa información a mano.", true)}
            <div className="flex items-end gap-2">
              {avatar}
              <div className="flex max-w-[85%] flex-col gap-2 rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2.5 dark:bg-white/10">
                <p className="text-[11px] leading-snug text-slate-700 dark:text-slate-200">{val("handoff_offer")}</p>
                <span className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-brand to-brand-dark px-2.5 py-1.5 text-[10px] font-semibold text-brand-foreground shadow-sm">
                  <Headphones className="h-3 w-3" /> Conectarme con un operador
                </span>
                <span className="self-center text-[10px] text-slate-400">Seguir con el asistente</span>
              </div>
            </div>
          </>
        )}

        {scene === "handoff_confirmed" && (
          <>
            {userBubble("Quiero hablar con un operador")}
            {systemPill(val("handoff_confirmed"))}
          </>
        )}

        {scene === "operator_inactive_alert" && (
          <>
            {systemPill(val("handoff_confirmed"))}
            <p className="text-center text-[10px] italic text-muted-foreground/60">— unos minutos después —</p>
            {systemPill(val("operator_inactive_alert"))}
          </>
        )}
      </div>
    </div>
  );
}
