"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Check, Pipette } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { contrastRatio, pickReadableTextColor } from "@/lib/use-tenant-branding";
import {
  ChatPreview,
  DEFAULT_BOT_NAME, DEFAULT_GREETING,
} from "@/components/admin/settings/chat-preview";

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
  const chatDirty = colorDirty || identityDirty;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-branding"] });
    qc.invalidateQueries({ queryKey: ["tenant-branding"] });
    qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
  };

  const saveNameM = useMutation({
    mutationFn: () => api.branding.update({
      display_name: displayName.trim() || branding!.display_name,
    }),
    onSuccess: () => { invalidate(); toast({ title: "Nombre actualizado", variant: "success" }); },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: detail, variant: "destructive" });
    },
  });

  // Un solo Guardar para toda la card del chat: identidad (bot config) y
  // color (branding) van a endpoints distintos — se disparan solo los dirty.
  const saveChatM = useMutation({
    mutationFn: async () => {
      if (identityDirty) {
        await api.tenants.updateBotConfig(tenantId!, {
          bot_name: botName.trim() || null,
          greeting_message: greetingMessage || null,
        });
      }
      if (colorDirty) {
        await api.branding.update({ primary_color: cssColorToHex(primary) || primary });
      }
    },
    onSuccess: () => { invalidate(); toast({ title: "Chat actualizado", variant: "success" }); },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: detail, variant: "destructive" });
    },
  });

  if (isLoading || !branding) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-[640px] rounded-2xl" />
      </div>
    );
  }

  // Lo elegido (aunque no esté guardado) se refleja en vivo en la réplica.
  const previewColor = cssColorToHex(primary) || branding.primary_color || DEFAULT_COLOR;
  const previewText  = pickReadableTextColor(previewColor);
  const ratio        = contrastRatio(previewColor, previewText);
  const aaNormal     = ratio >= 4.5;
  const aaLarge      = ratio >= 3.0;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
      {/* ── Columna izquierda: formulario ── */}
      <div className="space-y-6">
      {/* ── Organización ── */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Organización</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            El nombre visible para tus usuarios y operadores.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5 max-w-md">
            <Label htmlFor="display_name">Nombre visible</Label>
            <Input
              id="display_name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              maxLength={200}
              placeholder="Ej. Mutualyf S.A."
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => saveNameM.mutate()}
              disabled={!nameDirty || !displayName.trim() || saveNameM.isPending}
            >
              {saveNameM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Guardar cambios
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Chat de cara al cliente: identidad + color + réplica en vivo ── */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Chat de cara al cliente</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            El nombre, el saludo y el color con los que el asistente recibe a tus clientes en el chat y el widget.
            Todo se refleja al instante en la réplica.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">

          {/* Identidad del asistente */}
          <div className="grid gap-4 sm:grid-cols-[280px,minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="bot-name">Nombre del asistente</Label>
              <Input
                id="bot-name"
                value={botName}
                onChange={e => setBotName(e.target.value)}
                maxLength={80}
                placeholder={DEFAULT_BOT_NAME}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bot-greeting">Mensaje de saludo</Label>
              <Textarea
                id="bot-greeting"
                value={greetingMessage}
                onChange={e => setGreetingMessage(e.target.value)}
                placeholder={DEFAULT_GREETING}
                rows={2}
                className="text-sm resize-none"
              />
            </div>
          </div>

          {/* Color: paleta · gotero + hex · contraste a la derecha */}
          <div className="space-y-1.5">
            <Label>Color</Label>
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
                "ml-auto inline-flex items-center gap-1.5 text-[11px] font-medium",
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
              <p className="text-xs text-muted-foreground pt-1">
                {aaLarge
                  ? "Este color sirve solo para texto grande. El texto chico del chat puede leerse mal — probá un tono más oscuro o más claro."
                  : "Este color no contrasta bien ni con texto blanco ni oscuro. El chat puede quedar ilegible — elegí otro tono."}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <p className="text-[11px] text-muted-foreground">
              Es la misma vista que el widget y “Probar chat”.
            </p>
            <Button
              onClick={() => saveChatM.mutate()}
              disabled={!chatDirty || saveChatM.isPending}
            >
              {saveChatM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Guardar cambios
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* ── Columna derecha: réplica en vivo (refleja nombre, saludo y color) ── */}
      <div className="xl:sticky xl:top-6">
        <Card className="rounded-2xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Vista previa</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Se actualiza al instante con tus cambios.
            </p>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl bg-muted/30 border border-border/50 px-4 py-7 sm:py-9">
              <div className="mx-auto max-w-[330px]">
                <ChatPreview
                  botName={botName.trim() || DEFAULT_BOT_NAME}
                  primaryColor={previewColor}
                  logoUrl={null}
                  conversation={[
                    { from: "bot", text: greetingMessage.trim() || DEFAULT_GREETING },
                    { from: "user", text: "Hola, tengo una consulta" },
                  ]}
                  typing
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
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
