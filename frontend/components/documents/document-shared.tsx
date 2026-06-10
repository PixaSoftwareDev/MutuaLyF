"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, ChevronDown, ChevronUp, CheckCircle2, XCircle, UserCheck, Pencil,
} from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse, type PendingChunkResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { extractErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

// ── Config maps ───────────────────────────────────────────────────────────────

export const DOC_STATUS_CONFIG: Record<DocumentResponse["status"], { label: string; variant: any; dot: string }> = {
  pending:    { label: "En cola",    variant: "secondary",   dot: "bg-muted-foreground/50" },
  processing: { label: "Procesando", variant: "info",        dot: "bg-info" },
  ready:      { label: "Listo",      variant: "success",     dot: "bg-success" },
  failed:     { label: "Error",      variant: "destructive", dot: "bg-destructive" },
};

export const QG_DOC_CONFIG: Record<DocumentResponse["quality_gate_status"], { label: string; variant: any } | null> = {
  passed:  null,
  pending: { label: "Verificación pendiente", variant: "warning" },
  skipped: { label: "Fragmentos excluidos",   variant: "secondary" },
};

const QG_CHUNK_CONFIG: Record<ChunkResponse["quality_gate_status"], { label: string; dot: string; text: string }> = {
  passed:  { label: "Verificado",  dot: "bg-success",             text: "text-success" },
  pending: { label: "Por revisar", dot: "bg-warning",             text: "text-warning" },
  skipped: { label: "Excluido",    dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fileExt(title: string): string {
  const ext = title.split(".").pop()?.toLowerCase() ?? "";
  return ext.length <= 4 ? ext.toUpperCase() : "";
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
}

function humanReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === "groq_unavailable") return "El verificador automático no estaba disponible al procesar este fragmento.";
  if (reason === "exception_defaulting_to_pending") return "Ocurrió un error inesperado durante la verificación.";
  if (reason.startsWith("groq")) return "El verificador automático no estaba disponible.";
  return reason;
}

// ── ChunkSummaryChip ──────────────────────────────────────────────────────────

export function ChunkSummaryChip({ count, label, tone }: { count: number; label: string; tone: "success" | "warning" | "muted" }) {
  if (count === 0) return null;
  const cls =
    tone === "success" ? "bg-success/10 text-success" :
    tone === "warning" ? "bg-warning/10 text-warning" :
    "bg-muted text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium tabular-nums", cls)}>
      {count} {label}{count !== 1 ? "s" : ""}
    </span>
  );
}

// ── ConfidenceBar ─────────────────────────────────────────────────────────────

export function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? "bg-success" : pct >= 60 ? "bg-warning" : "bg-destructive";
  return (
    <div className="flex items-center gap-1.5" title={`Confianza del verificador: ${pct}%`}>
      <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

// ── ChunkActionButton ─────────────────────────────────────────────────────────

export function ChunkActionButton({
  onClick, icon: Icon, children, tone = "default", disabled, loading, title,
}: {
  onClick: () => void;
  icon: React.ElementType;
  children: React.ReactNode;
  tone?: "default" | "success" | "destructive";
  disabled?: boolean;
  loading?: boolean;
  title?: string;
}) {
  const toneCls =
    tone === "success"     ? "border-success/30 text-success bg-success/5 hover:bg-success/10" :
    tone === "destructive" ? "border-destructive/30 text-destructive bg-destructive/5 hover:bg-destructive/10" :
    "border-border text-muted-foreground bg-card hover:text-foreground hover:bg-muted";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer",
        toneCls,
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

// ── PendingChunkCard ──────────────────────────────────────────────────────────

export function PendingChunkCard({ chunk, onReviewed }: { chunk: PendingChunkResponse; onReviewed: () => void }) {
  const queryClient = useQueryClient();
  const [showFull, setShowFull] = useState(false);

  const { mutate: review, isPending: reviewing } = useMutation({
    mutationFn: (action: "approve" | "reject") => api.documents.reviewChunk(chunk.document_id, chunk.id, action),
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ["chunks", "pending"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["chunks", chunk.document_id] });
      onReviewed();
      toast({
        title: action === "approve" ? "Fragmento incluido" : "Fragmento excluido",
        description: action === "approve" ? "La IA lo usará en sus respuestas." : "La IA no lo tendrá en cuenta.",
        variant: "success",
      });
    },
    onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
  });

  const humanMsg = humanReason(chunk.quality_gate_reason);
  const PREVIEW_LENGTH = 250;
  const isLong = chunk.text.length > PREVIEW_LENGTH;
  const displayText = showFull || !isLong ? chunk.text : chunk.text.slice(0, PREVIEW_LENGTH) + "…";

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground truncate">Fragmento {chunk.chunk_index + 1} de {chunk.total_chunks}</span>
          <ConfidenceBar value={chunk.quality_gate_confidence} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ChunkActionButton onClick={() => review("approve")} disabled={reviewing} loading={reviewing} icon={CheckCircle2} tone="success">Incluir</ChunkActionButton>
          <ChunkActionButton onClick={() => review("reject")} disabled={reviewing} loading={reviewing} icon={XCircle} tone="destructive">Excluir</ChunkActionButton>
        </div>
      </div>
      {humanMsg && <p className="text-xs text-warning bg-warning/10 rounded-lg px-2.5 py-1.5 border border-warning/20">{humanMsg}</p>}
      <div>
        <p className="text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words">{displayText}</p>
        {isLong && (
          <button onClick={() => setShowFull((v) => !v)} className="text-[11px] text-action hover:underline mt-1 flex items-center gap-0.5">
            {showFull ? <><ChevronUp className="h-3 w-3" /> Ver menos</> : <><ChevronDown className="h-3 w-3" /> Ver todo el fragmento</>}
          </button>
        )}
      </div>
    </div>
  );
}

// ── ChunkCard ─────────────────────────────────────────────────────────────────

export function ChunkCard({ chunk, documentId }: { chunk: ChunkResponse; documentId: string }) {
  const queryClient = useQueryClient();
  const [showFull, setShowFull] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(chunk.text);
  const [confirmingExclude, setConfirmingExclude] = useState(false);
  const qg = QG_CHUNK_CONFIG[chunk.quality_gate_status];
  const isPassed  = chunk.quality_gate_status === "passed";
  const isSkipped = chunk.quality_gate_status === "skipped";
  const humanMsg  = humanReason(chunk.quality_gate_reason);
  const PREVIEW_LENGTH = 240;
  const isLong = chunk.text.length > PREVIEW_LENGTH;
  const displayText = showFull || !isLong ? chunk.text : chunk.text.slice(0, PREVIEW_LENGTH) + "…";

  const { mutate: review, isPending: reviewing } = useMutation({
    mutationFn: (action: "approve" | "reject") => api.documents.reviewChunk(documentId, chunk.id, action),
    onMutate: async (action) => {
      await queryClient.cancelQueries({ queryKey: ["chunks", documentId] });
      const prev = queryClient.getQueryData<ChunkResponse[]>(["chunks", documentId]);
      queryClient.setQueryData<ChunkResponse[]>(["chunks", documentId], (old) =>
        old?.map((c) => c.id === chunk.id
          ? { ...c, quality_gate_status: action === "approve" ? "passed" : "skipped", manually_reviewed: true }
          : c),
      );
      return { prev };
    },
    onError: (_err, _action, ctx) => {
      queryClient.setQueryData(["chunks", documentId], ctx?.prev);
      toast({ title: "Error al actualizar el fragmento", variant: "destructive" });
    },
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast({ title: action === "approve" ? "Fragmento incluido" : "Fragmento excluido", variant: "success" });
    },
    onSettled: () => setConfirmingExclude(false),
  });

  // Guardado del texto editado inline (re-procesa el embedding en el backend).
  const { mutate: save, isPending: saving } = useMutation({
    mutationFn: () => api.documents.editChunkText(documentId, chunk.id, editText.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chunks", documentId] });
      toast({
        title: "Fragmento actualizado",
        description: "Se re-procesó el embedding. El bot va a usar el nuevo texto.",
        variant: "success",
      });
      setEditing(false);
    },
    onError: (err: any) => {
      toast({ title: "Error al guardar", description: extractErrorMessage(err, "No se pudo guardar. Intentá de nuevo."), variant: "destructive" });
    },
  });

  const startEdit = () => { setEditText(chunk.text); setEditing(true); setShowFull(true); };
  const dirty = editText.trim() !== chunk.text.trim();
  const valid = editText.trim().length > 0 && editText.trim().length <= 8000;

  return (
    <div className={cn(
      "group rounded-2xl border bg-card shadow-xs transition-shadow hover:shadow-sm overflow-hidden",
      isSkipped && !editing && "bg-muted/40 border-dashed",
      editing && "ring-1 ring-action/30 shadow-sm",
    )}>
      {/* Cabecera */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex items-center justify-center h-5 min-w-[28px] px-1.5 rounded-md bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
            {chunk.chunk_index + 1}
          </span>
          {editing ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-action">
              <Pencil className="h-3 w-3" /> Editando
            </span>
          ) : (
            <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", qg.text)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", qg.dot)} />
              {qg.label}
            </span>
          )}
          {!editing && chunk.manually_reviewed && (
            <span title={`Revisado manualmente${chunk.reviewed_by ? ` por ${chunk.reviewed_by}` : ""}`} className="hidden sm:inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <UserCheck className="h-3 w-3" /> revisado
            </span>
          )}
        </div>
        {!editing && <ConfidenceBar value={chunk.quality_gate_confidence} />}
      </div>

      {!editing && !isPassed && humanMsg && <p className="text-[11px] text-warning italic px-4 pt-2">{humanMsg}</p>}

      {/* Texto / editor inline */}
      <div className="px-4 py-3">
        {editing ? (
          <>
            <Textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={7}
              maxLength={8000}
              autoFocus
              disabled={saving}
              className="text-sm leading-relaxed resize-y min-h-[120px]"
            />
            <p className="text-[11px] text-muted-foreground mt-1.5 tabular-nums">
              {editText.length} / 8000 · al guardar se re-procesa el embedding
            </p>
          </>
        ) : (
          <>
            <p className={cn("text-sm leading-relaxed whitespace-pre-wrap break-words", isSkipped ? "text-muted-foreground" : "text-foreground")}>
              {displayText}
            </p>
            {isLong && (
              <button onClick={() => setShowFull((v) => !v)} className="text-xs text-action hover:underline mt-2 flex items-center gap-0.5 font-medium">
                {showFull ? <><ChevronUp className="h-3.5 w-3.5" /> Ver menos</> : <><ChevronDown className="h-3.5 w-3.5" /> Ver todo</>}
              </button>
            )}
          </>
        )}
      </div>

      {/* Acciones */}
      <div className="px-3 py-2.5 border-t bg-muted/20">
        {editing ? (
          // Edición inline — sin modal.
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground hidden sm:block">Editás el texto en el lugar</span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={() => setEditing(false)}
                disabled={saving}
                className="inline-flex items-center h-8 px-3 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              <Button size="sm" className="h-8" onClick={() => save()} disabled={!dirty || !valid || saving}>
                {saving ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Guardando…</> : "Guardar cambios"}
              </Button>
            </div>
          </div>
        ) : confirmingExclude ? (
          // Doble validación del excluir — confirmación inline, sin modal.
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-foreground flex-1 min-w-0">
              ¿Excluir este fragmento de las respuestas de la IA?
            </span>
            <button
              onClick={() => setConfirmingExclude(false)}
              disabled={reviewing}
              className="inline-flex items-center h-8 px-3 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <ChunkActionButton onClick={() => review("reject")} disabled={reviewing} loading={reviewing} icon={XCircle} tone="destructive">
              Sí, excluir
            </ChunkActionButton>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <ChunkActionButton onClick={startEdit} icon={Pencil} title="Editar el texto del fragmento (re-procesa el embedding)">Editar</ChunkActionButton>
            <div className="ml-auto flex items-center gap-1.5">
              {!isPassed && (
                <ChunkActionButton onClick={() => review("approve")} disabled={reviewing} loading={reviewing} icon={CheckCircle2} tone="success" title="Incluir en las respuestas de la IA">Incluir</ChunkActionButton>
              )}
              {!isSkipped && (
                <ChunkActionButton onClick={() => setConfirmingExclude(true)} disabled={reviewing} icon={XCircle} tone="destructive" title="Excluir — la IA no lo usará">Excluir</ChunkActionButton>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
