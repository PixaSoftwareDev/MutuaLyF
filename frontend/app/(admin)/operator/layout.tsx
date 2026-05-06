"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { Sidebar } from "@/components/layout/sidebar";

// Accesible para operator, admin y super_admin
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
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
