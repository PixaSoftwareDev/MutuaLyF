"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pipette, Bot, Lock, X, Send, Loader2, Palette, Contrast, ChevronRight, ChevronLeft, Maximize2, Minimize2, MoveHorizontal, Paperclip } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { extractErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { contrastRatio, pickReadableTextColor, shade } from "@/lib/use-tenant-branding";
import { DEFAULT_BOT_NAME, DEFAULT_GREETING } from "@/components/admin/settings/defaults";
import { BotAvatar } from "@/components/admin/settings/chat-mock";

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
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <Skeleton className="h-[520px] rounded-2xl" />
        <Skeleton className="h-[560px] rounded-2xl" />
      </div>
    );
  }

  return <Customizer branding={branding} botConfig={botConfig} tenantId={tenantId} onSaved={invalidate} />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Customizer — dos piezas (configurador de la referencia):
//   IZQUIERDA (angosto): panel de configuración con el guardar adentro.
//   DERECHA (protagonista): navegador con el widget real, que abre/cierra y habla.
// ═══════════════════════════════════════════════════════════════════════════════

function Customizer({
  branding, botConfig, tenantId, onSaved,
}: { branding: any; botConfig: any; tenantId: string | null; onSaved: () => void }) {
  const [primary, setPrimary]                 = useState(branding.primary_color || DEFAULT_COLOR);
  const [botName, setBotName]                 = useState("");
  const [greeting, setGreeting]               = useState("");
  const [textMode, setTextMode]   = useState<"auto" | "custom">(branding.secondary_color ? "custom" : "auto");
  const [textColor, setTextColor] = useState(branding.secondary_color || "#ffffff");
  const [widgetTheme, setWidgetTheme] = useState<"light" | "dark">(branding.widget_theme === "dark" ? "dark" : "light");
  const [position, setPosition] = useState<"right" | "left">(branding.widget_position === "left" ? "left" : "right");
  // Drill-in del panel de config (patrón referencia): menú → sección → volver.
  const [section, setSection] = useState<"menu" | "tema" | "colores" | "identidad" | "posicion">("menu");

  useEffect(() => {
    setPrimary(branding.primary_color || DEFAULT_COLOR);
    setTextMode(branding.secondary_color ? "custom" : "auto");
    setTextColor(branding.secondary_color || "#ffffff");
    setWidgetTheme(branding.widget_theme === "dark" ? "dark" : "light");
    setPosition(branding.widget_position === "left" ? "left" : "right");
  }, [branding.primary_color, branding.secondary_color, branding.widget_theme, branding.widget_position]);

  // Deps primitivas (no el objeto): un refetch con los mismos valores no pisa
  // lo que el admin está tipeando; solo re-sincroniza si el server CAMBIÓ.
  useEffect(() => {
    if (!botConfig) return;
    setBotName(botConfig.bot_name ?? "");
    setGreeting(botConfig.greeting_message ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botConfig?.bot_name, botConfig?.greeting_message]);

  const previewColor = cssColorToHex(primary) || branding.primary_color || DEFAULT_COLOR;
  const effectiveText = textMode === "custom"
    ? (cssColorToHex(textColor) || pickReadableTextColor(previewColor))
    : pickReadableTextColor(previewColor);
  const desiredSecondary = textMode === "custom" ? effectiveText : null;

  const ratio    = contrastRatio(previewColor, effectiveText);
  const aaNormal = ratio >= 4.5;
  const aaLarge  = ratio >= 3.0;

  const identityDirty =
    botConfig != null &&
    (botName.trim() !== (botConfig.bot_name ?? "") || greeting !== (botConfig.greeting_message ?? ""));
  const colorDirty = previewColor.toLowerCase() !== (branding.primary_color || DEFAULT_COLOR).toLowerCase();
  const textDirty  = (desiredSecondary?.toLowerCase() ?? null) !== ((branding.secondary_color as string | null)?.toLowerCase() ?? null);
  const themeDirty = widgetTheme !== (branding.widget_theme === "dark" ? "dark" : "light");
  const positionDirty = position !== (branding.widget_position === "left" ? "left" : "right");
  const anyDirty = identityDirty || colorDirty || textDirty || themeDirty || positionDirty;

  const saveM = useMutation({
    mutationFn: async () => {
      if (identityDirty) {
        await api.tenants.updateBotConfig(tenantId!, {
          bot_name: botName.trim() || null,
          greeting_message: greeting || null,
        });
      }
      const patch: { primary_color?: string; secondary_color?: string; widget_theme?: "light" | "dark"; widget_position?: "right" | "left" } = {};
      if (colorDirty) patch.primary_color = previewColor;
      if (textDirty)  patch.secondary_color = desiredSecondary ?? "";  // "" = limpiar (auto)
      if (themeDirty) patch.widget_theme = widgetTheme;
      if (positionDirty) patch.widget_position = position;
      if (Object.keys(patch).length) await api.branding.update(patch);
    },
    onSuccess: () => toast({ title: "Cambios guardados", variant: "success" }),
    onError: (err: any) => toast({
      title: "Error al guardar",
      description: extractErrorMessage(err, "Algunos cambios pueden no haberse aplicado. Revisá y reintentá."),
      variant: "destructive",
    }),
    // onSettled (no onSuccess): el guardado son DOS requests (identidad +
    // branding). Si el segundo falla, el primero YA se aplicó — invalidar
    // siempre para que lo guardado se refleje y lo fallido quede editable.
    onSettled: onSaved,
  });

  return (
    // Riel único de Configuración (max-w-6xl), como el resto de las pestañas.
    // Altura de la ventana: ambos contenedores llegan hasta abajo (desktop).
    <div className="mx-auto grid w-full max-w-6xl gap-6 lg:h-[calc(100dvh-11rem)] lg:grid-cols-[340px_1fr]">
      {/* ── Panel de configuración (chico, izquierda) — drill-in sin scroll ── */}
      <Card className="flex flex-col overflow-hidden rounded-2xl lg:min-h-0">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          {section === "menu" ? (
            <>
              <div className="border-b px-5 py-4">
                <h3 className="text-sm font-semibold text-foreground">Personalizar widget</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">El aspecto del bot en tu sitio.</p>
              </div>
              <div className="min-h-0 flex-1 animate-fade-in overflow-y-auto scrollbar-slim p-2">
                <CategoryButton icon={Contrast} title="Tema" desc="Fondo claro u oscuro del chat." onClick={() => setSection("tema")} />
                <CategoryButton icon={Palette}  title="Colores" desc="Color de marca y de la letra." onClick={() => setSection("colores")} />
                <CategoryButton icon={Bot}      title="Identidad" desc="Nombre del asistente y saludo." onClick={() => setSection("identidad")} />
                <CategoryButton icon={MoveHorizontal} title="Posición" desc="Esquina donde aparece en el sitio." onClick={() => setSection("posicion")} />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-3">
                <button onClick={() => setSection("menu")} aria-label="Volver" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <h3 className="text-sm font-semibold text-foreground">
                  {section === "tema" ? "Tema" : section === "colores" ? "Colores" : section === "identidad" ? "Identidad" : "Posición"}
                </h3>
              </div>
              <div key={section} className="min-h-0 flex-1 animate-fade-in space-y-5 overflow-y-auto scrollbar-slim px-5 py-5">
                {section === "tema" && (
                  <div className="grid grid-cols-2 gap-2.5">
                    {(["light", "dark"] as const).map(t => (
                      <ThemeCard key={t} theme={t} selected={widgetTheme === t} primaryColor={previewColor} onSelect={() => setWidgetTheme(t)} />
                    ))}
                  </div>
                )}

                {section === "colores" && (<>
                  <Field label="Color de fondo" hint="Encabezado y mensajes del usuario.">
                    <ColorField presets={PALETTE_PRESETS} value={previewColor} raw={primary} onChange={setPrimary} />
                  </Field>
                  <Field label="Color de la letra">
                    <div className="inline-flex rounded-lg border bg-background p-0.5">
                      <button
                        type="button"
                        onClick={() => setTextMode("auto")}
                        className={cn(
                          "whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors",
                          textMode === "auto" ? "bg-action-gradient text-white shadow-sm" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Automático
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
                    {textMode === "custom" && (
                      <div className="mt-2.5">
                        <ColorField presets={TEXT_PRESETS} value={effectiveText} raw={textColor} onChange={setTextColor} />
                      </div>
                    )}
                    <div className="mt-2.5">
                      <ContrastPreview color={previewColor} text={effectiveText} aaNormal={aaNormal} aaLarge={aaLarge} />
                    </div>
                    {!aaNormal && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        {aaLarge ? "Sirve para texto grande; el chico puede leerse mal." : "Puede quedar ilegible — probá otra combinación."}
                      </p>
                    )}
                  </Field>
                </>)}

                {section === "identidad" && (<>
                  <Field label="Nombre del asistente">
                    <Input value={botName} onChange={e => setBotName(e.target.value)} maxLength={80} placeholder={DEFAULT_BOT_NAME} className="h-9" />
                  </Field>
                  <Field label="Mensaje de bienvenida">
                    <Textarea value={greeting} onChange={e => setGreeting(e.target.value)} maxLength={500} placeholder={DEFAULT_GREETING} className="min-h-[5rem] resize-none text-sm leading-relaxed" />
                  </Field>
                </>)}

                {section === "posicion" && (
                  <Field label="Esquina del sitio" hint="Dónde aparece el bot en la web del cliente.">
                    <div className="grid grid-cols-2 gap-2.5">
                      {(["left", "right"] as const).map(p => (
                        <PositionCard key={p} pos={p} selected={position === p} primaryColor={previewColor} onSelect={() => setPosition(p)} />
                      ))}
                    </div>
                  </Field>
                )}
              </div>
            </>
          )}

          {/* Guardar — SIEMPRE visible al pie del panel */}
          <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
            {/* Mismo copy que SettingsSaveBar — un solo lenguaje de guardado */}
            <span className="text-xs text-muted-foreground">{anyDirty ? "Tenés cambios sin guardar." : "Todo guardado."}</span>
            <Button size="sm" disabled={!anyDirty || saveM.isPending} onClick={() => saveM.mutate()}>
              {saveM.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Simulación (protagonista, derecha) — llena la altura ── */}
      <div className="flex min-h-[560px] flex-col lg:h-full lg:min-h-0">
        <BrowserPreview side={position}>
          <PreviewWidget
            primaryColor={previewColor}
            textColor={effectiveText}
            dark={widgetTheme === "dark"}
            botName={botName}
            greeting={greeting}
            position={position}
          />
        </BrowserPreview>
      </div>
    </div>
  );
}

// Botón grande de categoría (patrón referencia: ícono + título + descripción + chevron).
function CategoryButton({ icon: Icon, title, desc, onClick }: {
  icon: React.ElementType; title: string; desc: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/60"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{desc}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

// Campo del panel de config: label chico + control.
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Mockup de navegador (configurador de la referencia) ───────────────────────
// Ventana de browser grande: barra oscura + barra de dirección, página web falsa
// detrás, y el widget vivo anclado abajo a la derecha (abre/cierra/conversa).

function BrowserPreview({ children, side = "right" }: { children: React.ReactNode; side?: "right" | "left" }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-sm">
      {/* Barra del navegador */}
      <div className="flex shrink-0 items-center gap-3 bg-[#26272b] px-4 py-2.5">
        <div className="flex shrink-0 gap-1.5">
          {[0, 1, 2].map(i => <span key={i} className="h-3 w-3 rounded-full bg-white/25" />)}
        </div>
        <div className="mx-auto flex h-8 w-full max-w-sm items-center gap-2 rounded-lg bg-[#3a3b40] px-3">
          <Lock className="h-3 w-3 shrink-0 text-white/40" />
          <span className="truncate text-xs text-white/45">tu-sitio.com</span>
        </div>
        <div className="w-14 shrink-0" aria-hidden />
      </div>

      {/* Viewport: página falsa (izquierda, detrás) + widget (abajo a la derecha).
          La maqueta del sitio sigue el tema del PANEL (dark/light), no el del widget. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white dark:bg-[#0e1013]">
        {/* Contenido del sitio, del lado opuesto al widget para no taparse */}
        <div className={cn("max-w-[58%] space-y-4 p-8", side === "left" && "ml-auto")} aria-hidden>
          <div className="h-36 rounded-xl bg-slate-200/70 dark:bg-white/[0.06]" />
          <div className="h-2.5 w-4/5 rounded-full bg-slate-200/70 dark:bg-white/[0.06]" />
          <div className="h-2.5 w-3/5 rounded-full bg-slate-200/70 dark:bg-white/[0.06]" />
          <div className="mt-5 h-7 w-32 rounded-full bg-slate-300/70 dark:bg-white/10" />
          <div className="flex gap-4 pt-3">
            <div className="h-20 w-20 shrink-0 rounded-lg bg-slate-200/70 dark:bg-white/[0.06]" />
            <div className="flex-1 space-y-2.5 pt-1">
              <div className="h-2.5 w-full rounded-full bg-slate-200/70 dark:bg-white/[0.06]" />
              <div className="h-2.5 w-5/6 rounded-full bg-slate-200/70 dark:bg-white/[0.06]" />
              <div className="h-2.5 w-2/3 rounded-full bg-slate-200/70 dark:bg-white/[0.06]" />
            </div>
          </div>
        </div>
        {/* Slot del widget — el propio widget se ancla abajo a la derecha */}
        {children}
      </div>
    </div>
  );
}

// ── Widget de preview INTERACTIVO (abre/cierra, conversa como el real) ─────────

type PreviewMsg = { role: "user" | "bot"; text: string };

function PreviewWidget({ primaryColor, textColor, dark, botName, greeting, position }: {
  primaryColor: string;
  textColor: string;
  dark: boolean;
  botName: string;
  greeting: string;
  position: "right" | "left";
}) {
  const dock = position === "left" ? "left-4" : "right-4";
  const origin = position === "left" ? "bottom left" : "bottom right";
  const [open, setOpen] = useState(true);
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [msgs, setMsgs] = useState<PreviewMsg[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cerrar con animación: corre widget-out y recién después desmonta el panel.
  const close = () => {
    setClosing(true);
    closeTimer.current = setTimeout(() => { setOpen(false); setClosing(false); }, 180);
  };

  const name  = botName.trim() || DEFAULT_BOT_NAME;
  const greet = greeting.trim() || DEFAULT_GREETING;

  const avatarGrad = `linear-gradient(135deg, ${shade(primaryColor, 15)}, ${shade(primaryColor, -15)})`;
  const bubbleGrad = `linear-gradient(135deg, ${primaryColor}, ${shade(primaryColor, -15)})`;

  // Paleta white-first (referencia): panel blanco/oscuro, el color de marca es
  // acento (avatar + burbuja del usuario), no un header pintado.
  const T = dark
    ? { panel: "#15181b", border: "#262c33", cardBg: "#1c2126", botBg: "#1c2126", botText: "#e7e9ec", inputBg: "#22272c", ph: "#6b7280", sub: "#8b939e", icon: "#8b939e" }
    : { panel: "#ffffff", border: "#eceef1", cardBg: "#ffffff", botBg: "#f4f5f7", botText: "#1e293b", inputBg: "#f1f3f5", ph: "#94a3b8", sub: "#64748b", icon: "#94a3b8" };

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, typing, open]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  function send() {
    const t = input.trim();
    if (!t) return;
    setInput("");
    setMsgs(m => [...m, { role: "user", text: t }]);
    setTyping(true);
    timer.current = setTimeout(() => {
      setTyping(false);
      setMsgs(m => [...m, { role: "bot", text: "Esto es una vista previa. En tu sitio, respondería con la información de tus documentos." }]);
    }, 900);
  }

  // Avatar del bot — el compartido de Configuración, pintado con el color del
  // tenant (este preview muestra SU identidad, no la de la plataforma).
  const avatar = (size: number) => (
    <BotAvatar size={size} background={avatarGrad} dotBorderColor={T.panel} />
  );

  // ── FAB (cerrado) ── al pasar el cursor, la cara cambia por los 3 puntitos.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Abrir chat"
        className={cn("fab-pop group absolute bottom-4 z-10 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg transition-transform hover:scale-105", dock)}
        style={{ background: avatarGrad }}
      >
        <Bot className="h-7 w-7 transition-opacity duration-150 group-hover:opacity-0" />
        <span className="absolute inset-0 flex items-center justify-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {[0, 1, 2].map(i => (
            <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-white" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </span>
      </button>
    );
  }

  // ── Panel abierto (white-first, patrón referencia) ──
  return (
    <div
      className={cn(
        "absolute bottom-4 z-10 flex max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border shadow-2xl",
        dock,
        closing ? "widget-out" : "widget-in",
        "transition-[width,height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        expanded ? "h-[560px] w-[500px]" : "h-[480px] w-[350px]",
      )}
      style={{ background: T.panel, borderColor: T.border, transformOrigin: origin }}
    >
      {/* Acciones sueltas — agrandar a la izquierda, cerrar a la derecha */}
      <div className="flex shrink-0 items-center justify-between px-2.5 pt-2.5">
        {/* hover según el tema DEL WIDGET (no del panel): black/5 era invisible en oscuro */}
        <button onClick={() => setExpanded(e => !e)} aria-label={expanded ? "Reducir" : "Agrandar"} className={cn("flex h-7 w-7 items-center justify-center rounded-lg transition-colors", dark ? "hover:bg-white/10" : "hover:bg-black/5")} style={{ color: T.icon }}>
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button onClick={close} aria-label="Cerrar" className={cn("flex h-7 w-7 items-center justify-center rounded-lg transition-colors", dark ? "hover:bg-white/10" : "hover:bg-black/5")} style={{ color: T.icon }}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Cuerpo: tarjeta de identidad flotante + conversación */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto scrollbar-slim px-3.5 pb-4" style={{ background: T.panel }}>
        {/* Tarjeta de identidad — el nombre y el estado del bot */}
        <div className="mx-auto mb-5 mt-1 flex w-fit max-w-[90%] items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 shadow-[0_4px_12px_-3px_rgba(0,0,0,0.10),0_1px_4px_-1px_rgba(0,0,0,0.06)]" style={{ background: T.cardBg, borderColor: T.border }}>
          {avatar(34)}
          <div className="min-w-0 text-left">
            <p className="truncate text-[13px] font-semibold leading-tight" style={{ color: T.botText }}>{name}</p>
            <p className="text-[11px] leading-tight" style={{ color: T.sub }}>En línea</p>
          </div>
        </div>

        <div className="space-y-3">
          <BotLine avatar={avatar(24)} bg={T.botBg} color={T.botText}>{greet}</BotLine>
          {msgs.map((m, i) => m.role === "user"
            ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm" style={{ background: bubbleGrad, color: textColor }}>{m.text}</div>
              </div>
            )
            : <BotLine key={i} avatar={avatar(24)} bg={T.botBg} color={T.botText}>{m.text}</BotLine>
          )}
          {typing && (
            <div className="flex items-end gap-2">
              {avatar(24)}
              <div className="flex w-fit items-center gap-1 rounded-2xl rounded-bl-md px-3.5 py-3" style={{ background: T.botBg }}>
                {[0, 1, 2].map(i => (
                  <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ animationDelay: `${i * 160}ms`, background: T.sub }} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input pill */}
      <div className="shrink-0 px-3 py-2.5" style={{ background: T.panel }}>
        <div className="flex items-center gap-1 rounded-full py-1 pl-1.5 pr-1" style={{ background: T.inputBg }}>
          {/* Decorativo (el preview no adjunta): fuera del tab-order y de los lectores */}
          <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ color: T.icon }}>
            <Paperclip className="h-[18px] w-[18px]" />
          </span>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") send(); }}
            placeholder="Escribí un mensaje…"
            className="min-w-0 flex-1 bg-transparent px-1 text-[13px] outline-none"
            style={{ color: T.botText }}
          />
          <button onClick={send} disabled={!input.trim()} aria-label="Enviar" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40" style={{ background: bubbleGrad }}>
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Línea de mensaje del bot (avatar chico + burbuja liviana, sin borde duro).
function BotLine({ avatar, bg, color, children }: {
  avatar: React.ReactNode; bg: string; color: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-end gap-2">
      {avatar}
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md px-3.5 py-2.5 text-[13px] leading-relaxed" style={{ background: bg, color }}>
        {children}
      </div>
    </div>
  );
}

// ── Card de tema (mini-mock claro/oscuro, patrón Theme cards de la referencia) ─

function ThemeCard({ theme, selected, primaryColor, onSelect }: {
  theme: "light" | "dark";
  selected: boolean;
  primaryColor: string;
  onSelect: () => void;
}) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group relative overflow-hidden rounded-xl border text-left transition-all",
        selected ? "border-foreground/60 ring-1 ring-foreground/30" : "hover:border-foreground/25",
      )}
    >
      <div className={cn("h-20 p-2.5", dark ? "bg-[#101214]" : "bg-[#f6f7f8]")}>
        <div className={cn("flex h-full flex-col overflow-hidden rounded-lg border shadow-sm", dark ? "border-[#262c33] bg-[#15181b]" : "border-slate-200 bg-white")}>
          <div className="h-3 shrink-0" style={{ background: primaryColor }} />
          <div className="flex-1 space-y-1 p-1.5">
            <div className={cn("h-1.5 w-3/5 rounded-full", dark ? "bg-[#2a3138]" : "bg-slate-200")} />
            <div className="ml-auto h-1.5 w-2/5 rounded-full opacity-80" style={{ background: primaryColor }} />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between border-t px-2.5 py-1.5">
        <span className="text-xs font-medium text-foreground">{dark ? "Oscuro" : "Claro"}</span>
        {selected && (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-foreground">
            <Check className="h-2.5 w-2.5 text-background" />
          </span>
        )}
      </div>
    </button>
  );
}

// ── Card de posición (mini-mock: burbuja del widget en la esquina) ────────────

function PositionCard({ pos, selected, primaryColor, onSelect }: {
  pos: "right" | "left"; selected: boolean; primaryColor: string; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group relative overflow-hidden rounded-xl border text-left transition-all",
        selected ? "border-foreground/60 ring-1 ring-foreground/30" : "hover:border-foreground/25",
      )}
    >
      <div className="relative h-20 bg-[#f6f7f8] p-2.5">
        <div className="h-full rounded-lg border border-slate-200 bg-white" />
        <span
          className={cn("absolute bottom-3.5 flex h-6 w-6 items-center justify-center rounded-full", pos === "left" ? "left-3.5" : "right-3.5")}
          style={{ background: `linear-gradient(135deg, ${shade(primaryColor, 15)}, ${shade(primaryColor, -15)})` }}
        >
          <Bot className="h-3 w-3 text-white" />
        </span>
      </div>
      <div className="flex items-center justify-between border-t px-2.5 py-1.5">
        <span className="text-xs font-medium text-foreground">{pos === "left" ? "Izquierda" : "Derecha"}</span>
        {selected && (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-foreground">
            <Check className="h-2.5 w-2.5 text-background" />
          </span>
        )}
      </div>
    </button>
  );
}

// ── Preview de combinación (Aa) + contraste ───────────────────────────────────

function ContrastPreview({
  color, text, aaNormal, aaLarge,
}: {
  color: string; text: string; aaNormal: boolean; aaLarge: boolean;
}) {
  const textTone = aaNormal ? "text-success" : aaLarge ? "text-warning" : "text-destructive";
  const dotTone = aaNormal ? "bg-success" : aaLarge ? "bg-warning" : "bg-destructive";
  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-muted/30 p-2">
      {/* Muestra real: la letra sobre el fondo */}
      <span className="flex h-8 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold shadow-xs" style={{ backgroundColor: color, color: text }} aria-hidden>Aa</span>
      <span className={cn("flex min-w-0 items-center gap-1.5 text-xs font-medium", textTone)}>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotTone)} />
        <span className="truncate">{aaNormal ? "Se lee bien" : aaLarge ? "Puede costar leerse" : "Difícil de leer"}</span>
      </span>
    </div>
  );
}

// ── Selector de color reutilizable (presets + gotero + hex) ───────────────────

function ColorField({
  presets, value, raw, onChange,
}: { presets: string[]; value: string; raw: string; onChange: (v: string) => void }) {
  const valid = !!cssColorToHex(raw);
  return (
    <div className="space-y-2.5">
      {/* Color actual + hex + gotero — un chip prolijo arriba */}
      <div className={cn(
        "flex items-center gap-2.5 rounded-xl border bg-muted/30 p-2",
        !valid && "border-destructive",
      )}>
        <label
          className="relative h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded-lg border shadow-xs transition-transform hover:scale-105"
          style={{ background: `linear-gradient(135deg, ${shade(value, 12)}, ${shade(value, -12)})` }}
          title="Elegir un color"
        >
          <input
            type="color"
            value={cssColorToHex(raw) || "#ffffff"}
            onChange={e => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Selector de color"
          />
        </label>
        <input
          type="text"
          value={raw}
          onChange={e => onChange(e.target.value)}
          onBlur={e => { const hex = cssColorToHex(e.target.value); if (hex) onChange(hex); }}
          placeholder="#RRGGBB"
          aria-label="Color en hexadecimal"
          className="min-w-0 flex-1 bg-transparent text-sm font-mono uppercase text-foreground outline-none placeholder:text-muted-foreground"
        />
        <Pipette className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-2">
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
                "flex h-7 w-7 items-center justify-center rounded-full transition-all hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                selected ? "ring-2 ring-foreground/40 ring-offset-2 ring-offset-card" : "",
              )}
              style={{ background: `linear-gradient(135deg, ${shade(p, 12)}, ${shade(p, -12)})` }}
            >
              {selected && <Check className="h-3.5 w-3.5" style={{ color: pickReadableTextColor(p) }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Utilidad de color ────────────────────────────────────────────────────────

// Normaliza cualquier color CSS a #rrggbb. Devuelve null si no es válido.
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
  if (!probe.color) return null;
  const m = probe.color.match(/\d+(?:\.\d+)?/g);
  if (!m || m.length < 3) return null;
  const [r, g, b] = m.map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
