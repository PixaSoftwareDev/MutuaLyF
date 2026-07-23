"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Trash2, Loader2, ChevronLeft, ChevronDown, Download, XCircle, Search, Layers,
} from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ListDetailShell } from "@/components/admin/list-detail-shell";
import { DetailShell as Shell } from "@/components/admin/detail-shell";
import {
  DOC_STATUS_CONFIG, QG_DOC_CONFIG, fileExt, partStatus, PartDetailPanel, DocumentDeleteDialog,
} from "@/components/documents/document-shared";

type StatusKey = "all" | ChunkResponse["quality_gate_status"];

const STATUS_FILTERS: Array<{ key: StatusKey; label: string; dot?: string }> = [
  { key: "all",     label: "Todas" },
  { key: "passed",  label: "En uso",      dot: "bg-success" },
  { key: "pending", label: "Por revisar", dot: "bg-warning" },
  { key: "skipped", label: "Sin usar",    dot: "bg-muted-foreground/50" },
];

export default function DocumentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = String(params.id);

  const [showDelete, setShowDelete] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusKey>("all");
  const [search, setSearch] = useState("");

  // El doc sale de la lista cacheada; si se entra directo por URL, la query la trae.
  const { data: documents, isLoading: listLoading } = useQuery({
    queryKey: ["documents"],
    queryFn: api.documents.list,
    staleTime: 10_000,
  });
  const doc: DocumentResponse | undefined = documents?.find((d) => d.id === id);

  const { data: chunks, isLoading: chunksLoading } = useQuery({
    queryKey: ["chunks", id],
    queryFn: () => api.documents.chunks(id),
    enabled: !!doc && doc.status === "ready" && doc.chunk_count > 0,
    staleTime: 60_000,
    refetchInterval: doc && (doc.status === "pending" || doc.status === "processing") ? 5_000 : false,
  });

  const { mutate: deleteDoc, isPending: deleting } = useMutation({
    mutationFn: () => api.documents.delete(id),
    onSuccess: () => {
      toast({ title: "Documento eliminado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      router.push("/admin/documents");
    },
    onError: () => toast({ title: "Error al eliminar", description: "Intentá de nuevo.", variant: "destructive" }),
  });

  const { mutate: downloadDoc, isPending: downloading } = useMutation({
    mutationFn: (variant: "original" | "edited") => api.documents.download(id, variant),
    onError: (_err, variant) => toast({
      title: "No se pudo descargar",
      description: variant === "edited"
        ? "El documento no tiene partes en uso para exportar."
        : "El archivo original no está disponible.",
      variant: "destructive",
    }),
  });

  const counts = useMemo(() => {
    const c = { all: chunks?.length ?? 0, passed: 0, pending: 0, skipped: 0 };
    for (const ch of chunks ?? []) c[ch.quality_gate_status] += 1;
    return c;
  }, [chunks]);

  const filteredChunks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (chunks ?? []).filter((c) =>
      (statusFilter === "all" || c.quality_gate_status === statusFilter) &&
      (!q || c.text.toLowerCase().includes(q)),
    );
  }, [chunks, statusFilter, search]);

  // Selección desde la lista completa (no la filtrada): así el panel sobrevive
  // aunque la parte deje de matchear el filtro tras revisarla.
  const selectedChunk = chunks?.find((c) => c.id === selectedId) ?? null;

  useEffect(() => { setSelectedId(null); setPanelOpen(false); }, [id]);

  const backLink = (
    <Link
      href="/admin/documents"
      aria-label="Volver a Documentos"
      title="Volver a Documentos"
      className="-ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4" />
    </Link>
  );

  // ── Loading / not found ──────────────────────────────────────────────────────
  if (listLoading && !doc) {
    return (
      <Shell leading={backLink} title="Documento">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <div className="mt-4 space-y-2"><Skeleton className="h-10 w-full rounded-lg" /><Skeleton className="h-10 w-full rounded-lg" /></div>
      </Shell>
    );
  }
  if (!doc) {
    return (
      <Shell leading={backLink} title="Documento">
        <div className="rounded-2xl border bg-card p-12 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium text-foreground">No encontramos este documento</p>
          <p className="mt-1 text-sm text-muted-foreground">Puede que haya sido eliminado.</p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/admin/documents">Volver a Documentos</Link>
          </Button>
        </div>
      </Shell>
    );
  }

  const st = DOC_STATUS_CONFIG[doc.status];
  const qgBadge = QG_DOC_CONFIG[doc.quality_gate_status];

  const docActions = (
    <div className="flex shrink-0 items-center gap-2">
      {(doc.storage_key || doc.chunk_count > 0) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={downloading}>
              {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">Descargar</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem disabled={!doc.storage_key} onClick={() => downloadDoc("original")}>
              <div className="flex flex-col gap-0.5">
                <span>Archivo original</span>
                <span className="text-xs text-muted-foreground">Tal como se subió, sin cambios.</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={doc.status !== "ready" || doc.chunk_count === 0} onClick={() => downloadDoc("edited")}>
              <div className="flex flex-col gap-0.5">
                <span>Versión actual (.txt)</span>
                <span className="text-xs text-muted-foreground">Las partes en uso, con tus ediciones.</span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        variant="outline" size="sm"
        className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setShowDelete(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Eliminar</span>
      </Button>
    </div>
  );

  // Barra de metadatos del documento (estado + verificación + nº de partes).
  const metaBar = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex h-8 w-8 shrink-0 flex-col items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <FileText className="h-4 w-4" />
      </span>
      <Badge variant={st.variant} className="gap-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", doc.status === "processing" && "animate-pulse", st.dot)} />
        {st.label}
      </Badge>
      {qgBadge && <Badge variant={qgBadge.variant}>{qgBadge.label}</Badge>}
      {fileExt(doc.title) && <span className="text-xs font-medium text-muted-foreground">{fileExt(doc.title)}</span>}
      {doc.chunk_count > 0 && (
        <span className="inline-flex items-center gap-1 text-sm tabular-nums text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />{doc.chunk_count} parte{doc.chunk_count !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );

  // ── Documento aún no procesado ───────────────────────────────────────────────
  if (doc.status !== "ready") {
    return (
      <>
        <Shell leading={backLink} title={doc.title} actions={docActions}>
          {metaBar}
          <div className="mt-4 rounded-2xl border bg-card p-12 text-center text-muted-foreground">
            {doc.status === "failed" ? (
              <><XCircle className="mx-auto mb-2 h-8 w-8 text-destructive/50" /><p className="text-sm">El procesamiento falló. Probá volver a subir el documento.</p></>
            ) : (
              <><Loader2 className="mx-auto mb-2 h-8 w-8 animate-spin opacity-50" /><p className="text-sm">El documento se está procesando…</p></>
            )}
          </div>
        </Shell>
        <DocumentDeleteDialog open={showDelete} onOpenChange={setShowDelete} title={doc.title} onConfirm={() => deleteDoc()} deleting={deleting} />
      </>
    );
  }

  // ── Listo: master-detalle de partes ──────────────────────────────────────────
  return (
    <>
      <ListDetailShell
        title={doc.title}
        leading={backLink}
        actions={docActions}
        panelTitle="parte"
        open={panelOpen}
        hasSelection={!!selectedChunk}
        onExpand={() => setPanelOpen(true)}
        panelWidth={520}
        panel={selectedChunk ? (
          <PartDetailPanel
            key={selectedChunk.id}
            chunk={selectedChunk}
            documentId={doc.id}
            onCollapse={() => setPanelOpen(false)}
          />
        ) : null}
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            El asistente dividió este documento en partes para leerlo mejor. Elegí cuáles usa para responder: las que están{" "}
            <span className="font-medium text-foreground">en uso</span> las tiene en cuenta, las{" "}
            <span className="font-medium text-foreground">sin usar</span> las ignora.
          </p>

          {chunksLoading ? (
            <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11 w-full rounded-lg" />)}</div>
          ) : !chunks?.length ? (
            <div className="rounded-2xl border bg-card p-10 text-center text-sm text-muted-foreground">Sin partes disponibles</div>
          ) : (
            <>
              {/* Filtro por estado + búsqueda. Apilan hasta pantallas grandes
                  para no compartir línea y comprimirse en notebooks. */}
              <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
                <div role="tablist" aria-label="Filtrar partes" className="inline-flex shrink-0 items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1">
                  {STATUS_FILTERS.map((f) => {
                    const n = counts[f.key];
                    const active = statusFilter === f.key;
                    if (f.key !== "all" && n === 0) return null;
                    return (
                      <button
                        key={f.key}
                        role="tab"
                        aria-selected={active}
                        onClick={() => setStatusFilter(f.key)}
                        className={cn(
                          "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors",
                          active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {f.dot && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", f.dot)} />}
                        {f.label}
                        <span className="text-xs tabular-nums text-muted-foreground">{n}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="relative w-full min-w-0 lg:max-w-[300px]">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input placeholder="Buscar en el texto…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 pl-8 text-sm" />
                </div>
              </div>

              {/* Tabla de partes */}
              {filteredChunks.length === 0 ? (
                <div className="rounded-2xl border bg-card p-10 text-center text-muted-foreground">
                  <Search className="mx-auto mb-2 h-7 w-7 opacity-30" />
                  <p className="text-sm">Ninguna parte coincide con el filtro.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-10 text-center">#</TableHead>
                      <TableHead>Contenido</TableHead>
                      <TableHead className="w-[130px] text-right">Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredChunks.map((chunk) => (
                      <PartRow
                        key={chunk.id}
                        chunk={chunk}
                        selected={chunk.id === selectedId}
                        onSelect={() => { setSelectedId(chunk.id); setPanelOpen(true); }}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </div>
      </ListDetailShell>

      <DocumentDeleteDialog open={showDelete} onOpenChange={setShowDelete} title={doc.title} onConfirm={() => deleteDoc()} deleting={deleting} />
    </>
  );
}

// ── Fila de una parte ─────────────────────────────────────────────────────────

function PartRow({ chunk, selected, onSelect }: { chunk: ChunkResponse; selected: boolean; onSelect: () => void }) {
  const st = partStatus(chunk.quality_gate_status);
  const isSkipped = chunk.quality_gate_status === "skipped";
  return (
    <TableRow onClick={onSelect} aria-selected={selected} className={cn("cursor-pointer", selected && "bg-muted/60")}>
      <TableCell className="py-4 text-center align-middle text-xs tabular-nums text-muted-foreground/60">
        {chunk.chunk_index + 1}
      </TableCell>
      <TableCell className="py-4 align-middle">
        <p className={cn("line-clamp-1 text-sm", isSkipped ? "text-muted-foreground" : "text-foreground/80")}>
          {chunk.text}
        </p>
      </TableCell>
      <TableCell className="whitespace-nowrap py-4 text-right align-middle">
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", st.text)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", st.dot)} /> {st.label}
        </span>
      </TableCell>
    </TableRow>
  );
}

