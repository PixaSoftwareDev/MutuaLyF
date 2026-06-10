"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Check, Pipette, Bot, SendHorizontal, Pencil } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { contrastRatio, pickReadableTextColor } from "@/lib/use-tenant-branding";
import { DEFAULT_BOT_NAME, DEFAULT_GREETING } from "@/components/admin/settings/chat-preview";

const DEFAULT_COLOR = "#99323D";
const PALETTE_PRESETS = [
  "#99323D", "#1d4ed8", "#0ea5e9", "#10b981",
  "#f97316", "#a855f7", "#475569", "#0f172a",
];

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

  // ── Form state (espeja backend, editado local) ────────────────────────────
  const [displayName, setDisplayName]         = useState("");
  const [primary, setPrimary]                 = useState(DEFAULT_COLOR);
  const [botName, setBotName]                 = useState("");
  const [greetingMessage, setGreetingMessage] = useState("");

  useEffect(() => {
    if (!branding) return;
    setDisplayName(branding.display_name);
    setPrimary(branding.primary_color || DEFAULT_COLOR);
  }, [branding]);

  useEffect(() => {
    if (!botConfig) return;
    setBotName(botConfig.bot_name ?? "");
    setGreetingMessage(botConfig.greeting_message ?? "");
  }, [botConfig]);

  const nameDirty     = !!branding && displayName.trim() !== branding.display_name;
  const colorDirty    = !!branding && primary !== (branding.primary_color || DEFAULT_COLOR);
  const identityDirty =
    botConfig != null &&
    (botName.trim() !== (botConfig.bot_name ?? "") || greetingMessage !== (botConfig.greeting_message ?? ""));
  const anyDirty = nameDirty || colorDirty || identityDirty;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-branding"] });
    qc.invalidateQueries({ queryKey: ["tenant-branding"] });
    qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
  };

  // Un solo Guardar para todo el panel. Identidad (bot config) y branding
  // (nombre de la organización + color) van a endpoints distintos; el branding
  // se manda en un solo PATCH. Solo se disparan los que cambiaron.
  const saveM = useMutation({
    mutationFn: async () => {
      if (identityDirty) {
        await api.tenants.updateBotConfig(tenantId!, {
          bot_name: botName.trim() || null,
          greeting_message: greetingMessage || null,
        });
      }
      const brandingPatch: { display_name?: string; primary_color?: string } = {};
      if (nameDirty)  brandingPatch.display_name  = displayName.trim() || branding!.display_name;
      if (colorDirty) brandingPatch.primary_color = cssColorToHex(primary) || primary;
      if (Object.keys(brandingPatch).length) await api.branding.update(brandingPatch);
    },
    onSuccess: () => { invalidate(); toast({ title: "Cambios guardados", variant: "success" }); },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: typeof detail === "string" ? detail : "Error al guardar", variant: "destructive" });
    },
  });

  if (isLoading || !branding) {
    return <Skeleton className="h-[640px] rounded-2xl" />;
  }

  // Lo elegido (aunque no esté guardado) se refleja en vivo en la réplica.
  const previewColor = cssColorToHex(primary) || branding.primary_color || DEFAULT_COLOR;
  const previewText  = pickReadableTextColor(previewColor);
  const ratio        = contrastRatio(previewColor, previewText);
  const aaNormal     = ratio >= 4.5;
  const aaLarge      = ratio >= 3.0;

  return (
    <Card className="rounded-2xl overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Tu asistente</CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Editá el nombre, el saludo y el color directamente sobre el chat. Es la misma vista que verán tus clientes en la web y el widget.
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Organización + Color — fila que aprovecha el ancho */}
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-1.5">
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

          <div className="space-y-1.5">
            <Label>Color del chat</Label>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {PALETTE_PRESETS.map(p => {
                const selected = previewColor.toLowerCase() === p.toLowerCase();
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPrimary(p)}
                    aria-label={`Color ${p}`}
                    aria-pressed={selected}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full shadow-xs transition-all hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
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
                  value={cssColorToHex(primary) || "#ffffff"}
                  onChange={e => setPrimary(e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Color personalizado"
                />
              </label>

              <input
                type="text"
                value={primary}
                onChange={e => setPrimary(e.target.value)}
                onBlur={e => { const hex = cssColorToHex(e.target.value); if (hex) setPrimary(hex); }}
                placeholder="#RRGGBB"
                aria-label="Color en hexadecimal"
                className={cn(
                  "h-8 w-24 rounded-md border bg-background px-2.5 text-xs font-mono uppercase text-muted-foreground",
                  "focus:outline-none focus:ring-1 focus:ring-primary focus:text-foreground",
                  cssColorToHex(primary) ? "border-input" : "border-destructive",
                )}
              />

              <span className={cn(
                "inline-flex items-center gap-1.5 text-[11px] font-medium",
                aaNormal ? "text-success" : aaLarge ? "text-warning" : "text-destructive",
              )}>
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  aaNormal ? "bg-success" : aaLarge ? "bg-warning" : "bg-destructive",
                )} />
                {aaNormal ? "Legible" : aaLarge ? "Contraste justo" : "Contraste insuficiente"}
                <span className="font-mono font-normal opacity-70">{ratio.toFixed(1)}:1</span>
              </span>
            </div>
            {!aaNormal && (
              <p className="text-[11px] text-muted-foreground pt-1">
                {aaLarge
                  ? "Este color sirve solo para texto grande. El texto chico del chat puede leerse mal — probá un tono más oscuro o más claro."
                  : "Este color no contrasta bien ni con texto blanco ni oscuro. El chat puede quedar ilegible — elegí otro tono."}
              </p>
            )}
          </div>
        </div>

        {/* Lienzo con el chat editable in-situ */}
        <div className="rounded-2xl bg-muted/30 border border-border/50 px-4 py-8 sm:py-10">
          <div className="mx-auto max-w-[360px]">
            <EditableChat
              botName={botName}
              onBotName={setBotName}
              greeting={greetingMessage}
              onGreeting={setGreetingMessage}
              primaryColor={previewColor}
            />
          </div>
          <p className="text-center text-[11px] text-muted-foreground mt-4 inline-flex w-full items-center justify-center gap-1.5">
            <Pencil className="h-3 w-3" />
            Tocá el nombre o el saludo para editarlos.
          </p>
        </div>

        {/* Footer: aviso de cambios + guardar */}
        <div className="flex items-center justify-between gap-4">
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

// ── Chat editable in-situ ─────────────────────────────────────────────────────

/**
 * Réplica del chat del cliente, pero con el nombre (en el header) y el saludo
 * (en la primera burbuja) editables directamente sobre la pieza. El resto
 * (burbuja del usuario, "escribiendo", input) es decorativo para dar contexto.
 */
function EditableChat({
  botName, onBotName, greeting, onGreeting, primaryColor,
}: {
  botName: string;
  onBotName: (v: string) => void;
  greeting: string;
  onGreeting: (v: string) => void;
  primaryColor: string;
}) {
  const headerText = pickReadableTextColor(primaryColor);

  return (
    <div className="rounded-2xl border bg-card shadow-md overflow-hidden">
      {/* Header con el branding del tenant — nombre editable */}
      <div className="flex items-center gap-2.5 px-4 py-3" style={{ backgroundColor: primaryColor, color: headerText }}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 shrink-0">
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="group relative flex items-center gap-1">
            <input
              value={botName}
              onChange={e => onBotName(e.target.value)}
              placeholder={DEFAULT_BOT_NAME}
              maxLength={80}
              aria-label="Nombre del asistente"
              spellCheck={false}
              className="w-full min-w-0 bg-transparent text-sm font-semibold leading-tight outline-none rounded -mx-1 px-1 py-0.5 transition-colors hover:bg-white/10 focus:bg-white/15 placeholder:opacity-60"
              style={{ color: headerText }}
            />
            <Pencil className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 pointer-events-none" style={{ color: headerText }} />
          </div>
          <p className="text-[10px] leading-tight px-0.5" style={{ color: headerText, opacity: 0.75 }}>
            ● En línea
          </p>
        </div>
      </div>

      {/* Conversación de muestra — saludo editable */}
      <div className="bg-muted/30 px-3.5 py-4 space-y-3">
        <div className="group relative max-w-[88%]">
          <AutoTextarea
            value={greeting}
            onChange={onGreeting}
            placeholder={DEFAULT_GREETING}
            className="w-full rounded-2xl rounded-tl-md border bg-card px-3.5 py-2.5 pr-7 text-[13px] leading-relaxed shadow-xs resize-none outline-none transition-colors hover:border-action/40 focus:border-action/60 focus:ring-2 focus:ring-action/30"
          />
          <Pencil className="absolute top-2.5 right-2.5 h-3 w-3 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none" />
        </div>

        <div
          className="ml-auto max-w-[75%] w-fit rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13px] leading-relaxed shadow-xs"
          style={{ backgroundColor: primaryColor, color: headerText }}
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
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

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
