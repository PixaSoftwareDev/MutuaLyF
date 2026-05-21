"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, CheckCircle2, AlertCircle, Send, MessageSquare, Upload, FileText, X, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_ONBOARDING_DOCS = 3;
const ACCEPTED_DOC_TYPES = ".pdf,.docx,.txt,.html";

type DocStatus = "uploading" | "processing" | "ready" | "error";
interface UploadedDoc {
  filename: string;
  doc_id?: string;
  status: DocStatus;
  error?: string;
}

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

  // ── Test inline (Fase 4) ────────────────────────────────────────────────────
  /** Pregunta que el admin esta tipeando en el bloque "Probar el bot". */
  const [testInput, setTestInput] = useState("");
  /** Historial de pruebas (Q/A) en orden cronologico — se resetea si editan la descripcion. */
  const [testHistory, setTestHistory] = useState<Array<{ q: string; a: string }>>([]);

  // ── Docs upload (Fase 5) ────────────────────────────────────────────────────
  /** Docs subidos durante el onboarding. Se persisten en el tenant (van al Qdrant real). */
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  /** Cuantos docs estan en estado "ready" — habilita "regenerar con docs". */
  const readyDocs = uploadedDocs.filter(d => d.status === "ready").length;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Polling de status para docs en "processing"
  useEffect(() => {
    const pollingTargets = uploadedDocs
      .filter(d => d.status === "processing" && d.doc_id)
      .map(d => d.doc_id!);
    if (pollingTargets.length === 0) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      for (const docId of pollingTargets) {
        try {
          const status = await api.documents.status(docId);
          if (cancelled) return;
          if (status.status === "ready" || status.status === "error") {
            setUploadedDocs(docs => docs.map(d =>
              d.doc_id === docId
                ? { ...d, status: status.status === "ready" ? "ready" : "error" }
                : d
            ));
          }
        } catch { /* sigue polleando */ }
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [uploadedDocs]);

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const slotsAvailable = MAX_ONBOARDING_DOCS - uploadedDocs.length;
    const toUpload = Array.from(files).slice(0, slotsAvailable);

    for (const file of toUpload) {
      // Marcar pending
      const pendingEntry: UploadedDoc = { filename: file.name, status: "uploading" };
      setUploadedDocs(docs => [...docs, pendingEntry]);

      try {
        const resp = await api.documents.upload(file);
        // El endpoint /ingest devuelve doc_id + status inicial
        setUploadedDocs(docs => docs.map(d =>
          d.filename === file.name && d.status === "uploading"
            ? { ...d, doc_id: (resp as any).document_id || (resp as any).doc_id, status: "processing" }
            : d
        ));
      } catch (err: any) {
        const detail = err?.response?.data?.detail || "Error al subir";
        setUploadedDocs(docs => docs.map(d =>
          d.filename === file.name && d.status === "uploading"
            ? { ...d, status: "error", error: typeof detail === "string" ? detail : "Error al subir" }
            : d
        ));
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeDoc = (filename: string) => {
    // No borramos del backend — solo lo sacamos del listado del wizard.
    // Si quieren borrarlo despues, lo hacen desde el panel de Documentos.
    setUploadedDocs(docs => docs.filter(d => d.filename !== filename));
  };

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

  const testQueryM = useMutation({
    mutationFn: () => api.tenants.onboardingTestQuery(tenantId!, {
      question:        testInput.trim(),
      bot_description: editedDesc.trim(),
    }),
    onSuccess: (data) => {
      setTestHistory(h => [...h, { q: testInput.trim(), a: data.answer }]);
      setTestInput("");
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo probar la pregunta.";
      setSubmitError(typeof detail === "string" ? detail : "Error al probar.");
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
                Esta es la descripción que el sistema usa en cada consulta. Podés editarla y probarla antes de confirmar.
              </p>
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  Descripción generada por IA
                </Label>
                <textarea
                  value={editedDesc}
                  onChange={e => {
                    setEditedDesc(e.target.value);
                    // Si cambian la descripcion, las pruebas viejas dejan de ser representativas.
                    if (testHistory.length > 0) setTestHistory([]);
                  }}
                  rows={6}
                  className="w-full text-sm border rounded-md px-3 py-2 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring font-mono leading-relaxed"
                />
                <p className="text-[11px] text-muted-foreground">
                  Una vez que confirmés, podés volver a editarla desde Configuración → Bot.
                </p>
              </div>

              {/* ── Docs upload (Fase 5) ──────────────────────────────────────── */}
              <div className="pt-3 mt-3 border-t space-y-2">
                <div className="flex items-center gap-1.5">
                  <Upload className="h-3.5 w-3.5 text-primary" />
                  <Label className="text-xs">Mejorar la descripción con tus documentos (opcional)</Label>
                </div>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  Subí hasta {MAX_ONBOARDING_DOCS} archivos representativos. La IA va a generar una descripción más precisa basándose en el contenido real de tus docs.
                </p>

                {/* Drop zone / file picker */}
                {uploadedDocs.length < MAX_ONBOARDING_DOCS && (
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept={ACCEPTED_DOC_TYPES}
                      className="hidden"
                      onChange={e => handleFilesSelected(e.target.files)}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full border-2 border-dashed border-border rounded-lg py-4 px-3 flex flex-col items-center gap-1 hover:border-primary/50 hover:bg-primary/5 transition-colors text-xs text-muted-foreground"
                    >
                      <Upload className="h-4 w-4" />
                      Clickeá para seleccionar archivos
                      <span className="text-[10px]">PDF, DOCX, TXT, HTML · máx {MAX_ONBOARDING_DOCS}</span>
                    </button>
                  </div>
                )}

                {/* Lista de docs subidos */}
                {uploadedDocs.length > 0 && (
                  <div className="space-y-1.5 mt-2">
                    {uploadedDocs.map(d => (
                      <div key={d.filename} className="flex items-center gap-2 text-xs bg-muted/40 rounded-md px-2.5 py-1.5">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate flex-1">{d.filename}</span>
                        {d.status === "uploading" && (
                          <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                            <Loader2 className="h-3 w-3 animate-spin" /> subiendo…
                          </span>
                        )}
                        {d.status === "processing" && (
                          <span className="flex items-center gap-1 text-[10px] text-amber-600 shrink-0">
                            <Loader2 className="h-3 w-3 animate-spin" /> procesando…
                          </span>
                        )}
                        {d.status === "ready" && (
                          <span className="text-[10px] text-emerald-600 font-medium shrink-0">listo</span>
                        )}
                        {d.status === "error" && (
                          <span className="text-[10px] text-destructive shrink-0" title={d.error || ""}>
                            error
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => removeDoc(d.filename)}
                          className="text-muted-foreground hover:text-destructive shrink-0"
                          aria-label="Quitar"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Botón regenerar con docs */}
                {readyDocs > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={generateM.isPending}
                    onClick={() => { setSubmitError(null); generateM.mutate(); }}
                    className="w-full mt-2 gap-1.5"
                  >
                    {generateM.isPending
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Regenerando con tus {readyDocs} {readyDocs === 1 ? "documento" : "documentos"}…</>
                      : <><RefreshCw className="h-3.5 w-3.5" /> Regenerar descripción con {readyDocs} {readyDocs === 1 ? "documento" : "documentos"}</>}
                  </Button>
                )}
              </div>

              {/* ── Test inline (Fase 4) ──────────────────────────────────────── */}
              <div className="pt-3 mt-3 border-t space-y-2">
                <div className="flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5 text-primary" />
                  <Label className="text-xs">Probá una pregunta de ejemplo</Label>
                </div>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  Simulamos cómo respondería el bot con esta descripción. <strong>Sin documentos cargados todavía</strong>, así que para preguntas factuales el bot va a indicar que necesita los docs.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={testInput}
                    onChange={e => setTestInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && testInput.trim() && !testQueryM.isPending) {
                        e.preventDefault();
                        setSubmitError(null);
                        testQueryM.mutate();
                      }
                    }}
                    placeholder="Ej. ¿qué horarios tienen?, ¿cómo te llamás?, ¿dónde están?"
                    className="h-9 text-sm"
                  />
                  <Button
                    size="sm"
                    disabled={!testInput.trim() || testQueryM.isPending || editedDesc.trim().length < 20}
                    onClick={() => { setSubmitError(null); testQueryM.mutate(); }}
                  >
                    {testQueryM.isPending
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Send className="h-3.5 w-3.5" />}
                  </Button>
                </div>

                {testHistory.length > 0 && (
                  <div className="space-y-2 mt-3 max-h-56 overflow-y-auto pr-1">
                    {testHistory.map((t, i) => (
                      <div key={i} className="text-xs space-y-1">
                        <div className="flex items-start gap-2">
                          <span className="font-semibold text-muted-foreground shrink-0">Vos:</span>
                          <span>{t.q}</span>
                        </div>
                        <div className="flex items-start gap-2 bg-primary/5 rounded-md px-2 py-1.5 border border-primary/10">
                          <span className="font-semibold text-primary shrink-0">Bot:</span>
                          <span className="text-foreground leading-relaxed">{t.a}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
