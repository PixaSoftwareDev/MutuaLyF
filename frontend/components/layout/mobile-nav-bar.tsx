"use client";

import { Menu } from "lucide-react";
import Image from "next/image";
import { useUIStore } from "@/lib/store";
import { useTenantBranding } from "@/lib/use-tenant-branding";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
function fullLogoUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}

export function MobileNavBar() {
  const { openMobileSidebar } = useUIStore();
  const { branding } = useTenantBranding();
  const logoUrl = fullLogoUrl(branding.logo_url);

  return (
    // Identidad Intellix (superficie clara + marca), igual que el sidebar y el
    // topbar del operador. El color del tenant NO pinta el panel — el tenant
    // aparece como contexto a la derecha. Antes esta barra usaba
    // branding.primary_color de fondo y en mobile el admin se veía "rojo".
    <header className="relative flex h-14 shrink-0 items-center gap-2.5 border-b bg-card px-3 text-muted-foreground lg:hidden">
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

      {/* Marca Intellix — misma composición que el sidebar */}
      <div className="flex items-center gap-2 min-w-0">
        <Image
          src="/brand/intellix-mark.png"
          alt=""
          width={1400}
          height={1400}
          priority
          unoptimized
          className="h-6 w-6 object-contain shrink-0"
        />
        <Image
          src="/brand/intellix-wordmark.png"
          alt="Intellix"
          width={1518}
          height={174}
          priority
          unoptimized
          className="h-[12px] w-auto object-contain"
        />
      </div>

      <div className="flex-1" />

      {/* Contexto del tenant — logo + nombre, como en el pie del sidebar */}
      <div className="flex items-center gap-2 min-w-0">
        {/* Sin logo → gradient de marca, no el primary_color del tenant: el
            panel es identidad Intellix y el fallback (p.ej. super-admin sin
            tenant) se veía rojo. */}
        <div
          className={cn(
            "relative w-6 h-6 flex items-center justify-center shrink-0 rounded-md overflow-hidden ring-1 ring-border",
            !logoUrl && "bg-action-gradient",
          )}
        >
          {logoUrl ? (
            <Image
              src={logoUrl}
              alt={branding.display_name}
              width={24}
              height={24}
              className="w-full h-full object-contain"
              priority
              unoptimized
            />
          ) : (
            <span className="text-white font-bold text-[10px]">
              {(branding.display_name.trim()[0] ?? "?").toUpperCase()}
            </span>
          )}
        </div>
        <span className="text-[13px] font-medium text-foreground truncate max-w-[120px]">
          {branding.display_name}
        </span>
      </div>
    </header>
  );
}
