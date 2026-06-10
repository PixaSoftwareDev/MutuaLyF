"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Loader2, ChevronDown, ChevronUp, Search,
  AlertTriangle, ArrowRight, Copy, Plus,
} from "lucide-react";
import { api, type DocumentResponse, type PendingChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { DocumentUploader } from "@/components/documents/document-uploader";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { ExportKbButton } from "@/components/admin/export-kb-button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
  DOC_STATUS_CONFIG, fileExt, fmtDate, PendingChunkCard,
} from "@/components/documents/document-shared";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data: documents = [], isLoading, error } = useQuery({
    queryKey: ["documents"],
    queryFn: api.documents.list,
    staleTime: 10_000,
    // Polling adaptativo: si hay docs procesando, refetch agresivo cada 4s.
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
    refetchInterval: documents.some(d => d.status === "pending" || d.status === "processing") ? 5_000 : 30_000,
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
  const isEmpty = !isLoading && !error && documents.length === 0;

  return (
    <PageShell>
      <PageHeader
        title="Documentos"
        description="La base de conocimiento que el asistente usa para responder."
        actions={
          !isEmpty ? (
            <div className="flex items-center gap-2">
              <ExportKbButton />
              <Button onClick={() => setUploadOpen(true)} className="gap-1.5">
                <Plus className="h-4 w-4" />
                Subir documento
              </Button>
            </div>
          ) : undefined
        }
      />

      <PendingTasksBanner
        pendingDuplicates={pendingDuplicatesTotal}
        pendingChunks={pendingChunks}
        pendingByDocId={pendingByDocId}
        isLoading={pendingLoading || duplicatesLoading}
        onReviewed={refresh}
      />

      {isLoading ? (
        <Card className="rounded-2xl p-2">
          <div className="space-y-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-3">
                <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
                <div className="flex-1 space-y-2"><Skeleton className="h-4 w-56" /><Skeleton className="h-3 w-20" /></div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </Card>
      ) : error ? (
        <Card className="rounded-2xl p-8 text-center text-destructive text-sm">Error al cargar documentos</Card>
      ) : isEmpty ? (
        <Card className="rounded-2xl p-6 sm:p-8">
          <div className="max-w-xl mx-auto text-center mb-5">
            <h2 className="text-lg font-semibold tracking-tight">Subí tu primer documento</h2>
            <p className="text-sm text-muted-foreground mt-1.5">
              El asistente va a leerlo y usarlo para responder. Aceptamos PDF, DOCX, TXT, HTML y JSON.
            </p>
          </div>
          <DocumentUploader onUploaded={() => {
            refresh();
            toast({ title: "Documento enviado", description: "El procesamiento comenzó en segundo plano.", variant: "success" });
          }} />
        </Card>
      ) : (
        <Card className="rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-4 px-4 py-3 border-b">
            <div className="relative w-full max-w-[300px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Buscar documento…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-sm"
              />
            </div>
            {search && (
              <span className="text-sm text-muted-foreground shrink-0 tabular-nums">
                {filtered.length} resultado{filtered.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={Search} title="Sin resultados" description="No se encontraron documentos con ese nombre." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Documento</TableHead>
                  <TableHead className="hidden sm:table-cell w-[140px]">Estado</TableHead>
                  <TableHead className="hidden lg:table-cell w-[110px] text-right">Fragmentos</TableHead>
                  <TableHead className="hidden md:table-cell w-[130px]">Subido</TableHead>
                  <TableHead className="w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((doc) => (
                  <DocumentTableRow
                    key={doc.id}
                    doc={doc}
                    pendingChunkCount={pendingByDocId[doc.id]?.chunks.length ?? 0}
                    pendingDuplicateCount={duplicateCountByDocId[doc.id] ?? 0}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}

      {/* Dialog de carga */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Subir documentos</DialogTitle>
            <DialogDescription>
              Arrastrá o elegí archivos. El procesamiento sigue en segundo plano — podés cerrar esta ventana.
            </DialogDescription>
          </DialogHeader>
          <DocumentUploader
            onUploaded={() => {
              refresh();
              toast({ title: "Documento enviado", description: "El procesamiento comenzó en segundo plano.", variant: "success" });
            }}
            onDone={() => setUploadOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

// ── DocumentTableRow ──────────────────────────────────────────────────────────

function DocumentTableRow({
  doc, pendingChunkCount, pendingDuplicateCount,
}: {
  doc: DocumentResponse;
  pendingChunkCount: number;
  pendingDuplicateCount: number;
}) {
  const router = useRouter();
  const st = DOC_STATUS_CONFIG[doc.status];
  const ext = fileExt(doc.title);
  const processing = doc.status === "processing" || doc.status === "pending";
  const hasPendingWork = pendingChunkCount > 0 || pendingDuplicateCount > 0;

  return (
    <TableRow
      className="cursor-pointer group"
      onClick={() => router.push(`/admin/documents/${doc.id}`)}
      onMouseEnter={() => router.prefetch(`/admin/documents/${doc.id}`)}
    >
      <TableCell className="py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative h-9 w-9 rounded-lg bg-muted flex flex-col items-center justify-center shrink-0 text-muted-foreground">
            {processing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <FileText className="h-[18px] w-[18px]" />
                {ext && <span className="text-[7px] font-bold leading-none mt-0.5 tracking-wide">{ext}</span>}
              </>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate group-hover:text-action transition-colors">{doc.title}</p>
            <div className="flex items-center gap-2 mt-0.5 sm:hidden">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className={cn("h-1.5 w-1.5 rounded-full", st.dot)} />{st.label}
              </span>
              {doc.chunk_count > 0 && <span className="text-[11px] text-muted-foreground">· {doc.chunk_count} frag.</span>}
            </div>
            {hasPendingWork && (
              <div className="hidden sm:flex items-center gap-1.5 mt-1">
                {pendingChunkCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-warning font-medium">
                    <AlertTriangle className="h-3 w-3" />{pendingChunkCount} sin verificar
                  </span>
                )}
                {pendingDuplicateCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-warning font-medium">
                    <Copy className="h-3 w-3" />{pendingDuplicateCount} {pendingDuplicateCount === 1 ? "duplicado" : "duplicados"}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden sm:table-cell">
        <Badge variant={st.variant} className="gap-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", doc.status === "processing" && "animate-pulse", st.dot)} />
          {st.label}
        </Badge>
      </TableCell>

      <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm text-muted-foreground">
        {doc.chunk_count > 0 ? doc.chunk_count : "—"}
      </TableCell>

      <TableCell className="hidden md:table-cell text-sm text-muted-foreground whitespace-nowrap">
        {fmtDate(doc.created_at)}
      </TableCell>

      <TableCell className="text-right">
        <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-action group-hover:translate-x-0.5 transition-all inline-block" />
      </TableCell>
    </TableRow>
  );
}

// ── PendingTasksBanner ────────────────────────────────────────────────────────

function PendingTasksBanner({
  pendingDuplicates, pendingChunks, pendingByDocId, isLoading, onReviewed,
}: {
  pendingDuplicates: number;
  pendingChunks: PendingChunkResponse[];
  pendingByDocId: Record<string, { title: string; chunks: PendingChunkResponse[] }>;
  isLoading: boolean;
  onReviewed: () => void;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);

  const pendingChunkCount = pendingChunks.length;
  const hasDuplicates = pendingDuplicates > 0;
  const hasChunks = pendingChunkCount > 0;

  if (isLoading) return null;
  if (!hasDuplicates && !hasChunks) return null;

  const parts: string[] = [];
  if (hasDuplicates) parts.push(`${pendingDuplicates} ${pendingDuplicates === 1 ? "duplicado" : "duplicados"}`);
  if (hasChunks) parts.push(`${pendingChunkCount} fragmento${pendingChunkCount !== 1 ? "s" : ""} por revisar`);

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/[0.06] overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
          <p className="text-sm text-foreground">
            <span className="font-semibold">Tareas pendientes:</span>{" "}
            <span className="text-muted-foreground">{parts.join(" · ")}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasChunks && (
            <Button size="sm" variant="outline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? <>Ocultar <ChevronUp className="h-3.5 w-3.5 ml-1.5" /></> : <>Revisar fragmentos <ChevronDown className="h-3.5 w-3.5 ml-1.5" /></>}
            </Button>
          )}
          {hasDuplicates && (
            <Button size="sm" variant="outline" onClick={() => router.push("/admin/duplicates")}>
              <Copy className="h-3.5 w-3.5 mr-1.5" /> Ver duplicados <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
            </Button>
          )}
        </div>
      </div>

      {expanded && hasChunks && (
        <div className="border-t border-warning/20 px-4 py-4 bg-card/50">
          <p className="text-xs text-muted-foreground mb-3">
            El verificador automático no pudo decidir sobre estos fragmentos. Incluí los útiles y excluí el resto.
          </p>
          <div className="space-y-4">
            {Object.entries(pendingByDocId).map(([docId, group]) => (
              <div key={docId}>
                <p className="text-xs font-semibold text-foreground flex items-center gap-1.5 mb-2">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {group.title}
                  <span className="font-normal text-muted-foreground">· {group.chunks.length} fragmento{group.chunks.length !== 1 ? "s" : ""}</span>
                </p>
                <div className="space-y-2 pl-5">
                  {group.chunks.map((chunk) => <PendingChunkCard key={chunk.id} chunk={chunk} onReviewed={onReviewed} />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
