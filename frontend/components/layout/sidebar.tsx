"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Image from "next/image";
import {
  Inbox, FileText, Tags, Settings, LogOut, PanelLeftClose,
  Shield, Building2, GitMerge, Users, ExternalLink, BotMessageSquare, ClipboardList, Bot, Network, X, ChevronRight,
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
        tooltip: "Identidad, apariencia y comportamiento del asistente, y reglas de derivación." },
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

  // El colapso se rehidrata desde localStorage sincrónicamente, antes del primer
  // render del cliente. Eso provoca que el ancho salte de expandido (HTML del
  // server, sin localStorage) a colapsado al hidratar. Suprimimos la transición
  // hasta el primer effect: así ese ajuste inicial es instantáneo, no un slide.
  const [animReady, setAnimReady] = React.useState(false);
  React.useEffect(() => { setAnimReady(true); }, []);
  const { branding } = useTenantBranding();
  const brandLogoUrl   = fullLogoUrl(branding.logo_url);
  const brandName      = branding.display_name;

  const isAdmin = userRole === "admin";
  const isSuperAdmin = userRole === "super_admin";

  // Identidad del USUARIO logueado (distinta del tenant). El email completo es
  // largo para 248px → mostramos la parte previa al @ + el rol; el email entero
  // queda en el tooltip del avatar y en /admin/cuenta.
  const userInitial = (userEmail?.trim()[0] ?? "?").toUpperCase();
  const userName    = userEmail ? userEmail.split("@")[0] : "Usuario";
  const roleLabel   = userRole === "admin"       ? "Administrador"
                    : userRole === "super_admin" ? "Super Admin"
                    : userRole === "operator"    ? "Operador"
                    : "";

  const collapsed = sidebarOpen === false;

  // Anillo de foco consistente para teclado. El offset usa el color del shell
  // del sidebar (entre #f6f7fe y #ecedfa) para que el ring no "flote" sobre
  // blanco. Se aplica a TODOS los interactivos del navbar.
  const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#eef0fb]";

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
          className="lg:hidden fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm"
          onClick={closeMobileSidebar}
          aria-hidden="true"
        />
      )}

      {/* Shell CLARO, coherente con el login (mismo mesh de marca cyan/índigo/
          violeta sobre fondo claro). El panel ES el producto Intellix: la marca
          de la cabecera y el acento activo son de Intellix; el tenant aparece
          como contexto (logo + nombre) en el pie. */}
      <aside
        className={cn(
          "flex flex-col border-r border-slate-200 text-slate-600",
          "fixed inset-y-0 left-0 z-50 lg:static lg:z-auto",
          // Transición tranquila de ancho + slide. Easing suave (ease-out-quint).
          // Transición activa solo después del primer effect (ver animReady):
          // evita animar el ajuste de ancho inicial post-hidratación.
          animReady
            ? "transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            : "lg:transition-none",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          collapsed ? "lg:w-[68px] w-64" : "w-64 lg:w-[248px]",
        )}
        style={{
          // Superficie clara con tinte de marca (índigo) leve. Un gradiente
          // vertical muy sutil le da profundidad (más claro arriba, junto al
          // header con mesh; un punto más saturado abajo) sin manchones, y lo
          // distingue del contenido (cards blancas) como verdadero chrome.
          background: "linear-gradient(180deg, #eef1fb 0%, #e4e7f5 100%)",
          boxShadow: "1px 0 0 0 rgb(16 24 40 / 0.02), 4px 0 24px -12px rgb(16 24 40 / 0.06)",
        }}
      >
        {/* Brand Intellix + control de colapso integrado en el header. */}
        <div className={cn(
          "relative flex items-center gap-2.5 h-16 px-4 border-b border-slate-200/80 shrink-0 overflow-hidden",
          collapsed && "lg:px-2"
        )}>
          {/* Mesh de marca sutil — el mismo lenguaje del login (cyan/violeta en
              las esquinas superiores). Conecta el panel con la identidad Intellix
              sin invadir el resto del navbar. */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(circle at 0% 0%, #4FC3F726 0%, transparent 62%)," +
                "radial-gradient(circle at 100% 0%, #7A2DFF20 0%, transparent 60%)",
            }}
          />
          {/* Wordmark (expandido) — link al dashboard */}
          <Link
            href={isSuperAdmin ? "/superadmin" : "/admin/documents"}
            onClick={handleNavClick}
            aria-label="Intellix"
            className={cn("flex items-center gap-2 min-w-0 rounded-lg", focusRing, collapsed && "lg:hidden")}
          >
            <Image
              src="/brand/intellix-mark.png"
              alt=""
              width={1400}
              height={1400}
              priority
              unoptimized
              className="h-7 w-7 object-contain shrink-0"
            />
            <Image
              src="/brand/intellix-wordmark.png"
              alt=""
              width={1518}
              height={174}
              priority
              unoptimized
              className="h-[14px] w-auto object-contain"
            />
          </Link>

          {/* Colapsado (desktop): el ícono de marca actúa como botón "expandir". */}
          <button
            onClick={toggleSidebar}
            aria-label="Expandir menú"
            aria-expanded={false}
            aria-controls="sidebar-nav"
            title="Expandir menú"
            className={cn(
              "mx-auto items-center justify-center rounded-lg p-1 hover:bg-slate-100 transition-colors",
              focusRing,
              collapsed ? "hidden lg:flex" : "hidden"
            )}
          >
            <Image src="/brand/intellix-mark.png" alt="" width={1400} height={1400} priority unoptimized className="w-8 h-8 object-contain" />
          </button>

          {/* Toggle contraer (expandido, desktop) — a la derecha del wordmark. */}
          <button
            onClick={toggleSidebar}
            aria-label="Contraer menú"
            aria-expanded={true}
            aria-controls="sidebar-nav"
            title="Contraer menú"
            className={cn(
              "hidden lg:flex ml-auto items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 active:scale-95 motion-reduce:active:scale-100 transition-colors shrink-0",
              focusRing,
              collapsed && "lg:hidden"
            )}
          >
            <PanelLeftClose className="h-[18px] w-[18px]" />
          </button>

          {/* Cerrar (mobile) */}
          <button
            onClick={closeMobileSidebar}
            className={cn("lg:hidden ml-auto flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors", focusRing)}
            aria-label="Cerrar menú"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav */}
        <nav id="sidebar-nav" aria-label="Navegación principal" className="flex-1 overflow-y-auto scrollbar-slim px-3 pt-4 pb-3">
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
                      "px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400",
                      isFirstVisible ? "mb-1.5" : "mt-6 mb-1.5"
                    )}>
                      {group.label}
                    </div>
                  )}
                  {!group.label && !isFirstVisible && (
                    <div className="h-px bg-slate-200 my-3 mx-1" />
                  )}
                  {collapsed && group.label && !isFirstVisible && (
                    <div className="h-px bg-slate-200 my-3 mx-1 hidden lg:block" />
                  )}
                  <div className="space-y-0.5" role="group" aria-label={group.label || undefined}>
                    {showChatTester && (
                      <button
                        onClick={handleOpenChatTester}
                        className={cn(
                          "w-full flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-medium transition-colors",
                          "text-slate-600 hover:bg-white/70 hover:text-slate-900",
                          focusRing,
                          collapsed && "lg:justify-center lg:px-2 lg:min-h-[40px]"
                        )}
                        title={collapsed ? "Probar chat (nueva pestaña)" : "Abre el widget en una pestaña nueva"}
                      >
                        <BotMessageSquare className="h-[18px] w-[18px] shrink-0" />
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
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "relative flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-medium transition-colors",
                            active
                              ? "bg-action-gradient-soft text-foreground font-semibold shadow-xs ring-1 ring-action/10"
                              : "text-slate-600 hover:bg-white/70 hover:text-slate-900",
                            focusRing,
                            collapsed && "lg:justify-center lg:px-2 lg:min-h-[40px]"
                          )}
                          title={titleAttr}
                        >
                          <Icon className={cn("h-[18px] w-[18px] shrink-0", active && "text-action-dark")} />
                          <span className={cn("flex-1", collapsed && "lg:hidden")}>{item.label}</span>
                          {pendingCount > 0 && (
                            <span
                              aria-label={`${pendingCount} pendientes`}
                              className={cn(
                                "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white bg-action-gradient",
                                collapsed ? "lg:absolute lg:right-1 lg:top-1 lg:h-2.5 lg:w-2.5 lg:min-w-0 lg:rounded-full lg:px-0 lg:ring-2 lg:ring-[#eef0fb]" : "ml-auto"
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

        <div className="h-px bg-slate-200 shrink-0" />

        {/* User + logout */}
        <div className={cn("p-3 space-y-1 shrink-0", collapsed && "lg:flex lg:flex-col lg:items-center lg:p-2 lg:space-y-1")}>
          {/* Contexto del tenant — el nombre, sutil, anclado por un ícono de
              organización (o el mini-logo del tenant si tiene uno) para que se
              lea como "dónde estás operando" y no como decoración. El header
              Intellix arriba y tu usuario abajo terminan de enmarcarlo. Oculto
              en colapsado. */}
          <div className={cn(
            "flex items-center gap-2 px-2 py-1 min-w-0",
            collapsed && "lg:hidden"
          )}>
            {brandLogoUrl ? (
              <Image src={brandLogoUrl} alt="" width={18} height={18} unoptimized className="w-[18px] h-[18px] rounded object-contain shrink-0" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" aria-hidden />
            )}
            <p className="text-[12.5px] font-semibold text-slate-500 truncate" title={`Operando en ${brandName}`}>{brandName}</p>
          </div>

          {/* Tu identidad + salir. El bloque de identidad ES el acceso a "Mi
              cuenta" (avatar con TU inicial, no el logo del tenant → resuelve el
              "quién soy" vs "dónde estoy"). Antes Mi cuenta era una fila extra y
              Cerrar sesión llevaba texto: el pie quedaba recargado. Ahora: perfil
              clickeable + salir como ícono al lado. */}
          <div className={cn("flex items-center gap-2", collapsed && "lg:flex-col lg:gap-1")}>
            {(() => {
              const inner = (
                <>
                  <div className="w-8 h-8 flex items-center justify-center shrink-0 rounded-lg bg-action/10 text-action ring-1 ring-action/15 font-bold text-xs">
                    {userInitial}
                  </div>
                  <div className={cn("min-w-0 leading-tight", collapsed && "lg:hidden")}>
                    <p className="text-[13px] font-semibold text-foreground truncate">{userName}</p>
                    {roleLabel && <p className="text-[11px] text-slate-500 truncate">{roleLabel}</p>}
                  </div>
                </>
              );
              const base = cn(
                "group flex items-center gap-2.5 px-2 py-2 min-w-0 flex-1 rounded-xl transition-colors",
                collapsed && "lg:flex-none lg:px-0 lg:py-1 lg:justify-center"
              );
              return isAdmin ? (
                <Link
                  href="/admin/cuenta"
                  onClick={handleNavClick}
                  aria-current={pathname === "/admin/cuenta" ? "page" : undefined}
                  title={roleLabel ? `Mi cuenta · ${userEmail}` : "Mi cuenta"}
                  className={cn(
                    base,
                    focusRing,
                    pathname === "/admin/cuenta"
                      ? "bg-action-gradient-soft ring-1 ring-action/10 shadow-xs"
                      : "bg-white/60 ring-1 ring-slate-200/80 shadow-xs hover:bg-white/90",
                    collapsed && "lg:bg-transparent lg:ring-0 lg:shadow-none lg:hover:bg-white/70",
                  )}
                >
                  {inner}
                  {/* Affordence de "clickeable → Mi cuenta": sin esto el bloque
                      parece una card pasiva y el usuario no descubre el acceso. */}
                  <ChevronRight className={cn("h-4 w-4 text-slate-400 shrink-0 transition-transform group-hover:translate-x-0.5", collapsed && "lg:hidden")} aria-hidden />
                </Link>
              ) : (
                <div
                  title={userEmail || undefined}
                  className={cn(base, "bg-white/60 ring-1 ring-slate-200/80 shadow-xs", collapsed && "lg:bg-transparent lg:ring-0 lg:shadow-none")}
                >
                  {inner}
                </div>
              );
            })()}
            <button
              onClick={handleLogout}
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
              className={cn(
                "flex items-center justify-center w-9 h-9 shrink-0 rounded-xl text-slate-500 hover:bg-destructive/10 hover:text-destructive transition-colors",
                focusRing,
                collapsed && "lg:w-full lg:h-10",
              )}
            >
              <LogOut className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

      </aside>
    </>
  );
}
