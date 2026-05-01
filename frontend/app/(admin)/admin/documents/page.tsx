"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, RefreshCw, Clock, Trash2, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { api, type DocumentResponse, type ChunkResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DocumentUploader } from "@/components/documents/document-uploader";

const STATUS_CONFIG: Record<DocumentResponse["status"], { label: string; variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline" }> = {
  pending:    { label: "Pendiente",   variant: "secondary" },
  processing: { label: "Procesando",  variant: "default" },
  ready:      { label: "Listo",       variant: "success" },
  failed:     { label: "Error",       variant: "destructive" },
};

const QG_CONFIG: Record<DocumentResponse["quality_gate_status"], { label: string; variant: "success" | "warning" | "secondary" }> = {
  passed:  { label: "Verificado", variant: "success" },
  pending: { label: "Pendiente",  variant: "warning" },
  skipped: { label: "Omitido",    variant: "secondary" },
};

const CHUNK_QG_CONFIG: Record<ChunkResponse["quality_gate_status"], { label: string; variant: "success" | "warning" | "secondary" }> = {
  passed:  { label: "OK",       variant: "success" },
  pending: { label: "Pendiente", variant: "warning" },
  skipped: { label: "Omitido",  variant: "secondary" },
};

export default function DocumentsPage() {
  const queryClient = useQueryClient();

  const { data: documents = [], isLoading, error } = useQuery({
    queryKey: ["documents"],
    queryFn: api.documents.list,
    refetchInterval: 5000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["documents"] });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            Documentos
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Subí documentos para que la IA los ingeste y use en sus respuestas
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Actualizar
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Subir documentos</CardTitle>
          <CardDescription>Los documentos se procesan en segundo plano. El estado se actualiza automáticamente.</CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentUploader onUploaded={refresh} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Documentos ({documents.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="text-center py-8 text-destructive text-sm">Error al cargar documentos</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No hay documentos todavía. Subí el primero.
            </div>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} onDeleted={refresh} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DocumentRow({ doc, onDeleted }: { doc: DocumentResponse; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const status = STATUS_CONFIG[doc.status];
  const qg = QG_CONFIG[doc.quality_gate_status];
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
    onSuccess: () => { setConfirming(false); onDeleted(); },
  });

  return (
    <div className="rounded-lg border overflow-hidden">
      <div
        className={`flex items-center gap-3 p-3 transition-colors ${canExpand ? "hover:bg-accent/30 cursor-pointer" : ""}`}
        onClick={() => canExpand && setExpanded((v) => !v)}
      >
        {canExpand ? (
          expanded
            ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{doc.title}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {date}
            </span>
            {doc.chunk_count > 0 && (
              <span className="text-xs text-muted-foreground">{doc.chunk_count} chunks</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Badge variant={qg.variant as any}>{qg.label}</Badge>
          <Badge variant={status.variant as any}>{status.label}</Badge>

          {confirming ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2 text-xs"
                disabled={deleting}
                onClick={() => deleteDoc()}
              >
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirmar"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={deleting}
                onClick={() => setConfirming(false)}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {expanded && canExpand && (
        <div className="border-t bg-muted/30 px-4 py-3 space-y-2">
          {chunksLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : !chunks || chunks.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">Sin chunks disponibles</p>
          ) : (
            chunks.map((chunk) => <ChunkCard key={chunk.id} chunk={chunk} />)
          )}
        </div>
      )}
    </div>
  );
}

function ChunkCard({ chunk }: { chunk: ChunkResponse }) {
  const qg = CHUNK_QG_CONFIG[chunk.quality_gate_status];
  return (
    <div className="rounded border bg-background p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Chunk {chunk.chunk_index + 1} / {chunk.total_chunks}
        </span>
        <Badge variant={qg.variant as any} className="text-[10px] h-4 px-1.5">{qg.label}</Badge>
      </div>
      <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">{chunk.text}</p>
    </div>
  );
}
