"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MessageSquare, FileText, Zap, Settings, LogOut, ChevronLeft, ChevronRight, Shield, Headphones, Building2, GitMerge, Users, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore, useUIStore } from "@/lib/store";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useQuery } from "@tanstack/react-query";

const navItems = [
  { href: "/dashboard",             label: "Consultas",       icon: MessageSquare },
  { href: "/operator",              label: "Panel Operador",  icon: Headphones, operatorOnly: true },
  { href: "/admin/documents",       label: "Documentos",      icon: FileText,   adminOnly: true },
  { href: "/admin/intentions",      label: "Intenciones",     icon: Zap,        adminOnly: true },
  { href: "/admin/duplicates",      label: "Duplicados",      icon: GitMerge,   adminOnly: true, badgeKey: "duplicates-pending" },
  { href: "/admin/sectors",         label: "Sectores",        icon: Building2,  adminOnly: true },
  { href: "/admin/operators",       label: "Operadores",      icon: Users,      adminOnly: true },
  { href: "/admin/handoff-config",  label: "Config. Handoff", icon: Copy,       adminOnly: true },
  { href: "/admin/settings",        label: "Configuración",   icon: Settings,   adminOnly: true },
  { href: "/superadmin",            label: "Super Admin",     icon: Shield,     superAdminOnly: true },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { userEmail, userRole, tenantId, clearAuth } = useAuthStore();
  const { sidebarOpen, toggleSidebar } = useUIStore();

  const isAdmin = ["admin", "super_admin"].includes(userRole ?? "");

  const { data: duplicatesStats } = useQuery({
    queryKey: ["duplicates-stats"],
    queryFn: api.duplicates.stats,
    enabled: isAdmin,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const duplicatesPending: number = (duplicatesStats as any)?.pending ?? 0;

  const handleLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // Ignore API errors on logout — clear local state regardless
    }
    clearAuth();
    router.push("/login");
  };

  return (
    <aside
      className={cn(
        "relative flex flex-col border-r bg-card transition-all duration-200",
        sidebarOpen ? "w-56" : "w-14"
      )}
    >
      {/* Logo */}
      <div className={cn("flex items-center gap-2 h-14 px-3 border-b", !sidebarOpen && "justify-center")}>
        <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-bold">IA</span>
        </div>
        {sidebarOpen && <span className="font-semibold text-sm truncate">IA Inteligent</span>}
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => {
          if (item.adminOnly && !isAdmin) return null;
          if ((item as any).superAdminOnly && userRole !== "super_admin") return null;
          if ((item as any).operatorOnly && !["operator","admin","super_admin"].includes(userRole ?? "")) return null;
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          const pendingCount = (item as any).badgeKey === "duplicates-pending" ? duplicatesPending : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                !sidebarOpen && "justify-center px-2"
              )}
              title={!sidebarOpen ? item.label : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {sidebarOpen && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {pendingCount > 0 && (
                    <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                      {pendingCount > 99 ? "99+" : pendingCount}
                    </span>
                  )}
                </>
              )}
              {!sidebarOpen && pendingCount > 0 && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive" />
              )}
            </Link>
          );
        })}
      </nav>

      <Separator />

      {/* User + logout */}
      <div className={cn("p-2 space-y-1", !sidebarOpen && "flex flex-col items-center")}>
        {sidebarOpen && (
          <div className="px-2 py-1">
            <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
            <p className="text-xs font-medium capitalize">{userRole}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className={cn(
            "flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground w-full transition-colors",
            !sidebarOpen && "justify-center"
          )}
          title="Cerrar sesión"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {sidebarOpen && <span>Cerrar sesión</span>}
        </button>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={toggleSidebar}
        className="absolute -right-3 top-16 z-10 flex h-6 w-6 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-accent"
      >
        {sidebarOpen ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
    </aside>
  );
}
