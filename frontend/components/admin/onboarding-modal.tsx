"use client";

import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const ORG_TYPES = ["Empresa privada", "Cooperativa", "Mutual", "ONG", "Organismo público", "Sindicato", "Otra"];
const SERVES_OPTIONS = ["Clientes", "Empleados", "Afiliados", "Socios", "Ciudadanos", "Estudiantes", "Otro"];

/** Sugerencias de excluded_topics segun org_type. Son ejemplos editables — el admin
 *  puede borrarlos o ajustarlos. No se aplican si el admin ya escribio algo manualmente. */
const SUGGESTED_EXCLUDED: Record<string, string> = {
  "Empresa privada":     "salarios individuales, decisiones internas, conflictos personales",
  "Cooperativa":         "datos personales de socios, decisiones internas, conflictos en curso",
  "Mutual":              "datos personales de socios, prestaciones individuales, casos confidenciales",
  "ONG":                 "datos personales de beneficiarios, posiciones políticas, financiamiento detallado",
  "Organismo público":   "opiniones partidarias, casos personales, datos protegidos por privacidad",
  "Sindicato":           "negociaciones en curso, datos personales de afiliados, posiciones políticas",
  "Otra":                "datos personales, decisiones internas, conflictos en curso",
};
const TONES = [
  { key: "formal",   label: "Formal",   desc: "Usted, sin contracciones, profesional" },
  { key: "amigable", label: "Amigable", desc: "Vos, cercano, contracciones permitidas" },
  { key: "tecnico",  label: "Técnico",  desc: "Preciso, directo, sin rodeos" },
];

const FALLBACKS = [
  {
    key: "suggest_contact",
    label: "Sugiere consultar a la organización",
    desc: "El bot indica que el usuario contacte directamente a la organización.",
  },
  {
    key: "offer_handoff",
    label: "Ofrece derivar a un humano",
    desc: "El bot ofrece traspasar la conversación a un operador en vivo.",
  },
  {
    key: "request_contact",
    label: "Pide email o teléfono",
    desc: "El bot pide datos de contacto y avisa que la organización va a responder.",
  },
  {
    key: "suggest_business_hours",
    label: "Sugiere horario de atención",
    desc: "El bot sugiere comunicarse durante el horario habitual de atención.",
  },
] as const;

const STEPS = ["Organización", "Audiencia y temas", "Tono y nombre", "Revisá y confirmá"] as const;

const empty = {
  org_name: "",
  org_type: "",
  org_type_custom: "",   // texto libre cuando org_type === "Otra"
  serves: "",
  serves_custom: "",     // texto libre cuando serves === "Otro"
  main_topics: "",
  excluded_topics: "",
  tone: "",
  bot_name: "",
  fallback_behavior: "suggest_contact", // default historico
};

/** Cuenta items separados por coma (no vacíos). */
function countTopics(value: string): number {
  return value.split(",").map(t => t.trim()).filter(Boolean).length;
}

export function OnboardingModal() {
  const { tenantId } = useAuthStore();
  const qc = useQueryClient();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState(empty);
  const [generatedDesc, setGeneratedDesc] = useState("");
  const [editedDesc, setEditedDesc] = useState("");
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Cuando el admin escribe algo en excluded_topics, dejamos de auto-sugerir.
   *  Asi no le pisamos lo que estaba escribiendo si despues cambia de org_type. */
  const [excludedTouchedByUser, setExcludedTouchedByUser] = useState(false);

  const set = (k: keyof typeof empty, v: string) => setForm(f => ({ ...f, [k]: v }));

  /** Setter especial para org_type: si el admin no edito excluded_topics, lo auto-sugiere. */
  const setOrgType = (t: string) => {
    setForm(f => ({
      ...f,
      org_type: t,
      excluded_topics: excludedTouchedByUser
        ? f.excluded_topics
        : (SUGGESTED_EXCLUDED[t] ?? f.excluded_topics),
    }));
  };

  /** Setter para excluded_topics que marca el campo como editado manualmente. */
  const setExcludedTopics = (v: string) => {
    setExcludedTouchedByUser(true);
    set("excluded_topics", v);
  };

  // Resuelve el valor final de org_type / serves (custom o predefinido)
  const effectiveOrgType = form.org_type === "Otra"
    ? form.org_type_custom.trim()
    : form.org_type;
  const effectiveServes = form.serves === "Otro"
    ? form.serves_custom.trim()
    : form.serves;

  const topicsCount = useMemo(() => countTopics(form.main_topics), [form.main_topics]);

  const generateM = useMutation({
    mutationFn: () => api.tenants.onboardingGenerate(tenantId!, {
      org_name:          form.org_name.trim(),
      org_type:          effectiveOrgType,
      serves:            effectiveServes,
      main_topics:       form.main_topics.trim(),
      excluded_topics:   form.excluded_topics.trim(),
      tone:              form.tone,
      bot_name:          form.bot_name.trim(),
      fallback_behavior: form.fallback_behavior as any,
    }),
    onSuccess: (data) => {
      setGeneratedDesc(data.bot_description);
      setEditedDesc(data.bot_description);
      setSubmitError(null);
      setStep(3);
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo generar la descripción. Intentá de nuevo.";
      setSubmitError(typeof detail === "string" ? detail : "Error al generar.");
    },
  });

  const completeM = useMutation({
    mutationFn: () => api.tenants.onboardingComplete(tenantId!, {
      bot_name:        form.bot_name.trim(),
      bot_description: editedDesc.trim(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      setDone(true);
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo guardar.";
      setSubmitError(typeof detail === "string" ? detail : "Error al guardar.");
    },
  });

  // ── Validación por paso ──
  const canNextPerStep = [
    // Step 0: nombre + tipo (si "Otra", también texto libre)
    form.org_name.trim().length > 0
      && form.org_type !== ""
      && (form.org_type !== "Otra" || form.org_type_custom.trim().length > 0),
    // Step 1: audiencia (si "Otro", custom) + main_topics ≥ 3 items
    form.serves !== ""
      && (form.serves !== "Otro" || form.serves_custom.trim().length > 0)
      && topicsCount >= 3,
    // Step 2: tono + fallback_behavior (siempre tiene default)
    form.tone !== "" && form.fallback_behavior !== "",
    // Step 3: descripción >= 20 chars
    editedDesc.trim().length >= 20,
  ];
  const canNext = canNextPerStep[step];

  if (done) {
    return (
      <div className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-[2px] flex items-center justify-center p-4">
        <div className="bg-background border rounded-xl shadow-lg max-w-md w-full p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
            <CheckCircle2 className="h-7 w-7 text-emerald-600" />
          </div>
          <h2 className="text-xl font-bold">¡Todo listo!</h2>
          <p className="text-sm text-muted-foreground">
            Tu asistente ya tiene contexto sobre la organización. Podés empezar subiendo documentos.
          </p>
          <Button className="w-full" onClick={() => window.location.reload()}>
            Ir al panel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-background border rounded-xl shadow-lg w-full max-w-xl overflow-hidden my-8">

        {/* Header */}
        <div className="px-6 pt-6 pb-5 border-b bg-muted/30">
          <h2 className="font-semibold text-base leading-tight">Configuración inicial del asistente</h2>
          <p className="text-xs text-muted-foreground mt-1">Tomá un minuto para personalizar tu bot.</p>

          {/* Step indicator */}
          <div className="mt-4 space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-medium text-foreground">{STEPS[step]}</p>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                Paso {step + 1} de {STEPS.length}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors",
                    i < step  ? "bg-primary" :
                    i === step ? "bg-primary/60" :
                                 "bg-border"
                  )}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 min-h-[260px]">

          {/* Step 0: Organización */}
          {step === 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                Contanos sobre tu organización. Esta información le dice al bot quién es y para quién trabaja.
              </p>
              <div className="space-y-1">
                <Label className="text-xs">Nombre de la organización *</Label>
                <Input
                  value={form.org_name}
                  onChange={e => set("org_name", e.target.value)}
                  placeholder="Ej. Acme Industries, Banco Norte, Fundación Sur"
                  className="h-9"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tipo de organización *</Label>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {ORG_TYPES.map(t => (
                    <button
                      key={t} type="button"
                      onClick={() => setOrgType(t)}
                      className={cn(
                        "px-3 py-1.5 rounded-md border text-xs font-medium transition-colors",
                        form.org_type === t
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/40"
                      )}
                    >{t}</button>
                  ))}
                </div>
                {form.org_type === "Otra" && (
                  <Input
                    value={form.org_type_custom}
                    onChange={e => set("org_type_custom", e.target.value)}
                    placeholder="Ej. Universidad, Clínica, Estudio jurídico..."
                    className="h-9 mt-2"
                  />
                )}
              </div>
            </>
          )}

          {/* Step 1: Audiencia y temas */}
          {step === 1 && (
            <>
              <p className="text-sm text-muted-foreground">
                ¿A quién atiende el bot y sobre qué temas responde?
              </p>
              <div className="space-y-1">
                <Label className="text-xs">¿A quién atiende? *</Label>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {SERVES_OPTIONS.map(s => (
                    <button
                      key={s} type="button"
                      onClick={() => set("serves", s)}
                      className={cn(
                        "px-3 py-1.5 rounded-md border text-xs font-medium transition-colors",
                        form.serves === s
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/40"
                      )}
                    >{s}</button>
                  ))}
                </div>
                {form.serves === "Otro" && (
                  <Input
                    value={form.serves_custom}
                    onChange={e => set("serves_custom", e.target.value)}
                    placeholder="Ej. Pacientes, Proveedores, Inversores..."
                    className="h-9 mt-2"
                  />
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">¿Sobre qué temas tiene información el bot? *</Label>
                <Input
                  value={form.main_topics}
                  onChange={e => set("main_topics", e.target.value)}
                  placeholder="Ej. recursos humanos, ventas, soporte técnico, facturación, contactos"
                  className="h-9"
                />
                <div className="flex items-center justify-between text-[11px]">
                  <p className="text-muted-foreground">
                    Listá al menos 3 temas separados por comas. Reflejá lo que cubren tus documentos.
                  </p>
                  <span className={cn(
                    "tabular-nums font-medium shrink-0 ml-2",
                    topicsCount >= 3 ? "text-emerald-600" : "text-muted-foreground"
                  )}>
                    {topicsCount}/3
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Temas que NO debe responder (opcional)</Label>
                <Input
                  value={form.excluded_topics}
                  onChange={e => setExcludedTopics(e.target.value)}
                  placeholder="Ej. datos personales, decisiones internas, conflictos en curso"
                  className="h-9"
                />
                <p className="text-[11px] text-muted-foreground">
                  {excludedTouchedByUser
                    ? "Lista lo que el bot debe evitar incluso si lo encuentra en los documentos."
                    : "💡 Sugerido según el tipo de organización — editá lo que no aplique."}
                </p>
              </div>
            </>
          )}

          {/* Step 2: Tono y nombre */}
          {step === 2 && (
            <>
              <p className="text-sm text-muted-foreground">
                ¿Cómo se comunica el asistente?
              </p>
              <div className="space-y-1">
                <Label className="text-xs">Tono *</Label>
                <div className="grid grid-cols-3 gap-2 pt-0.5">
                  {TONES.map(t => (
                    <button
                      key={t.key} type="button"
                      onClick={() => set("tone", t.key)}
                      className={cn(
                        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                        form.tone === t.key
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/40"
                      )}
                    >
                      <span className={cn("text-xs font-semibold", form.tone === t.key ? "text-primary" : "")}>
                        {t.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground leading-tight">{t.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Nombre del asistente (opcional)</Label>
                <Input
                  value={form.bot_name}
                  onChange={e => set("bot_name", e.target.value)}
                  placeholder="Ej. Aria, Soporte, Asistente (dejá vacío para sin nombre)"
                  className="h-9"
                />
              </div>
              <div className="space-y-1 pt-2 border-t">
                <Label className="text-xs">¿Qué hace cuando no encuentra la respuesta? *</Label>
                <div className="grid grid-cols-2 gap-2 pt-0.5">
                  {FALLBACKS.map(f => (
                    <button
                      key={f.key} type="button"
                      onClick={() => set("fallback_behavior", f.key)}
                      className={cn(
                        "flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors",
                        form.fallback_behavior === f.key
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/40"
                      )}
                    >
                      <span className={cn("text-xs font-semibold", form.fallback_behavior === f.key ? "text-primary" : "")}>
                        {f.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground leading-tight">{f.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Step 3: Revisión */}
          {step === 3 && (
            <>
              <p className="text-sm text-muted-foreground">
                Esta es la descripción que el sistema usa en cada consulta. Podés editarla antes de confirmar.
              </p>
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  Descripción generada por IA
                </Label>
                <textarea
                  value={editedDesc}
                  onChange={e => setEditedDesc(e.target.value)}
                  rows={6}
                  className="w-full text-sm border rounded-md px-3 py-2 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring font-mono leading-relaxed"
                />
                <p className="text-[11px] text-muted-foreground">
                  Una vez que confirmés, podés volver a editarla desde Configuración → Bot.
                </p>
              </div>
            </>
          )}

          {/* Error inline */}
          {submitError && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2.5">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex items-center justify-between gap-3">
          {step > 0 && step < 3 ? (
            <Button variant="ghost" size="sm" onClick={() => { setStep(s => s - 1); setSubmitError(null); }}>
              Atrás
            </Button>
          ) : <div />}

          {step < 2 && (
            <Button
              size="sm"
              disabled={!canNext}
              onClick={() => setStep(s => s + 1)}
            >
              Siguiente
            </Button>
          )}

          {step === 2 && (
            <Button
              size="sm"
              disabled={!canNext || generateM.isPending}
              onClick={() => { setSubmitError(null); generateM.mutate(); }}
            >
              {generateM.isPending
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />Generando…</>
                : <><Sparkles className="h-3.5 w-3.5 mr-2" />Generar descripción</>}
            </Button>
          )}

          {step === 3 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setStep(2); setSubmitError(null); }}>
                Atrás
              </Button>
              <Button
                size="sm"
                disabled={!canNext || completeM.isPending}
                onClick={() => { setSubmitError(null); completeM.mutate(); }}
              >
                {completeM.isPending
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />Guardando…</>
                  : "Confirmar y comenzar"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
