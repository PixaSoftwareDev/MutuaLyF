"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, userRole } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (userRole !== "super_admin") { router.replace("/dashboard"); }
  }, [isAuthenticated, userRole, router]);

  if (!isAuthenticated || userRole !== "super_admin") return null;
  return <>{children}</>;
}
