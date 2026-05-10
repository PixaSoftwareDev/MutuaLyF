"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { Sidebar } from "@/components/layout/sidebar";

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
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
