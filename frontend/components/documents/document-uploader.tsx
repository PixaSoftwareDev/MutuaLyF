"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, File, AlertCircle, Loader2, X, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────────────────────
//
// El uploader solo se preocupa por la transferencia HTTP. Una vez que el
// backend acepta el archivo, la fila desaparece y el documento pasa a verse
// en la lista de Documentos (que tiene polling adaptativo propio).
//
// Mostramos filas solo cuando "uploading" (feedback de la subida), "failed"
// (para que el usuario sepa qué archivo no entró y pueda reintentar), o
// "duplicate" (cuando el backend detecta exact_bytes — no es un error,
// solo info de que ya estaba cargado).

type UploadPhase = "uploading" | "failed" | "duplicate";

// Tipos de match que devuelve el backend en el 409:
//   filename:     mismo nombre, contenido distinto
//   exact_bytes:  bytes idénticos (mismo archivo subido dos veces)
//   same_content: mismo texto pero formato/bytes distintos (PDF vs DOCX del mismo doc)
type DuplicateMatchType = "filename" | "exact_bytes" | "same_content";

interface UploadItem {
  file: File;
  phase: UploadPhase;
  uploadPct: number;
  error?: string;
  /** Cuando phase=duplicate: titulo del doc ya existente. */
  duplicateOfTitle?: string;
  duplicateMatchType?: DuplicateMatchType;
}

const ACCEPTED_TYPES = {
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/html": [".html"],
  "application/json": [".json"],
};

const MAX_SIZE_MB = 200;

// ── DocumentUploader ──────────────────────────────────────────────────────────

export function DocumentUploader({ onUploaded }: { onUploaded?: () => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);

  const update = (file: File, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((i) => (i.file === file ? { ...i, ...patch } : i)));

  const remove = (file: File) =>
    setItems((prev) => prev.filter((i) => i.file !== file));

  const uploadFile = async (item: UploadItem) => {
    try {
      await api.documents.upload(item.file, (pct) => {
        update(item.file, { uploadPct: pct });
      });
      // El backend ya recibió el archivo → desaparece de acá, la lista de
      // Documentos se encarga del estado posterior (procesando → listo).
      remove(item.file);
      onUploaded?.();
    } catch (err: any) {
      // 409 Conflict = duplicado detectado. NO es un error tecnico — el backend
      // avisa que ya cargaste algo similar. Lo mostramos en estilo info (ambar).
      // El backend devuelve match_type para que mostremos mensaje preciso:
      //   filename     → mismo nombre, contenido distinto
      //   exact_bytes  → mismo archivo (bytes idénticos)
      //   same_content → mismo texto, formato distinto (PDF vs DOCX, etc)
      if (err?.response?.status === 409) {
        const dup = err.response.data?.duplicate_of;
        const matchType = err.response.data?.match_type as DuplicateMatchType | undefined;
        update(item.file, {
          phase: "duplicate",
          duplicateOfTitle: dup?.title || dup?.filename,
          duplicateMatchType: matchType,
        });
        return;
      }
      const msg =
        err?.response?.data?.detail ||
        (typeof err?.message === "string" ? err.message : "Error al subir el archivo");
      update(item.file, { phase: "failed", error: typeof msg === "string" ? msg : JSON.stringify(msg) });
    }
  };

  const onDrop = useCallback(
    (accepted: File[]) => {
      const newItems: UploadItem[] = accepted.map((f) => ({
        file: f,
        phase: "uploading",
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

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={cn(
          "relative group border-2 border-dashed rounded-xl px-6 py-6 text-center cursor-pointer transition-all overflow-hidden",
          isDragActive
            ? "border-primary bg-primary/5 scale-[1.01]"
            : "border-border hover:border-primary/50",
        )}
      >
        {/* Gradient sutil al hover, debajo del contenido */}
        <div
          className={cn(
            "absolute inset-0 -z-0 opacity-0 transition-opacity duration-300 pointer-events-none",
            "bg-gradient-to-br from-primary/[0.04] via-transparent to-primary/[0.06]",
            "group-hover:opacity-100",
            isDragActive && "opacity-100",
          )}
        />

        <input {...getInputProps()} />

        {/* Icono con halo */}
        <div className="relative inline-flex items-center justify-center mb-2.5">
          <div
            className={cn(
              "absolute inset-0 rounded-xl blur-xl transition-opacity",
              "bg-primary/30",
              isDragActive ? "opacity-60" : "opacity-0 group-hover:opacity-30",
            )}
          />
          <div
            className={cn(
              "relative w-11 h-11 rounded-xl flex items-center justify-center transition-colors",
              isDragActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary",
            )}
          >
            <Upload className="h-5 w-5" />
          </div>
        </div>

        <p className="text-sm font-semibold text-foreground">
          {isDragActive ? "Soltá los archivos acá" : "Arrastrá tus documentos"}
          <span className="font-normal text-muted-foreground"> · o hacé click</span>
        </p>

        {/* Chips de formatos + tamaño máx en una sola línea */}
        <div className="flex flex-wrap items-center justify-center gap-1.5 mt-2.5">
          {["PDF", "DOCX", "TXT", "HTML", "JSON"].map((fmt) => (
            <span
              key={fmt}
              className="inline-flex items-center px-2 py-0.5 rounded-md bg-muted text-[10px] font-mono font-medium text-muted-foreground border border-border/60"
            >
              {fmt}
            </span>
          ))}
          <span className="text-[11px] text-muted-foreground/80 ml-1">
            · máx. {MAX_SIZE_MB} MB
          </span>
        </div>
      </div>

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, idx) => (
            <UploadRow key={idx} item={item} onDismiss={() => remove(item.file)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── UploadRow ─────────────────────────────────────────────────────────────────

function UploadRow({ item, onDismiss }: { item: UploadItem; onDismiss: () => void }) {
  const sizeMB = (item.file.size / (1024 * 1024)).toFixed(1);
  const isUploading = item.phase === "uploading";
  const isFailed    = item.phase === "failed";
  const isDuplicate = item.phase === "duplicate";

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2 transition-colors",
        isFailed    && "border-destructive/40 bg-destructive/5",
        isDuplicate && "border-amber-300 bg-amber-50",
        isUploading && "border-primary/30 bg-primary/5",
      )}
    >
      <div className="flex items-center gap-3">
        <File className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{item.file.name}</p>
          <p className="text-xs text-muted-foreground">{sizeMB} MB</p>
        </div>
        {isUploading && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
        {isDuplicate && (
          <>
            <Info className="h-4 w-4 text-amber-600 shrink-0" />
            <button
              onClick={onDismiss}
              className="text-amber-700/70 hover:text-amber-900 transition-colors"
              aria-label="Descartar"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        )}
        {isFailed && (
          <>
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <button
              onClick={onDismiss}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Descartar"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

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

      {isDuplicate && (
        <p className="text-xs text-amber-900">
          {item.duplicateMatchType === "filename" ? (
            <>
              Ya existe un documento con este nombre
              {item.duplicateOfTitle && (
                <> (<span className="font-medium">"{item.duplicateOfTitle}"</span>)</>
              )}
              . Renombrá el archivo o eliminá el anterior antes de subir.
            </>
          ) : item.duplicateMatchType === "same_content" ? (
            <>
              Se detectó contenido duplicado: el texto coincide con
              {item.duplicateOfTitle && (
                <> <span className="font-medium">"{item.duplicateOfTitle}"</span></>
              )}
              {" "}aunque el archivo sea distinto. No se volvió a procesar.
            </>
          ) : (
            <>
              Este archivo ya estaba cargado{item.duplicateOfTitle ? ` como ` : "."}
              {item.duplicateOfTitle && (
                <span className="font-medium">"{item.duplicateOfTitle}"</span>
              )}
              {item.duplicateOfTitle && "."} No se volvió a procesar.
            </>
          )}
        </p>
      )}

      {isFailed && item.error && (
        <p className="text-xs text-destructive">{item.error}</p>
      )}
    </div>
  );
}
