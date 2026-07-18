"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { AppRail } from "@/components/layout/app-rail";
import { TopBar } from "@/components/layout/top-bar";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNavBar } from "@/components/layout/mobile-nav-bar";
import { ThemeApplier } from "@/components/layout/theme-applier";

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, userRole, _hasHydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!_hasHydrated) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (userRole !== "super_admin") { router.replace("/admin/documents"); }
  }, [isAuthenticated, userRole, _hasHydrated, router]);

  if (!_hasHydrated) return null;
  if (!isAuthenticated || userRole !== "super_admin") return null;

  return (
    // Misma estructura que el admin: lienzo gris + rail + contenedor blanco.
    <>
    <ThemeApplier />
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <AppRail />
        {/* Panel secundario sobre el lienzo, fuera del recuadro (referencia Text) */}
        <Sidebar />
        <div className="flex min-w-0 flex-1 lg:pb-2 lg:pr-2">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card lg:rounded-2xl lg:border lg:shadow-xs">
            <MobileNavBar />
            {/* overflow-y-auto: las páginas de flujo normal (Inicio, Organizaciones,
                Monitoreo, Auditoría) scrollean acá; las de scroll interno (detalle
                de tenant) ocupan h-full y no desbordan. */}
            <main className="flex-1 overflow-y-auto scrollbar-slim">{children}</main>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
