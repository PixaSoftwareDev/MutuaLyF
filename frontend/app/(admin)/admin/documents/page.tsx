"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Loader2, Search,
  AlertTriangle, Copy, Plus, Trash2, Upload,
} from "lucide-react";
import { api, type DocumentResponse, type PendingChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { FormDialog } from "@/components/ui/form-dialog";
import { DocumentUploader } from "@/components/documents/document-uploader";
import { toast } from "@/components/ui/toast";
import { ExportKbButton } from "@/components/admin/export-kb-button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { useTableSort, applySort, SortHeader } from "@/components/admin/sortable";
import { cn } from "@/lib/utils";
import {
  DOC_STATUS_CONFIG, fileExt, fmtDate, DocumentDeleteDialog,
} from "@/components/documents/document-shared";

type SortKey = "nombre" | "fragmentos" | "fecha";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  // Debounce para la búsqueda en contenido (pega al backend); el filtro por
  // título sigue siendo instantáneo sobre la lista ya cargada.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // La búsqueda vive en la URL (?q=): "volver" desde el detalle la restaura,
  // entrar de cero desde el menú arranca limpia — patrón estándar de listas.
  // Se lee en effect (no useSearchParams) para no requerir Suspense.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) { setSearch(q); setDebouncedSearch(q); }
  }, []);

  const handleSearch = (v: string) => {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(v);
      const t = v.trim();
      window.history.replaceState(null, "", t ? `?q=${encodeURIComponent(t)}` : window.location.pathname);
    }, 350);
  };
  const [uploadOpen, setUploadOpen] = useState(false);
  const { sort, toggle } = useTableSort<SortKey>({ fragmentos: "desc", fecha: "desc" });

  const { data: documents = [], isLoading, error, refetch } = useQuery({
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

  const { data: pendingChunks = [] } = useQuery({
    queryKey: ["chunks", "pending"],
    queryFn: api.documents.pendingChunks,
    staleTime: 15_000,
    refetchInterval: documents.some(d => d.status === "pending" || d.status === "processing") ? 5_000 : 30_000,
  });

  // Coincidencias en el CONTENIDO (partes) de los documentos, no solo el título.
  const contentQ = debouncedSearch.trim();
  const { data: contentHits = [] } = useQuery({
    queryKey: ["documents-content-search", contentQ],
    queryFn: () => api.documents.searchContent(contentQ),
    enabled: contentQ.length >= 2,
    staleTime: 30_000,
  });
  const contentMatches = useMemo(() => {
    const map = new Map<string, number>();
    if (contentQ.length >= 2) for (const h of contentHits) map.set(h.document_id, h.matches);
    return map;
  }, [contentHits, contentQ]);

  const { data: duplicatesData } = useQuery({
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

  const filtered = documents.filter(
    (d) => !search || d.title.toLowerCase().includes(search.toLowerCase()) || contentMatches.has(d.id),
  );
  const sorted = useMemo(() => applySort(filtered, sort, (a, b, key) =>
    key === "nombre"     ? a.title.localeCompare(b.title, "es") :
    key === "fragmentos" ? (a.chunk_count ?? 0) - (b.chunk_count ?? 0) :
                           new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  ), [filtered, sort]);

  const isEmpty = !isLoading && !error && documents.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4 sm:px-6">
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">Documentos</h1>
        {!isEmpty && (
          <div className="flex shrink-0 items-center gap-2">
            <ExportKbButton />
            <Button size="sm" className="shrink-0" onClick={() => setUploadOpen(true)}>
              <Plus className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Subir documento</span>
              <span className="sm:hidden">Subir</span>
            </Button>
          </div>
        )}
      </div>

      {/* Contenido scrolleable */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4 sm:p-6">
        {isLoading ? (
          <Skeleton className="h-72 rounded-2xl" />
        ) : error ? (
          <div className="rounded-2xl border">
            <ErrorState
              title="Error al cargar documentos"
              description="No pudimos traer tus documentos. Revisá la conexión y probá de nuevo."
              onRetry={() => refetch()}
            />
          </div>
        ) : isEmpty ? (
          /* Estado inicial: hero centrado con el uploader */
          <div className="mx-auto w-full max-w-2xl">
            <div className="mb-5 text-center">
              {/* Ícono neutro, igual que el resto de los estados vacíos (EmptyState). */}
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <FileText className="h-6 w-6 text-muted-foreground" />
              </div>
              <h2 className="mt-4 text-lg font-semibold tracking-tight">Subí tu primer documento</h2>
              {/* Los formatos y el tamaño máximo ya los muestra el dropzone; acá no se repiten. */}
              <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
                El asistente lo lee y lo usa para responder.
              </p>
            </div>
            <DocumentUploader onUploaded={() => {
              refresh();
              toast({ title: "Documento enviado", description: "El procesamiento comenzó en segundo plano.", variant: "success" });
            }} />
          </div>
        ) : (
          <div className="space-y-4">
            <ListToolbar search={search} onSearch={handleSearch} placeholder="Buscar por nombre o contenido…" />

            {sorted.length === 0 ? (
              <EmptyState icon={Search} title="Sin resultados" description="Ningún documento coincide por nombre ni por contenido." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead><SortHeader label="Documento" sortKey="nombre" sort={sort} onToggle={toggle} /></TableHead>
                    <TableHead className="hidden w-[150px] sm:table-cell">Estado</TableHead>
                    <TableHead className="hidden w-[120px] text-right lg:table-cell">
                      <SortHeader label="Fragmentos" sortKey="fragmentos" sort={sort} onToggle={toggle} />
                    </TableHead>
                    <TableHead className="hidden w-[150px] md:table-cell">
                      <SortHeader label="Subido" sortKey="fecha" sort={sort} onToggle={toggle} />
                    </TableHead>
                    <TableHead className="w-[48px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((doc) => (
                    <DocumentTableRow
                      key={doc.id}
                      doc={doc}
                      pendingChunkCount={pendingByDocId[doc.id]?.chunks.length ?? 0}
                      pendingDuplicateCount={duplicateCountByDocId[doc.id] ?? 0}
                      contentMatchCount={contentMatches.get(doc.id) ?? 0}
                      searchTerm={debouncedSearch}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>

      {/* Modal de carga */}
      <FormDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        icon={Upload}
        title="Subir documentos"
        description="Arrastrá o elegí archivos. El procesamiento sigue en segundo plano — podés cerrar esta ventana."
      >
        <DocumentUploader
          onUploaded={() => {
            refresh();
            toast({ title: "Documento enviado", description: "El procesamiento comenzó en segundo plano.", variant: "success" });
          }}
          onDone={() => setUploadOpen(false)}
        />
      </FormDialog>
    </div>
  );
}

// ── DocumentTableRow ──────────────────────────────────────────────────────────

function DocumentTableRow({
  doc, pendingChunkCount, pendingDuplicateCount, contentMatchCount = 0, searchTerm = "",
}: {
  doc: DocumentResponse;
  pendingChunkCount: number;
  pendingDuplicateCount: number;
  contentMatchCount?: number;
  searchTerm?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [showDelete, setShowDelete] = useState(false);

  const { mutate: deleteDoc, isPending: deleting } = useMutation({
    mutationFn: () => api.documents.delete(doc.id),
    onSuccess: () => {
      toast({ title: "Documento eliminado", variant: "success" });
      setShowDelete(false);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["chunks", "pending"] });
      queryClient.invalidateQueries({ queryKey: ["duplicates"] });
    },
    onError: () => toast({ title: "Error al eliminar", description: "Intentá de nuevo.", variant: "destructive" }),
  });

  const st = DOC_STATUS_CONFIG[doc.status];
  const ext = fileExt(doc.title);
  const processing = doc.status === "processing" || doc.status === "pending";
  const hasPendingWork = pendingChunkCount > 0 || pendingDuplicateCount > 0;

  // El término viaja al detalle SOLO si hubo coincidencias de contenido — si
  // matcheó por título, entrar filtrado mostraría "ninguna parte coincide".
  const detailHref = contentMatchCount > 0 && searchTerm.trim()
    ? `/admin/documents/${doc.id}?q=${encodeURIComponent(searchTerm.trim())}`
    : `/admin/documents/${doc.id}`;

  return (
    <TableRow
      className="cursor-pointer group"
      onClick={() => router.push(detailHref)}
      onMouseEnter={() => router.prefetch(`/admin/documents/${doc.id}`)}
    >
      {/* w-full + max-w-0: la columna toma el espacio restante y el título trunca
          (sin esto, en mobile los títulos largos ensanchan la tabla y hacían
          scroll lateral interno). */}
      <TableCell className="w-full max-w-0 py-2.5">
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
            {contentMatchCount > 0 && (
              <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Search className="h-3 w-3" />
                {contentMatchCount} {contentMatchCount === 1 ? "mención" : "menciones"} en el contenido
              </span>
            )}
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

      <TableCell className="hidden whitespace-nowrap sm:table-cell">
        <Badge variant={st.variant} className="gap-1.5 whitespace-nowrap">
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

      <TableCell className="text-right whitespace-nowrap">
        {/* stopPropagation: el click en el tachito no debe navegar al detalle */}
        <button
          type="button"
          aria-label={`Eliminar ${doc.title}`}
          title="Eliminar documento"
          onClick={(e) => { e.stopPropagation(); setShowDelete(true); }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        {/* El diálogo vive fuera del flujo de click de la fila (portal), pero
            frenamos la propagación por si el overlay re-dispara sobre la fila */}
        <span onClick={(e) => e.stopPropagation()}>
          <DocumentDeleteDialog
            open={showDelete}
            onOpenChange={setShowDelete}
            title={doc.title}
            onConfirm={() => deleteDoc()}
            deleting={deleting}
          />
        </span>
      </TableCell>
    </TableRow>
  );
}
