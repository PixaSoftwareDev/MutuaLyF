"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNavBar } from "@/components/layout/mobile-nav-bar";

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
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <MobileNavBar />
        {/* overflow-y-auto: las páginas de flujo normal (Inicio, Organizaciones,
            Monitoreo, Auditoría) scrollean acá; las de scroll interno (detalle
            de tenant) ocupan h-full y no desbordan. */}
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
