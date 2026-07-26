"use client";

import Link from "next/link";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { Menu } from "lucide-react";
import { useUIStore } from "@/lib/store";
import { useTenantBranding } from "@/lib/use-tenant-branding";
import { api } from "@/lib/api";

export function OperatorTopbar() {
  const { openMobileSidebar } = useUIStore();

  // Inyecta el color del tenant (--brand) en el panel del operador, igual que
  // el Sidebar del admin. Sin esto, las burbujas del chat (bg-brand) caían al
  // azul por defecto de --brand, mientras el admin y el widget las ven verdes.
  // No cambia la identidad Intellix del shell (eso vive en --action).
  useTenantBranding();

  // Conversaciones en espera — punto de aviso en la hamburguesa. Misma query
  // key que el panel del operador: con la bandeja abierta comparten cache (cero
  // requests extra); en Historial este poll relajado mantiene la señal viva.
  const { data: convsData } = useQuery({
    queryKey: ["operator-conversations", "all", "operator"],
    queryFn: () => api.operator.listConversations(),
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const waitingCount = (convsData?.sectors ?? [])
    .flatMap((s: any) => s.conversations)
    .filter((c: any) => c.status === "handoff_requested").length;

  return (
    // Barra compacta del modo angosto (<1024px; en desktop el operador usa el
    // shell TopBar+rail, igual que el admin). Lenguaje actual: fondo plano,
    // SOLO el isologo (sin wordmark) y sin lavados de color — el mesh cyan y el
    // logo completo eran del diseño anterior.
    <header className="relative flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:gap-4 sm:px-5">
      {/* Izquierda: hamburguesa (abre el drawer vertical — mismo patrón que el
          admin) + isologo. La navegación vive en el drawer, no inline. */}
      <div className="relative flex items-center gap-2.5 min-w-0">
        <button
          onClick={openMobileSidebar}
          className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={waitingCount > 0 ? `Abrir menú — ${waitingCount} en espera` : "Abrir menú"}
          title={waitingCount > 0 ? `${waitingCount} en espera` : undefined}
        >
          <Menu className="h-5 w-5" />
          {/* Punto de aviso: hay conversaciones esperando y la nav está plegada */}
          {waitingCount > 0 && (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive shadow-sm" aria-hidden />
          )}
        </button>

        <Link href="/operator" className="flex items-center shrink-0" aria-label="Intellix">
          <Image
            src="/brand/intellix-mark.png"
            alt="Intellix"
            width={1400}
            height={1400}
            priority
            unoptimized
            className="h-7 w-7 object-contain shrink-0"
          />
        </Link>
      </div>

      <div className="flex-1" />
    </header>
  );
}
