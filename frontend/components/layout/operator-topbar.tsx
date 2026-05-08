"use client";

import { useRouter } from "next/navigation";
import { LogOut, Headphones, Shield } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function OperatorTopbar() {
  const { userEmail, userRole, clearAuth } = useAuthStore();
  const router = useRouter();

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  const isAdmin = ["admin", "super_admin"].includes(userRole ?? "");

  return (
    <header className="h-12 border-b bg-card flex items-center px-4 gap-3 shrink-0">
      {/* Brand */}
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center shrink-0">
          <span className="text-white text-[10px] font-bold">IA</span>
        </div>
        <span className="font-semibold text-sm hidden sm:inline">IA Inteligent</span>
      </div>

      <div className="h-4 w-px bg-border mx-1" />

      {/* Current view */}
      <div className="flex items-center gap-1.5 text-sm font-medium text-primary">
        <Headphones className="h-4 w-4" />
        <span>Panel Operador</span>
      </div>

      <div className="flex-1" />

      {/* Admin back link */}
      {isAdmin && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1.5 text-muted-foreground"
          onClick={() => router.push("/admin/documents")}
        >
          <Shield className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Panel Admin</span>
        </Button>
      )}

      {/* User info + logout */}
      <div className="flex items-center gap-2">
        <div className="hidden sm:block text-right">
          <p className="text-xs text-muted-foreground leading-tight truncate max-w-36">{userEmail}</p>
          <p className="text-[10px] text-muted-foreground capitalize leading-tight">{userRole}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          title="Cerrar sesión"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
