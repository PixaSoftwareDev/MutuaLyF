"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, Sparkles, CheckCircle2, AlertCircle,
  Send, MessageSquare, Upload, FileText, X,
} from "lucide-react";
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

type ChatMessage = { role: "assistant" | "user"; content: string };

const ORG_TYPES = [
  "Empresa privada", "Cooperativa", "Mutual", "ONG",
  "Organismo público", "Sindicato", "Otra",
];

const TONES = [
  {
    key: "formal",
    label: "Formal",
    example: "De acuerdo, podemos asistirle con esa consulta.",
  },
  {
    key: "amigable",
    label: "Amigable",
    example: "¡Claro! Te cuento cómo funciona...",
  },
  {
    key: "tecnico",
    label: "Técnico",
    example: "El proceso requiere validación en dos etapas.",
  },
];

const STEPS = ["Organización", "Documentos", "Preguntas", "Revisión"] as const;
const MAX_EXCHANGES = 5;

export function OnboardingModal() {
  const { tenantId } = useAuthStore();
  const qc = useQueryClient();

  // ── Navigation ──
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Step 0: Identity ──
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState("");
  const [orgTypeCustom, setOrgTypeCustom] = useState("");
  const [tone, setTone] = useState("");
  const [botName, setBotName] = useState("");

  // ── Step 1: Documents ──
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Step 2: AI Conversation ──
  const [chatConversation, setChatConversation] = useState<ChatMessage[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatInitialized, setChatInitialized] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // ── Step 3: Review ──
  const [editedDesc, setEditedDesc] = useState("");
  const [testInput, setTestInput] = useState("");
  const [testHistory, setTestHistory] = useState<Array<{ q: string; a: string }>>([]);

  const effectiveOrgType = useMemo(
    () => (orgType === "Otra" ? orgTypeCustom.trim() : orgType),
    [orgType, orgTypeCustom],
  );

  // ── Doc polling ──
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
            setUploadedDocs(docs =>
              docs.map(d =>
                d.doc_id === docId
                  ? { ...d, status: st.status === "ready" ? "ready" : "error" }
                  : d,
              ),
            );
          }
        } catch { /* keep polling */ }
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [uploadedDocs]);

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const slots = MAX_ONBOARDING_DOCS - uploadedDocs.length;
    const toUpload = Array.from(files).slice(0, slots);
    for (const file of toUpload) {
      setUploadedDocs(docs => [...docs, { filename: file.name, status: "uploading" }]);
      try {
        const resp = await api.documents.upload(file);
        setUploadedDocs(docs =>
          docs.map(d =>
            d.filename === file.name && d.status === "uploading"
              ? {
                  ...d,
                  doc_id: (resp as any).document_id || (resp as any).doc_id,
                  status: "processing",
                }
              : d,
          ),
        );
      } catch (err: any) {
        const detail = err?.response?.data?.detail || "Error al subir";
        setUploadedDocs(docs =>
          docs.map(d =>
            d.filename === file.name && d.status === "uploading"
              ? {
                  ...d,
                  status: "error",
                  error: typeof detail === "string" ? detail : "Error al subir",
                }
              : d,
          ),
        );
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeDoc = (filename: string) =>
    setUploadedDocs(docs => docs.filter(d => d.filename !== filename));

  // ── AI Chat ──
  const callChat = useCallback(
    async (conv: ChatMessage[], forceGenerate = false) => {
      setChatLoading(true);
      setChatError(null);
      try {
        const res = await api.tenants.onboardingChat(tenantId!, {
          org_name: orgName,
          org_type: effectiveOrgType,
          tone,
          bot_name: botName,
          conversation: conv,
          force_generate: forceGenerate,
        });
        if (res.is_done && res.bot_description) {
          setEditedDesc(res.bot_description);
          setStep(3);
        } else if (res.next_question) {
          setCurrentQuestion(res.next_question);
        }
      } catch (err: any) {
        const detail =
          err?.response?.data?.detail ||
          "No se pudo conectar con la IA. Intentá de nuevo.";
        setChatError(typeof detail === "string" ? detail : "Error al procesar.");
      } finally {
        setChatLoading(false);
      }
    },
    [tenantId, orgName, effectiveOrgType, tone, botName],
  );

  // Scroll chat to bottom when new content arrives
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatConversation, currentQuestion, chatLoading]);

  // Initialize chat when entering step 2
  useEffect(() => {
    if (step === 2 && !chatInitialized) {
      setChatInitialized(true);
      callChat([]);
    }
  }, [step, chatInitialized, callChat]);

  const completedExchanges = Math.floor(chatConversation.length / 2);

  const submitAnswer = async () => {
    if (!chatInput.trim() || chatLoading || !currentQuestion) return;
    const answer = chatInput.trim();
    setChatInput("");
    const newConv: ChatMessage[] = [
      ...chatConversation,
      { role: "assistant", content: currentQuestion },
      { role: "user", content: answer },
    ];
    setChatConversation(newConv);
    setCurrentQuestion(null);
    await callChat(newConv);
  };

  const skipQuestion = async () => {
    if (!currentQuestion || chatLoading) return;
    // Marcamos la pregunta como skipeada (con un token que el backend filtra del contexto)
    // pero igual cuenta como user_turn para llegar al limite y forzar generacion.
    const newConv: ChatMessage[] = [
      ...chatConversation,
      { role: "assistant", content: currentQuestion },
      { role: "user", content: "[skip]" },
    ];
    setChatConversation(newConv);
    setCurrentQuestion(null);
    // Si esta es la quinta o mas pregunta skipeada, fuerza generacion para no entrar en loop.
    const userTurnsAfterSkip = newConv.filter(m => m.role === "user").length;
    await callChat(newConv, userTurnsAfterSkip >= MAX_EXCHANGES);
  };

  const goBackFromStep2 = () => {
    // Reset chat state so docs uploaded now are picked up in a fresh conversation
    setChatInitialized(false);
    setChatConversation([]);
    setCurrentQuestion(null);
    setChatError(null);
    setChatInput("");
    setStep(1);
    setSubmitError(null);
  };

  // ── Test query ──
  const testQueryM = useMutation({
    mutationFn: () =>
      api.tenants.onboardingTestQuery(tenantId!, {
        question: testInput.trim(),
        bot_description: editedDesc.trim(),
      }),
    onSuccess: data => {
      setTestHistory(h => [...h, { q: testInput.trim(), a: data.answer }]);
      setTestInput("");
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo probar la pregunta.";
      setSubmitError(typeof detail === "string" ? detail : "Error al probar.");
    },
  });

  // ── Regenerate description from step 3 ──
  const regenerateM = useMutation({
    mutationFn: () =>
      api.tenants.onboardingChat(tenantId!, {
        org_name: orgName,
        org_type: effectiveOrgType,
        tone,
        bot_name: botName,
        conversation: chatConversation,
        force_generate: true,
      }),
    onSuccess: data => {
      if (data.bot_description) {
        setEditedDesc(data.bot_description);
        setTestHistory([]);
      }
    },
    onError: () => {
      setSubmitError("No se pudo regenerar. Intentá de nuevo.");
    },
  });

  // ── Complete onboarding ──
  const completeM = useMutation({
    mutationFn: () =>
      api.tenants.onboardingComplete(tenantId!, {
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

  // ── Validation ──
  const canNext0 =
    orgName.trim().length > 0 &&
    orgType !== "" &&
    (orgType !== "Otra" || orgTypeCustom.trim().length > 0) &&
    tone !== "";

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

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-xl overflow-hidden my-8">

        {/* Header */}
        <div className="px-6 pt-6 pb-5 border-b bg-muted/30">
          <h2 className="text-lg font-semibold leading-none tracking-tight">
            Configuración inicial del asistente
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">
            {step === 2
              ? "La IA te hace preguntas para entender mejor tu organización."
              : "Tomá unos minutos para personalizar tu bot."}
          </p>
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
                    i < step ? "bg-primary" : i === step ? "bg-primary/60" : "bg-border",
                  )}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 min-h-[300px]">

          {/* ── Step 0: Identity ── */}
          {step === 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                Contanos sobre tu organización para que el bot sepa quién es y cómo comunicarse.
              </p>

              <div className="space-y-1">
                <Label className="text-xs">Nombre de la organización *</Label>
                <Input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="Ej. Mutual Norte, Acme Industries, Fundación Sur"
                  className="h-9"
                  autoFocus
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Tipo de organización *</Label>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {ORG_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setOrgType(t)}
                      className={cn(
                        "px-3 py-1.5 rounded-md border text-xs font-medium transition-colors",
                        orgType === t
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/40",
                      )}
                    >
                      {t}
                    </button>
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
                <Label className="text-xs">Tono del asistente *</Label>
                <div className="grid grid-cols-3 gap-2 pt-0.5">
                  {TONES.map(t => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTone(t.key)}
                      className={cn(
                        "flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors",
                        tone === t.key
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/40",
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
                  Nombre del asistente{" "}
                  <span className="text-muted-foreground font-normal">(opcional)</span>
                </Label>
                <Input
                  value={botName}
                  onChange={e => setBotName(e.target.value)}
                  placeholder="Ej. Aria, Soporte, Asistente... (dejá vacío para omitir)"
                  className="h-9"
                />
              </div>
            </>
          )}

          {/* ── Step 1: Documents ── */}
          {step === 1 && (
            <>
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                <p className="text-sm font-medium text-foreground">
                  Este es el paso más importante
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  El bot va a basar sus respuestas en tus documentos. La IA también los va a usar
                  para hacerte preguntas más precisas en el siguiente paso.
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
                    <span className="text-[11px]">
                      PDF, DOCX, TXT, HTML · máx {MAX_ONBOARDING_DOCS} archivos
                    </span>
                  </button>
                </div>
              )}

              {uploadedDocs.length > 0 && (
                <div className="space-y-1.5">
                  {uploadedDocs.map(d => (
                    <div
                      key={d.filename}
                      className="flex items-center gap-2 text-xs bg-muted/40 rounded-md px-2.5 py-1.5"
                    >
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
                        <span className="text-[10px] text-emerald-600 font-medium shrink-0">
                          listo
                        </span>
                      )}
                      {d.status === "error" && (
                        <span
                          className="text-[10px] text-destructive shrink-0"
                          title={d.error || ""}
                        >
                          error
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeDoc(d.filename)}
                        className="text-muted-foreground hover:text-destructive shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {uploadedDocs.some(d => d.status === "processing") && (
                <p className="text-[11px] text-muted-foreground">
                  Los documentos se seguirán procesando mientras respondés las preguntas de configuración.
                </p>
              )}

              {uploadedDocs.length === 0 && (
                <p className="text-[11px] text-amber-600">
                  Sin documentos el bot va a tener contexto limitado. Podés subirlos ahora o después desde el panel de Documentos.
                </p>
              )}
            </>
          )}

          {/* ── Step 2: AI Conversation ── */}
          {step === 2 && (
            <div className="space-y-3">

              {/* Completed Q&A history */}
              {chatConversation.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-y-auto pr-0.5">
                  {Array.from(
                    { length: Math.floor(chatConversation.length / 2) },
                    (_, i) => ({
                      q: chatConversation[i * 2].content,
                      a: chatConversation[i * 2 + 1]?.content,
                    }),
                  ).map((pair, i) => (
                    <div key={i} className="text-xs space-y-1">
                      <div className="bg-primary/5 border border-primary/10 rounded-md px-2.5 py-2">
                        <span className="text-[10px] text-primary font-medium block mb-0.5">
                          Pregunta {i + 1}
                        </span>
                        <span className="text-foreground">{pair.q}</span>
                      </div>
                      {pair.a && pair.a !== "[Sin información adicional]" && (
                        <div className="pl-3 text-muted-foreground">
                          <span className="font-medium text-foreground/70">Vos:</span> {pair.a}
                        </div>
                      )}
                      {pair.a === "[Sin información adicional]" && (
                        <div className="pl-3 text-muted-foreground/50 italic text-[10px]">
                          Saltada
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={chatBottomRef} />
                </div>
              )}

              {/* Loading */}
              {chatLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  {completedExchanges === 0
                    ? "Analizando tu organización..."
                    : "Procesando tu respuesta..."}
                </div>
              )}

              {/* Current question */}
              {currentQuestion && !chatLoading && (
                <div className="bg-primary/5 border border-primary/20 rounded-lg px-3.5 py-3">
                  <span className="text-[10px] text-primary font-medium block mb-1">
                    Pregunta {completedExchanges + 1} de hasta {MAX_EXCHANGES}
                  </span>
                  <p className="text-sm text-foreground">{currentQuestion}</p>
                </div>
              )}

              {/* Answer input */}
              {currentQuestion && !chatLoading && (
                <div className="space-y-2">
                  <Textarea
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submitAnswer();
                      }
                    }}
                    placeholder="Escribí tu respuesta... (Enter para enviar, Shift+Enter para nueva línea)"
                    rows={3}
                    className="resize-none text-sm"
                    autoFocus
                  />
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={skipQuestion}
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    >
                      Saltar esta pregunta
                    </button>
                    <div className="flex items-center gap-2">
                      {completedExchanges >= 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs h-7 px-2.5"
                          disabled={chatLoading}
                          onClick={() => {
                            // Generar inmediatamente: marcamos esta pregunta como
                            // contestada con "[skip]" (que el backend filtra) y
                            // pedimos force_generate=true para que el backend salte
                            // al prompt de generacion.
                            const conv: ChatMessage[] = [
                              ...chatConversation,
                              { role: "assistant", content: currentQuestion },
                              { role: "user", content: "[skip]" },
                            ];
                            setChatConversation(conv);
                            setCurrentQuestion(null);
                            callChat(conv, true);
                          }}
                        >
                          Generar ahora
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={!chatInput.trim() || chatLoading}
                        onClick={submitAnswer}
                      >
                        Responder
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Skip all — shown only before first answer and after first question loads */}
              {currentQuestion && !chatLoading && completedExchanges === 0 && (
                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => callChat([], true)}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  >
                    Saltar todas las preguntas y generar descripción
                  </button>
                </div>
              )}

              {/* Error */}
              {chatError && (
                <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-2.5 flex items-start gap-2">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    {chatError}
                    <button
                      type="button"
                      onClick={() => callChat(chatConversation)}
                      className="ml-2 underline"
                    >
                      Reintentar
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Review ── */}
          {step === 3 && (
            <>
              <p className="text-sm text-muted-foreground">
                Esta descripción guía al bot en cada conversación. Editala si algo no refleja bien tu organización.
              </p>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                    Descripción generada por IA
                  </Label>
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
                <p className="text-[11px] text-muted-foreground">
                  También podés ajustarla después desde Configuración → Bot.
                </p>
              </div>

              {/* Test inline */}
              <div className="pt-3 mt-1 border-t space-y-2">
                <div className="flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5 text-primary" />
                  <Label className="text-xs">Probá una pregunta</Label>
                </div>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  Simula cómo responde el bot con esta descripción. Para preguntas sobre datos reales, el bot va a indicar que necesita documentos.
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
                    placeholder="Ej. ¿Cómo me puedo comunicar con ustedes?, ¿Cómo te llamás?"
                    className="h-9 text-sm"
                  />
                  <Button
                    size="sm"
                    disabled={
                      !testInput.trim() ||
                      testQueryM.isPending ||
                      editedDesc.trim().length < 20
                    }
                    onClick={() => { setSubmitError(null); testQueryM.mutate(); }}
                  >
                    {testQueryM.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
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
          {/* Back button */}
          {step === 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setStep(0); setSubmitError(null); }}
            >
              Atrás
            </Button>
          )}
          {step === 2 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={chatLoading}
              onClick={goBackFromStep2}
            >
              Atrás
            </Button>
          )}
          {step !== 1 && step !== 2 && <div />}

          {/* Forward button */}
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

          {step === 2 && (
            /* Step 2 advances automatically — no forward button */
            <div />
          )}

          {step === 3 && (
            <Button
              size="sm"
              disabled={editedDesc.trim().length < 20 || completeM.isPending}
              onClick={() => { setSubmitError(null); completeM.mutate(); }}
            >
              {completeM.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                  Guardando…
                </>
              ) : (
                "Activar el bot"
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
