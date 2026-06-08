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
    <header
      style={{ background: branding.primary_color }}
      className="lg:hidden flex items-center gap-3 h-14 px-4 border-b text-brand-foreground shrink-0"
    >
      <button
        onClick={openMobileSidebar}
        className="flex items-center justify-center w-8 h-8 rounded-md text-brand-foreground/80 hover:text-brand-foreground hover:bg-white/10 transition-colors"
        aria-label="Abrir menú"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="flex items-center gap-2">
        <div className={cn(
          "relative w-6 h-6 flex items-center justify-center shrink-0",
          !logoUrl && "rounded-sm overflow-hidden bg-white/10",
        )}>
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
            <span className="text-brand-foreground font-bold text-[10px]">
              {(branding.display_name.trim()[0] ?? "?").toUpperCase()}
            </span>
          )}
        </div>
        <span className="font-semibold text-sm tracking-tight truncate">{branding.display_name}</span>
      </div>
    </header>
  );
}
