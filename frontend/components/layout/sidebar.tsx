"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Image from "next/image";
import {
  Inbox, FileText, Tags, Settings, LogOut, ChevronLeft, ChevronRight,
  Shield, Building2, GitMerge, Users, ExternalLink, FlaskConical, ClipboardList, Bot, Network, X, Palette, UserCog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore, useUIStore } from "@/lib/store";
import { api, apiClient } from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { useTenantBranding } from "@/lib/use-tenant-branding";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
function fullLogoUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  badgeKey?: string;
  tooltip?: string;
};

type NavGroup = {
  label?: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    items: [
      { href: "/admin/conversations", label: "Conversaciones", icon: Inbox, adminOnly: true },
    ],
  },
  {
    label: "Conocimiento",
    items: [
      { href: "/admin/documents",  label: "Documentos", icon: FileText, adminOnly: true },
      { href: "/admin/duplicates", label: "Duplicados", icon: GitMerge, adminOnly: true,
        badgeKey: "duplicates-pending",
        tooltip: "Documentos parecidos que conviene unificar para evitar respuestas contradictorias." },
      { href: "/admin/intentions", label: "Temas reconocidos", icon: Tags, adminOnly: true,
        tooltip: "Categorías de consulta que el bot identifica. Validá las que aprendió." },
    ],
  },
  {
    label: "Equipo",
    items: [
      { href: "/admin/sectors",   label: "Sectores",   icon: Building2, adminOnly: true },
      { href: "/admin/operators", label: "Operadores", icon: Users,     adminOnly: true },
    ],
  },
  {
    label: "Sistema",
    items: [
      { href: "/admin/settings", label: "Configuración", icon: Settings, adminOnly: true,
        tooltip: "Personalidad, mensaje de saludo y comportamiento del asistente." },
      { href: "/admin/branding", label: "Branding",      icon: Palette, adminOnly: true,
        tooltip: "Personalizá el nombre, color y logo de tu organización." },
      { href: "/admin/audit",    label: "Auditoría",     icon: ClipboardList, adminOnly: true,
        tooltip: "Registro de acciones críticas: logins, subidas, cambios de configuración." },
    ],
  },
  {
    label: "Plataforma",
    items: [
      { href: "/superadmin",         label: "Resumen",        icon: Shield,        superAdminOnly: true,
        tooltip: "Administración cross-tenant: organizaciones, planes y cuotas." },
      { href: "/superadmin/prompts", label: "Bots / Prompts", icon: Bot,           superAdminOnly: true,
        tooltip: "Creá y asignás templates de prompt a los tenants." },
      { href: "/superadmin/audit",   label: "Auditoría",      icon: ClipboardList, superAdminOnly: true,
        tooltip: "Registro de actividad de todas las organizaciones." },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userEmail, userRole, tenantId, clearAuth } = useAuthStore();
  const { sidebarOpen, toggleSidebar, mobileSidebarOpen, closeMobileSidebar } = useUIStore();
  const { branding } = useTenantBranding();
  const brandColor     = branding.primary_color;
  const brandLogoUrl   = fullLogoUrl(branding.logo_url);
  const brandName      = branding.display_name;

  const isAdmin = userRole === "admin";
  const isSuperAdmin = userRole === "super_admin";

  const collapsed = sidebarOpen === false;

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
    enabled: isAdmin,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const duplicatesPending: number = (duplicatesStats as any)?.pending ?? 0;

  const handleLogout = async () => {
    closeMobileSidebar();
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  const handleOpenChatTester = async () => {
    if (!tenantId) return;
    try {
      const data = await api.tenants.generateWidgetToken(tenantId);
      const url = `/chat?token=${encodeURIComponent(data.widget_token)}&tenant=${encodeURIComponent(tenantId)}&test=1`;
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

  const handleNavClick = () => closeMobileSidebar();

  return (
    <>
      {/* Mobile backdrop */}
      {mobileSidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={closeMobileSidebar}
          aria-hidden="true"
        />
      )}

      {/* Shell oscuro premium (Linear/Vercel). El color de marca del tenant vive
          como ACENTO (logo, barra activa), no como bloque sólido de fondo. */}
      <aside
        className={cn(
          "flex flex-col border-r border-white/[0.06] bg-[#1c1815] text-slate-300",
          "fixed inset-y-0 left-0 z-50 lg:static lg:z-auto",
          "transition-transform duration-200 ease-in-out",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          collapsed ? "lg:w-[64px] w-64" : "w-64 lg:w-60",
        )}
      >
        {/* Brand */}
        <div className={cn(
          "flex items-center gap-2.5 h-16 px-4 border-b border-white/[0.06] shrink-0",
          collapsed && "lg:justify-center lg:px-2"
        )}>
          <div
            className="relative w-8 h-8 flex items-center justify-center shrink-0 rounded-lg overflow-hidden ring-1 ring-white/10"
            style={!brandLogoUrl ? { background: brandColor } : undefined}
          >
            {brandLogoUrl ? (
              <Image src={brandLogoUrl} alt={brandName} width={32} height={32} className="w-full h-full object-contain" priority unoptimized />
            ) : (
              <span className="text-white font-bold text-sm">
                {(brandName.trim()[0] ?? "?").toUpperCase()}
              </span>
            )}
          </div>
          <span className={cn(
            "font-semibold text-[15px] tracking-tight text-white flex-1 truncate",
            collapsed && "lg:hidden"
          )}>
            {brandName}
          </span>
          <button
            onClick={closeMobileSidebar}
            className="lg:hidden flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Cerrar menú"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto scrollbar-hide px-3 pt-4 pb-3">
          {(() => {
            let visibleGroupCount = 0;
            return navGroups.map((group, groupIdx) => {
              const visibleItems = group.items.filter(isVisible);
              const showChatTester = groupIdx === 0 && isAdmin;
              if (visibleItems.length === 0 && !showChatTester) return null;
              const isFirstVisible = visibleGroupCount === 0;
              visibleGroupCount++;

              return (
                <React.Fragment key={groupIdx}>
                  {group.label && !collapsed && (
                    <div className={cn(
                      "px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500",
                      isFirstVisible ? "mb-1.5" : "mt-6 mb-1.5"
                    )}>
                      {group.label}
                    </div>
                  )}
                  {!group.label && !isFirstVisible && (
                    <div className="h-px bg-white/[0.06] my-3 mx-1" />
                  )}
                  {collapsed && group.label && !isFirstVisible && (
                    <div className="h-px bg-white/[0.06] my-3 mx-1 hidden lg:block" />
                  )}
                  <div className="space-y-0.5">
                    {showChatTester && (
                      <button
                        onClick={handleOpenChatTester}
                        className={cn(
                          "w-full flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                          "text-slate-400 hover:bg-white/5 hover:text-white",
                          collapsed && "lg:justify-center lg:px-2"
                        )}
                        title={collapsed ? "Probar chat (nueva pestaña)" : "Abre el widget en una pestaña nueva"}
                      >
                        <FlaskConical className="h-[18px] w-[18px] shrink-0" />
                        <span className={cn("flex-1 text-left", collapsed && "lg:hidden")}>Probar chat</span>
                        <ExternalLink className={cn("h-3.5 w-3.5 opacity-50", collapsed && "lg:hidden")} />
                      </button>
                    )}

                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const active = pathname === item.href || pathname.startsWith(item.href + "/");
                      const pendingCount = item.badgeKey === "duplicates-pending" ? duplicatesPending : 0;
                      const titleAttr = collapsed ? item.label : item.tooltip;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={handleNavClick}
                          onMouseEnter={() => prefetchMap[item.href]?.()}
                          onFocus={() => prefetchMap[item.href]?.()}
                          className={cn(
                            "relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                            active
                              ? "bg-white/[0.08] text-white"
                              : "text-slate-400 hover:bg-white/5 hover:text-white",
                            collapsed && "lg:justify-center lg:px-2"
                          )}
                          title={titleAttr}
                        >
                          {/* Barra de acento = color de marca del tenant */}
                          {active && (
                            <span
                              style={{ background: brandColor }}
                              className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full"
                            />
                          )}
                          <Icon className="h-[18px] w-[18px] shrink-0" />
                          <span className={cn("flex-1", collapsed && "lg:hidden")}>{item.label}</span>
                          {pendingCount > 0 && (
                            <span
                              style={{ background: brandColor }}
                              className={cn(
                                "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white",
                                collapsed ? "lg:absolute lg:right-1 lg:top-1 lg:h-2 lg:w-2 lg:min-w-0 lg:rounded-full lg:px-0" : "ml-auto"
                              )}>
                              <span className={cn(collapsed && "lg:hidden")}>
                                {pendingCount > 99 ? "99+" : pendingCount}
                              </span>
                            </span>
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

        <div className="h-px bg-white/[0.06] shrink-0" />

        {/* User + logout */}
        <div className={cn("p-3 space-y-1 shrink-0", collapsed && "lg:flex lg:flex-col lg:items-center lg:p-2 lg:space-y-1")}>
          <div className={cn("px-2.5 py-1", collapsed && "lg:hidden")}>
            <p className="text-xs text-slate-500 truncate" title={userRole || undefined}>{userEmail}</p>
          </div>
          {isAdmin && (
            <Link
              href="/admin/cuenta"
              onClick={handleNavClick}
              className={cn(
                "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm w-full transition-colors",
                pathname === "/admin/cuenta"
                  ? "bg-white/[0.08] text-white"
                  : "text-slate-400 hover:bg-white/5 hover:text-white",
                collapsed && "lg:justify-center"
              )}
              title="Mi cuenta"
            >
              <UserCog className="h-[18px] w-[18px] shrink-0" />
              <span className={cn(collapsed && "lg:hidden")}>Mi cuenta</span>
            </Link>
          )}
          <button
            onClick={handleLogout}
            className={cn(
              "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-slate-400 hover:bg-white/5 hover:text-white w-full transition-colors",
              collapsed && "lg:justify-center"
            )}
            title="Cerrar sesión"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" />
            <span className={cn(collapsed && "lg:hidden")}>Cerrar sesión</span>
          </button>
        </div>

        {/* Collapse toggle — desktop only */}
        <button
          onClick={toggleSidebar}
          className="hidden lg:flex absolute -right-3 top-16 z-10 h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-[#1c1815] text-slate-300 shadow-md hover:text-white hover:border-white/20 transition-all"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      </aside>
    </>
  );
}
