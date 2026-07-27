"use client";

import { useState, useRef, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Check, X, Pencil, PanelRight, AlertTriangle } from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { extractErrorMessage } from "@/lib/errors";
import { DetailPanelHeader, PanelIconButton } from "@/components/admin/list-detail-shell";
import { HighlightedText } from "@/lib/highlight";
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
  pending: { label: "Partes por revisar", variant: "warning" },
  skipped: { label: "Partes sin usar",    variant: "secondary" },
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
  if (reason === "groq_unavailable") return "El verificador automático no estaba disponible al procesar esta parte.";
  if (reason === "exception_defaulting_to_pending") return "Ocurrió un error inesperado durante la verificación.";
  if (reason.startsWith("groq")) return "El verificador automático no estaba disponible.";
  return reason;
}

// Estado de una parte en lenguaje del admin: ¿el asistente la usa para responder?
// passed + pending → en uso; skipped → sin usar; pending además pide revisión.
export function partStatus(s: ChunkResponse["quality_gate_status"]) {
  if (s === "skipped") return {
    label: "Sin usar",    dot: "bg-muted-foreground/40", text: "text-muted-foreground",
    pill: "border-border bg-muted text-muted-foreground",
  };
  if (s === "pending") return {
    label: "Por revisar", dot: "bg-warning", text: "text-warning",
    pill: "border-warning/30 bg-warning/[0.08] text-warning",
  };
  return {
    label: "En uso",      dot: "bg-success", text: "text-success",
    pill: "border-success/30 bg-success/[0.08] text-success",
  };
}

// ── DocumentDeleteDialog ──────────────────────────────────────────────────────
// Confirmación de eliminación de un documento. Se usa desde el detalle y desde
// el tachito de la tabla de documentos.

export function DocumentDeleteDialog({ open, onOpenChange, title, onConfirm, deleting }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  onConfirm: () => void;
  deleting: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <DialogTitle>Eliminar documento</DialogTitle>
              <DialogDescription>
                Vas a eliminar <span className="font-medium text-foreground">{title}</span> y todas sus partes. Esta acción no se puede deshacer.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>Cancelar</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {deleting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Eliminar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── PartDetailPanel ───────────────────────────────────────────────────────────
// Contenido del panel derecho (master-detalle) para una parte del documento.
// Muestra el texto completo y deja accionar: usar/no usar y editar. Sin tarjetas
// anidadas — todo vive en el panel, legible de un vistazo.

export function PartDetailPanel({ chunk, documentId, onCollapse, highlight }: {
  chunk: ChunkResponse;
  documentId: string;
  onCollapse: () => void;
  /** Término de búsqueda activo — pinta las coincidencias en el texto. */
  highlight?: string;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(chunk.text);

  // El editor crece hasta el alto del contenido (como se lee, sin caja chica
  // con scroll interno). El panel de la derecha es el que scrollea, igual que
  // en modo lectura.
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editText, editing]);

  const isSkipped   = chunk.quality_gate_status === "skipped";
  const needsReview = chunk.quality_gate_status === "pending";
  const inUse       = !isSkipped;
  const st          = partStatus(chunk.quality_gate_status);
  const humanMsg    = humanReason(chunk.quality_gate_reason);

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
      toast({ title: "No se pudo guardar el cambio", variant: "destructive" });
    },
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast({
        title: action === "approve" ? "El asistente va a usar esta parte" : "El asistente ya no usa esta parte",
        variant: "success",
      });
    },
  });

  // Guardado del texto editado (re-procesa el embedding en el backend).
  const { mutate: save, isPending: saving } = useMutation({
    mutationFn: () => api.documents.editChunkText(documentId, chunk.id, editText.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chunks", documentId] });
      toast({ title: "Texto actualizado", description: "El asistente va a usar la nueva versión.", variant: "success" });
      setEditing(false);
    },
    onError: (err: any) => {
      toast({ title: "Error al guardar", description: extractErrorMessage(err, "No se pudo guardar. Intentá de nuevo."), variant: "destructive" });
    },
  });

  const startEdit = () => { setEditText(chunk.text); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setEditText(chunk.text); };
  const dirty = editText.trim() !== chunk.text.trim();
  const valid = editText.trim().length > 0 && editText.trim().length <= 8000;

  return (
    <div className="w-full bg-card">
      <DetailPanelHeader label={`Parte ${chunk.chunk_index + 1}`}>
        {/* Toggle "en uso" compacto en el header. Reemplaza la pastilla de estado
            y la fila de abajo — el estado + la acción viven en un solo lugar. */}
        {!editing && !needsReview && (
          <button
            type="button"
            role="switch"
            aria-checked={inUse}
            disabled={reviewing}
            onClick={() => review(inUse ? "reject" : "approve")}
            title={inUse ? "En uso — tocá para que el asistente la ignore" : "Sin usar — tocá para que el asistente la use"}
            className="inline-flex h-8 items-center gap-1.5 rounded-md pl-1.5 pr-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            <span className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", inUse ? "bg-success" : "bg-muted-foreground/30")}>
              <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all", inUse ? "left-[14px]" : "left-0.5")} />
            </span>
            {inUse ? "En uso" : "Sin usar"}
          </button>
        )}
        {!editing && (
          <PanelIconButton onClick={startEdit} label="Editar texto"><Pencil className="h-4 w-4" /></PanelIconButton>
        )}
        <PanelIconButton onClick={onCollapse} label="Ocultar panel"><PanelRight className="h-4 w-4" /></PanelIconButton>
      </DetailPanelHeader>

      {/* Aviso — solo cuando el chunk está "Por revisar". El estado "en uso"
          vive en el toggle del header; un chunk normal va directo al texto. */}
      {needsReview && (
        <div className="border-b px-4 py-3">
          <p className="rounded-lg border border-warning/20 bg-warning/[0.07] px-2.5 py-2 text-xs leading-relaxed text-warning">
            {humanMsg ?? "El asistente no está seguro de esta parte. Revisala y decidí si la usa para responder."}
          </p>
        </div>
      )}

      {/* Texto / editor */}
      <div className="px-4 py-4">
        {editing ? (
          <>
            <Textarea
              ref={taRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              maxLength={8000}
              autoFocus
              disabled={saving}
              className="min-h-[140px] w-full resize-none overflow-hidden text-sm leading-relaxed"
            />
            <p className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">{editText.length} / 8000</p>
          </>
        ) : (
          <p className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed", isSkipped ? "text-muted-foreground" : "text-foreground")}>
            {highlight?.trim() ? <HighlightedText text={chunk.text} term={highlight} /> : chunk.text}
          </p>
        )}
      </div>

      {/* Acciones — solo al editar o cuando está pendiente de revisión. El
          toggle "en uso" de un chunk normal vive ahora en el header. */}
      {(editing || needsReview) && (
        <div className="border-t p-4">
          {editing ? (
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={cancelEdit} disabled={saving}>Cancelar</Button>
              <Button size="sm" onClick={() => save()} disabled={!dirty || !valid || saving}>
                {saving ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Guardando…</> : "Guardar cambios"}
              </Button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs font-medium text-foreground">¿El asistente usa esta parte para responder?</p>
              <div className="flex gap-2">
                <Button
                  variant="outline" size="sm"
                  className="flex-1 border-success/30 text-success hover:bg-success/10 hover:text-success"
                  onClick={() => review("approve")} disabled={reviewing}
                >
                  <Check className="mr-1.5 h-4 w-4" /> Sí, usarla
                </Button>
                <Button
                  variant="outline" size="sm"
                  className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => review("reject")} disabled={reviewing}
                >
                  <X className="mr-1.5 h-4 w-4" /> No usarla
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

