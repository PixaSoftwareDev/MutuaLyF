import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-sm px-4">
        <FileQuestion className="h-14 w-14 mx-auto text-muted-foreground opacity-50" />
        <h1 className="text-2xl font-bold">Página no encontrada</h1>
        <p className="text-muted-foreground text-sm">
          La página que buscás no existe o fue movida.
        </p>
        <Button asChild>
          <Link href="/admin/documents">Ir al inicio</Link>
        </Button>
      </div>
    </div>
  );
}
