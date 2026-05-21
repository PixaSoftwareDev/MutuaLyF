"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type OnboardingFixedAnswers } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, CheckCircle2, AlertCircle,
  Upload, FileText, X, HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Constantes ──────────────────────────────────────────────────────────────

const MAX_ONBOARDING_DOCS = 3;
const ACCEPTED_DOC_TYPES = ".pdf,.docx,.txt,.html";

type DocStatus = "uploading" | "processing" | "ready" | "error";
interface UploadedDoc {
  filename: string;
  doc_id?: string;
  status: DocStatus;
  error?: string;
  /** Mensaje informativo (ej. "ya estaba cargado" cuando se detecta duplicado). */
  note?: string;
}

const ORG_TYPES = [
  "Empresa privada", "Cooperativa", "Mutual", "ONG",
  "Organismo público", "Sindicato", "Otra",
];

const TONES = [
  { key: "formal",   label: "Formal",   example: "De acuerdo, podemos asistirle con esa consulta." },
  { key: "amigable", label: "Amigable", example: "¡Claro! Te cuento cómo funciona..." },
  { key: "tecnico",  label: "Técnico",  example: "El proceso requiere validación en dos etapas." },
];

const FALLBACKS = [
  { key: "suggest_contact",        label: "Sugerir contacto",    desc: "Que consulten a la organización" },
  { key: "request_contact",        label: "Pedir contacto",      desc: "Pide email o teléfono" },
  { key: "suggest_business_hours", label: "Horario de atención", desc: "Sugiere horario habitual" },
] as const;

type FallbackKey = typeof FALLBACKS[number]["key"];

const STEPS = ["Organización", "Documentos", "Preguntas", "Revisión"] as const;

// ── Componente ──────────────────────────────────────────────────────────────

export function OnboardingModal() {
  const { tenantId } = useAuthStore();
  const qc = useQueryClient();

  // Navegación
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 0 — Identidad
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState("");
  const [orgTypeCustom, setOrgTypeCustom] = useState("");
  const [tone, setTone] = useState("");
  const [botName, setBotName] = useState("");

  // Step 1 — Documentos
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2 — 5 preguntas curadas + followup adaptativo
  const [audience, setAudience]                 = useState("");
  const [typicalQuestions, setTypicalQuestions] = useState("");
  const [excludedTopics, setExcludedTopics]     = useState("");
  const [fallback, setFallback]                 = useState<FallbackKey>("suggest_contact");
  const [additionalNotes, setAdditionalNotes]   = useState("");
  /** Pregunta de profundización adaptativa (null = aún no pedida, "" = la IA decidió no preguntar). */
  const [followupQuestion, setFollowupQuestion] = useState<string | null>(null);
  const [followupAnswer, setFollowupAnswer]     = useState("");
  const [followupSkipped, setFollowupSkipped]   = useState(false);

  // Step 3 — Revisión
  const [editedDesc, setEditedDesc] = useState("");
  const [testInput, setTestInput]   = useState("");
  const [testHistory, setTestHistory] = useState<Array<{ q: string; a: string }>>([]);

  const effectiveOrgType = useMemo(
    () => (orgType === "Otra" ? orgTypeCustom.trim() : orgType),
    [orgType, orgTypeCustom],
  );

  const answersPayload: OnboardingFixedAnswers = useMemo(() => ({
    audience:          audience.trim(),
    typical_questions: typicalQuestions.trim(),
    excluded_topics:   excludedTopics.trim(),
    fallback,
    additional_notes:  additionalNotes.trim(),
  }), [audience, typicalQuestions, excludedTopics, fallback, additionalNotes]);

  // ── Polling de docs en "processing" ──
  useEffect(() => {
    const targets = uploadedDocs
      .filter(d => d.status === "processing" && d.doc_id)
      .map(d => d.doc_id!);
    if (targets.length === 0) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      for (const docId of targets) {
        try {
          const st = await api.documents.status(docId);
          if (cancelled) return;
          if (st.status === "ready" || st.status === "error") {
            setUploadedDocs(docs => docs.map(d =>
              d.doc_id === docId
                ? { ...d, status: st.status === "ready" ? "ready" : "error" }
                : d
            ));
          }
        } catch { /* keep polling */ }
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [uploadedDocs]);

  // ── Upload de docs ──
  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const slots = MAX_ONBOARDING_DOCS - uploadedDocs.length;
    const toUpload = Array.from(files).slice(0, slots);

    for (const file of toUpload) {
      setUploadedDocs(docs => [...docs, { filename: file.name, status: "uploading" }]);

      try {
        const resp = await api.documents.upload(file);
        setUploadedDocs(docs => docs.map(d =>
          d.filename === file.name && d.status === "uploading"
            ? { ...d, doc_id: (resp as any).document_id || (resp as any).doc_id, status: "processing" }
            : d
        ));
      } catch (err: any) {
        const status = err?.response?.status;
        const detail = err?.response?.data?.detail;

        // 409 = duplicate. El archivo YA esta cargado, lo marcamos ready con nota.
        if (status === 409 && detail && typeof detail === "object" && detail.duplicate_of?.id) {
          setUploadedDocs(docs => docs.map(d =>
            d.filename === file.name && d.status === "uploading"
              ? { ...d, doc_id: detail.duplicate_of.id, status: "ready", note: "ya estaba cargado" }
              : d
          ));
          continue;
        }

        const errorMsg =
          typeof detail === "string" ? detail :
          typeof detail?.detail === "string" ? detail.detail :
          status === 413 ? "Archivo demasiado grande" :
          status === 415 ? "Tipo de archivo no soportado" :
          "Error al subir";
        setUploadedDocs(docs => docs.map(d =>
          d.filename === file.name && d.status === "uploading"
            ? { ...d, status: "error", error: errorMsg }
            : d
        ));
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeDoc = (filename: string) =>
    setUploadedDocs(docs => docs.filter(d => d.filename !== filename));

  // ── Mutations ──

  const followupM = useMutation({
    mutationFn: () => api.tenants.onboardingFollowup(tenantId!, {
      org_name: orgName.trim(),
      org_type: effectiveOrgType,
      tone,
      bot_name: botName.trim(),
      answers: answersPayload,
    }),
    onSuccess: (data) => {
      // null = la IA decidió que no hay nada para profundizar — saltamos a generar
      if (!data.question) {
        setFollowupQuestion("");
        generateM.mutate();
      } else {
        setFollowupQuestion(data.question);
      }
    },
    onError: () => {
      // Si falla el followup, no bloqueamos — vamos directo a generar
      setFollowupQuestion("");
      generateM.mutate();
    },
  });

  const generateM = useMutation({
    mutationFn: () => api.tenants.onboardingGenerate(tenantId!, {
      org_name: orgName.trim(),
      org_type: effectiveOrgType,
      tone,
      bot_name: botName.trim(),
      answers: answersPayload,
      followup_question: followupQuestion && !followupSkipped ? followupQuestion : "",
      followup_answer:   !followupSkipped ? followupAnswer.trim() : "",
    }),
    onSuccess: (data) => {
      setEditedDesc(data.bot_description);
      setSubmitError(null);
      setTestHistory([]);
      setStep(3);
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo generar la descripción.";
      setSubmitError(typeof detail === "string" ? detail : "Error al generar.");
    },
  });

  const testQueryM = useMutation({
    mutationFn: () => api.tenants.onboardingTestQuery(tenantId!, {
      question: testInput.trim(),
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

  const regenerateM = useMutation({
    mutationFn: () => api.tenants.onboardingGenerate(tenantId!, {
      org_name: orgName.trim(),
      org_type: effectiveOrgType,
      tone,
      bot_name: botName.trim(),
      answers: answersPayload,
      followup_question: followupQuestion && !followupSkipped ? followupQuestion : "",
      followup_answer:   !followupSkipped ? followupAnswer.trim() : "",
    }),
    onSuccess: (data) => {
      setEditedDesc(data.bot_description);
      setTestHistory([]);
    },
    onError: () => setSubmitError("No se pudo regenerar."),
  });

  const completeM = useMutation({
    mutationFn: () => api.tenants.onboardingComplete(tenantId!, {
      bot_name: botName.trim(),
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

  // ── Acciones step 2 ──

  /** El admin termino las 5 preguntas. Pedimos al backend si hay followup. */
  const submitFixedAnswers = () => {
    setSubmitError(null);
    setFollowupQuestion(null);
    setFollowupAnswer("");
    setFollowupSkipped(false);
    followupM.mutate();
  };

  /** Admin responde la pregunta de followup → generar */
  const submitFollowup = () => {
    if (!followupAnswer.trim()) return;
    setSubmitError(null);
    generateM.mutate();
  };

  /** Admin saltea el followup → generar sin esa info */
  const skipFollowup = () => {
    setFollowupSkipped(true);
    setSubmitError(null);
    generateM.mutate();
  };

  // ── Validaciones ──
  const canNext0 =
    orgName.trim().length > 0 &&
    orgType !== "" &&
    (orgType !== "Otra" || orgTypeCustom.trim().length > 0) &&
    tone !== "";

  // Step 2: la única respuesta obligatoria es "audiencia" — el resto son opcionales
  const canSubmitFixed = audience.trim().length > 0 && fallback !== ("" as any);

  // ── Done screen ──
  if (done) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-background border rounded-lg shadow-lg max-w-md w-full p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
            <CheckCircle2 className="h-7 w-7 text-emerald-600" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight">¡Tu asistente está listo!</h2>
          <p className="text-sm text-muted-foreground">
            El bot ya tiene contexto sobre tu organización. Podés subir más documentos desde el panel para mejorar sus respuestas.
          </p>
          <Button className="w-full" onClick={() => window.location.reload()}>
            Ir al panel
          </Button>
        </div>
      </div>
    );
  }

  // ── Render ──
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-xl overflow-hidden my-8">

        {/* Header */}
        <div className="px-6 pt-6 pb-5 border-b bg-muted/30">
          <h2 className="text-lg font-semibold leading-none tracking-tight">
            Configuración inicial del asistente
          </h2>
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
                    i < step ? "bg-primary" : i === step ? "bg-primary/60" : "bg-border"
                  )}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 min-h-[300px] max-h-[70vh] overflow-y-auto">

          {/* ── Step 0: Identidad ── */}
          {step === 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                Contanos sobre tu organización para que el bot sepa quién es y cómo comunicarse.
              </p>
              <div className="space-y-1">
                <Label className="text-xs">Nombre de la organización</Label>
                <Input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="Ej. Mutual Norte"
                  className="h-9"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tipo de organización</Label>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {ORG_TYPES.map(t => (
                    <button
                      key={t} type="button"
                      onClick={() => setOrgType(t)}
                      className={cn(
                        "px-3 py-1.5 rounded-md border text-xs font-medium transition-colors",
                        orgType === t
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/40"
                      )}
                    >{t}</button>
                  ))}
                </div>
                {orgType === "Otra" && (
                  <Input
                    value={orgTypeCustom}
                    onChange={e => setOrgTypeCustom(e.target.value)}
                    placeholder="Ej. Universidad, Clínica, Estudio jurídico..."
                    className="h-9 mt-2"
                  />
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tono del asistente</Label>
                <div className="grid grid-cols-3 gap-2 pt-0.5">
                  {TONES.map(t => (
                    <button
                      key={t.key} type="button"
                      onClick={() => setTone(t.key)}
                      className={cn(
                        "flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors",
                        tone === t.key
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/40"
                      )}
                    >
                      <span className={cn("text-xs font-semibold", tone === t.key ? "text-primary" : "")}>
                        {t.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground leading-tight italic">
                        &ldquo;{t.example}&rdquo;
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  Nombre del asistente <span className="text-muted-foreground font-normal">(opcional)</span>
                </Label>
                <Input
                  value={botName}
                  onChange={e => setBotName(e.target.value)}
                  placeholder="Ej. Aria"
                  className="h-9"
                />
              </div>
            </>
          )}

          {/* ── Step 1: Documentos ── */}
          {step === 1 && (
            <>
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                <p className="text-sm font-medium text-foreground">Este es el paso más importante</p>
                <p className="text-xs text-muted-foreground mt-1">
                  El bot va a basar sus respuestas en tus documentos. La IA también los va a leer para entender mejor tu organización.
                </p>
              </div>

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
                    className="w-full border-2 border-dashed border-border rounded-lg py-6 px-3 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-sm text-muted-foreground"
                  >
                    <Upload className="h-5 w-5" />
                    Clickeá para seleccionar archivos
                    <span className="text-[11px]">PDF, DOCX, TXT, HTML · máx {MAX_ONBOARDING_DOCS} archivos</span>
                  </button>
                </div>
              )}

              {uploadedDocs.length > 0 && (
                <div className="space-y-1.5">
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
                      {d.status === "ready" && !d.note && (
                        <span className="text-[10px] text-emerald-600 font-medium shrink-0">listo</span>
                      )}
                      {d.status === "ready" && d.note && (
                        <span className="text-[10px] text-amber-600 font-medium shrink-0" title={d.note}>
                          {d.note}
                        </span>
                      )}
                      {d.status === "error" && (
                        <span className="text-[10px] text-destructive shrink-0 max-w-[200px] truncate" title={d.error || ""}>
                          {d.error || "error"}
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

              {uploadedDocs.some(d => d.status === "processing") && (
                <p className="text-[11px] text-muted-foreground">
                  Los documentos se seguirán procesando mientras respondés las preguntas.
                </p>
              )}

              {uploadedDocs.length === 0 && (
                <p className="text-[11px] text-amber-600">
                  Sin documentos el bot va a tener contexto limitado. Podés subirlos ahora o después desde el panel de Documentos.
                </p>
              )}
            </>
          )}

          {/* ── Step 2: 5 preguntas curadas + followup ── */}
          {step === 2 && (
            <>
              {!followupM.isPending && !generateM.isPending && followupQuestion === null && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Solo la primera es obligatoria.
                  </p>

                  {/* Pregunta 1: Audiencia */}
                  <div className="space-y-1">
                    <Label className="text-xs">1. ¿Quiénes lo van a usar?</Label>
                    <Input
                      value={audience}
                      onChange={e => setAudience(e.target.value)}
                      placeholder="Ej. clientes"
                      className="h-9"
                    />
                  </div>

                  {/* Pregunta 2: Preguntas típicas */}
                  <div className="space-y-1">
                    <Label className="text-xs">
                      2. ¿Qué le suelen preguntar?{" "}
                      <span className="text-muted-foreground font-normal">(opcional)</span>
                    </Label>
                    <Textarea
                      value={typicalQuestions}
                      onChange={e => setTypicalQuestions(e.target.value)}
                      placeholder="Ej. ¿Cómo recupero mi clave?"
                      rows={2}
                      className="text-sm resize-none"
                    />
                  </div>

                  {/* Pregunta 3: Temas excluidos */}
                  <div className="space-y-1">
                    <Label className="text-xs">
                      3. ¿Algún tema que NO debe tocar?{" "}
                      <span className="text-muted-foreground font-normal">(opcional)</span>
                    </Label>
                    <Input
                      value={excludedTopics}
                      onChange={e => setExcludedTopics(e.target.value)}
                      placeholder="Ej. precios"
                      className="h-9"
                    />
                  </div>

                  {/* Pregunta 4: Fallback */}
                  <div className="space-y-1">
                    <Label className="text-xs">4. Si no sabe algo</Label>
                    <div className="grid grid-cols-3 gap-2 pt-0.5">
                      {FALLBACKS.map(f => (
                        <button
                          key={f.key} type="button"
                          onClick={() => setFallback(f.key)}
                          className={cn(
                            "flex flex-col gap-0.5 rounded-lg border p-2.5 text-left transition-colors",
                            fallback === f.key
                              ? "border-primary bg-primary/5 ring-1 ring-primary"
                              : "border-border hover:border-primary/40"
                          )}
                        >
                          <span className={cn("text-xs font-semibold", fallback === f.key ? "text-primary" : "")}>
                            {f.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground leading-tight">
                            {f.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Pregunta 5: Notas */}
                  <div className="space-y-1">
                    <Label className="text-xs">
                      5. ¿Algo más a tener en cuenta?{" "}
                      <span className="text-muted-foreground font-normal">(opcional)</span>
                    </Label>
                    <Textarea
                      value={additionalNotes}
                      onChange={e => setAdditionalNotes(e.target.value)}
                      placeholder="Ej. siempre saluda al iniciar"
                      rows={2}
                      className="text-sm resize-none"
                    />
                  </div>
                </>
              )}

              {/* Loading: pidiendo followup o generando */}
              {(followupM.isPending || generateM.isPending) && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  {followupM.isPending && "Analizando tus respuestas..."}
                  {generateM.isPending && "Generando la descripción del bot..."}
                </div>
              )}

              {/* Followup pregunta (si la IA decidió hacerla) */}
              {followupQuestion && !followupM.isPending && !generateM.isPending && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3">
                    <span className="text-[10px] text-primary font-medium flex items-center gap-1 mb-1">
                      <HelpCircle className="h-3 w-3" /> Una pregunta extra
                    </span>
                    <p className="text-sm text-foreground">{followupQuestion}</p>
                  </div>

                  <Textarea
                    value={followupAnswer}
                    onChange={e => setFollowupAnswer(e.target.value)}
                    placeholder="Tu respuesta... (o saltala con el botón si no aplica)"
                    rows={3}
                    className="resize-none text-sm"
                    autoFocus
                  />

                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={skipFollowup}
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    >
                      Saltar y generar descripción
                    </button>
                    <Button
                      size="sm"
                      disabled={!followupAnswer.trim()}
                      onClick={submitFollowup}
                    >
                      Responder y generar
                    </Button>
                  </div>
                </div>
              )}

              {submitError && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2.5">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}
            </>
          )}

          {/* ── Step 3: Revisión ── */}
          {step === 3 && (
            <>
              <p className="text-xs text-muted-foreground">
                Editá si algo no refleja a tu organización.
              </p>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Descripción del bot</Label>
                  <button
                    type="button"
                    disabled={regenerateM.isPending}
                    onClick={() => { setSubmitError(null); regenerateM.mutate(); }}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline flex items-center gap-1 disabled:opacity-50"
                  >
                    {regenerateM.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                    Regenerar
                  </button>
                </div>
                <Textarea
                  value={editedDesc}
                  onChange={e => {
                    setEditedDesc(e.target.value);
                    if (testHistory.length > 0) setTestHistory([]);
                  }}
                  rows={6}
                  className="resize-none leading-relaxed"
                />
              </div>

              {/* Test inline */}
              <div className="pt-3 mt-1 border-t space-y-2">
                <Label className="text-xs">Probá una pregunta</Label>
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
                    placeholder="Ej. ¿cómo me contacto?"
                    className="h-9 text-sm"
                  />
                  <Button
                    size="sm"
                    disabled={!testInput.trim() || testQueryM.isPending || editedDesc.trim().length < 20}
                    onClick={() => { setSubmitError(null); testQueryM.mutate(); }}
                  >
                    {testQueryM.isPending
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : "Probar"}
                  </Button>
                </div>

                {testHistory.length > 0 && (
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
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

              {submitError && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2.5">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex items-center justify-between gap-3">
          {/* Back */}
          {step === 1 && (
            <Button variant="ghost" size="sm" onClick={() => { setStep(0); setSubmitError(null); }}>
              Atrás
            </Button>
          )}
          {step === 2 && !followupQuestion && (
            <Button
              variant="ghost" size="sm"
              disabled={followupM.isPending || generateM.isPending}
              onClick={() => { setStep(1); setSubmitError(null); }}
            >
              Atrás
            </Button>
          )}
          {step === 2 && followupQuestion && (
            <Button
              variant="ghost" size="sm"
              disabled={generateM.isPending}
              onClick={() => { setFollowupQuestion(null); setFollowupAnswer(""); setSubmitError(null); }}
            >
              Atrás
            </Button>
          )}
          {step !== 1 && step !== 2 && <div />}

          {/* Forward */}
          {step === 0 && (
            <Button size="sm" disabled={!canNext0} onClick={() => setStep(1)}>
              Siguiente
            </Button>
          )}
          {step === 1 && (
            <Button size="sm" onClick={() => setStep(2)}>
              {uploadedDocs.length > 0 ? "Continuar" : "Continuar sin documentos"}
            </Button>
          )}
          {step === 2 && !followupQuestion && !followupM.isPending && !generateM.isPending && (
            <Button size="sm" disabled={!canSubmitFixed} onClick={submitFixedAnswers}>
              Continuar
            </Button>
          )}
          {step === 3 && (
            <Button
              size="sm"
              disabled={editedDesc.trim().length < 20 || completeM.isPending}
              onClick={() => { setSubmitError(null); completeM.mutate(); }}
            >
              {completeM.isPending
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />Guardando…</>
                : "Activar el bot"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
