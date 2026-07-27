"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { ThemeApplier } from "@/components/layout/theme-applier";
import { TopBar } from "@/components/layout/top-bar";
import { AppRail } from "@/components/layout/app-rail";
import { OperatorSidebar } from "@/components/layout/operator-sidebar";
import { OperatorTopbar } from "@/components/layout/operator-topbar";

const ALLOWED_ROLES = ["operator"];

export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, userRole, _hasHydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!_hasHydrated) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (!ALLOWED_ROLES.includes(userRole ?? "")) { router.replace("/admin/documents"); }
  }, [isAuthenticated, userRole, _hasHydrated, router]);

  if (!_hasHydrated) return null;
  if (!isAuthenticated || !ALLOWED_ROLES.includes(userRole ?? "")) return null;

  return (
    // Misma estructura que el admin (reutiliza TopBar + AppRail): lienzo gris +
    // buscador arriba + rail de íconos (Bandeja/Historial + config + cuenta con
    // dark/light) + recuadro blanco redondeado. En mobile: topbar horizontal.
    <>
      <ThemeApplier />
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas">
        {/* Desktop: buscador Ctrl+K */}
        <TopBar />
        {/* Mobile: topbar horizontal con tabs + cuenta */}
        <div className="lg:hidden">
          <OperatorTopbar />
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Zona de navegación: rail + submenú. group/nav permite que el submenú
              sin fijar se despliegue al pasar el mouse por acá (rail o panel),
              igual que el admin. */}
          <div className="group/nav relative flex">
            <AppRail />
            <OperatorSidebar />
          </div>

          {/* Contenido en el recuadro blanco redondeado */}
          <div className="flex min-w-0 flex-1 lg:pb-2 lg:pr-2">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card lg:rounded-2xl lg:border lg:shadow-xs">
              <main className="flex-1 overflow-y-auto scrollbar-slim">{children}</main>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
