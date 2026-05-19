"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

const ORG_TYPES = ["Empresa privada", "Cooperativa", "Mutual", "ONG", "Organismo público", "Sindicato", "Otra"];
const SERVES_OPTIONS = ["Clientes", "Empleados", "Afiliados", "Socios", "Ciudadanos", "Estudiantes", "Otro"];
const TONES = [
  { key: "formal", label: "Formal", desc: "Lenguaje profesional y respetuoso" },
  { key: "amigable", label: "Amigable", desc: "Cercano, cálido, de vos" },
  { key: "tecnico", label: "Técnico", desc: "Preciso, directo, sin rodeos" },
];

const STEPS = ["Organización", "Audiencia y temas", "Tono y nombre", "Revisá y confirmá"] as const;

const empty = {
  org_name: "",
  org_type: "",
  serves: "",
  main_topics: "",
  excluded_topics: "",
  tone: "",
  bot_name: "",
};

export function OnboardingModal() {
  const { tenantId } = useAuthStore();
  const qc = useQueryClient();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState(empty);
  const [generatedDesc, setGeneratedDesc] = useState("");
  const [editedDesc, setEditedDesc] = useState("");
  const [done, setDone] = useState(false);

  const set = (k: keyof typeof empty, v: string) => setForm(f => ({ ...f, [k]: v }));

  const generateM = useMutation({
    mutationFn: () => api.tenants.onboardingGenerate(tenantId!, {
      ...form,
      excluded_topics: form.excluded_topics,
    }),
    onSuccess: (data) => {
      setGeneratedDesc(data.bot_description);
      setEditedDesc(data.bot_description);
      setStep(3);
    },
  });

  const completeM = useMutation({
    mutationFn: () => api.tenants.onboardingComplete(tenantId!, {
      bot_name: form.bot_name.trim(),
      bot_description: editedDesc.trim(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-config", tenantId] });
      setDone(true);
    },
  });

  const canNext = [
    form.org_name.trim() && form.org_type,
    form.serves && form.main_topics.trim(),
    form.tone,
    editedDesc.trim().length >= 20,
  ][step];

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

          {/* Step indicator — solo el paso actual + progress bar segmentada */}
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
                  placeholder="Nombre de tu organización"
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
                      onClick={() => set("org_type", t)}
                      className={cn(
                        "px-3 py-1.5 rounded-md border text-xs font-medium transition-colors",
                        form.org_type === t
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/40"
                      )}
                    >{t}</button>
                  ))}
                </div>
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
              </div>
              <div className="space-y-1">
                <Label className="text-xs">¿Sobre qué temas tiene información el bot? *</Label>
                <Input
                  value={form.main_topics}
                  onChange={e => set("main_topics", e.target.value)}
                  placeholder="Ej. horarios de atención, profesionales, normativa, trámites, beneficios"
                  className="h-9"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground">
                  Listá los temas que cubren tus documentos, separados por comas. Se usa para redactar la descripción del bot — no limita lo que puede responder.
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Temas que NO debe responder (opcional)</Label>
                <Input
                  value={form.excluded_topics}
                  onChange={e => set("excluded_topics", e.target.value)}
                  placeholder="Ej. política partidaria, opiniones personales, diagnósticos médicos"
                  className="h-9"
                />
                <p className="text-[11px] text-muted-foreground">
                  Si lo dejás vacío, el bot responde sobre todo lo que encuentre en sus documentos.
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
                  placeholder="Ej. Aria, Asistente, Bot Soporte (dejá vacío para sin nombre)"
                  className="h-9"
                />
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
                  Una vez que confirmés, solo el equipo de soporte puede modificar esto.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex items-center justify-between gap-3">
          {step > 0 && step < 3 ? (
            <Button variant="ghost" size="sm" onClick={() => setStep(s => s - 1)}>
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
              onClick={() => generateM.mutate()}
            >
              {generateM.isPending
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />Generando…</>
                : <><Sparkles className="h-3.5 w-3.5 mr-2" />Generar descripción</>}
            </Button>
          )}

          {step === 3 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep(2)}>
                Atrás
              </Button>
              <Button
                size="sm"
                disabled={!canNext || completeM.isPending}
                onClick={() => completeM.mutate()}
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
