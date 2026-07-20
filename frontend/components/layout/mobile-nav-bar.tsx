"use client";

import { Menu } from "lucide-react";
import Image from "next/image";
import { useUIStore } from "@/lib/store";
import { useTenantBranding } from "@/lib/use-tenant-branding";

export function MobileNavBar() {
  const { openMobileSidebar } = useUIStore();
  const { branding } = useTenantBranding();

  return (
    // Identidad Intellix, mismo formato que el TopBar desktop y el topbar del
    // operador: SOLO la marca Intellix (el panel es identidad Intellix fija; el
    // logo del tenant va de cara al afiliado, no acá). El nombre del tenant queda
    // como contexto en texto, sin un segundo logo compitiendo.
    <header className="relative flex h-14 shrink-0 items-center gap-2.5 border-b bg-card px-3 lg:hidden">
      {/* Mesh de marca sutil — mismo lenguaje que sidebar/login/topbar operador */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 0% 0%, #22d3ee14 0%, transparent 55%)," +
            "radial-gradient(circle at 100% 0%, #7A2DFF14 0%, transparent 55%)",
        }}
      />

      <button
        onClick={openMobileSidebar}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Abrir menú"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Marca Intellix — mark siempre + wordmark desde 520px (igual que operador) */}
      <div className="relative flex min-w-0 items-center gap-2" aria-label="Intellix">
        <Image
          src="/brand/intellix-mark.png"
          alt=""
          width={1400}
          height={1400}
          priority
          unoptimized
          className="h-7 w-7 shrink-0 object-contain"
        />
        <Image
          src="/brand/intellix-wordmark.png"
          alt="Intellix"
          width={1518}
          height={174}
          priority
          unoptimized
          className="hidden h-[14px] w-auto object-contain min-[520px]:block"
        />
      </div>

      <div className="flex-1" />

      {/* Contexto del tenant — solo el nombre (sin logo), como etiqueta discreta */}
      <span className="relative max-w-[150px] truncate text-[13px] font-medium text-muted-foreground">
        {branding.display_name}
      </span>
    </header>
  );
}
