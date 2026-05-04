"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-sm px-4">
        <AlertTriangle className="h-14 w-14 mx-auto text-destructive opacity-70" />
        <h1 className="text-2xl font-bold">Algo salió mal</h1>
        <p className="text-muted-foreground text-sm">
          Ocurrió un error inesperado. Podés intentar recargar la página.
        </p>
        <Button onClick={reset}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Reintentar
        </Button>
      </div>
    </div>
  );
}
