"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { OperatorTopbar } from "@/components/layout/operator-topbar";

const ALLOWED_ROLES = ["operator", "admin", "super_admin"];

export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, userRole } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (!ALLOWED_ROLES.includes(userRole ?? "")) { router.replace("/dashboard"); }
  }, [isAuthenticated, userRole, router]);

  if (!isAuthenticated || !ALLOWED_ROLES.includes(userRole ?? "")) return null;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <OperatorTopbar />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
