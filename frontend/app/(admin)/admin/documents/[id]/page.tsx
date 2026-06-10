"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Trash2, Loader2, ArrowLeft, Download, XCircle, AlertTriangle, Search, Layers,
} from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { cn } from "@/lib/utils";
import {
  DOC_STATUS_CONFIG, QG_DOC_CONFIG, fileExt, ChunkCard,
} from "@/components/documents/document-shared";

const PAGE_SIZE = 10;

type StatusKey = "all" | ChunkResponse["quality_gate_status"];

const STATUS_FILTERS: Array<{ key: StatusKey; label: string; dot?: string }> = [
  { key: "all",     label: "Todos" },
  { key: "passed",  label: "Verificados", dot: "bg-success" },
  { key: "pending", label: "Por revisar", dot: "bg-warning" },
  { key: "skipped", label: "Excluidos",   dot: "bg-muted-foreground/50" },
];

export default function DocumentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = String(params.id);
  const [showDelete, setShowDelete] = useState(false);

  // Filtros + paginación de fragmentos
  const [statusFilter, setStatusFilter] = useState<StatusKey>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

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
    mutationFn: () => api.documents.download(id),
    onError: () => toast({ title: "No se pudo descargar", description: "El archivo original no está disponible.", variant: "destructive" }),
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

  const totalPages = Math.max(1, Math.ceil(filteredChunks.length / PAGE_SIZE));
  const pageChunks = filteredChunks.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset de página al cambiar filtros; clamp si la página quedó fuera de rango.
  useEffect(() => { setPage(1); }, [statusFilter, search]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  // ── Loading / not found ──────────────────────────────────────────────────────
  if (listLoading && !doc) {
    return (
      <PageShell>
        <BackLink />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <div className="space-y-2.5">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
      </PageShell>
    );
  }
  if (!doc) {
    return (
      <PageShell>
        <BackLink />
        <div className="rounded-2xl border bg-card p-12 text-center">
          <FileText className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-foreground">No encontramos este documento</p>
          <p className="text-sm text-muted-foreground mt-1">Puede que haya sido eliminado.</p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/admin/documents">Volver a Documentos</Link>
          </Button>
        </div>
      </PageShell>
    );
  }

  const st = DOC_STATUS_CONFIG[doc.status];
  const qgBadge = QG_DOC_CONFIG[doc.quality_gate_status];

  return (
    <PageShell>
      <BackLink />

      {/* Cabecera del documento */}
      <div className="rounded-2xl border bg-card shadow-xs p-5">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-muted flex flex-col items-center justify-center shrink-0 text-muted-foreground">
            <FileText className="h-5 w-5" />
            {fileExt(doc.title) && <span className="text-[7px] font-bold leading-none mt-0.5">{fileExt(doc.title)}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight text-foreground break-words leading-snug">{doc.title}</h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant={st.variant} className="gap-1.5">
                <span className={cn("h-1.5 w-1.5 rounded-full", doc.status === "processing" && "animate-pulse", st.dot)} />
                {st.label}
              </Badge>
              {qgBadge && <Badge variant={qgBadge.variant}>{qgBadge.label}</Badge>}
              {doc.chunk_count > 0 && (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
                  <Layers className="h-3.5 w-3.5" />{doc.chunk_count} fragmento{doc.chunk_count !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>

          {/* Acciones del documento */}
          <div className="flex items-center gap-2 shrink-0">
            {doc.storage_key && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadDoc()} disabled={downloading}>
                {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">Descargar</span>
              </Button>
            )}
            <Button
              variant="outline" size="sm"
              className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setShowDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Eliminar</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Fragmentos */}
      {doc.status !== "ready" ? (
        <div className="rounded-2xl border bg-card p-12 text-center text-muted-foreground">
          {doc.status === "failed" ? (
            <><XCircle className="h-8 w-8 mx-auto text-destructive/50 mb-2" /><p className="text-sm">El procesamiento falló. Probá volver a subir el documento.</p></>
          ) : (
            <><Loader2 className="h-8 w-8 mx-auto animate-spin opacity-50 mb-2" /><p className="text-sm">El documento se está procesando…</p></>
          )}
        </div>
      ) : chunksLoading ? (
        <div className="space-y-2.5">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
      ) : !chunks?.length ? (
        <div className="rounded-2xl border bg-card p-10 text-center text-sm text-muted-foreground">Sin fragmentos disponibles</div>
      ) : (
        <div className="space-y-3">
          {/* Toolbar: filtro por estado + búsqueda */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <div role="tablist" aria-label="Filtrar fragmentos" className="inline-flex items-center gap-1 p-1 bg-muted rounded-lg overflow-x-auto">
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
                      "inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm font-medium whitespace-nowrap transition-colors",
                      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.dot && <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", f.dot)} />}
                    {f.label}
                    <span className="tabular-nums text-xs text-muted-foreground">{n}</span>
                  </button>
                );
              })}
            </div>

            <div className="relative w-full sm:max-w-[420px] sm:flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Buscar en los fragmentos…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-sm"
              />
            </div>
          </div>

          {/* Lista paginada */}
          {filteredChunks.length === 0 ? (
            <div className="rounded-2xl border bg-card p-10 text-center text-muted-foreground">
              <Search className="h-7 w-7 mx-auto opacity-30 mb-2" />
              <p className="text-sm">Ningún fragmento coincide con el filtro.</p>
            </div>
          ) : (
            <>
              <div className="space-y-2.5">
                {pageChunks.map((chunk) => <ChunkCard key={chunk.id} chunk={chunk} documentId={doc.id} />)}
              </div>

              {/* Footer: rango + paginación */}
              <div className="flex items-center justify-between gap-3 pt-1 flex-wrap">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredChunks.length)} de {filteredChunks.length}
                  {statusFilter !== "all" || search ? ` (filtrado de ${counts.all})` : ""}
                </span>
                <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
              </div>
            </>
          )}
        </div>
      )}

      {/* Confirmación de eliminación */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Eliminar documento
            </DialogTitle>
            <DialogDescription className="pt-2">
              Vas a eliminar <span className="font-medium text-foreground">{doc.title}</span> y todos sus fragmentos. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setShowDelete(false)} disabled={deleting}>Cancelar</Button>
            <Button variant="destructive" onClick={() => deleteDoc()} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/documents"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
    >
      <ArrowLeft className="h-4 w-4" />
      Volver a Documentos
    </Link>
  );
}
