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
function shade(hex: string, pct: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const num = parseInt(h, 16);
  let r = (num >> 16) + Math.round(2.55 * pct);
  let g = ((num >> 8) & 0xff) + Math.round(2.55 * pct);
  let b = (num & 0xff) + Math.round(2.55 * pct);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
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
    // Primer grupo sin label — atajo + tarea diaria principal del admin
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
      // ENTITIES_DISABLED: { href: "/admin/entities", label: "Entidades", icon: Network, adminOnly: true }
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
  const brandColorDark = shade(brandColor, -15);
  const brandLogoUrl   = fullLogoUrl(branding.logo_url);
  const brandName      = branding.display_name;

  const isAdmin = userRole === "admin";
  const isSuperAdmin = userRole === "super_admin";

  // On mobile the sidebar is always expanded (no icon-only mode)
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

  const handleNavClick = () => {
    // Close mobile drawer when navigating
    closeMobileSidebar();
  };

  // Shared label/icon visibility: on desktop respect collapsed state; on mobile always show labels
  // We use CSS to handle this: `hidden lg:inline` for labels when collapsed
  const showLabel = !collapsed;

  return (
    <>
      {/* Mobile backdrop */}
      {mobileSidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={closeMobileSidebar}
          aria-hidden="true"
        />
      )}

      <aside
        style={{ background: `linear-gradient(180deg, ${brandColor} 0%, ${brandColorDark} 100%)` }}
        className={cn(
          // Base
          "flex flex-col border-r border-black/10 text-brand-foreground",
          // Mobile: fixed overlay drawer
          "fixed inset-y-0 left-0 z-50 lg:static lg:z-auto",
          // Mobile visibility via transform
          "transition-transform duration-200 ease-in-out",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          // Width: mobile always full-width label sidebar; desktop respects collapsed
          collapsed ? "lg:w-14 w-64" : "w-64 lg:w-56",
        )}
      >
        {/* Brand */}
        <div
          style={{ background: brandColorDark }}
          className={cn(
            "flex items-center gap-3 h-16 px-4 border-b border-white/10 shrink-0",
            collapsed && "lg:justify-center lg:px-2"
          )}
        >
          <div className={cn(
            "relative w-7 h-7 flex items-center justify-center shrink-0",
            !brandLogoUrl && "rounded-sm overflow-hidden bg-white/10",
          )}>
            {brandLogoUrl ? (
              <Image
                src={brandLogoUrl}
                alt={brandName}
                width={28}
                height={28}
                className="w-full h-full object-contain"
                priority
                unoptimized
              />
            ) : (
              <span className="text-brand-foreground font-bold text-xs">
                {(brandName.trim()[0] ?? "?").toUpperCase()}
              </span>
            )}
          </div>
          <span className={cn(
            "font-semibold text-sm tracking-tight text-brand-foreground flex-1 truncate",
            collapsed && "lg:hidden"
          )}>
            {brandName}
          </span>
          {/* Close button — mobile only */}
          <button
            onClick={closeMobileSidebar}
            className="lg:hidden flex items-center justify-center w-7 h-7 rounded-md text-brand-foreground/70 hover:text-brand-foreground hover:bg-white/10 transition-colors"
            aria-label="Cerrar menú"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto scrollbar-hide px-3 pt-5 pb-3">
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
                  {/* Section label — solo si el grupo lo tiene Y no está colapsado */}
                  {group.label && !collapsed && (
                    <div className={cn(
                      "px-2.5 text-[10px] font-semibold uppercase tracking-wider text-brand-foreground/40",
                      isFirstVisible ? "mb-1.5" : "mt-5 mb-1.5"
                    )}>
                      {group.label}
                    </div>
                  )}
                  {/* Separador discreto cuando el grupo no tiene label pero hay un grupo arriba */}
                  {!group.label && !isFirstVisible && (
                    <div className="h-px bg-white/10 my-3 mx-1" />
                  )}
                  {/* Si está colapsado, igual quiero separar grupos visualmente */}
                  {collapsed && group.label && !isFirstVisible && (
                    <div className="h-px bg-white/10 my-3 mx-1 hidden lg:block" />
                  )}
                  <div className="space-y-1">
                    {showChatTester && (
                      <button
                        onClick={handleOpenChatTester}
                        className={cn(
                          "w-full flex items-center gap-3 rounded-md px-2.5 py-2.5 text-sm font-medium transition-colors",
                          "text-brand-foreground/75 hover:bg-white/10 hover:text-brand-foreground",
                          collapsed && "lg:justify-center lg:px-2"
                        )}
                        title={collapsed ? "Probar chat (nueva pestaña)" : "Abre el widget en una pestaña nueva"}
                      >
                        <FlaskConical className="h-4 w-4 shrink-0" />
                        <span className={cn("flex-1 text-left", collapsed && "lg:hidden")}>
                          Probar chat
                        </span>
                        <ExternalLink className={cn("h-3.5 w-3.5 opacity-60", collapsed && "lg:hidden")} />
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
                            "relative flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-all",
                            active
                              ? "bg-white/20 text-brand-foreground font-semibold shadow-sm before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-1 before:rounded-r-full before:bg-brand-foreground"
                              : "text-brand-foreground/70 hover:bg-white/10 hover:text-brand-foreground",
                            collapsed && "lg:justify-center lg:px-2"
                          )}
                          title={titleAttr}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className={cn("flex-1", collapsed && "lg:hidden")}>
                            {item.label}
                          </span>
                          {pendingCount > 0 && (
                            <span
                              style={{ color: brandColor }}
                              className={cn(
                                "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold",
                                collapsed ? "lg:absolute lg:right-1 lg:top-1 lg:h-2 lg:w-2 lg:rounded-full lg:bg-white lg:px-0" : "ml-auto"
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

        <div className="h-px bg-white/10 shrink-0" />

        {/* User + logout */}
        <div className={cn("p-3 space-y-2 shrink-0", collapsed && "lg:flex lg:flex-col lg:items-center lg:p-2 lg:space-y-2")}>
          <div className={cn("px-2.5 py-1", collapsed && "lg:hidden")}>
            <p className="text-xs text-brand-foreground/70 truncate" title={userRole || undefined}>{userEmail}</p>
          </div>
          {isAdmin && (
            <Link
              href="/admin/cuenta"
              onClick={handleNavClick}
              className={cn(
                "flex items-center gap-3 rounded-md px-2.5 py-2.5 text-sm w-full transition-colors",
                pathname === "/admin/cuenta"
                  ? "bg-white/15 text-brand-foreground shadow-sm"
                  : "text-brand-foreground/75 hover:bg-white/10 hover:text-brand-foreground",
                collapsed && "lg:justify-center"
              )}
              title="Mi cuenta"
            >
              <UserCog className="h-4 w-4 shrink-0" />
              <span className={cn(collapsed && "lg:hidden")}>Mi cuenta</span>
            </Link>
          )}
          <button
            onClick={handleLogout}
            className={cn(
              "flex items-center gap-3 rounded-md px-2.5 py-2.5 text-sm text-brand-foreground/75 hover:bg-white/10 hover:text-brand-foreground w-full transition-colors",
              collapsed && "lg:justify-center"
            )}
            title="Cerrar sesión"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && "lg:hidden")}>Cerrar sesión</span>
          </button>
        </div>

        {/* Collapse toggle — desktop only */}
        <button
          onClick={toggleSidebar}
          style={{ background: brandColor }}
          className="hidden lg:flex absolute -right-3 top-16 z-10 h-6 w-6 items-center justify-center rounded-full border border-white/20 text-brand-foreground shadow-md hover:brightness-110 transition-all"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      </aside>
    </>
  );
}
