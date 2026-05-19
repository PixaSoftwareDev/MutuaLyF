"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, File, CheckCircle, AlertCircle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────────────────────

type UploadPhase =
  | "idle"        // queued, not started
  | "uploading"   // HTTP transfer in progress
  | "processing"  // server-side Celery pipeline
  | "ready"       // done — chunks indexed
  | "failed";     // terminal error

interface UploadItem {
  file: File;
  phase: UploadPhase;
  uploadPct: number;        // 0-100 during uploading phase
  documentId?: string;
  chunkCount?: number;
  error?: string;
}

const ACCEPTED_TYPES = {
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/html": [".html"],
};

const MAX_SIZE_MB = 200;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS  = 15 * 60_000; // stop polling after 15 min (safety)

// ── DocumentUploader ──────────────────────────────────────────────────────────

export function DocumentUploader({ onUploaded }: { onUploaded?: () => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);

  const update = (file: File, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((i) => (i.file === file ? { ...i, ...patch } : i)));

  const uploadFile = async (item: UploadItem) => {
    update(item.file, { phase: "uploading", uploadPct: 0 });

    let documentId: string | undefined;
    try {
      const result = await api.documents.upload(item.file, (pct) => {
        update(item.file, { uploadPct: pct });
      });
      documentId = result.document_id;
      update(item.file, { phase: "processing", uploadPct: 100, documentId });
      onUploaded?.();
    } catch (err: any) {
      const msg =
        err?.response?.data?.detail ||
        (typeof err?.message === "string" ? err.message : "Error al subir el archivo");
      update(item.file, { phase: "failed", error: typeof msg === "string" ? msg : JSON.stringify(msg) });
      return;
    }

    // Poll document status until terminal state
    if (!documentId) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        update(item.file, { phase: "failed", error: "Tiempo de espera agotado. Revisá el estado del documento." });
        return;
      }
      try {
        const st = await api.documents.status(documentId!);
        if (st.status === "ready") {
          clearInterval(timer);
          update(item.file, { phase: "ready", chunkCount: st.chunk_count });
        } else if (st.status === "failed") {
          clearInterval(timer);
          update(item.file, { phase: "failed", error: "El procesamiento falló. Revisá el documento." });
        }
        // pending / processing → keep polling
      } catch {
        // network hiccup — keep polling
      }
    }, POLL_INTERVAL_MS);
  };

  const onDrop = useCallback(
    (accepted: File[]) => {
      const newItems: UploadItem[] = accepted.map((f) => ({
        file: f,
        phase: "idle",
        uploadPct: 0,
      }));
      setItems((prev) => [...prev, ...newItems]);
      newItems.forEach((item) => uploadFile(item));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_SIZE_MB * 1024 * 1024,
    multiple: true,
  });

  const clearDone = () =>
    setItems((prev) => prev.filter((i) => i.phase === "uploading" || i.phase === "processing"));

  const hasActive = items.some((i) => i.phase === "uploading" || i.phase === "processing");

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={cn(
          "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors",
          isDragActive
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/50 hover:bg-accent/30",
        )}
      >
        <input {...getInputProps()} />
        <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
        <p className="text-sm font-medium mb-1">
          {isDragActive ? "Soltá los archivos acá" : "Arrastrá archivos o hacé click para seleccionar"}
        </p>
        <p className="text-xs text-muted-foreground">
          PDF, TXT, DOCX, HTML · máx. {MAX_SIZE_MB} MB por archivo
        </p>
      </div>

      {items.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground font-medium">
              {items.length} archivo{items.length !== 1 ? "s" : ""}
              {hasActive && (
                <span className="ml-2 text-primary animate-pulse">procesando…</span>
              )}
            </p>
            <Button variant="ghost" size="sm" onClick={clearDone} className="text-xs h-7">
              Limpiar completados
            </Button>
          </div>
          {items.map((item, idx) => (
            <UploadRow key={idx} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── UploadRow ─────────────────────────────────────────────────────────────────

function UploadRow({ item }: { item: UploadItem }) {
  const sizeMB = (item.file.size / (1024 * 1024)).toFixed(1);
  const isUploading   = item.phase === "uploading";
  const isProcessing  = item.phase === "processing";
  const isReady       = item.phase === "ready";
  const isFailed      = item.phase === "failed";
  const isActive      = isUploading || isProcessing;

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2 transition-colors",
        isFailed   && "border-destructive/40 bg-destructive/5",
        isReady    && "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20",
        isActive   && "border-primary/30 bg-primary/5",
      )}
    >
      {/* Top row */}
      <div className="flex items-center gap-3">
        <File className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{item.file.name}</p>
          <p className="text-xs text-muted-foreground">{sizeMB} MB</p>
        </div>
        {/* Status icon */}
        {isUploading   && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
        {isProcessing  && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
        {isReady       && <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />}
        {isFailed      && <AlertCircle className="h-4 w-4 text-destructive shrink-0" />}
      </div>

      {/* Progress bar */}
      {isUploading && (
        <div className="space-y-1">
          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-200"
              style={{ width: `${item.uploadPct}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Subiendo… {item.uploadPct}%
          </p>
        </div>
      )}

      {/* Processing indeterminate bar */}
      {isProcessing && (
        <div className="space-y-1">
          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary/60 rounded-full animate-progress-indeterminate" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Procesando… extrayendo y clasificando fragmentos
          </p>
        </div>
      )}

      {/* Ready */}
      {isReady && (
        <p className="text-xs text-green-700 dark:text-green-400 font-medium">
          Listo — {item.chunkCount ?? 0} fragmento{item.chunkCount !== 1 ? "s" : ""} indexado{item.chunkCount !== 1 ? "s" : ""}
        </p>
      )}

      {/* Error */}
      {isFailed && item.error && (
        <p className="text-xs text-destructive">{item.error}</p>
      )}
    </div>
  );
}
