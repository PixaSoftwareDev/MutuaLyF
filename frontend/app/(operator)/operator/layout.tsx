"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
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
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <OperatorTopbar />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
