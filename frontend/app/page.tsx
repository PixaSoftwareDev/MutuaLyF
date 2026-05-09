"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";

export default function RootPage() {
  const router = useRouter();
  const { isAuthenticated, userRole, _hasHydrated } = useAuthStore();

  useEffect(() => {
    if (!_hasHydrated) return;
    if (!isAuthenticated) {
      router.replace("/login");
      return;
    }
    if (userRole === "super_admin") router.replace("/superadmin");
    else if (userRole === "operator") router.replace("/operator");
    else router.replace("/admin/documents");
  }, [_hasHydrated, isAuthenticated, userRole, router]);

  return null;
}
