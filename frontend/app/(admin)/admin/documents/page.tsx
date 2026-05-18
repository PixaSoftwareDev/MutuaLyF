"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Clock, Trash2, Loader2,
  ChevronDown, ChevronRight, Search, CheckCircle2,
  XCircle, UserCheck, AlertTriangle, ShieldCheck, ChevronUp,
} from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse, type PendingChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DocumentUploader } from "@/components/documents/document-uploader";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// ── Config maps ───────────────────────────────────────────────────────────────

const DOC_STATUS_CONFIG: Record<DocumentResponse["status"], { label: string; variant: any }> = {
  pending:    { label: "En cola",    variant: "secondary" },
  processing: { label: "Procesando", variant: "default" },
  ready:      { label: "Listo",      variant: "success" },
  failed:     { label: "Error",      variant: "destructive" },
};

// Human-readable names for quality gate status on the document row.
// "passed" intentionally has no badge — the happy path should be silent.
const QG_DOC_CONFIG: Record<DocumentResponse["quality_gate_status"], { label: string; variant: any } | null> = {
  passed:  null,
  pending: { label: "Revisión pendiente", variant: "warning" },
  skipped: { label: "Fragmentos excluidos", variant: "secondary" },
};

// Quality gate labels inside the expanded chunk view.
const QG_CHUNK_CONFIG: Record<ChunkResponse["quality_gate_status"], { label: string; variant: any }> = {
  passed:  { label: "Verificado", variant: "success" },
  pending: { label: "Por revisar", variant: "warning" },
  skipped: { label: "Excluido",   variant: "secondary" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === "groq_unavailable") return "El verificador automático no estaba disponible al procesar este fragmento.";
  if (reason === "exception_defaulting_to_pending") return "Ocurrió un error inesperado durante la verificación.";
  if (reason === "groq_unavailable" || reason.startsWith("groq")) return "El verificador automático no estaba disponible.";
  return reason;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: documents = [], isLoading, error } = useQuery({
    queryKey: ["documents"],
    queryFn: api.documents.list,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const { data: pendingChunks = [], isLoading: pendingLoading } = useQuery({
    queryKey: ["chunks", "pending"],
    queryFn: api.documents.pendingChunks,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["documents"] });
    queryClient.invalidateQueries({ queryKey: ["chunks", "pending"] });
  };

  // Group pending chunks by document so the review queue is readable.
  const pendingByDocId = useMemo(() => {
    const map: Record<string, { title: string; chunks: PendingChunkResponse[] }> = {};
    for (const chunk of pendingChunks) {
      if (!map[chunk.document_id]) map[chunk.document_id] = { title: chunk.document_title, chunks: [] };
      map[chunk.document_id].chunks.push(chunk);
    }
    return map;
  }, [pendingChunks]);

  const filtered = documents.filter(
    (d) => !search || d.title.toLowerCase().includes(search.toLowerCase()),
  );

  const readyCount      = documents.filter((d) => d.status === "ready").length;
  const processingCount = documents.filter((d) => ["pending", "processing"].includes(d.status)).length;

  return (
    <PageShell>
      <PageHeader
        title="Documentos"
        description="Subí documentos para que la IA los use en sus respuestas."
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Actualizar
          </Button>
        }
      />

      {/* Stats rápidas */}
      {documents.length > 0 && (
        <div className="flex gap-6 text-sm">
          <span><strong className="text-foreground">{documents.length}</strong> <span className="text-muted-foreground">total</span></span>
          <span><strong className="text-green-600">{readyCount}</strong> <span className="text-muted-foreground">listos</span></span>
          {processingCount > 0 && (
            <span><strong className="text-primary">{processingCount}</strong> <span className="text-muted-foreground">procesando</span></span>
          )}
        </div>
      )}

      {/* Uploader */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Subir documentos</CardTitle>
          <CardDescription>PDF, Word, TXT o HTML · Máximo 200 MB · Se procesan en segundo plano.</CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentUploader
            onUploaded={() => {
              refresh();
              toast({ title: "Documento enviado", description: "El procesamiento comenzó en segundo plano.", variant: "success" });
            }}
          />
        </CardContent>
      </Card>

      {/* Sección de revisión — SIEMPRE visible */}
      <ReviewQueue
        pendingChunks={pendingChunks}
        pendingByDocId={pendingByDocId}
        isLoading={pendingLoading}
        onReviewed={refresh}
      />

      {/* Lista de documentos */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="text-base">Documentos ({filtered.length})</CardTitle>
            {documents.length > 4 && (
              <div className="relative max-w-xs">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-lg border">
                  <Skeleton className="h-4 w-4 rounded" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-8 text-destructive text-sm">Error al cargar documentos</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 space-y-2">
              <FileText className="h-10 w-10 mx-auto text-muted-foreground opacity-30" />
              <p className="text-muted-foreground text-sm">
                {search ? "No se encontraron documentos con ese nombre." : "No hay documentos todavía. Subí el primero arriba."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  pendingChunkCount={pendingByDocId[doc.id]?.chunks.length ?? 0}
                  onDeleted={refresh}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

// ── ReviewQueue ───────────────────────────────────────────────────────────────

function ReviewQueue({
  pendingChunks,
  pendingByDocId,
  isLoading,
  onReviewed,
}: {
  pendingChunks: PendingChunkResponse[];
  pendingByDocId: Record<string, { title: string; chunks: PendingChunkResponse[] }>;
  isLoading: boolean;
  onReviewed: () => void;
}) {
  const hasPending = pendingChunks.length > 0;

  if (!isLoading && !hasPending) {
    // Happy path — clean, minimal, reassuring
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
        <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
        Todo el contenido está verificado — no hay fragmentos pendientes de revisión.
      </div>
    );
  }

  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base flex items-center gap-2 text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {isLoading ? "Revisión de contenido" : (
                <>
                  {pendingChunks.length} fragmento{pendingChunks.length !== 1 ? "s" : ""} necesitan tu revisión
                </>
              )}
            </CardTitle>
            <CardDescription className="text-amber-700 text-xs mt-1">
              La IA verificó el contenido automáticamente. En los casos marcados no pudo hacerlo
              o encontró texto poco útil — revisá y decidí si incluirlos en las respuestas.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : (
          <div className="space-y-4">
            {Object.entries(pendingByDocId).map(([docId, group]) => (
              <div key={docId}>
                {/* Document group header */}
                <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5 mb-2">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  {group.title}
                  <span className="font-normal text-amber-700">
                    · {group.chunks.length} fragmento{group.chunks.length !== 1 ? "s" : ""}
                  </span>
                </p>
                <div className="space-y-2 pl-5">
                  {group.chunks.map((chunk) => (
                    <PendingChunkCard key={chunk.id} chunk={chunk} onReviewed={onReviewed} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── DocumentRow ───────────────────────────────────────────────────────────────

function DocumentRow({
  doc,
  pendingChunkCount,
  onDeleted,
}: {
  doc: DocumentResponse;
  pendingChunkCount: number;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const docStatus = DOC_STATUS_CONFIG[doc.status];
  const qgBadge = QG_DOC_CONFIG[doc.quality_gate_status];
  const canExpand = doc.status === "ready" && doc.chunk_count > 0;
  const date = new Date(doc.created_at).toLocaleDateString("es-AR", {
    day: "2-digit", month: "short", year: "numeric",
  });

  const { data: chunks, isLoading: chunksLoading } = useQuery({
    queryKey: ["chunks", doc.id],
    queryFn: () => api.documents.chunks(doc.id),
    enabled: expanded && canExpand,
    staleTime: 60_000,
  });

  const { mutate: deleteDoc, isPending: deleting } = useMutation({
    mutationFn: () => api.documents.delete(doc.id),
    onSuccess: () => {
      setConfirming(false);
      onDeleted();
      toast({ title: "Documento eliminado", variant: "success" });
    },
    onError: () => toast({ title: "Error al eliminar", description: "Intentá de nuevo.", variant: "destructive" }),
  });

  return (
    <div className="rounded-lg border overflow-hidden">
      <div
        className={`flex items-center gap-3 p-3 transition-colors ${canExpand ? "hover:bg-accent/30 cursor-pointer" : ""}`}
        onClick={() => canExpand && setExpanded((v) => !v)}
      >
        {/* Expand indicator / status icon */}
        {canExpand ? (
          expanded
            ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : doc.status === "processing" ? (
          <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        )}

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{doc.title}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {date}
            </span>
            {doc.chunk_count > 0 && (
              <span className="text-xs text-muted-foreground">
                {doc.chunk_count} fragmento{doc.chunk_count !== 1 ? "s" : ""}
              </span>
            )}
            {/* Inline warning for pending chunks in this document */}
            {pendingChunkCount > 0 && (
              <span className="text-xs text-amber-700 flex items-center gap-1 font-medium">
                <AlertTriangle className="h-3 w-3" />
                {pendingChunkCount} requiere{pendingChunkCount !== 1 ? "n" : ""} revisión
              </span>
            )}
          </div>
        </div>

        {/* Badges + actions */}
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          {qgBadge && <Badge variant={qgBadge.variant}>{qgBadge.label}</Badge>}
          <Badge variant={docStatus.variant}>{docStatus.label}</Badge>

          {confirming ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={deleting} onClick={() => deleteDoc()}>
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirmar"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={deleting} onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button
              size="sm" variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Expanded chunk view */}
      {expanded && canExpand && (
        <div className="border-t bg-muted/30 px-4 py-3 space-y-2">
          {chunksLoading ? (
            <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded" />)}</div>
          ) : !chunks?.length ? (
            <p className="text-xs text-muted-foreground text-center py-2">Sin fragmentos disponibles</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-1">
                {chunks.length} fragmento{chunks.length !== 1 ? "s" : ""} · {chunks.filter(c => c.quality_gate_status === "passed").length} verificado{chunks.filter(c => c.quality_gate_status === "passed").length !== 1 ? "s" : ""}
                {chunks.filter(c => c.quality_gate_status === "pending").length > 0 && (
                  <span className="text-amber-700 font-medium">
                    {" "}· {chunks.filter(c => c.quality_gate_status === "pending").length} pendiente{chunks.filter(c => c.quality_gate_status === "pending").length !== 1 ? "s" : ""}
                  </span>
                )}
                {chunks.filter(c => c.quality_gate_status === "skipped").length > 0 && (
                  <span className="text-muted-foreground">
                    {" "}· {chunks.filter(c => c.quality_gate_status === "skipped").length} excluido{chunks.filter(c => c.quality_gate_status === "skipped").length !== 1 ? "s" : ""}
                  </span>
                )}
              </p>
              {chunks.map((chunk) => <ChunkCard key={chunk.id} chunk={chunk} documentId={doc.id} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── ConfidenceBar ─────────────────────────────────────────────────────────────

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? "bg-green-500" : pct >= 60 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-1.5" title={`Confianza del verificador: ${pct}%`}>
      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground">{pct}%</span>
    </div>
  );
}

// ── PendingChunkCard ──────────────────────────────────────────────────────────

function PendingChunkCard({ chunk, onReviewed }: { chunk: PendingChunkResponse; onReviewed: () => void }) {
  const queryClient = useQueryClient();
  const [showFull, setShowFull] = useState(false);

  const { mutate: review, isPending: reviewing } = useMutation({
    mutationFn: (action: "approve" | "reject") =>
      api.documents.reviewChunk(chunk.document_id, chunk.id, action),
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ["chunks", "pending"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["chunks", chunk.document_id] });
      onReviewed();
      toast({
        title: action === "approve" ? "Fragmento incluido" : "Fragmento excluido",
        description: action === "approve"
          ? "La IA lo usará en sus respuestas."
          : "La IA no lo tendrá en cuenta.",
        variant: "success",
      });
    },
    onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
  });

  const isPending = chunk.quality_gate_status === "pending";
  const humanMsg = humanReason(chunk.quality_gate_reason);
  const PREVIEW_LENGTH = 250;
  const isLong = chunk.text.length > PREVIEW_LENGTH;
  const displayText = showFull || !isLong ? chunk.text : chunk.text.slice(0, PREVIEW_LENGTH) + "…";

  return (
    <div className="rounded border bg-background p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Badge
            variant={isPending ? "warning" : "secondary"}
            className="text-[10px] h-5 px-2 shrink-0"
          >
            {isPending ? "No verificado" : "Excluido"}
          </Badge>
          <span className="text-xs text-muted-foreground truncate">
            Fragmento {chunk.chunk_index + 1} de {chunk.total_chunks}
          </span>
          <ConfidenceBar value={chunk.quality_gate_confidence} />
        </div>

        {/* Action buttons — prominent */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-3 text-xs border-green-300 text-green-700 hover:bg-green-50 hover:text-green-900"
            disabled={reviewing}
            onClick={() => review("approve")}
          >
            {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
            Incluir
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-3 text-xs border-red-200 text-red-600 hover:bg-red-50 hover:text-red-800"
            disabled={reviewing}
            onClick={() => review("reject")}
          >
            {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
            Excluir
          </Button>
        </div>
      </div>

      {/* Reason */}
      {humanMsg && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded px-2.5 py-1.5 border border-amber-100">
          {humanMsg}
        </p>
      )}

      {/* Fragment text */}
      <div>
        <p className="text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{displayText}</p>
        {isLong && (
          <button
            onClick={() => setShowFull((v) => !v)}
            className="text-[11px] text-primary hover:underline mt-1 flex items-center gap-0.5"
          >
            {showFull ? <><ChevronUp className="h-3 w-3" /> Ver menos</> : <><ChevronDown className="h-3 w-3" /> Ver todo el fragmento</>}
          </button>
        )}
      </div>
    </div>
  );
}

// ── ChunkCard (dentro del documento expandido) ────────────────────────────────

function ChunkCard({ chunk, documentId }: { chunk: ChunkResponse; documentId: string }) {
  const queryClient = useQueryClient();
  const [showFull, setShowFull] = useState(false);
  const qg = QG_CHUNK_CONFIG[chunk.quality_gate_status];
  const isPassed  = chunk.quality_gate_status === "passed";
  const isSkipped = chunk.quality_gate_status === "skipped";
  const humanMsg  = humanReason(chunk.quality_gate_reason);
  const PREVIEW_LENGTH = 200;
  const isLong = chunk.text.length > PREVIEW_LENGTH;
  const displayText = showFull || !isLong ? chunk.text : chunk.text.slice(0, PREVIEW_LENGTH) + "…";

  const { mutate: review, isPending: reviewing } = useMutation({
    mutationFn: (action: "approve" | "reject") =>
      api.documents.reviewChunk(documentId, chunk.id, action),
    onMutate: async (action) => {
      await queryClient.cancelQueries({ queryKey: ["chunks", documentId] });
      const prev = queryClient.getQueryData<ChunkResponse[]>(["chunks", documentId]);
      queryClient.setQueryData<ChunkResponse[]>(["chunks", documentId], (old) =>
        old?.map((c) =>
          c.id === chunk.id
            ? { ...c, quality_gate_status: action === "approve" ? "passed" : "skipped", manually_reviewed: true }
            : c,
        ),
      );
      return { prev };
    },
    onError: (_err, _action, ctx) => {
      queryClient.setQueryData(["chunks", documentId], ctx?.prev);
      toast({ title: "Error al actualizar el fragmento", variant: "destructive" });
    },
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast({
        title: action === "approve" ? "Fragmento incluido" : "Fragmento excluido",
        variant: "success",
      });
    },
  });

  return (
    <div className={`rounded border bg-background p-3 space-y-2 ${!isPassed ? "border-amber-200" : ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Fragmento {chunk.chunk_index + 1} / {chunk.total_chunks}
          </span>
          {chunk.manually_reviewed && (
            <span title={`Revisado manualmente${chunk.reviewed_by ? ` por ${chunk.reviewed_by}` : ""}`}>
              <UserCheck className="h-3 w-3 text-muted-foreground" />
            </span>
          )}
          <ConfidenceBar value={chunk.quality_gate_confidence} />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={qg.variant} className="text-[10px] h-5 px-1.5">{qg.label}</Badge>

          {/* Show Incluir when not yet passed */}
          {!isPassed && (
            <button
              disabled={reviewing}
              onClick={() => review("approve")}
              className="flex items-center gap-1 text-xs text-green-700 hover:text-green-900 disabled:opacity-50 font-medium transition-colors"
              title="Incluir este fragmento en las respuestas"
            >
              {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Incluir
            </button>
          )}

          {/* Show Excluir when not already excluded */}
          {!isSkipped && (
            <button
              disabled={reviewing}
              onClick={() => review("reject")}
              className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
              title="Excluir este fragmento de las respuestas"
            >
              {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              {isPassed ? "Excluir" : "Rechazar"}
            </button>
          )}
        </div>
      </div>

      {/* Reason (only when not passed) */}
      {!isPassed && humanMsg && (
        <p className="text-[11px] text-amber-700 italic">{humanMsg}</p>
      )}

      {/* Text */}
      <div>
        <p className="text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-700">{displayText}</p>
        {isLong && (
          <button
            onClick={() => setShowFull((v) => !v)}
            className="text-[11px] text-primary hover:underline mt-1 flex items-center gap-0.5"
          >
            {showFull
              ? <><ChevronUp className="h-3 w-3" /> Ver menos</>
              : <><ChevronDown className="h-3 w-3" /> Ver todo</>}
          </button>
        )}
      </div>
    </div>
  );
}
