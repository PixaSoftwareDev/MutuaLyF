"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

/**
 * Botón "Exportar KB" + modal con opciones.
 *
 * El export es JSON portable, descargable directo. Incluye:
 *   - tenant config (bot_name, bot_description, branding)
 *   - sectores
 *   - documentos con sus parent_chunks (texto)
 *   - intenciones aprendidas + ejemplos
 *   - opcional: conversaciones (datos de usuarios)
 *   - opcional: embeddings (vectores ~10x size)
 *
 * No incluye los archivos binarios originales (PDF/DOCX) — esos se bajan
 * uno por uno desde el menú "Descargar original" de cada documento.
 */
export function ExportKbButton() {
  const [open, setOpen] = useState(false);
  const [includeConversations, setIncludeConversations] = useState(false);
  const [includeEmbeddings, setIncludeEmbeddings] = useState(false);

  const exportM = useMutation({
    mutationFn: () =>
      api.documents.exportJson({
        includeConversations,
        includeEmbeddings,
      }),
    onSuccess: ({ blob, filename }) => {
      // Trigger download del browser
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Export descargado",
        description: filename,
        variant: "success",
      });
      setOpen(false);
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo exportar la KB.";
      toast({
        title: "Error al exportar",
        description: typeof detail === "string" ? detail : "Intentá de nuevo.",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !exportM.isPending && setOpen(v)}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="h-4 w-4 mr-1.5" />
          Exportar KB
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Exportar base de conocimiento</DialogTitle>
          <DialogDescription>
            Descarga un archivo JSON con todo el contenido del bot:
            configuración, sectores, documentos con su texto y las
            intenciones que aprendió.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <label className="flex items-start gap-3 cursor-pointer rounded-md border p-3 hover:bg-muted/40 transition-colors">
            <input
              type="checkbox"
              checked={includeConversations}
              onChange={(e) => setIncludeConversations(e.target.checked)}
              disabled={exportM.isPending}
              className="mt-0.5 h-4 w-4"
            />
            <div className="flex-1 text-sm">
              <div className="font-medium">Incluir conversaciones</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Historial de chats con usuarios. Contiene datos personales —
                manejar con cuidado.
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer rounded-md border p-3 hover:bg-muted/40 transition-colors">
            <input
              type="checkbox"
              checked={includeEmbeddings}
              onChange={(e) => setIncludeEmbeddings(e.target.checked)}
              disabled={exportM.isPending}
              className="mt-0.5 h-4 w-4"
            />
            <div className="flex-1 text-sm">
              <div className="font-medium">Incluir embeddings</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Vectores numéricos de cada chunk. Hace el archivo ~10x más
                grande. Útil solo para backup completo o portar a otro motor.
              </div>
            </div>
          </label>

          <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
            Los archivos originales (PDF/DOCX) no se incluyen — bajalos uno por
            uno desde el menú de cada documento si los necesitás.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={exportM.isPending}
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={() => exportM.mutate()}
            disabled={exportM.isPending}
          >
            {exportM.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Generando…
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-1.5" />
                Descargar JSON
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
