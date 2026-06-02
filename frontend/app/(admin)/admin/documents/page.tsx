"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Clock, Trash2, Loader2,
  ChevronDown, ChevronRight, Search, CheckCircle2,
  XCircle, UserCheck, AlertTriangle, ShieldCheck, ChevronUp,
  ArrowRight, MoreVertical, Edit2, Download, Pencil,
} from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse, type PendingChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { DocumentUploader } from "@/components/documents/document-uploader";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { ExportKbButton } from "@/components/admin/export-kb-button";
import { cn } from "@/lib/utils";

// ── Config maps ───────────────────────────────────────────────────────────────

const DOC_STATUS_CONFIG: Record<DocumentResponse["status"], { label: string; variant: any }> = {
  pending:    { label: "En cola",    variant: "secondary" },
  processing: { label: "Procesando", variant: "default" },
  ready:      { label: "Listo",      variant: "success" },
  failed:     { label: "Error",      variant: "destructive" },
};

const QG_DOC_CONFIG: Record<DocumentResponse["quality_gate_status"], { label: string; variant: any } | null> = {
  passed:  null,
  pending: { label: "Verificación pendiente", variant: "warning" },
  skipped: { label: "Fragmentos excluidos",   variant: "secondary" },
};

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
  if (reason.startsWith("groq")) return "El verificador automático no estaba disponible.";
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
    // Polling adaptativo: si hay docs procesando, refetch agresivo cada 4s
    // para ver el cambio de estado casi al toque. Si todo está estable, 30s.
    refetchInterval: (query) => {
      const docs = (query.state.data as DocumentResponse[] | undefined) ?? [];
      const anyProcessing = docs.some(d => d.status === "pending" || d.status === "processing");
      return anyProcessing ? 4_000 : 30_000;
    },
  });

  const { data: pendingChunks = [], isLoading: pendingLoading } = useQuery({
    queryKey: ["chunks", "pending"],
    queryFn: api.documents.pendingChunks,
    staleTime: 15_000,
    // Mismo razonamiento: refetch rápido cuando hay docs procesando, porque
    // pueden aparecer fragmentos nuevos por revisar en cualquier momento.
    refetchInterval: documents.some(d => d.status === "pending" || d.status === "processing")
      ? 5_000
      : 30_000,
  });

  const { data: duplicatesData, isLoading: duplicatesLoading } = useQuery({
    queryKey: ["duplicates"],
    queryFn: api.duplicates.list,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["documents"] });
    queryClient.invalidateQueries({ queryKey: ["chunks", "pending"] });
    queryClient.invalidateQueries({ queryKey: ["duplicates"] });
    queryClient.invalidateQueries({ queryKey: ["duplicates-stats"] });
  };

  const pendingByDocId = useMemo(() => {
    const map: Record<string, { title: string; chunks: PendingChunkResponse[] }> = {};
    for (const chunk of pendingChunks) {
      if (!map[chunk.document_id]) map[chunk.document_id] = { title: chunk.document_title, chunks: [] };
      map[chunk.document_id].chunks.push(chunk);
    }
    return map;
  }, [pendingChunks]);

  // Build map: doc_id → count of pending duplicate pairs involving that document
  const duplicateCountByDocId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const pair of duplicatesData?.pairs ?? []) {
      if (pair.status !== "pending") continue;
      map[pair.doc_id_a] = (map[pair.doc_id_a] ?? 0) + 1;
      map[pair.doc_id_b] = (map[pair.doc_id_b] ?? 0) + 1;
    }
    return map;
  }, [duplicatesData]);

  const pendingDuplicatesTotal = duplicatesData?.pending ?? 0;

  const filtered = documents.filter(
    (d) => !search || d.title.toLowerCase().includes(search.toLowerCase()),
  );

  const processingCount = documents.filter((d) => ["pending", "processing"].includes(d.status)).length;

  return (
    <PageShell>
      <PageHeader
        title="Documentos"
        description="Subí documentos para que la IA los use en sus respuestas."
        actions={<ExportKbButton />}
      />

      {/* Uploader — el dropzone se explica solo, sin doble título */}
      <DocumentUploader
        onUploaded={() => {
          refresh();
          toast({ title: "Documento enviado", description: "El procesamiento comenzó en segundo plano.", variant: "success" });
        }}
      />

      {/* Alerta de duplicados */}
      <DuplicatesAlert
        pendingCount={pendingDuplicatesTotal}
        pairs={duplicatesData?.pairs ?? []}
        isLoading={duplicatesLoading}
      />

      {/* Cola de revisión de calidad */}
      <ReviewQueue
        pendingChunks={pendingChunks}
        pendingByDocId={pendingByDocId}
        isLoading={pendingLoading}
        hasPendingDuplicates={pendingDuplicatesTotal > 0}
        hasProcessingDocs={processingCount > 0}
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
                {search ? "No se encontraron documentos con ese nombre." : "Todavía no hay documentos."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  pendingChunkCount={pendingByDocId[doc.id]?.chunks.length ?? 0}
                  pendingDuplicateCount={duplicateCountByDocId[doc.id] ?? 0}
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

// ── DuplicatesAlert ───────────────────────────────────────────────────────────

function DuplicatesAlert({
  pendingCount,
  pairs,
  isLoading,
}: {
  pendingCount: number;
  pairs: { doc_id_a: string; doc_id_b: string; doc_title_a: string | null; doc_title_b: string | null; status: string }[];
  isLoading: boolean;
}) {
  const router = useRouter();

  // Hooks must be called unconditionally (Rules of Hooks) — keep above any return.
  const affectedDocs = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const p of pairs) {
      if (p.status !== "pending") continue;
      if (p.doc_title_a && !seen.has(p.doc_id_a)) { seen.add(p.doc_id_a); names.push(p.doc_title_a); }
      if (p.doc_title_b && !seen.has(p.doc_id_b)) { seen.add(p.doc_id_b); names.push(p.doc_title_b); }
    }
    return names;
  }, [pairs]);

  if (isLoading) return null;
  if (pendingCount === 0) return null;

  return (
    <div className="relative rounded-lg border border-amber-200 bg-amber-50/40 overflow-hidden">
      {/* Banda lateral para impacto visual */}
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-400" />

      <div className="pl-5 pr-4 py-3.5">
        <div className="flex items-start justify-between gap-4">
          {/* Número grande + texto */}
          <div className="flex items-baseline gap-2.5 min-w-0">
            <span className="text-2xl font-bold text-amber-900 leading-none tabular-nums">
              {pendingCount}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900 leading-tight">
                {pendingCount === 1 ? "par de fragmentos similares" : "pares de fragmentos similares"}
              </p>
              <p className="text-[11px] text-amber-700/90 mt-0.5">
                Revisá si son duplicados reales o coincidencias.
              </p>
            </div>
          </div>

          <Button
            size="sm"
            variant="outline"
            className="border-amber-300 bg-white text-amber-800 hover:bg-amber-50 hover:text-amber-900 shrink-0"
            onClick={() => router.push("/admin/duplicates")}
          >
            Revisar
            <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </div>

        {affectedDocs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {affectedDocs.map((name) => (
              <span
                key={name}
                className="inline-flex items-center text-[11px] bg-white text-amber-900 rounded-md px-2 py-1 border border-amber-200/80 font-medium"
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ReviewQueue ───────────────────────────────────────────────────────────────

function ReviewQueue({
  pendingChunks,
  pendingByDocId,
  isLoading,
  hasPendingDuplicates,
  hasProcessingDocs,
  onReviewed,
}: {
  pendingChunks: PendingChunkResponse[];
  pendingByDocId: Record<string, { title: string; chunks: PendingChunkResponse[] }>;
  isLoading: boolean;
  hasPendingDuplicates: boolean;
  hasProcessingDocs: boolean;
  onReviewed: () => void;
}) {
  const hasPending = pendingChunks.length > 0;

  if (!isLoading && !hasPending) {
    // No mostrar "todo verificado" si:
    //  - hay duplicados pendientes (ya se ve la alerta de duplicados)
    //  - hay docs todavía procesando (es engañoso: parece que no hay
    //    fragmentos pendientes cuando en realidad todavía no se procesaron)
    if (hasPendingDuplicates || hasProcessingDocs) return null;
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
        <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
        Todo el contenido está verificado — no hay fragmentos pendientes de revisión.
      </div>
    );
  }

  if (isLoading) return null;

  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {pendingChunks.length} fragmento{pendingChunks.length !== 1 ? "s" : ""} por revisar
        </CardTitle>
        <CardDescription className="text-amber-700 text-xs mt-1">
          El verificador automático no pudo decidir sobre estos fragmentos. Aprobá los que sean útiles para responder consultas y descartá el resto — desaparecen de la cola al decidir.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {Object.entries(pendingByDocId).map(([docId, group]) => (
            <div key={docId}>
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
      </CardContent>
    </Card>
  );
}

// ── DocumentRow ───────────────────────────────────────────────────────────────

function DocumentRow({
  doc,
  pendingChunkCount,
  pendingDuplicateCount,
  onDeleted,
}: {
  doc: DocumentResponse;
  pendingChunkCount: number;
  pendingDuplicateCount: number;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [showDelete, setShowDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const docStatus = DOC_STATUS_CONFIG[doc.status];
  const qgBadge = QG_DOC_CONFIG[doc.quality_gate_status];
  const canExpand = doc.status === "ready" && doc.chunk_count > 0;
  const hasPendingWork = pendingChunkCount > 0 || pendingDuplicateCount > 0;
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
      setShowDelete(false);
      onDeleted();
      toast({ title: "Documento eliminado", variant: "success" });
    },
    onError: () => toast({ title: "Error al eliminar", description: "Intentá de nuevo.", variant: "destructive" }),
  });

  const { mutate: downloadDoc, isPending: downloading } = useMutation({
    mutationFn: () => api.documents.download(doc.id),
    onSuccess: () => {},
    onError: () => toast({ title: "No se pudo descargar", description: "El archivo original no está disponible.", variant: "destructive" }),
  });

  return (
    <div className={cn(
      "relative rounded-lg border overflow-hidden transition-colors",
      hasPendingWork && "border-amber-200/80 bg-amber-50/20"
    )}>
      {/* Banda lateral cuando hay trabajo pendiente — mismo lenguaje que la alerta de duplicados */}
      {hasPendingWork && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-400" />
      )}

      <div
        className={cn(
          "flex items-center gap-3 p-3 transition-colors",
          hasPendingWork && "pl-4",
          canExpand && "hover:bg-accent/30 cursor-pointer"
        )}
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
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {date}
            </span>
            {doc.chunk_count > 0 && (
              <span className="text-xs text-muted-foreground">
                {doc.chunk_count} fragmento{doc.chunk_count !== 1 ? "s" : ""}
              </span>
            )}
            {pendingChunkCount > 0 && (
              <span className="inline-flex items-center text-[11px] bg-amber-100 text-amber-900 rounded-md px-2 py-0.5 font-medium border border-amber-200/80">
                {pendingChunkCount} sin verificar
              </span>
            )}
            {pendingDuplicateCount > 0 && (
              <button
                className="inline-flex items-center text-[11px] bg-amber-100 text-amber-900 rounded-md px-2 py-0.5 font-medium border border-amber-200/80 hover:bg-amber-200/60 transition-colors"
                onClick={(e) => { e.stopPropagation(); router.push("/admin/duplicates"); }}
                title="Ir a revisar duplicados"
              >
                {pendingDuplicateCount} {pendingDuplicateCount === 1 ? "duplicado" : "duplicados"} por revisar
              </button>
            )}
          </div>
        </div>

        {/* Badges + actions */}
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          {qgBadge && <Badge variant={qgBadge.variant}>{qgBadge.label}</Badge>}
          <Badge variant={docStatus.variant}>{docStatus.label}</Badge>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Acciones del documento">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canExpand && (
                <DropdownMenuItem
                  onSelect={() => {
                    // Auto-expandir si está colapsado para que se vean los chunks editables
                    if (!expanded) setExpanded(true);
                    setEditMode(v => !v);
                  }}
                >
                  {editMode ? (
                    <><CheckCircle2 className="h-4 w-4 mr-2" /> Salir de edición</>
                  ) : (
                    <><Edit2 className="h-4 w-4 mr-2" /> Editar fragmentos</>
                  )}
                </DropdownMenuItem>
              )}
              {doc.storage_key && (
                <DropdownMenuItem onSelect={() => downloadDoc()} disabled={downloading}>
                  {downloading
                    ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Descargando…</>
                    : <><Download className="h-4 w-4 mr-2" /> Descargar original</>
                  }
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => setShowDelete(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Eliminar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <p className="text-xs text-muted-foreground">
                  {chunks.length} fragmento{chunks.length !== 1 ? "s" : ""} · {chunks.filter(c => c.quality_gate_status === "passed").length} verificado{chunks.filter(c => c.quality_gate_status === "passed").length !== 1 ? "s" : ""}
                  {chunks.filter(c => c.quality_gate_status === "pending").length > 0 && (
                    <span className="text-amber-700 font-medium">
                      {" "}· {chunks.filter(c => c.quality_gate_status === "pending").length} sin verificar
                    </span>
                  )}
                  {chunks.filter(c => c.quality_gate_status === "skipped").length > 0 && (
                    <span className="text-muted-foreground">
                      {" "}· {chunks.filter(c => c.quality_gate_status === "skipped").length} excluido{chunks.filter(c => c.quality_gate_status === "skipped").length !== 1 ? "s" : ""}
                    </span>
                  )}
                </p>
                {editMode && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-primary font-medium">Modo edición</span>
                    <Button
                      size="sm" variant="outline"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setEditMode(false)}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      Listo
                    </Button>
                  </div>
                )}
              </div>
              {chunks.map((chunk) => (
                <ChunkCard
                  key={chunk.id}
                  chunk={chunk}
                  documentId={doc.id}
                  editable={editMode}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Modal de confirmación de eliminación */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Eliminar documento
            </DialogTitle>
            <DialogDescription className="pt-2">
              Vas a eliminar <span className="font-medium text-foreground">{doc.title}</span> y
              todos sus fragmentos. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setShowDelete(false)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => deleteDoc()} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

  const humanMsg = humanReason(chunk.quality_gate_reason);
  const PREVIEW_LENGTH = 250;
  const isLong = chunk.text.length > PREVIEW_LENGTH;
  const displayText = showFull || !isLong ? chunk.text : chunk.text.slice(0, PREVIEW_LENGTH) + "…";

  return (
    <div className="rounded border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="warning" className="text-[10px] h-5 px-2 shrink-0">
            Por verificar
          </Badge>
          <span className="text-xs text-muted-foreground truncate">
            Fragmento {chunk.chunk_index + 1} de {chunk.total_chunks}
          </span>
          <ConfidenceBar value={chunk.quality_gate_confidence} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm" variant="outline"
            className="h-8 px-3 text-xs border-green-300 text-green-700 hover:bg-green-50 hover:text-green-900"
            disabled={reviewing}
            onClick={() => review("approve")}
          >
            {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
            Incluir
          </Button>
          <Button
            size="sm" variant="outline"
            className="h-8 px-3 text-xs border-red-200 text-red-600 hover:bg-red-50 hover:text-red-800"
            disabled={reviewing}
            onClick={() => review("reject")}
          >
            {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
            Excluir
          </Button>
        </div>
      </div>
      {humanMsg && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded px-2.5 py-1.5 border border-amber-100">
          {humanMsg}
        </p>
      )}
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

// ── ChunkCard ─────────────────────────────────────────────────────────────────

function ChunkCard({ chunk, documentId, editable }: { chunk: ChunkResponse; documentId: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const [showFull, setShowFull] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
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
          {editable && (
            <button
              onClick={() => setEditOpen(true)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Editar texto del fragmento (se re-procesa el embedding)"
            >
              <Pencil className="h-3.5 w-3.5" />
              Editar
            </button>
          )}
          {editable && !isPassed && (
            <button
              disabled={reviewing}
              onClick={() => review("approve")}
              className="flex items-center gap-1 text-xs text-green-700 hover:text-green-900 disabled:opacity-50 font-medium transition-colors"
            >
              {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Incluir
            </button>
          )}
          {editable && !isSkipped && (
            <button
              disabled={reviewing}
              onClick={() => review("reject")}
              className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
            >
              {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              {isPassed ? "Excluir" : "Rechazar"}
            </button>
          )}
        </div>
      </div>
      {!isPassed && humanMsg && (
        <p className="text-[11px] text-amber-700 italic">{humanMsg}</p>
      )}
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

      <EditChunkTextDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        documentId={documentId}
        chunkId={chunk.id}
        initialText={chunk.text}
        chunkLabel={`Fragmento ${chunk.chunk_index + 1} / ${chunk.total_chunks}`}
      />
    </div>
  );
}

// ── EditChunkTextDialog ───────────────────────────────────────────────────────

function EditChunkTextDialog({
  open, onClose, documentId, chunkId, initialText, chunkLabel,
}: {
  open: boolean;
  onClose: () => void;
  documentId: string;
  chunkId: string;
  initialText: string;
  chunkLabel: string;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(initialText);

  useMemo(() => { if (open) setText(initialText); }, [open, initialText]);

  const { mutate: save, isPending } = useMutation({
    mutationFn: () => api.documents.editChunkText(documentId, chunkId, text.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chunks", documentId] });
      toast({
        title: "Fragmento actualizado",
        description: "Se re-procesó el embedding. El bot va a usar el nuevo texto en sus respuestas.",
        variant: "success",
      });
      onClose();
    },
    onError: (err: any) => {
      const d = err?.response?.data?.detail || "No se pudo guardar.";
      toast({
        title: "Error al guardar",
        description: typeof d === "string" ? d : "Intentá de nuevo.",
        variant: "destructive",
      });
    },
  });

  const dirty = text.trim() !== initialText.trim();
  const valid = text.trim().length > 0 && text.trim().length <= 8000;

  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Editar texto del fragmento</DialogTitle>
          <DialogDescription>
            {chunkLabel} · Al guardar, el sistema re-procesa el embedding para que
            las búsquedas usen este texto. La verificación de calidad se preserva.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={14}
          maxLength={8000}
          className="font-mono text-xs resize-none"
          disabled={isPending}
        />
        <p className="text-[11px] text-muted-foreground">
          {text.length} / 8000 caracteres
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={() => save()}
            disabled={!dirty || !valid || isPending}
          >
            {isPending ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Guardando…</>
            ) : "Guardar cambios"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
