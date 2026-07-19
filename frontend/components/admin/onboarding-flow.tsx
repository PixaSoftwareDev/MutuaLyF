"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, ArrowLeft, ArrowRight, Check, RefreshCw, CheckCircle2, AlertCircle, Send,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Constantes ──────────────────────────────────────────────────────────────

const TONES = [
  { key: "formal",   label: "Formal",   desc: "Trato de usted, preciso.",  example: "De acuerdo, podemos asistirle con esa consulta." },
  { key: "amigable", label: "Amigable", desc: "Cercano y cálido.",         example: "¡Claro! Te cuento cómo funciona…" },
  { key: "tecnico",  label: "Técnico",  desc: "Directo y detallado.",      example: "El proceso requiere validación en dos etapas." },
] as const;

// Paleta de colores de marca (lindos, con buen contraste). El primero es el de Intellix.
const BRAND_COLORS = [
  "#7A2DFF", "#6366F1", "#2563EB", "#0891B2",
  "#059669", "#CA8A04", "#EA580C", "#E11D48",
];

const TOTAL_STEPS = 4;

// ── Componente ──────────────────────────────────────────────────────────────

export function OnboardingFlow() {
  const { tenantId } = useAuthStore();
  const qc = useQueryClient();

  const [step, setStep] = useState(0);          // 0..4 (4 = revisión)
  const [dir, setDir]   = useState<1 | -1>(1);  // dirección de la animación
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Datos del wizard
  const [orgName, setOrgName]         = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor]             = useState(BRAND_COLORS[0]);
  const [tone, setTone]               = useState("");

  // Revisión
  const [editedDesc, setEditedDesc] = useState("");

  const go = (next: number) => { setDir(next >= step ? 1 : -1); setError(null); setStep(next); };

  const genPayload = () => ({
    org_name: orgName.trim(),
    description: description.trim(),
    tone,
  });

  const generateM = useMutation({
    mutationFn: () => api.tenants.onboardingGenerate(tenantId!, genPayload()),
    onSuccess: (data) => { setEditedDesc(data.bot_description); go(4); },
    onError: (err: any) => setError(err?.response?.data?.detail || "No se pudo generar la descripción. Probá de nuevo."),
  });

  const regenerateM = useMutation({
    mutationFn: () => api.tenants.onboardingGenerate(tenantId!, genPayload()),
    onSuccess: (data) => { setEditedDesc(data.bot_description); },
    onError: () => setError("No se pudo regenerar."),
  });

  const completeM = useMutation({
    mutationFn: async () => {
      // Guardar el color de marca (best-effort — no bloquea la activación).
      try { await api.branding.update({ primary_color: color }); } catch { /* ignore */ }
      await api.tenants.onboardingComplete(tenantId!, { bot_name: "", bot_description: editedDesc.trim() });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bot-config", tenantId] }); setDone(true); },
    onError: (err: any) => setError(err?.response?.data?.detail || "No se pudo activar el asistente."),
  });

  const busy = generateM.isPending || completeM.isPending;

  const canForward =
    step === 0 ? orgName.trim().length > 0 :
    step === 1 ? description.trim().length >= 10 :
    step === 2 ? !!color :
    step === 3 ? tone !== "" :
    editedDesc.trim().length >= 20;

  const forward = () => {
    if (step < 3) go(step + 1);
    else if (step === 3) generateM.mutate();   // genera y salta a revisión
    else completeM.mutate();                   // activa
  };

  // ── Pantalla final ─────────────────────────────────────────────────────────
  if (done) {
    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center animate-fade-in-up">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10">
            <CheckCircle2 className="h-8 w-8 text-success" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">¡Tu asistente está listo!</h1>
          <p className="max-w-sm text-muted-foreground">
            Ya conoce a tu organización. Subí documentos desde el panel de Conocimiento para que responda con más precisión.
          </p>
          <Button size="lg" className="mt-2" onClick={() => window.location.reload()}>
            Ir al panel <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
      </Screen>
    );
  }

  // ── Wizard ─────────────────────────────────────────────────────────────────
  return (
    <Screen>
      {/* Header: título + progreso */}
      <header className="shrink-0">
        <span className="text-sm font-semibold tracking-tight text-foreground">Configuremos tu asistente</span>
        <div className="mt-6 flex items-center gap-1.5">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full transition-all duration-500",
                i < step ? "bg-action" : i === step ? "bg-action/50" : "bg-border",
              )}
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
          Paso {Math.min(step + 1, TOTAL_STEPS)} de {TOTAL_STEPS}
        </p>
      </header>

      {/* Contenido del paso (animado por dirección) */}
      <main className="flex flex-1 flex-col justify-center py-8">
        <div key={step} className={cn(dir === 1 ? "animate-slide-in-right" : "animate-slide-in-left")}>

          {/* ── Paso 0: Nombre ── */}
          {step === 0 && (
            <div className="space-y-5">
              <StepTitle title="¿Cómo se llama tu organización?" subtitle="Es el nombre con el que tu asistente se va a presentar." />
              <Input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canForward) forward(); }}
                autoFocus
                maxLength={200}
                placeholder="Nombre de tu organización"
                className="h-12 text-base"
              />
            </div>
          )}

          {/* ── Paso 1: A qué se dedican ── */}
          {step === 1 && (
            <div className="space-y-5">
              <StepTitle
                title={`¿A qué se dedica ${orgName.trim() || "tu organización"}?`}
                subtitle="Contanos qué hace y qué ofrece. Con esto la IA entiende de qué puede responder el asistente."
              />
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                autoFocus
                maxLength={1000}
                rows={5}
                placeholder="Ej. Vendemos productos de tecnología y damos soporte a nuestros clientes."
                className="resize-none text-[15px] leading-relaxed"
              />
              <p className="text-[11px] tabular-nums text-muted-foreground">{description.length} / 1000</p>
            </div>
          )}

          {/* ── Paso 2: Branding (color) ── */}
          {step === 2 && (
            <div className="relative space-y-5">
              <StepTitle
                title="Elegí el color de tu marca"
                subtitle="Es el color con el que tus clientes van a ver el asistente en el chat de tu sitio (el widget). Podés cambiarlo cuando quieras."
              />
              {/* Controles (paleta + custom, alineados al mismo ancho) */}
              <div className="max-w-[232px] space-y-3">
                  <div className="grid grid-cols-4 gap-3">
                    {BRAND_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        aria-label={`Color ${c}`}
                        aria-pressed={color === c}
                        className={cn(
                          "flex aspect-square items-center justify-center rounded-xl transition-transform hover:scale-105 focus-visible:outline-none",
                          color === c ? "ring-2 ring-offset-2 ring-offset-canvas" : "ring-1 ring-black/5",
                        )}
                        style={{ backgroundColor: c, ...(color === c ? { boxShadow: `0 0 0 2px ${c}` } : {}) }}
                      >
                        {color === c && <Check className="h-4 w-4 text-white" />}
                      </button>
                    ))}
                  </div>

                  {/* Personalizar: si el color de su marca no está en la paleta */}
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border bg-card p-2.5 transition-colors hover:bg-muted/40">
                    <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md ring-1 ring-black/10" style={{ backgroundColor: color }}>
                      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Elegir un color personalizado" />
                    </span>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block text-[13px] font-medium text-foreground">¿No está el de tu marca?</span>
                      <span className="block text-[11px] text-muted-foreground">Elegí cualquier color · <span className="tabular-nums">{color.toUpperCase()}</span></span>
                    </span>
                  </label>
                </div>

                {/* Vista previa: en pantallas anchas "sale" del ancho contenido y
                    va grande a la derecha (sobre el lienzo); en el resto, debajo. */}
              <div className="mt-6 flex flex-col items-center gap-2 xl:absolute xl:left-full xl:top-1/2 xl:mt-0 xl:ml-10 xl:-translate-y-1/2 xl:items-start">
                <WidgetPreview color={color} />
                <span className="text-[11px] text-muted-foreground xl:pl-1">Así lo ven tus clientes</span>
              </div>
            </div>
          )}

          {/* ── Paso 3: Personalidad ── */}
          {step === 3 && (
            <div className="space-y-5">
              <StepTitle title="¿Cómo querés que hable el asistente?" subtitle="Elegí la personalidad. Después vas a poder ajustar el texto generado." />
              <div className="grid gap-3 sm:grid-cols-3">
                {TONES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTone(t.key)}
                    className={cn(
                      "flex flex-col gap-1.5 rounded-xl border p-4 text-left transition-all",
                      tone === t.key ? "border-action bg-action/[0.05] ring-1 ring-action" : "border-border hover:border-action/40 hover:bg-muted/40",
                    )}
                  >
                    <span className={cn("text-sm font-semibold", tone === t.key && "text-action")}>{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.desc}</span>
                    <span className="mt-1 text-[11px] italic leading-snug text-muted-foreground/80">&ldquo;{t.example}&rdquo;</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Paso 4: Revisión ── */}
          {step === 4 && (
            <div className="space-y-4">
              <StepTitle title="Tu asistente está casi listo" subtitle="La IA generó esta descripción con lo que nos contaste. Editá lo que quieras antes de activarlo." />
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Cómo se describe el asistente</span>
                  <button
                    type="button"
                    disabled={regenerateM.isPending}
                    onClick={() => { setError(null); regenerateM.mutate(); }}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-action hover:underline disabled:opacity-50"
                  >
                    {regenerateM.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Regenerar
                  </button>
                </div>
                <Textarea
                  value={editedDesc}
                  onChange={(e) => setEditedDesc(e.target.value)}
                  rows={9}
                  className="resize-none leading-relaxed scrollbar-slim"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </main>

      {/* Navegación */}
      <footer className="flex shrink-0 items-center justify-between gap-3">
        {step > 0 ? (
          <Button variant="ghost" onClick={() => go(step - 1)} disabled={busy}>
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Atrás
          </Button>
        ) : <span />}
        <Button size="lg" onClick={forward} disabled={!canForward || busy}>
          {busy ? (
            <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {step === 3 ? "Generando…" : "Activando…"}</>
          ) : step < 3 ? (
            <>Siguiente <ArrowRight className="ml-1.5 h-4 w-4" /></>
          ) : step === 3 ? (
            <>Generar asistente</>
          ) : (
            <>Activar el asistente <Check className="ml-1.5 h-4 w-4" /></>
          )}
        </Button>
      </footer>
    </Screen>
  );
}

// ── Layout full-page (no modal) ─────────────────────────────────────────────

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto scrollbar-slim bg-canvas">
      {/* Mesh de marca sutil, mismo lenguaje que el login */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 0% 0%, #22d3ee14 0%, transparent 45%)," +
            "radial-gradient(circle at 100% 0%, #7A2DFF14 0%, transparent 45%)",
        }}
      />
      <div className="relative mx-auto flex min-h-full w-full max-w-xl flex-col px-6 py-8 sm:py-12">
        {children}
      </div>
    </div>
  );
}

// Maqueta del widget de chat, pintada con el color elegido — se actualiza en vivo
// y las burbujas entran escalonadas para que se sienta "vivo".
function WidgetPreview({ color }: { color: string }) {
  return (
    <div className="w-[320px] shrink-0 overflow-hidden rounded-2xl border bg-card shadow-xl">
      {/* Encabezado (sin ícono de IA) */}
      <div className="flex items-center gap-2.5 px-4 py-3 text-white" style={{ backgroundColor: color }}>
        <span className="h-2.5 w-2.5 rounded-full bg-white/90 shadow-sm" />
        <span className="text-sm font-semibold">Asistente</span>
      </div>
      {/* Conversación — cada burbuja aparece con un pequeño retraso */}
      <div className="min-h-[300px] space-y-2.5 bg-muted/30 p-4">
        <div className="max-w-[85%] animate-fade-in-up rounded-2xl rounded-tl-sm bg-background px-3 py-2 text-xs leading-snug text-foreground shadow-sm" style={{ animationDelay: "0.15s" }}>
          ¡Hola! ¿En qué te puedo ayudar?
        </div>
        <div className="ml-auto max-w-[85%] animate-fade-in-up rounded-2xl rounded-tr-sm px-3 py-2 text-xs leading-snug text-white shadow-sm" style={{ backgroundColor: color, animationDelay: "0.45s" }}>
          ¿Cuál es el horario de atención?
        </div>
        <div className="max-w-[85%] animate-fade-in-up rounded-2xl rounded-tl-sm bg-background px-3 py-2 text-xs leading-snug text-foreground shadow-sm" style={{ animationDelay: "0.75s" }}>
          Atendemos de lunes a viernes de 9 a 18 h.
        </div>
        <div className="ml-auto max-w-[85%] animate-fade-in-up rounded-2xl rounded-tr-sm px-3 py-2 text-xs leading-snug text-white shadow-sm" style={{ backgroundColor: color, animationDelay: "1.05s" }}>
          Perfecto, ¡gracias!
        </div>
      </div>
      {/* Barra de escritura */}
      <div className="flex items-center gap-2 border-t p-2.5">
        <div className="flex h-8 flex-1 items-center rounded-full bg-muted px-3 text-[11px] text-muted-foreground">Escribí un mensaje…</div>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow-sm" style={{ backgroundColor: color }}>
          <Send className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  );
}

function StepTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1.5">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="text-[15px] leading-relaxed text-muted-foreground">{subtitle}</p>
    </div>
  );
}
