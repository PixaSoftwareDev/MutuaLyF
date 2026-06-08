"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Clock, Trash2, Loader2,
  ChevronDown, ChevronRight, Search, CheckCircle2,
  XCircle, UserCheck, AlertTriangle, ShieldCheck, ChevronUp,
  ArrowRight, MoreVertical, Download, Pencil, Copy, Layers, Hash,
} from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse, type PendingChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { EmptyState } from "@/components/ui/empty-state";
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

const QG_CHUNK_CONFIG: Record<ChunkResponse["quality_gate_status"], { label: string; variant: any; accent: string }> = {
  passed:  { label: "Verificado", variant: "success",   accent: "border-l-success" },
  pending: { label: "Por revisar", variant: "warning",  accent: "border-l-warning" },
  skipped: { label: "Excluido",   variant: "secondary", accent: "border-l-border" },
};

// Paleta decorativa por tipo de archivo (categórica, no de estado) — da
// reconocimiento visual rápido en la lista, igual que el explorador de archivos.
const FILE_KINDS: Record<string, { label: string; cls: string }> = {
  pdf:  { label: "PDF",  cls: "bg-red-50 text-red-600 ring-red-100" },
  doc:  { label: "DOC",  cls: "bg-blue-50 text-blue-600 ring-blue-100" },
  docx: { label: "DOCX", cls: "bg-blue-50 text-blue-600 ring-blue-100" },
  txt:  { label: "TXT",  cls: "bg-slate-100 text-slate-600 ring-slate-200" },
  html: { label: "HTML", cls: "bg-orange-50 text-orange-600 ring-orange-100" },
  json: { label: "JSON", cls: "bg-violet-50 text-violet-600 ring-violet-100" },
};

function fileKind(title: string): { label: string; cls: string } {
  const ext = title.split(".").pop()?.toLowerCase() ?? "";
  return FILE_KINDS[ext] ?? { label: ext ? ext.slice(0, 4).toUpperCase() : "DOC", cls: "bg-muted text-muted-foreground ring-border" };
}

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
  const readyCount = documents.filter((d) => d.status === "ready").length;
  const totalChunks = documents.reduce((acc, d) => acc + (d.chunk_count ?? 0), 0);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Conocimiento"
        title="Documentos"
        description="Subí documentos para que la IA los use en sus respuestas."
        actions={<ExportKbButton />}
      />

      {/* Resumen de la base — da contexto de un vistazo, estilo dashboard. */}
      {!isLoading && documents.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={FileText} label="Documentos"  value={documents.length} />
          <StatCard icon={CheckCircle2} label="Listos"   value={readyCount} tone="success" />
          <StatCard icon={Layers} label="Fragmentos"     value={totalChunks} />
          <StatCard
            icon={processingCount > 0 ? Loader2 : ShieldCheck}
            label={processingCount > 0 ? "Procesando" : "Estado"}
            value={processingCount > 0 ? processingCount : "OK"}
            tone={processingCount > 0 ? "info" : "success"}
            spin={processingCount > 0}
          />
        </div>
      )}

      {/* Carga — dropzone con identidad Intellix */}
      <DocumentUploader
        onUploaded={() => {
          refresh();
          toast({ title: "Documento enviado", description: "El procesamiento comenzó en segundo plano.", variant: "success" });
        }}
      />

      {/* Tareas pendientes — un solo banner compacto que unifica duplicados +
          fragmentos por revisar. La cola de revisión queda expandible. */}
      <PendingTasksBanner
        pendingDuplicates={pendingDuplicatesTotal}
        pendingChunks={pendingChunks}
        pendingByDocId={pendingByDocId}
        isLoading={pendingLoading || duplicatesLoading}
        hasProcessingDocs={processingCount > 0}
        onReviewed={refresh}
      />

      {/* Lista de documentos */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <CardTitle className="text-base">Tus documentos</CardTitle>
              <span className="text-sm text-muted-foreground tabular-nums">
                {filtered.length}{search && documents.length !== filtered.length ? ` de ${documents.length}` : ""}
              </span>
            </div>
            {documents.length > 4 && (
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Buscar por nombre…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-9 text-sm"
                />
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {isLoading ? (
            <div className="space-y-2.5">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 p-3.5 rounded-xl border">
                  <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-8 text-destructive text-sm">Error al cargar documentos</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={search ? "Sin resultados" : "Todavía no hay documentos"}
              description={search ? "No se encontraron documentos con ese nombre." : "Subí documentos para que la IA los use en sus respuestas."}
            />
          ) : (
            <div className="space-y-2.5">
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

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon, label, value, tone = "default", spin = false,
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  tone?: "default" | "success" | "info";
  spin?: boolean;
}) {
  const toneCls =
    tone === "success" ? "bg-success/10 text-success" :
    tone === "info"    ? "bg-info/10 text-info" :
    "bg-action-gradient-soft text-action";
  return (
    <div className="rounded-2xl border bg-card shadow-xs px-4 py-3.5 flex items-center gap-3">
      <div className={cn("h-9 w-9 rounded-xl flex items-center justify-center shrink-0", toneCls)}>
        <Icon className={cn("h-[18px] w-[18px]", spin && "animate-spin")} />
      </div>
      <div className="min-w-0 leading-tight">
        <p className="text-xl font-bold tracking-tight tabular-nums text-foreground">{value}</p>
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide truncate">{label}</p>
      </div>
    </div>
  );
}

// ── PendingTasksBanner ────────────────────────────────────────────────────────
// Unifica los dos carriles de pendientes (duplicados + fragmentos por revisar)
// en un solo banner compacto con conteos. La cola de revisión de fragmentos
// queda como sección expandible inline; los duplicados linkean a /admin/duplicates.

function PendingTasksBanner({
  pendingDuplicates,
  pendingChunks,
  pendingByDocId,
  isLoading,
  hasProcessingDocs,
  onReviewed,
}: {
  pendingDuplicates: number;
  pendingChunks: PendingChunkResponse[];
  pendingByDocId: Record<string, { title: string; chunks: PendingChunkResponse[] }>;
  isLoading: boolean;
  hasProcessingDocs: boolean;
  onReviewed: () => void;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);

  const pendingChunkCount = pendingChunks.length;
  const hasDuplicates = pendingDuplicates > 0;
  const hasChunks = pendingChunkCount > 0;

  if (isLoading) return null;

  // Sin pendientes: estado tranquilo. No mostramos el "todo verificado" si
  // todavía hay docs procesando (sería engañoso: aún pueden aparecer fragmentos).
  if (!hasDuplicates && !hasChunks) {
    if (hasProcessingDocs) return null;
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
        <ShieldCheck className="h-4 w-4 text-success shrink-0" />
        Todo el contenido está verificado — no hay tareas pendientes.
      </div>
    );
  }

  // Construir el resumen de conteos: "3 duplicados · 5 fragmentos por revisar"
  const parts: string[] = [];
  if (hasDuplicates) parts.push(`${pendingDuplicates} ${pendingDuplicates === 1 ? "duplicado" : "duplicados"}`);
  if (hasChunks) parts.push(`${pendingChunkCount} fragmento${pendingChunkCount !== 1 ? "s" : ""} por revisar`);

  return (
    <div className="relative rounded-2xl border border-warning/20 bg-warning/5 overflow-hidden">
      {/* Banda lateral para impacto visual */}
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-warning" />

      {/* Fila resumen compacta */}
      <div className="pl-5 pr-4 py-3.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-xl bg-warning/15 flex items-center justify-center shrink-0">
            <AlertTriangle className="h-[18px] w-[18px] text-warning shrink-0" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-warning leading-tight">
              Tareas pendientes
            </p>
            <p className="text-xs text-warning/90 mt-0.5 truncate">
              {parts.join(" · ")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {hasChunks && (
            <Button
              size="sm"
              variant="outline"
              className="border-warning/20 bg-white text-warning hover:bg-warning/10 hover:text-warning"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <>Ocultar fragmentos <ChevronUp className="h-3.5 w-3.5 ml-1.5" /></>
              ) : (
                <>Revisar fragmentos <ChevronDown className="h-3.5 w-3.5 ml-1.5" /></>
              )}
            </Button>
          )}
          {hasDuplicates && (
            <Button
              size="sm"
              variant="outline"
              className="border-warning/20 bg-white text-warning hover:bg-warning/10 hover:text-warning"
              onClick={() => router.push("/admin/duplicates")}
            >
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Ver duplicados
              <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Cola de revisión de fragmentos — expandible inline */}
      {expanded && hasChunks && (
        <div className="border-t border-warning/20 pl-5 pr-4 py-4 bg-card/40">
          <p className="text-xs text-warning/90 mb-3">
            El verificador automático no pudo decidir sobre estos fragmentos. Incluí los que sean útiles para responder consultas y excluí el resto — desaparecen de la cola al decidir.
          </p>
          <div className="space-y-4">
            {Object.entries(pendingByDocId).map(([docId, group]) => (
              <div key={docId}>
                <p className="text-xs font-semibold text-warning flex items-center gap-1.5 mb-2">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  {group.title}
                  <span className="font-normal text-warning">
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
        </div>
      )}
    </div>
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
  const docStatus = DOC_STATUS_CONFIG[doc.status];
  const qgBadge = QG_DOC_CONFIG[doc.quality_gate_status];
  const canExpand = doc.status === "ready" && doc.chunk_count > 0;
  const hasPendingWork = pendingChunkCount > 0 || pendingDuplicateCount > 0;
  const kind = fileKind(doc.title);
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
      "rounded-xl border bg-card shadow-xs overflow-hidden transition-all",
      hasPendingWork ? "border-warning/30 ring-1 ring-warning/10" : "hover:shadow-sm",
      expanded && "shadow-sm",
    )}>
      <div
        className={cn(
          "flex items-center gap-3.5 p-3.5 transition-colors",
          canExpand && "hover:bg-accent/40 cursor-pointer"
        )}
        onClick={() => canExpand && setExpanded((v) => !v)}
      >
        {/* Icono de tipo de archivo — color por formato */}
        <div className={cn(
          "h-11 w-11 rounded-xl flex flex-col items-center justify-center shrink-0 ring-1",
          kind.cls,
        )}>
          {doc.status === "processing" || doc.status === "pending" ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <>
              <FileText className="h-4 w-4" />
              <span className="text-[8px] font-bold leading-none mt-0.5 tracking-wide">{kind.label}</span>
            </>
          )}
        </div>

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate text-foreground">{doc.title}</p>
          <div className="flex items-center gap-x-2.5 gap-y-1 mt-1 flex-wrap">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {date}
            </span>
            {doc.chunk_count > 0 && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Layers className="h-3 w-3" />
                {doc.chunk_count} fragmento{doc.chunk_count !== 1 ? "s" : ""}
              </span>
            )}
            {pendingChunkCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] bg-warning/10 text-warning rounded-md px-2 py-0.5 font-medium border border-warning/20">
                <AlertTriangle className="h-3 w-3" />
                {pendingChunkCount} sin verificar
              </span>
            )}
            {pendingDuplicateCount > 0 && (
              <button
                className="inline-flex items-center gap-1 text-[11px] bg-warning/10 text-warning rounded-md px-2 py-0.5 font-medium border border-warning/20 hover:bg-warning/20 transition-colors"
                onClick={(e) => { e.stopPropagation(); router.push("/admin/duplicates"); }}
                title="Ir a revisar duplicados"
              >
                <Copy className="h-3 w-3" />
                {pendingDuplicateCount} {pendingDuplicateCount === 1 ? "duplicado" : "duplicados"}
              </button>
            )}
          </div>
        </div>

        {/* Badges + actions */}
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          {qgBadge && <Badge variant={qgBadge.variant} className="hidden md:inline-flex">{qgBadge.label}</Badge>}
          <Badge variant={docStatus.variant}>{docStatus.label}</Badge>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Acciones del documento">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
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

          {/* Affordance de expandir — visible y claro (antes era un chevron suelto) */}
          {canExpand && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label={expanded ? "Ocultar fragmentos" : "Ver fragmentos"}
              title={expanded ? "Ocultar fragmentos" : "Ver fragmentos"}
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
            </button>
          )}
        </div>
      </div>

      {/* Expanded chunk view */}
      {expanded && canExpand && (
        <div className="border-t bg-muted/20 px-3.5 py-3.5 space-y-2.5">
          {chunksLoading ? (
            <div className="space-y-2.5">{[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}</div>
          ) : !chunks?.length ? (
            <p className="text-xs text-muted-foreground text-center py-2">Sin fragmentos disponibles</p>
          ) : (
            <>
              <div className="flex items-center gap-2 px-1 flex-wrap text-xs">
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Hash className="h-3 w-3" /> {chunks.length} fragmento{chunks.length !== 1 ? "s" : ""}
                </span>
                <ChunkSummaryChip count={chunks.filter(c => c.quality_gate_status === "passed").length} label="verificado" tone="success" />
                <ChunkSummaryChip count={chunks.filter(c => c.quality_gate_status === "pending").length} label="por revisar" tone="warning" />
                <ChunkSummaryChip count={chunks.filter(c => c.quality_gate_status === "skipped").length} label="excluido" tone="muted" />
              </div>
              {chunks.map((chunk) => (
                <ChunkCard
                  key={chunk.id}
                  chunk={chunk}
                  documentId={doc.id}
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
              <AlertTriangle className="h-5 w-5 text-warning" />
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

// ── ChunkSummaryChip ──────────────────────────────────────────────────────────

function ChunkSummaryChip({ count, label, tone }: { count: number; label: string; tone: "success" | "warning" | "muted" }) {
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

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? "bg-success" : pct >= 60 ? "bg-warning" : "bg-destructive";
  return (
    <div className="flex items-center gap-1.5" title={`Confianza del verificador: ${pct}%`}>
      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
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
    <div className="rounded-xl border bg-card p-4 space-y-3">
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
          {/* Jerarquía: Incluir es la acción recomendada (sólida), Excluir secundaria. */}
          <Button
            size="sm" className="h-8 px-3 text-xs"
            disabled={reviewing}
            onClick={() => review("approve")}
          >
            {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
            Incluir
          </Button>
          <Button
            size="sm" variant="outline"
            className="h-8 px-3 text-xs text-muted-foreground"
            disabled={reviewing}
            onClick={() => review("reject")}
          >
            {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
            Excluir
          </Button>
        </div>
      </div>
      {humanMsg && (
        <p className="text-xs text-warning bg-warning/10 rounded-lg px-2.5 py-1.5 border border-warning/20">
          {humanMsg}
        </p>
      )}
      <div>
        <p className="text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words">{displayText}</p>
        {isLong && (
          <button
            onClick={() => setShowFull((v) => !v)}
            className="text-[11px] text-action hover:underline mt-1 flex items-center gap-0.5"
          >
            {showFull ? <><ChevronUp className="h-3 w-3" /> Ver menos</> : <><ChevronDown className="h-3 w-3" /> Ver todo el fragmento</>}
          </button>
        )}
      </div>
    </div>
  );
}

// ── ChunkCard ─────────────────────────────────────────────────────────────────

function ChunkCard({ chunk, documentId }: { chunk: ChunkResponse; documentId: string }) {
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
    <div className={cn(
      "rounded-xl border border-l-[3px] bg-card overflow-hidden",
      qg.accent,
    )}>
      {/* Cabecera del fragmento */}
      <div className="flex items-center justify-between gap-2 px-3.5 pt-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground tabular-nums">
            Fragmento {chunk.chunk_index + 1}
            <span className="text-muted-foreground font-normal"> / {chunk.total_chunks}</span>
          </span>
          {chunk.manually_reviewed && (
            <span title={`Revisado manualmente${chunk.reviewed_by ? ` por ${chunk.reviewed_by}` : ""}`} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <UserCheck className="h-3 w-3" /> revisado
            </span>
          )}
          <ConfidenceBar value={chunk.quality_gate_confidence} />
        </div>
        <Badge variant={qg.variant} className="text-[10px] h-5 px-1.5">{qg.label}</Badge>
      </div>

      {!isPassed && humanMsg && (
        <p className="text-[11px] text-warning italic px-3.5 pt-2">{humanMsg}</p>
      )}

      {/* Texto del fragmento */}
      <div className="px-3.5 py-2.5">
        <p className="text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">{displayText}</p>
        {isLong && (
          <button
            onClick={() => setShowFull((v) => !v)}
            className="text-[11px] text-action hover:underline mt-1.5 flex items-center gap-0.5 font-medium"
          >
            {showFull
              ? <><ChevronUp className="h-3 w-3" /> Ver menos</>
              : <><ChevronDown className="h-3 w-3" /> Ver todo</>}
          </button>
        )}
      </div>

      {/* Barra de acciones — SIEMPRE visible (antes aparecían solo al hover). */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t bg-muted/30">
        <ChunkActionButton onClick={() => setEditOpen(true)} icon={Pencil} title="Editar el texto del fragmento (re-procesa el embedding)">
          Editar
        </ChunkActionButton>
        <div className="ml-auto flex items-center gap-1.5">
          {!isPassed && (
            <ChunkActionButton
              onClick={() => review("approve")}
              disabled={reviewing}
              loading={reviewing}
              icon={CheckCircle2}
              tone="success"
              title="Incluir este fragmento en las respuestas de la IA"
            >
              Incluir
            </ChunkActionButton>
          )}
          {!isSkipped && (
            <ChunkActionButton
              onClick={() => review("reject")}
              disabled={reviewing}
              loading={reviewing}
              icon={XCircle}
              tone="destructive"
              title="Excluir este fragmento — la IA no lo usará"
            >
              Excluir
            </ChunkActionButton>
          )}
        </div>
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

// ── ChunkActionButton ─────────────────────────────────────────────────────────
// Botón-chip claro y siempre visible para las acciones del fragmento.

function ChunkActionButton({
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
        "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50",
        toneCls,
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
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
