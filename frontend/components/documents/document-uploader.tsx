"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, File, AlertCircle, Loader2, X, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { extractErrorMessage } from "@/lib/errors";
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
  /** Cuando phase=duplicate: id y titulo del doc ya existente. */
  duplicateOfId?: string;
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

export function DocumentUploader({ onUploaded, onDone }: { onUploaded?: () => void; onDone?: () => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);

  // Cuando la lista queda vacía después de haber tenido subidas (todas OK — los
  // duplicados/errores permanecen visibles), avisamos para que el contenedor
  // (p. ej. el modal de carga) se cierre solo. El estado posterior del documento
  // ("en cola → procesando → listo") lo muestra la tabla, no hace falta acá.
  const hadItems = useRef(false);
  useEffect(() => {
    if (items.length > 0) { hadItems.current = true; return; }
    if (hadItems.current) { hadItems.current = false; onDone?.(); }
  }, [items, onDone]);

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
          duplicateOfId: dup?.id,
          duplicateOfTitle: dup?.title || dup?.filename,
          duplicateMatchType: matchType,
        });
        return;
      }
      update(item.file, { phase: "failed", error: extractErrorMessage(err, "No se pudo subir el archivo.") });
    }
  };

  // Reemplazar el documento existente: borra el viejo y sube el nuevo. Lo decide
  // el admin explícitamente desde el aviso de duplicado (no se pisa nada solo).
  const replaceFile = async (item: UploadItem) => {
    if (!item.duplicateOfId) return;
    update(item.file, { phase: "uploading", uploadPct: 0 });
    try {
      await api.documents.delete(item.duplicateOfId);
      await api.documents.upload(item.file, (pct) => update(item.file, { uploadPct: pct }));
      remove(item.file);
      onUploaded?.();
    } catch (err: any) {
      update(item.file, {
        phase: "failed",
        error: extractErrorMessage(err, "No se pudo reemplazar el documento."),
      });
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
          "relative group border-2 border-dashed rounded-2xl px-6 py-8 text-center cursor-pointer transition-all overflow-hidden",
          isDragActive
            ? "border-action bg-action-gradient-soft scale-[1.01] shadow-sm"
            : "border-border hover:border-action/50 hover:shadow-xs",
        )}
      >
        {/* Mesh de marca sutil al hover/drag, debajo del contenido */}
        <div
          className={cn(
            "absolute inset-0 -z-0 opacity-0 transition-opacity duration-300 pointer-events-none bg-action-gradient-soft",
            "group-hover:opacity-100",
            isDragActive && "opacity-100",
          )}
        />

        <input {...getInputProps()} />

        {/* Icono con halo de marca */}
        <div className="relative inline-flex items-center justify-center mb-3">
          <div
            className={cn(
              "absolute inset-0 rounded-2xl blur-xl transition-opacity bg-action/30",
              isDragActive ? "opacity-70" : "opacity-0 group-hover:opacity-40",
            )}
          />
          <div
            className={cn(
              "relative w-12 h-12 rounded-2xl flex items-center justify-center transition-all shadow-xs",
              isDragActive
                ? "text-white scale-110"
                : "bg-card text-action ring-1 ring-action/15 group-hover:scale-105",
            )}
            style={isDragActive ? { backgroundImage: "linear-gradient(135deg, #4FC3F7 0%, #5B5BFF 50%, #7A2DFF 100%)" } : undefined}
          >
            <Upload className="h-5 w-5" />
          </div>
        </div>

        <p className="text-[15px] font-semibold text-foreground">
          {isDragActive ? "Soltá los archivos acá" : "Arrastrá tus documentos"}
          <span className="font-normal text-muted-foreground"> · o hacé click para elegir</span>
        </p>

        {/* Chips de formatos + tamaño máx en una sola línea */}
        <div className="flex flex-wrap items-center justify-center gap-1.5 mt-3">
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
            <UploadRow
              key={idx}
              item={item}
              onDismiss={() => remove(item.file)}
              onReplace={() => replaceFile(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── UploadRow ─────────────────────────────────────────────────────────────────

function UploadRow({ item, onDismiss, onReplace }: { item: UploadItem; onDismiss: () => void; onReplace: () => void }) {
  const sizeMB = (item.file.size / (1024 * 1024)).toFixed(1);
  const isUploading = item.phase === "uploading";
  const isFailed    = item.phase === "failed";
  const isDuplicate = item.phase === "duplicate";

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2 transition-colors",
        isFailed    && "border-destructive/40 bg-destructive/5",
        isDuplicate && "border-warning/20 bg-warning/10",
        isUploading && "border-action/30 bg-action/5",
      )}
    >
      <div className="flex items-center gap-3">
        <File className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{item.file.name}</p>
          <p className="text-xs text-muted-foreground">{sizeMB} MB</p>
        </div>
        {isUploading && <Loader2 className="h-4 w-4 animate-spin text-action shrink-0" />}
        {isDuplicate && (
          <>
            <Info className="h-4 w-4 text-warning shrink-0" />
            <button
              onClick={onDismiss}
              className="text-warning/70 hover:text-warning transition-colors"
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
              className="h-full bg-action-gradient rounded-full transition-all duration-200"
              style={{ width: `${item.uploadPct}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Subiendo… {item.uploadPct}%
          </p>
        </div>
      )}

      {isDuplicate && (
        <p className="text-xs text-warning">
          {item.duplicateMatchType === "filename" ? (
            <>
              Ya existe un documento con este nombre
              {item.duplicateOfTitle && (
                <> (<span className="font-medium">"{item.duplicateOfTitle}"</span>)</>
              )}
              . Podés reemplazar el anterior o renombrar el archivo nuevo.
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

      {isDuplicate && item.duplicateOfId && item.duplicateMatchType !== "exact_bytes" && (
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onReplace}>
          Reemplazar el anterior
        </Button>
      )}

      {isFailed && item.error && (
        <p className="text-xs text-destructive">{item.error}</p>
      )}
    </div>
  );
}
