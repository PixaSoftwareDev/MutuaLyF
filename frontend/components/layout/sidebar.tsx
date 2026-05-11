"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Inbox, FileText, Sparkles, Settings, LogOut, ChevronLeft, ChevronRight,
  Shield, Building2, GitMerge, Users, ExternalLink, FlaskConical, ClipboardList, Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore, useUIStore } from "@/lib/store";
import { api, apiClient } from "@/lib/api";
import { Separator } from "@/components/ui/separator";
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

type NavSection = {
  label: string;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    label: "Trabajo diario",
    items: [
      { href: "/admin/conversations", label: "Conversaciones", icon: Inbox, adminOnly: true },
    ],
  },
  {
    label: "Conocimiento",
    items: [
      { href: "/admin/documents",  label: "Documentos",            icon: FileText, adminOnly: true },
      { href: "/admin/intentions", label: "Temas reconocidos",     icon: Sparkles, adminOnly: true,
        tooltip: "Categorías de consulta que el bot identifica. Validá las que aprendió." },
      { href: "/admin/duplicates", label: "Documentos duplicados", icon: GitMerge, adminOnly: true,
        badgeKey: "duplicates-pending",
        tooltip: "Documentos parecidos que conviene unificar para evitar respuestas contradictorias." },
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
    label: "Configuración",
    items: [
      { href: "/admin/settings", label: "Configuración del bot", icon: Settings, adminOnly: true,
        tooltip: "Personalidad, mensaje de saludo y comportamiento del asistente." },
    ],
  },
  {
    label: "Sistema",
    items: [
      { href: "/admin/audit", label: "Auditoría", icon: ClipboardList, adminOnly: true,
        tooltip: "Registro de acciones críticas: logins, subidas, cambios de configuración." },
    ],
  },
  {
    label: "Plataforma",
    items: [
      { href: "/superadmin",         label: "Plataforma",       icon: Shield,        superAdminOnly: true,
        tooltip: "Administración cross-tenant: organizaciones, planes y cuotas." },
      { href: "/superadmin/prompts", label: "Bots / Prompts",   icon: Bot,           superAdminOnly: true,
        tooltip: "Creá y asignás templates de prompt a los tenants." },
      { href: "/superadmin/audit",   label: "Auditoría global", icon: ClipboardList, superAdminOnly: true,
        tooltip: "Registro de actividad de todas las organizaciones." },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userEmail, userRole, tenantId, clearAuth } = useAuthStore();
  const { sidebarOpen, toggleSidebar } = useUIStore();

  // All sections open by default; persists in component state
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const toggleSection = (label: string) =>
    setCollapsed(prev => ({ ...prev, [label]: !prev[label] }));

  const isAdmin = userRole === "admin";
  const isSuperAdmin = userRole === "super_admin";

  const prefetchMap: Record<string, () => void> = {
    "/admin/conversations": () => queryClient.prefetchQuery({ queryKey: ["operator-conversations", "all", "admin-readonly"], queryFn: () => api.operator.listConversations(), staleTime: 4_000 }),
    "/admin/documents":     () => queryClient.prefetchQuery({ queryKey: ["documents"],   queryFn: api.documents.list,   staleTime: 10_000 }),
    "/admin/intentions":    () => queryClient.prefetchQuery({ queryKey: ["intentions"],  queryFn: api.intentions.list,  staleTime: 30_000 }),
    "/admin/duplicates":    () => queryClient.prefetchQuery({ queryKey: ["duplicates"],  queryFn: api.duplicates.list,  staleTime: 30_000 }),
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
      <nav className="flex-1 overflow-y-auto p-2 space-y-3">
        {navSections.map((section, idx) => {
          const visibleItems = section.items.filter(isVisible);
          const showChatTester = section.label === "Trabajo diario" && isAdmin;
          if (visibleItems.length === 0 && !showChatTester) return null;

          const isSectionCollapsed = !!collapsed[section.label];
          // If any item in section is active, force-open even if collapsed
          const hasActive = visibleItems.some(
            item => pathname === item.href || pathname.startsWith(item.href + "/")
          );
          const isOpen = !isSectionCollapsed || hasActive;

          return (
            <div key={section.label}>
              {/* Section header */}
              {sidebarOpen ? (
                <div className="flex items-center justify-between px-2 mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {section.label}
                  </span>
                  <button
                    onClick={() => toggleSection(section.label)}
                    className="rounded p-0.5 hover:bg-accent transition-colors"
                    title={isOpen ? "Colapsar" : "Expandir"}
                  >
                    <ChevronRight className={cn(
                      "h-3 w-3 text-muted-foreground/40 hover:text-muted-foreground transition-all duration-200",
                      isOpen && "rotate-90"
                    )} />
                  </button>
                </div>
              ) : (
                idx > 0 && <div className="border-t border-border/40 my-1.5 mx-1" />
              )}

              {/* Items — hidden when collapsed (only in expanded sidebar mode) */}
              {(isOpen || !sidebarOpen) && (
                <div className="space-y-1">
                  {showChatTester && (
                    <button
                      onClick={handleOpenChatTester}
                      className={cn(
                        "w-full flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                        "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
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
                          "relative flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                          active
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                          !sidebarOpen && "justify-center px-2"
                        )}
                        title={titleAttr}
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
                </div>
              )}
            </div>
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
