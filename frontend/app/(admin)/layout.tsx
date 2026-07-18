import { AdminGuard } from "@/components/auth-guard";
import { AppRail } from "@/components/layout/app-rail";
import { TopBar } from "@/components/layout/top-bar";
import { ThemeApplier } from "@/components/layout/theme-applier";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNavBar } from "@/components/layout/mobile-nav-bar";
import { OnboardingGate } from "@/components/admin/onboarding-gate";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminGuard>
      {/* Estructura de referencia (Text App): lienzo gris + rail de íconos +
          contenedor blanco redondeado donde vive TODO (nav secundaria + página).
          En mobile: sin rail ni redondeo, el Sidebar es el drawer de siempre. */}
      <ThemeApplier />
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <AppRail />
          {/* El panel secundario vive SOBRE el lienzo (fuera del recuadro),
              como en la referencia; el recuadro blanco es solo del contenido. */}
          <Sidebar />
          <div className="flex min-w-0 flex-1 lg:pb-2 lg:pr-2">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card lg:rounded-2xl lg:border lg:shadow-xs">
              <MobileNavBar />
              <main className="flex-1 overflow-auto scrollbar-slim">{children}</main>
            </div>
          </div>
        </div>
      </div>
      <OnboardingGate />
    </AdminGuard>
  );
}
