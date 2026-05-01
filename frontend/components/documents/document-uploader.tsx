"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, X, File, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

type UploadState = "idle" | "uploading" | "success" | "error";

interface UploadItem {
  file: File;
  state: UploadState;
  error?: string;
  documentId?: string;
}

const ACCEPTED_TYPES = {
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/html": [".html"],
};

const MAX_SIZE_MB = 200;

export function DocumentUploader({ onUploaded }: { onUploaded?: () => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);

  const uploadFile = async (item: UploadItem) => {
    setItems((prev) => prev.map((i) => (i.file === item.file ? { ...i, state: "uploading" } : i)));
    try {
      const result = await api.documents.upload(item.file);
      setItems((prev) =>
        prev.map((i) =>
          i.file === item.file ? { ...i, state: "success", documentId: result.document_id } : i
        )
      );
      onUploaded?.();
    } catch (err: any) {
      const msg = err?.response?.data?.detail || "Error al subir el archivo";
      setItems((prev) =>
        prev.map((i) => (i.file === item.file ? { ...i, state: "error", error: msg } : i))
      );
    }
  };

  const onDrop = useCallback(
    (accepted: File[]) => {
      const newItems: UploadItem[] = accepted.map((f) => ({ file: f, state: "idle" as const }));
      setItems((prev) => [...prev, ...newItems]);
      newItems.forEach((item) => uploadFile(item));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_SIZE_MB * 1024 * 1024,
    multiple: true,
  });

  const clearDone = () => {
    setItems((prev) => prev.filter((i) => i.state === "uploading"));
  };

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={cn(
          "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors",
          isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-accent/30"
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
            <p className="text-sm font-medium">{items.length} archivo{items.length !== 1 ? "s" : ""}</p>
            <Button variant="ghost" size="sm" onClick={clearDone} className="text-xs">
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

function UploadRow({ item }: { item: UploadItem }) {
  const sizeMB = (item.file.size / (1024 * 1024)).toFixed(1);
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <File className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{item.file.name}</p>
        <p className="text-xs text-muted-foreground">{sizeMB} MB</p>
        {item.error && <p className="text-xs text-destructive mt-0.5">{item.error}</p>}
      </div>
      {item.state === "uploading" && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
      {item.state === "success" && <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />}
      {item.state === "error" && <AlertCircle className="h-4 w-4 text-destructive shrink-0" />}
    </div>
  );
}
