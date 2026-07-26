"use client";

import { Menu } from "lucide-react";
import Image from "next/image";
import { useUIStore } from "@/lib/store";
import { useTenantBranding } from "@/lib/use-tenant-branding";

export function MobileNavBar() {
  const { openMobileSidebar } = useUIStore();
  // Mantiene --brand del tenant inyectado (burbujas del chat, etc.); el nombre
  // ya no se muestra en la barra — la identidad del shell es solo Intellix.
  useTenantBranding();

  return (
    // Identidad Intellix, mismo formato que el TopBar desktop y el topbar del
    // operador: SOLO la marca Intellix (el panel es identidad Intellix fija; el
    // logo del tenant va de cara al afiliado, no acá). El nombre del tenant queda
    // como contexto en texto, sin un segundo logo compitiendo.
    // Lenguaje actual (igual que el shell desktop): fondo plano, SOLO el
    // isologo — el mesh cyan y el wordmark eran del diseño anterior.
    <header className="relative flex h-14 shrink-0 items-center gap-2.5 border-b bg-card px-3 lg:hidden">
      <button
        onClick={openMobileSidebar}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Abrir menú"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="relative flex min-w-0 items-center" aria-label="Intellix">
        <Image
          src="/brand/intellix-mark.png"
          alt="Intellix"
          width={1400}
          height={1400}
          priority
          unoptimized
          className="h-7 w-7 shrink-0 object-contain"
        />
      </div>

      <div className="flex-1" />
    </header>
  );
}
