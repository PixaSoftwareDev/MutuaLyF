"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Check, Pipette, Bot, SendHorizontal, Pencil, Wand2, Palette } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { contrastRatio, pickReadableTextColor } from "@/lib/use-tenant-branding";
import { DEFAULT_BOT_NAME, DEFAULT_GREETING } from "@/components/admin/settings/chat-preview";
import { SectionHeader } from "@/components/admin/settings/section-header";

const DEFAULT_COLOR = "#99323D";
const PALETTE_PRESETS = [
  "#99323D", "#1d4ed8", "#0ea5e9", "#10b981",
  "#f97316", "#a855f7", "#475569", "#0f172a",
];
// Color de la letra sobre el fondo: blanco o un casi-negro. El resto, custom.
const TEXT_PRESETS = ["#ffffff", "#0f172a"];

export function AppearanceSettings() {
  const qc = useQueryClient();
  const { tenantId } = useAuthStore();

  const { data: branding, isLoading } = useQuery({
    queryKey: ["admin-branding"],
    queryFn: () => api.branding.getAdmin(),
  });

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-branding"] });
    qc.invalidateQueries({ queryKey: ["tenant-branding"] });
    qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
  };

  if (isLoading || !branding) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-[620px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AssistantCard branding={branding} botConfig={botConfig} tenantId={tenantId} onSaved={invalidate} />
    </div>
  );
}

// ── Card: Identidad y apariencia (nombre org + editor WYSIWYG + colores) ──────

function AssistantCard({
  branding, botConfig, tenantId, onSaved,
}: { branding: any; botConfig: any; tenantId: string | null; onSaved: () => void }) {
  const [displayName, setDisplayName]         = useState(branding.display_name);
  const [primary, setPrimary]                 = useState(branding.primary_color || DEFAULT_COLOR);
  const [botName, setBotName]                 = useState("");
  const [greetingMessage, setGreetingMessage] = useState("");
  // Color de la letra: 'auto' = legibilidad automática; 'custom' = elegido.
  const [textMode, setTextMode]   = useState<"auto" | "custom">(branding.secondary_color ? "custom" : "auto");
  const [textColor, setTextColor] = useState(branding.secondary_color || "#ffffff");

  useEffect(() => {
    setDisplayName(branding.display_name);
    setPrimary(branding.primary_color || DEFAULT_COLOR);
    setTextMode(branding.secondary_color ? "custom" : "auto");
    setTextColor(branding.secondary_color || "#ffffff");
  }, [branding.display_name, branding.primary_color, branding.secondary_color]);

  useEffect(() => {
    if (!botConfig) return;
    setBotName(botConfig.bot_name ?? "");
    setGreetingMessage(botConfig.greeting_message ?? "");
  }, [botConfig]);

  const previewColor = cssColorToHex(primary) || branding.primary_color || DEFAULT_COLOR;
  // Color de letra efectivo: el elegido (custom) o el legible automático.
  const effectiveText = textMode === "custom"
    ? (cssColorToHex(textColor) || pickReadableTextColor(previewColor))
    : pickReadableTextColor(previewColor);
  // Lo que se persiste en secondary_color: el hex en custom, null en auto.
  const desiredSecondary = textMode === "custom" ? effectiveText : null;

  const ratio    = contrastRatio(previewColor, effectiveText);
  const aaNormal = ratio >= 4.5;
  const aaLarge  = ratio >= 3.0;

  const nameDirty = displayName.trim().length > 0 && displayName.trim() !== branding.display_name;
  const identityDirty =
    botConfig != null &&
    (botName.trim() !== (botConfig.bot_name ?? "") || greetingMessage !== (botConfig.greeting_message ?? ""));
  const colorDirty = previewColor.toLowerCase() !== (branding.primary_color || DEFAULT_COLOR).toLowerCase();
  const textDirty  = (desiredSecondary?.toLowerCase() ?? null) !== ((branding.secondary_color as string | null)?.toLowerCase() ?? null);
  const anyDirty = nameDirty || identityDirty || colorDirty || textDirty;

  const saveM = useMutation({
    mutationFn: async () => {
      if (identityDirty) {
        await api.tenants.updateBotConfig(tenantId!, {
          bot_name: botName.trim() || null,
          greeting_message: greetingMessage || null,
        });
      }
      const patch: { primary_color?: string; secondary_color?: string; display_name?: string } = {};
      if (nameDirty)  patch.display_name = displayName.trim();
      if (colorDirty) patch.primary_color = previewColor;
      // El backend trata "" como null (limpia secondary_color en modo auto).
      if (textDirty)  patch.secondary_color = desiredSecondary ?? "";
      if (Object.keys(patch).length) await api.branding.update(patch);
    },
    onSuccess: () => { onSaved(); toast({ title: "Cambios guardados", variant: "success" }); },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: typeof detail === "string" ? detail : "Error al guardar", variant: "destructive" });
    },
  });

  return (
    <Card className="rounded-2xl overflow-hidden">
      <CardHeader className="pb-4">
        <SectionHeader
          icon={Palette}
          title="Identidad y apariencia"
          description="El nombre de tu organización y el aspecto del asistente que ven tus usuarios."
        />
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Nombre de la organización */}
        <div className="space-y-1.5 sm:max-w-md">
          <Label htmlFor="display_name">Nombre de la organización</Label>
          <Input
            id="display_name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            maxLength={200}
            placeholder="Ej. Mutualyf S.A."
          />
          <p className="text-[11px] text-muted-foreground">El nombre visible para tus usuarios y operadores.</p>
        </div>

        <div className="h-px bg-border" aria-hidden />

        {/* ── Preview protagonista: el chat es la pieza central ── */}
        <div className="rounded-2xl border bg-action-gradient-soft px-4 py-6">
          <div className="mx-auto max-w-[410px]">
            <EditableChat
              botName={botName}
              onBotName={setBotName}
              greeting={greetingMessage}
              onGreeting={setGreetingMessage}
              primaryColor={previewColor}
              textColor={effectiveText}
            />
          </div>
        </div>

        {/* ── Toolbar de controles: fondo + letra, compacta bajo el preview ──
            Dos columnas recién desde xl: en anchos intermedios (tablet o ventana
            angosta con sidebar) las columnas quedaban más chicas que el toggle
            Automático/Personalizado y desbordaba la card. Apiladas hasta tener
            espacio real. */}
        <div className="rounded-xl border bg-muted/20 p-4">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,auto)_1px_minmax(0,1fr)] xl:gap-6">
            {/* Color de fondo */}
            <div className="space-y-2.5 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Color de fondo</p>
              <ColorField presets={PALETTE_PRESETS} value={previewColor} raw={primary} onChange={setPrimary} />
            </div>

            <div className="hidden bg-border xl:block" aria-hidden />

            {/* Color de la letra */}
            <div className="space-y-2.5 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Color de la letra</p>
              <div className="flex flex-wrap items-center gap-3">
                {/* shrink-0 + nowrap: en contenedores angostos los labels se
                    partían en dos líneas y el pill se deformaba. El preview de
                    al lado baja de fila (flex-wrap del padre), el toggle no se
                    comprime. */}
                <div className="inline-flex shrink-0 rounded-lg border bg-background p-0.5">
                  <button
                    type="button"
                    onClick={() => setTextMode("auto")}
                    className={cn(
                      "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      textMode === "auto" ? "bg-action-gradient text-white shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Wand2 className="h-3 w-3 shrink-0" /> Automático
                  </button>
                  <button
                    type="button"
                    onClick={() => setTextMode("custom")}
                    className={cn(
                      "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      textMode === "custom" ? "bg-action-gradient text-white shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Personalizado
                  </button>
                </div>
                {textMode === "auto" && <ContrastPreview color={previewColor} text={effectiveText} aaNormal={aaNormal} aaLarge={aaLarge} note />}
              </div>

              {textMode === "custom" && (
                <div className="flex flex-wrap items-center gap-3">
                  <ColorField presets={TEXT_PRESETS} value={effectiveText} raw={textColor} onChange={setTextColor} />
                  <ContrastPreview color={previewColor} text={effectiveText} aaNormal={aaNormal} aaLarge={aaLarge} />
                </div>
              )}

              {!aaNormal && (
                <p className="text-[11px] text-muted-foreground">
                  {aaLarge
                    ? "Sirve solo para texto grande; el texto chico del chat puede leerse mal."
                    : "El texto puede quedar ilegible — probá otra combinación o el modo automático."}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer: aviso de cambios + guardar */}
        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
            {anyDirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
            {anyDirty ? "Tenés cambios sin guardar." : "Todo guardado."}
          </p>
          <Button onClick={() => saveM.mutate()} disabled={!anyDirty || saveM.isPending}>
            {saveM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Guardar cambios
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Preview de combinación (Aa) + contraste ───────────────────────────────────

function ContrastPreview({
  color, text, aaNormal, aaLarge, note = false,
}: {
  color: string; text: string; aaNormal: boolean; aaLarge: boolean; note?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {/* Muestra real de cómo se ve la letra sobre el fondo */}
      <span
        className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-semibold shadow-xs"
        style={{ backgroundColor: color, color: text }}
        aria-hidden
      >
        Aa
      </span>
      <span className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        aaNormal ? "text-success" : aaLarge ? "text-warning" : "text-destructive",
      )}>
        <span className={cn(
          "h-1.5 w-1.5 rounded-full",
          aaNormal ? "bg-success" : aaLarge ? "bg-warning" : "bg-destructive",
        )} />
        {aaNormal ? "Se lee bien" : aaLarge ? "Puede costar leerse" : "Difícil de leer"}
      </span>
      {note && <span className="text-[11px] text-muted-foreground">Color elegido automáticamente</span>}
    </div>
  );
}

// ── Selector de color reutilizable (presets + gotero + hex) ───────────────────

function ColorField({
  presets, value, raw, onChange,
}: { presets: string[]; value: string; raw: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {presets.map(p => {
        const selected = value.toLowerCase() === p.toLowerCase();
        return (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            aria-label={`Color ${p}`}
            aria-pressed={selected}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full border shadow-xs transition-all hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              selected ? "ring-2 ring-foreground/35 ring-offset-2" : "hover:shadow-sm",
            )}
            style={{ background: p }}
          >
            {selected && <Check className="h-3.5 w-3.5" style={{ color: pickReadableTextColor(p) }} />}
          </button>
        );
      })}

      <span className="mx-1 h-6 w-px bg-border" aria-hidden />

      <label
        className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-dashed border-border bg-background transition-colors hover:border-action/50 hover:text-action text-muted-foreground"
        title="Elegir un color personalizado"
      >
        <Pipette className="h-3.5 w-3.5" />
        <input
          type="color"
          value={cssColorToHex(raw) || "#ffffff"}
          onChange={e => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Color personalizado"
        />
      </label>

      <input
        type="text"
        value={raw}
        onChange={e => onChange(e.target.value)}
        onBlur={e => { const hex = cssColorToHex(e.target.value); if (hex) onChange(hex); }}
        placeholder="#RRGGBB"
        aria-label="Color en hexadecimal"
        className={cn(
          "h-8 w-24 rounded-md border bg-background px-2.5 text-xs font-mono uppercase text-muted-foreground",
          "focus:outline-none focus:ring-1 focus:ring-primary focus:text-foreground",
          cssColorToHex(raw) ? "border-input" : "border-destructive",
        )}
      />
    </div>
  );
}

// ── Chat editable in-situ ─────────────────────────────────────────────────────

/**
 * Réplica del chat del cliente, con el nombre (header) y el saludo (primera
 * burbuja) editables directamente sobre la pieza. El resto es decorativo.
 */
function EditableChat({
  botName, onBotName, greeting, onGreeting, primaryColor, textColor,
}: {
  botName: string;
  onBotName: (v: string) => void;
  greeting: string;
  onGreeting: (v: string) => void;
  primaryColor: string;
  textColor: string;
}) {
  return (
    <div className="rounded-2xl border bg-card shadow-md overflow-hidden">
      {/* Header — nombre editable */}
      <div className="flex items-center gap-3 px-4 py-4" style={{ backgroundColor: primaryColor, color: textColor }}>
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 shrink-0">
          <Bot className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="group relative">
            <input
              value={botName}
              onChange={e => onBotName(e.target.value)}
              placeholder={DEFAULT_BOT_NAME}
              maxLength={80}
              aria-label="Nombre del asistente"
              spellCheck={false}
              className="w-full min-w-0 cursor-text rounded-lg border px-2.5 py-1.5 pr-7 text-sm font-semibold leading-tight outline-none transition-all placeholder:opacity-60"
              style={{ color: textColor, backgroundColor: `${textColor}22`, borderColor: `${textColor}40` }}
            />
            <Pencil className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 opacity-70 transition-opacity group-hover:opacity-100" style={{ color: textColor }} />
            {/* Ring de hover en el color del texto (contrasta con el fondo elegido) */}
            <span
              className="pointer-events-none absolute inset-0 rounded-lg opacity-0 transition-opacity group-hover:opacity-100"
              style={{ boxShadow: `0 0 0 1.5px ${textColor}66` }}
              aria-hidden
            />
          </div>
          <p className="text-[11px] leading-tight px-0.5 mt-1.5" style={{ color: textColor, opacity: 0.75 }}>
            ● En línea
          </p>
        </div>
      </div>

      {/* Conversación de muestra — saludo editable */}
      <div className="bg-muted/30 px-3.5 py-5 space-y-3">
        <div className="group relative">
          <AutoTextarea
            value={greeting}
            onChange={onGreeting}
            placeholder={DEFAULT_GREETING}
            className="block w-full min-h-[4.5rem] cursor-text rounded-2xl rounded-tl-md border border-dashed border-action/40 bg-card px-4 py-3 pr-9 text-sm leading-relaxed shadow-xs resize-none overflow-hidden outline-none transition-all hover:border-action hover:shadow-sm focus:border-action focus:ring-2 focus:ring-action/30"
          />
          <span className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-md bg-action/10 text-action transition-colors group-hover:bg-action/20 pointer-events-none">
            <Pencil className="h-3 w-3" />
          </span>
        </div>

        <div
          className="ml-auto max-w-[75%] w-fit rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13px] leading-relaxed shadow-xs"
          style={{ backgroundColor: primaryColor, color: textColor }}
        >
          Hola, tengo una consulta
        </div>

        <div className="w-fit rounded-2xl rounded-tl-md border bg-card px-3.5 py-3 shadow-xs flex items-center gap-1">
          {[0, 1, 2].map(i => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-pulse"
              style={{ animationDelay: `${i * 200}ms` }}
            />
          ))}
        </div>
      </div>

      {/* Input decorativo */}
      <div className="border-t bg-card px-3.5 py-3">
        <div className="flex items-center gap-2 rounded-full border bg-muted/40 px-4 py-2">
          <span className="flex-1 text-[13px] text-muted-foreground/60 truncate">Hacé tu consulta…</span>
          <SendHorizontal className="h-4 w-4 shrink-0" style={{ color: primaryColor }} />
        </div>
      </div>
    </div>
  );
}

/** Textarea de una línea que crece con el contenido (sin scroll interno). */
function AutoTextarea({
  value, onChange, placeholder, className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // Cuando está vacío, medir contra el placeholder: así el saludo por defecto
    // (que ocupa varias líneas) no queda cortado a una sola línea.
    if (!value) {
      const prev = el.value;
      el.value = placeholder;
      el.style.height = `${el.scrollHeight}px`;
      el.value = prev;
    } else {
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value, placeholder]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={500}
      aria-label="Mensaje de saludo"
      className={className}
    />
  );
}

// ── Utilidad de color ────────────────────────────────────────────────────────

// Normaliza cualquier color CSS (hex, rgb(), hsl(), nombre tipo "royalblue") a
// #rrggbb. Devuelve null si no es un color válido. Usa el parser del navegador
// para no mantener una lista de nombres ni regex frágiles; fallback a hex en SSR.
function cssColorToHex(input: string): string | null {
  const v = (input || "").trim();
  if (!v) return null;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
    if (v.length === 4) return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
    return v.toLowerCase();
  }
  if (typeof document === "undefined") return null;
  const probe = document.createElement("span").style;
  probe.color = "";
  probe.color = v;
  if (!probe.color) return null;  // el navegador no lo reconoció como color
  const m = probe.color.match(/\d+(?:\.\d+)?/g);
  if (!m || m.length < 3) return null;
  const [r, g, b] = m.map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
