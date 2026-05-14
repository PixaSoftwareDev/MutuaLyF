"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Image from "next/image";
import {
  Inbox, FileText, Tags, Settings, LogOut, ChevronLeft, ChevronRight,
  Shield, Building2, GitMerge, Users, ExternalLink, FlaskConical, ClipboardList, Bot, Network,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore, useUIStore } from "@/lib/store";
import { api, apiClient } from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  badgeKey?: string;
  tooltip?: string;
};

// Flat groups — no section headers. Visual dividers separate them.
const navGroups: NavItem[][] = [
  // Trabajo diario
  [
    { href: "/admin/conversations", label: "Conversaciones", icon: Inbox, adminOnly: true },
  ],
  // Conocimiento
  [
    { href: "/admin/documents",  label: "Documentos", icon: FileText, adminOnly: true },
    { href: "/admin/intentions", label: "Temas reconocidos", icon: Tags, adminOnly: true,
      tooltip: "Categorías de consulta que el bot identifica. Validá las que aprendió." },
    { href: "/admin/entities",   label: "Entidades",  icon: Network, adminOnly: true,
      tooltip: "Personas, departamentos y más extraídos automáticamente de tus documentos." },
    { href: "/admin/duplicates", label: "Duplicados", icon: GitMerge, adminOnly: true,
      badgeKey: "duplicates-pending",
      tooltip: "Documentos parecidos que conviene unificar para evitar respuestas contradictorias." },
  ],
  // Equipo
  [
    { href: "/admin/sectors",   label: "Sectores",   icon: Building2, adminOnly: true },
    { href: "/admin/operators", label: "Operadores", icon: Users,     adminOnly: true },
  ],
  // Configuración + sistema
  [
    { href: "/admin/settings", label: "Configuración", icon: Settings, adminOnly: true,
      tooltip: "Personalidad, mensaje de saludo y comportamiento del asistente." },
    { href: "/admin/audit",    label: "Auditoría",     icon: ClipboardList, adminOnly: true,
      tooltip: "Registro de acciones críticas: logins, subidas, cambios de configuración." },
  ],
  // Plataforma (super admin)
  [
    { href: "/superadmin",         label: "Plataforma",     icon: Shield,        superAdminOnly: true,
      tooltip: "Administración cross-tenant: organizaciones, planes y cuotas." },
    { href: "/superadmin/prompts", label: "Bots / Prompts", icon: Bot,           superAdminOnly: true,
      tooltip: "Creá y asignás templates de prompt a los tenants." },
    { href: "/superadmin/audit",   label: "Auditoría",      icon: ClipboardList, superAdminOnly: true,
      tooltip: "Registro de actividad de todas las organizaciones." },
  ],
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userEmail, userRole, tenantId, clearAuth } = useAuthStore();
  const { sidebarOpen, toggleSidebar } = useUIStore();


  const isAdmin = userRole === "admin";
  const isSuperAdmin = userRole === "super_admin";

  const prefetchMap: Record<string, () => void> = {
    "/admin/conversations": () => queryClient.prefetchQuery({ queryKey: ["operator-conversations", "all", "admin-readonly"], queryFn: () => api.operator.listConversations(), staleTime: 4_000 }),
    "/admin/documents":     () => queryClient.prefetchQuery({ queryKey: ["documents"],   queryFn: api.documents.list,   staleTime: 10_000 }),
    "/admin/intentions":    () => queryClient.prefetchQuery({ queryKey: ["intentions"],  queryFn: api.intentions.list,  staleTime: 30_000 }),
    "/admin/duplicates":    () => queryClient.prefetchQuery({ queryKey: ["duplicates"],  queryFn: api.duplicates.list,  staleTime: 30_000 }),
    "/admin/entities":      () => queryClient.prefetchQuery({ queryKey: ["entity-stats"], queryFn: api.entities.stats,   staleTime: 60_000 }),
    "/admin/sectors":       () => queryClient.prefetchQuery({ queryKey: ["sectors"],     queryFn: api.sectors.list,     staleTime: 30_000 }),
    "/admin/operators":     () => queryClient.prefetchQuery({ queryKey: ["operators"],   queryFn: () => apiClient.get("/admin/operators").then(r => r.data), staleTime: 30_000 }),
    "/admin/settings":      () => tenantId && queryClient.prefetchQuery({ queryKey: ["bot-config", tenantId], queryFn: () => api.tenants.getBotConfig(tenantId), staleTime: 60_000 }),
  };

  const { data: duplicatesStats } = useQuery({
    queryKey: ["duplicates-stats"],
    queryFn: api.duplicates.stats,
    enabled: isAdmin,  // only for tenant admins
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const duplicatesPending: number = (duplicatesStats as any)?.pending ?? 0;

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  const handleOpenChatTester = async () => {
    if (!tenantId) return;
    try {
      const data = await api.tenants.generateWidgetToken(tenantId);
      const url = `/chat?token=${encodeURIComponent(data.widget_token)}&tenant=${encodeURIComponent(tenantId)}`;
      window.open(url, "_blank", "noopener");
    } catch {
      toast({ title: "No se pudo generar el link de prueba", variant: "destructive" });
    }
  };

  const isVisible = (item: NavItem) => {
    if (item.adminOnly && !isAdmin) return false;
    if (item.superAdminOnly && !isSuperAdmin) return false;
    return true;
  };

  return (
    <aside
      className={cn(
        "relative flex flex-col border-r border-white/10 bg-[#7A2731] text-white transition-all duration-200",
        sidebarOpen ? "w-56" : "w-14"
      )}
    >
      {/* Brand */}
      <div className={cn("flex items-center gap-3 h-16 px-4 border-b border-white/10 bg-[#5C1D24]", !sidebarOpen && "justify-center px-2")}>
        <div className="relative w-7 h-7 flex items-center justify-center shrink-0">
          <Image
            src="/Logo.png"
            alt="MutualBot"
            width={28}
            height={28}
            className="w-full h-full object-cover rounded-sm"
            priority
            unoptimized
          />
        </div>
        {sidebarOpen && (
          <span className="font-semibold text-sm tracking-tight text-white">MutualBot</span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-hidden px-3 pt-5 pb-3">
        {(() => {
          let visibleGroupCount = 0;
          return navGroups.map((group, groupIdx) => {
            const visibleItems = group.filter(isVisible);
            const showChatTester = groupIdx === 0 && isAdmin;
            if (visibleItems.length === 0 && !showChatTester) return null;
            const needsDivider = visibleGroupCount > 0;
            visibleGroupCount++;

            return (
            <React.Fragment key={groupIdx}>
              {needsDivider && <div className="h-px bg-white/10 my-3 mx-1" />}
              <div className="space-y-1">
                {showChatTester && (
                  <button
                    onClick={handleOpenChatTester}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-md px-2.5 py-2.5 text-sm font-medium transition-colors",
                      "text-white/75 hover:bg-white/10 hover:text-white",
                      !sidebarOpen && "justify-center px-2"
                    )}
                    title={!sidebarOpen ? "Probar chat (nueva pestaña)" : "Abre el widget en una pestaña nueva"}
                  >
                    <FlaskConical className="h-4 w-4 shrink-0" />
                    {sidebarOpen && (
                      <>
                        <span className="flex-1 text-left">Probar chat</span>
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                      </>
                    )}
                  </button>
                )}

                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href || pathname.startsWith(item.href + "/");
                  const pendingCount = item.badgeKey === "duplicates-pending" ? duplicatesPending : 0;
                  const titleAttr = !sidebarOpen ? item.label : item.tooltip;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onMouseEnter={() => prefetchMap[item.href]?.()}
                      onFocus={() => prefetchMap[item.href]?.()}
                      className={cn(
                        "relative flex items-center gap-3 rounded-md px-2.5 py-2.5 text-sm font-medium transition-colors",
                        active
                          ? "bg-white/15 text-white shadow-sm"
                          : "text-white/75 hover:bg-white/10 hover:text-white",
                        !sidebarOpen && "justify-center px-2"
                      )}
                      title={titleAttr}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {sidebarOpen && (
                        <>
                          <span className="flex-1">{item.label}</span>
                          {pendingCount > 0 && (
                            <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-[#7A2731]">
                              {pendingCount > 99 ? "99+" : pendingCount}
                            </span>
                          )}
                        </>
                      )}
                      {!sidebarOpen && pendingCount > 0 && (
                        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-white" />
                      )}
                    </Link>
                  );
                })}
              </div>
            </React.Fragment>
            );
          });
        })()}
      </nav>

      <div className="h-px bg-white/10" />

      {/* User + logout */}
      <div className={cn("p-3 space-y-2", !sidebarOpen && "flex flex-col items-center p-2")}>
        {sidebarOpen && (
          <div className="px-2.5 py-1">
            <p className="text-xs text-white/70 truncate" title={userRole || undefined}>{userEmail}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className={cn(
            "flex items-center gap-3 rounded-md px-2.5 py-2.5 text-sm text-white/75 hover:bg-white/10 hover:text-white w-full transition-colors",
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
        className="absolute -right-3 top-16 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-[#7A2731] text-white shadow-md hover:bg-[#99323D] transition-colors"
      >
        {sidebarOpen ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
    </aside>
  );
}
