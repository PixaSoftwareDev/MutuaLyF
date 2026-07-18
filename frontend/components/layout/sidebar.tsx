"use client";

import React, { Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Inbox, FileText, Tags, Settings, LogOut,
  Home, Building2, GitMerge, Users, MessageSquareShare, ClipboardList, Bot, Network, X, Layers, BarChart3,
  MessageSquare, Clock, UserCheck, Archive, UserRound, ChevronDown, Globe, Database, Grid3x3, Pin, PinOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore, useUIStore } from "@/lib/store";
import { api, apiClient } from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { useTenantBranding } from "@/lib/use-tenant-branding";

/**
 * Modelo de navegación (referencia Text):
 *   MENÚ    = rail de íconos (AppRail) — una entrada por sección.
 *   SUBMENÚ = este panel — SOLO los ítems de la sección activa (contextual).
 * En mobile no hay rail: el drawer muestra la navegación completa agrupada.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  badgeKey?: string;
  tooltip?: string;
  /** Rutas adicionales que "pertenecen" a este item para marcarlo activo
      (ej. el detalle de tenant pertenece a Organizaciones). */
  matchPrefixes?: string[];
};

type NavGroup = {
  /** Sección del rail a la que pertenece este grupo (submenú contextual). */
  sectionId: string;
  label?: string;
  items: NavItem[];
};

export const navGroups: NavGroup[] = [
  {
    sectionId: "conversations",
    items: [
      { href: "/admin/conversations", label: "Conversaciones", icon: Inbox, adminOnly: true },
    ],
  },
  {
    sectionId: "knowledge",
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
    sectionId: "team",
    label: "Equipo",
    items: [
      { href: "/admin/sectors",   label: "Sectores",   icon: Building2, adminOnly: true },
      { href: "/admin/operators", label: "Operadores", icon: Users,     adminOnly: true },
    ],
  },
  {
    sectionId: "metrics",
    label: "Informes",
    items: [
      { href: "/admin/metrics", label: "Resumen", icon: BarChart3, adminOnly: true,
        tooltip: "Uso, rendimiento, temas más consultados y atención — el pulso del asistente." },
      { href: "/admin/metrics?view=asistente",    label: "Asistente",    icon: Bot,      adminOnly: true },
      { href: "/admin/metrics?view=atencion",     label: "Atención",     icon: UserCheck, adminOnly: true },
      { href: "/admin/metrics?view=conocimiento", label: "Conocimiento", icon: FileText, adminOnly: true },
      { href: "/admin/metrics?view=plan",         label: "Plan",         icon: Layers,   adminOnly: true },
    ],
  },
  {
    sectionId: "system",
    label: "Sistema",
    items: [
      { href: "/admin/settings", label: "Configuración", icon: Settings, adminOnly: true,
        tooltip: "Identidad, apariencia y comportamiento del asistente, y reglas de derivación." },
      { href: "/admin/connectors", label: "Fuentes de datos", icon: Database, adminOnly: true,
        tooltip: "APIs y bases externas que el asistente puede consultar (datos personales o públicos)." },
      { href: "/admin/cuenta", label: "Mi cuenta", icon: UserRound, adminOnly: true },
    ],
  },
  // ── Plataforma (super-admin) — una sección de rail por destino, cada una con
  //    su submenú contextual (mismo modelo que admin). Antes era un solo grupo
  //    "platform" que mostraba SIEMPRE los 6 ítems y titulaba SIEMPRE "Plataforma"
  //    sin importar la sección → submenú no contextual, se sentía roto. ──────────
  {
    sectionId: "sa-home",
    items: [
      { href: "/superadmin", label: "Inicio", icon: Home, superAdminOnly: true,
        tooltip: "Centro de operaciones: estado, alertas, colas y consumo de un vistazo." },
    ],
  },
  {
    sectionId: "sa-clients",
    label: "Organizaciones",
    items: [
      { href: "/superadmin/orgs", label: "Organizaciones", icon: Building2, superAdminOnly: true,
        matchPrefixes: ["/superadmin/orgs", "/superadmin/tenants"],
        tooltip: "Los clientes de la plataforma: planes, cuotas y detalle por organización." },
      { href: "/superadmin/plans", label: "Planes", icon: Layers, superAdminOnly: true,
        tooltip: "Los planes de la plataforma: límites y precios. Editá o creá planes." },
    ],
  },
  {
    sectionId: "sa-monitoring",
    items: [
      { href: "/superadmin/monitoring", label: "Monitoreo", icon: Network, superAdminOnly: true,
        tooltip: "Infraestructura, alertas, errores recientes y backups." },
    ],
  },
  {
    sectionId: "sa-prompts",
    items: [
      { href: "/superadmin/prompts", label: "Bots / Prompts", icon: Bot, superAdminOnly: true,
        tooltip: "Creá y asignás templates de prompt a los tenants." },
    ],
  },
  {
    sectionId: "sa-audit",
    items: [
      { href: "/superadmin/audit", label: "Auditoría", icon: ClipboardList, superAdminOnly: true,
        tooltip: "Registro de actividad de todas las organizaciones." },
    ],
  },
];

// ── Definiciones compartidas (panel desktop + drawer mobile + buscador Ctrl+K) ──

export const INBOX_VIEWS = [
  { key: "all",               label: "Todas",       icon: MessageSquare },
  { key: "handoff_requested", label: "En espera",   icon: Clock },
  { key: "human_attending",   label: "En atención", icon: UserCheck },
  { key: "bot_active",        label: "Bot activo",  icon: Bot },
  { key: "closed",            label: "Cerradas",    icon: Archive },
] as const;

export const CONFIG_TABS = [
  { key: "asistente",  label: "Asistente",           icon: Bot },
  { key: "derivacion", label: "Derivación a humano", icon: UserCheck },
] as const;

/** Glifo oficial de WhatsApp (lucide no incluye marcas). Hereda el color del texto. */
export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.1-.198.05-.371-.025-.52-.074-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

export const CANAL_LINKS = [
  { href: "/admin/settings?tab=canales&canal=all",      label: "Todos",           icon: Grid3x3 },
  { href: "/admin/settings?tab=canales&canal=widget",   label: "Widget web",      icon: Globe },
  { href: "/admin/settings?tab=canales&canal=whatsapp", label: "WhatsApp",        icon: WhatsAppIcon },
  { href: "/admin/connectors",                          label: "Fuentes de datos", icon: Database },
] as const;

/** Destinos extra para el buscador Ctrl+K (deep-links que no están en navGroups). */
export const searchExtras: Array<NavItem & { group: string }> = [
  ...INBOX_VIEWS.filter(v => v.key !== "all").map(v => ({
    href: `/admin/conversations?status=${v.key}`, label: v.label, icon: v.icon,
    adminOnly: true, group: "Bandeja de entrada",
  })),
  ...CONFIG_TABS.map(t => ({
    href: `/admin/settings?tab=${t.key}`, label: t.label, icon: t.icon,
    adminOnly: true, group: "Configuración",
  })),
  ...CANAL_LINKS.filter(c => c.href !== "/admin/connectors").map(c => ({
    href: c.href, label: c.label, icon: c.icon,
    adminOnly: true, group: "Canales",
  })),
];

// Sección activa: qué rutas pertenecen a cada sección del rail, y su título.
const SECTIONS: Array<{ id: string; title: string; prefixes: string[] }> = [
  { id: "conversations", title: "Bandeja de entrada", prefixes: ["/admin/conversations"] },
  { id: "knowledge",     title: "Conocimiento",       prefixes: ["/admin/documents", "/admin/duplicates", "/admin/intentions"] },
  { id: "team",          title: "Equipo",             prefixes: ["/admin/sectors", "/admin/operators"] },
  { id: "metrics",       title: "Informes",           prefixes: ["/admin/metrics"] },
  { id: "system",        title: "Sistema",            prefixes: ["/admin/settings", "/admin/connectors", "/admin/cuenta"] },
  // Super-admin: una sección por destino (el prefijo más largo gana, así
  // "/superadmin" exacto = Inicio y las subrutas caen en su sección).
  { id: "sa-home",       title: "Inicio",             prefixes: ["/superadmin"] },
  { id: "sa-clients",    title: "Organizaciones",     prefixes: ["/superadmin/orgs", "/superadmin/tenants", "/superadmin/plans"] },
  { id: "sa-monitoring", title: "Monitoreo",          prefixes: ["/superadmin/monitoring"] },
  { id: "sa-prompts",    title: "Bots y prompts",     prefixes: ["/superadmin/prompts"] },
  { id: "sa-audit",      title: "Auditoría",          prefixes: ["/superadmin/audit"] },
];

export function Sidebar() {
  const pathname = usePathname();
  // El item activo es el de prefijo MÁS específico que matchea la ruta actual.
  const activeHref = navGroups
    .flatMap(g => g.items)
    .flatMap(i => (i.matchPrefixes ?? [i.href]).map(p => ({ href: i.href, prefix: p })))
    .filter(m => pathname === m.prefix || pathname.startsWith(m.prefix + "/"))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.href ?? null;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userEmail, userRole, tenantId, clearAuth } = useAuthStore();
  const { mobileSidebarOpen, closeMobileSidebar, sidebarPinned, toggleSidebarPin } = useUIStore();

  const { branding } = useTenantBranding();

  const isAdmin = userRole === "admin";
  const isSuperAdmin = userRole === "super_admin";

  // Sección activa (mismo criterio de prefijo más específico)
  const activeSection = SECTIONS
    .flatMap(s => s.prefixes.map(p => ({ id: s.id, title: s.title, prefix: p })))
    .filter(m => pathname === m.prefix || pathname.startsWith(m.prefix + "/"))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? null;
  const sectionTitle = activeSection?.title ?? (isSuperAdmin ? "Plataforma" : "Panel");

  const userInitial = (userEmail?.trim()[0] ?? "?").toUpperCase();
  const userName    = userEmail ? userEmail.split("@")[0] : "Usuario";
  const roleLabel   = userRole === "admin"       ? "Administrador"
                    : userRole === "super_admin" ? "Super Admin"
                    : userRole === "operator"    ? "Operador"
                    : "";

  const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25";

  const prefetchMap: Record<string, () => void> = {
    "/admin/conversations": () => queryClient.prefetchQuery({ queryKey: ["operator-conversations", "all", "admin-readonly"], queryFn: () => api.operator.listConversations(), staleTime: 4_000 }),
    "/admin/documents":     () => queryClient.prefetchQuery({ queryKey: ["documents"],   queryFn: api.documents.list,   staleTime: 10_000 }),
    "/admin/intentions":    () => queryClient.prefetchQuery({ queryKey: ["intentions"],  queryFn: api.intentions.list,  staleTime: 30_000 }),
    "/admin/duplicates":    () => queryClient.prefetchQuery({ queryKey: ["duplicates"],  queryFn: api.duplicates.list,  staleTime: 30_000 }),
    "/admin/sectors":       () => queryClient.prefetchQuery({ queryKey: ["sectors"],     queryFn: api.sectors.list,     staleTime: 30_000 }),
    "/admin/operators":     () => queryClient.prefetchQuery({ queryKey: ["operators"],   queryFn: () => apiClient.get("/admin/operators").then(r => r.data), staleTime: 30_000 }),
    "/admin/settings":      () => tenantId && queryClient.prefetchQuery({ queryKey: ["bot-config", tenantId], queryFn: () => api.tenants.getBotConfig(tenantId), staleTime: 60_000 }),
    "/superadmin":            () => queryClient.prefetchQuery({ queryKey: ["platform-health"], queryFn: api.tenants.platformHealth, staleTime: 30_000 }),
    "/superadmin/orgs":       () => queryClient.prefetchQuery({ queryKey: ["tenants"], queryFn: () => apiClient.get("/tenants").then(r => r.data), staleTime: 30_000 }),
    "/superadmin/monitoring": () => queryClient.prefetchQuery({ queryKey: ["platform-system"], queryFn: api.tenants.platformSystem, staleTime: 15_000 }),
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
      const brand = branding.primary_color ? `&brand=${encodeURIComponent(branding.primary_color)}` : "";
      const url = `/chat?token=${encodeURIComponent(data.widget_token)}&tenant=${encodeURIComponent(tenantId)}&test=1${brand}`;
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

  const itemCls = (active: boolean) => cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors",
    active
      ? "bg-muted text-foreground font-semibold lg:bg-card lg:shadow-xs"
      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground lg:hover:bg-foreground/[0.06]",
    focusRing,
  );

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = item.href === activeHref;
    const pendingCount = item.badgeKey === "duplicates-pending" ? duplicatesPending : 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={handleNavClick}
        onMouseEnter={() => prefetchMap[item.href]?.()}
        onFocus={() => prefetchMap[item.href]?.()}
        aria-current={active ? "page" : undefined}
        className={itemCls(active)}
        title={item.tooltip}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1">{item.label}</span>
        {pendingCount > 0 && (
          <span aria-label={`${pendingCount} pendientes`} className="ml-auto text-xs font-semibold tabular-nums text-foreground">
            {pendingCount > 99 ? "99+" : pendingCount}
          </span>
        )}
      </Link>
    );
  };

  // Submenú contextual (desktop): solo los ítems de la sección activa.
  const activeGroups = navGroups.filter(
    g => g.sectionId === (activeSection?.id ?? "") && g.items.some(isVisible)
  );

  // Nav completa (mobile drawer): todos los grupos visibles, con sus labels.
  const allGroups = navGroups.filter(g => g.items.some(isVisible));

  const isConversations = isAdmin && pathname.startsWith("/admin/conversations");

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

      <aside
        className={cn(
          // Mobile: drawer blanco fijo. Desktop: depende del pin.
          // group/aside: el botón de pin aparece al pasar el mouse por el panel.
          "group/aside flex flex-col bg-card border-r",
          "fixed inset-y-0 left-0 z-50 w-64",
          "transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop FIJADO: panel transparente en el flujo, sobre el lienzo gris.
          sidebarPinned && "lg:static lg:z-auto lg:w-[224px] lg:shrink-0 lg:translate-x-0 lg:border-r-0 lg:bg-transparent lg:transition-none",
          // Desktop SIN FIJAR: EN FLUJO (empuja el contenido, no lo tapa). Colapsa
          // a ancho 0 y se expande al pasar el mouse por la zona de navegación
          // (rail o panel). Mismo fondo transparente sobre el lienzo que fijado.
          !sidebarPinned && cn(
            "lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 lg:overflow-hidden lg:border-r-0 lg:bg-transparent",
            "lg:w-0 lg:group-hover/nav:w-[224px] lg:group-focus-within/nav:w-[224px]",
            "lg:transition-[width] lg:duration-200 lg:ease-out",
          ),
        )}
      >
        {/* Título de la SECCIÓN activa, alineado con el primer ícono del rail. */}
        <div className="flex h-14 shrink-0 items-center gap-1.5 border-b px-4 lg:mt-1 lg:h-10 lg:w-[224px] lg:border-b-0 lg:px-3">
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-foreground">{sectionTitle}</p>
          {/* Fijar / desfijar panel (solo desktop). Aparece al pasar el mouse por
              el panel (patrón text.com), en la costura con el contenido. */}
          <button
            onClick={(e) => { toggleSidebarPin(); e.currentTarget.blur(); }}
            aria-pressed={sidebarPinned}
            title={sidebarPinned
              ? "Desfijar panel — se oculta y aparece al pasar el mouse"
              : "Fijar panel — queda siempre abierto"}
            aria-label={sidebarPinned ? "Desfijar panel" : "Fijar panel"}
            className={cn(
              "hidden lg:flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
              "opacity-0 transition-[opacity,background-color,color] lg:group-hover/aside:opacity-100 focus-visible:opacity-100",
              focusRing,
            )}
          >
            {sidebarPinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
          </button>
          {/* Cerrar (mobile) */}
          <button
            onClick={closeMobileSidebar}
            className={cn("lg:hidden flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors", focusRing)}
            aria-label="Cerrar menú"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav id="sidebar-nav" aria-label="Navegación principal" className="flex-1 overflow-y-auto scrollbar-slim px-3 pb-3 pt-3 lg:w-[224px]">
          {/* ── Desktop: SUBMENÚ contextual de la sección activa ─────────────── */}
          <div className="hidden lg:block">
            {isConversations ? (
              <Suspense fallback={null}>
                <InboxViews focusRing={focusRing} />
              </Suspense>
            ) : isAdmin && activeSection?.id === "system" ? (
              <Suspense fallback={null}>
                <SystemViews focusRing={focusRing} activeHref={activeHref} onOpenChatTester={handleOpenChatTester} />
              </Suspense>
            ) : isAdmin && activeSection?.id === "metrics" ? (
              <Suspense fallback={null}>
                <MetricsViews focusRing={focusRing} />
              </Suspense>
            ) : (
              <div className="space-y-0.5">
                {activeGroups.flatMap(g => g.items.filter(isVisible)).map(renderItem)}
              </div>
            )}
          </div>

          {/* ── Mobile: navegación completa espejando el modelo desktop ──────── */}
          <div className="lg:hidden">
            {isSuperAdmin ? (
              <div className="space-y-0.5">
                {allGroups.flatMap(g => g.items.filter(isVisible)).map(renderItem)}
              </div>
            ) : (
              <Suspense fallback={null}>
                <MobileNav
                  activeHref={activeHref}
                  focusRing={focusRing}
                  duplicatesPending={duplicatesPending}
                  onNavClick={handleNavClick}
                  onOpenChatTester={handleOpenChatTester}
                />
              </Suspense>
            )}
          </div>
        </nav>

        {/* Pie SOLO mobile: identidad + salir (en desktop viven en el rail). */}
        <div className="shrink-0 border-t p-3 lg:hidden">
          <div className="flex items-center gap-2">
            {(() => {
              const inner = (
                <>
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm"
                    style={{ background: "linear-gradient(135deg, #22d3ee 0%, #6366f1 55%, #7A2DFF 100%)" }}
                  >
                    {userInitial}
                  </div>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-[13px] font-semibold text-foreground" title={userEmail || undefined}>{userName}</p>
                    {roleLabel && <p className="truncate text-[11px] text-muted-foreground">{roleLabel}</p>}
                  </div>
                </>
              );
              return isAdmin ? (
                <Link
                  href="/admin/cuenta"
                  onClick={handleNavClick}
                  title={roleLabel ? `Mi cuenta · ${userEmail}` : "Mi cuenta"}
                  className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-muted/70", focusRing)}
                >
                  {inner}
                </Link>
              ) : (
                <div title={userEmail || undefined} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2">
                  {inner}
                </div>
              );
            })()}
            <button
              onClick={handleLogout}
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
              className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors", focusRing)}
            >
              <LogOut className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// ── Panel contextual de Conversaciones (patrón Inbox de la referencia) ─────────
// Vistas por estado con contadores en vivo + filtro por sector. El estado vive
// en la URL (?status=&sector=) → compartible, bookmarkeable y sin estado dual.

function InboxViews({ focusRing }: { focusRing: string }) {
  const params = useSearchParams();
  const status = params.get("status") ?? "all";
  const sector = params.get("sector") ?? "";

  const { data: active } = useQuery({
    queryKey: ["operator-conversations", "all", "admin"],
    queryFn: () => api.operator.listConversations(),
    staleTime: 5_000,
    refetchInterval: 8_000,
  });
  const allActive  = active?.sectors?.flatMap((s: any) => s.conversations) ?? [];
  const waiting    = allActive.filter((c: any) => c.status === "handoff_requested").length;
  const attending  = allActive.filter((c: any) => c.status === "human_attending").length;

  const { data: sectors = [] } = useQuery({
    queryKey: ["sectors"],
    queryFn:  api.sectors.list,
    staleTime: 60_000,
  });

  const hrefFor = (patch: { status?: string; sector?: string }) => {
    const s   = patch.status ?? status;
    const sec = patch.sector !== undefined ? patch.sector : sector;
    const p = new URLSearchParams();
    if (s !== "all") p.set("status", s);
    if (sec)         p.set("sector", sec);
    const q = p.toString();
    return "/admin/conversations" + (q ? `?${q}` : "");
  };

  const VIEWS = INBOX_VIEWS.map(v => ({
    ...v,
    count: v.key === "handoff_requested" ? waiting : v.key === "human_attending" ? attending : 0,
    countClass: v.key === "handoff_requested" ? "text-warning" : "text-success",
  }));

  const itemCls = (isActive: boolean) => cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors",
    isActive
      ? "bg-card text-foreground font-semibold shadow-xs"
      : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]",
    focusRing,
  );

  return (
    <>
      <CollapsibleGroup label="Chats">
        {VIEWS.map(v => (
          <Link key={v.key} href={hrefFor({ status: v.key })} className={itemCls(status === v.key)} aria-current={status === v.key ? "page" : undefined}>
            <v.icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{v.label}</span>
            {v.count > 0 && (
              <span className={cn("text-xs font-semibold tabular-nums", v.countClass)}>{v.count}</span>
            )}
          </Link>
        ))}
      </CollapsibleGroup>

      {(sectors as any[]).length > 0 && (
        <CollapsibleGroup label="Sectores" className="mt-4">
          <Link href={hrefFor({ sector: "" })} className={itemCls(!sector)} aria-current={!sector ? "page" : undefined}>
            <span className="flex-1">Todos</span>
          </Link>
          {(sectors as any[]).map(s => (
            <Link key={s.id} href={hrefFor({ sector: s.id })} className={itemCls(sector === s.id)} aria-current={sector === s.id ? "page" : undefined}>
              <span className="flex-1 truncate">{s.nombre}</span>
            </Link>
          ))}
        </CollapsibleGroup>
      )}
    </>
  );
}

// ── Drawer mobile (admin): espeja el modelo menú/submenú del desktop ───────────
// Grupos plegables por sección; abre por defecto solo el de la ruta actual.

function MobileNav({ activeHref, focusRing, duplicatesPending, onNavClick, onOpenChatTester }: {
  activeHref: string | null;
  focusRing: string;
  duplicatesPending: number;
  onNavClick: () => void;
  onOpenChatTester: () => void;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const currentUrl = pathname + (params.toString() ? `?${params.toString()}` : "");

  const isActive = (href: string) =>
    href.includes("?")
      ? href === currentUrl
      // Rutas con vistas por query (bandeja, informes): el ítem "base" solo está
      // activo sin query. El resto, por el matcheo de prefijos del sidebar.
      : href === "/admin/conversations" || href === "/admin/metrics"
        ? currentUrl === href
        : activeHref === href;

  const itemCls = (active: boolean) => cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors",
    active ? "bg-muted text-foreground font-semibold" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
    focusRing,
  );

  const item = (href: string, label: string, Icon: React.ComponentType<{ className?: string }>, badge?: number) => (
    <Link key={href} href={href} onClick={onNavClick} className={itemCls(isActive(href))} aria-current={isActive(href) ? "page" : undefined}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && <span className="text-xs font-semibold tabular-nums text-foreground">{badge > 99 ? "99+" : badge}</span>}
    </Link>
  );

  const openFor = (prefix: string) => pathname.startsWith(prefix);

  return (
    <div className="space-y-4">
      <CollapsibleGroup label="Bandeja de entrada" defaultOpen={openFor("/admin/conversations")}>
        {INBOX_VIEWS.map(v => item(
          v.key === "all" ? "/admin/conversations" : `/admin/conversations?status=${v.key}`,
          v.label, v.icon,
        ))}
      </CollapsibleGroup>

      <CollapsibleGroup label="Conocimiento" defaultOpen={openFor("/admin/documents") || openFor("/admin/duplicates") || openFor("/admin/intentions")}>
        {item("/admin/documents", "Documentos", FileText)}
        {item("/admin/duplicates", "Duplicados", GitMerge, duplicatesPending)}
        {item("/admin/intentions", "Temas reconocidos", Tags)}
      </CollapsibleGroup>

      <CollapsibleGroup label="Equipo" defaultOpen={openFor("/admin/sectors") || openFor("/admin/operators")}>
        {item("/admin/sectors", "Sectores", Building2)}
        {item("/admin/operators", "Operadores", Users)}
      </CollapsibleGroup>

      <CollapsibleGroup label="Informes" defaultOpen={openFor("/admin/metrics")}>
        {item("/admin/metrics", "Resumen", BarChart3)}
        {item("/admin/metrics?view=asistente", "Asistente", Bot)}
        {item("/admin/metrics?view=atencion", "Atención", UserCheck)}
        {item("/admin/metrics?view=conocimiento", "Conocimiento", FileText)}
        {item("/admin/metrics?view=plan", "Plan", Layers)}
      </CollapsibleGroup>

      <CollapsibleGroup label="Configuración" defaultOpen={openFor("/admin/settings")}>
        {CONFIG_TABS.map(t => item(`/admin/settings?tab=${t.key}`, t.label, t.icon))}
        <button
          onClick={() => { onNavClick(); onOpenChatTester(); }}
          className={cn(itemCls(false), "w-full text-left")}
          title="Abre el widget en una pestaña nueva"
        >
          <MessageSquareShare className="h-4 w-4 shrink-0" />
          <span className="flex-1">Probar chat</span>
        </button>
      </CollapsibleGroup>

      <CollapsibleGroup label="Canales" defaultOpen={openFor("/admin/connectors")}>
        {CANAL_LINKS.map(c => item(c.href, c.label, c.icon))}
      </CollapsibleGroup>
      {/* Mi cuenta: por el avatar (pie del drawer), no como ítem de navegación */}
    </div>
  );
}

// ── Panel contextual de Informes ───────────────────────────────────────────────
// Cada informe es una vista propia (?view=) — el panel navega entre ellas.

function MetricsViews({ focusRing }: { focusRing: string }) {
  const params = useSearchParams();
  const view = params.get("view") ?? "resumen";

  const VIEWS = [
    { key: "resumen",      label: "Resumen",      icon: BarChart3 },
    { key: "asistente",    label: "Asistente",    icon: Bot },
    { key: "atencion",     label: "Atención",     icon: UserCheck },
    { key: "conocimiento", label: "Conocimiento", icon: FileText },
    { key: "plan",         label: "Plan",         icon: Layers },
  ];

  const itemCls = (isActive: boolean) => cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors",
    isActive
      ? "bg-card text-foreground font-semibold shadow-xs"
      : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]",
    focusRing,
  );

  return (
    <div className="space-y-0.5" role="group" aria-label="Informes">
      {VIEWS.map(v => {
        const active = view === v.key;
        const href = v.key === "resumen" ? "/admin/metrics" : `/admin/metrics?view=${v.key}`;
        return (
          <Link key={v.key} href={href} className={itemCls(active)} aria-current={active ? "page" : undefined}>
            <v.icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{v.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

// ── Panel contextual de Sistema ────────────────────────────────────────────────
// Las pestañas de Configuración (Asistente/Apariencia/Canales/Derivación) son
// subitems del panel, navegando por URL (?tab=) — mismo patrón que la bandeja.

function SystemViews({ focusRing, activeHref, onOpenChatTester }: {
  focusRing: string;
  activeHref: string | null;
  onOpenChatTester: () => void;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  // Mismos alias que resolveTab de la página de settings (links viejos incluidos)
  const raw = params.get("tab");
  const tab = raw === "apariencia" || raw === "branding" ? "apariencia"
    : raw === "derivacion" || raw === "handoff" ? "derivacion"
    : raw === "canales" ? "canales"
    : "asistente";
  const canal = params.get("canal");
  const onSettings = pathname === "/admin/settings";

  const TABS = CONFIG_TABS;

  // Canales = todo por donde entra y sale información: overview (Todos), los de
  // conversación (widget, WhatsApp) y los de datos (conectores a APIs/BD externas).
  const currentCanal = canal ?? "widget";  // sin ?canal= → Widget por default
  const CANALES = CANAL_LINKS.map(c => {
    const linkCanal = c.href.includes("canal=all") ? "all"
      : c.href.includes("canal=whatsapp") ? "whatsapp"
      : c.href.includes("canal=widget") ? "widget" : null;
    return {
      ...c,
      active: c.href === "/admin/connectors"
        ? activeHref === "/admin/connectors"
        : onSettings && tab === "canales" && currentCanal === linkCanal,
    };
  });

  const itemCls = (isActive: boolean) => cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors",
    isActive
      ? "bg-card text-foreground font-semibold shadow-xs"
      : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]",
    focusRing,
  );

  return (
    <>
      <CollapsibleGroup label="Configuración">
        {TABS.map(t => {
          const active = onSettings && tab === t.key;
          return (
            <Link key={t.key} href={`/admin/settings?tab=${t.key}`} className={itemCls(active)} aria-current={active ? "page" : undefined}>
              <t.icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
            </Link>
          );
        })}
        {/* Acción que cierra el ciclo de lo que se configura acá arriba */}
        <button onClick={onOpenChatTester} className={cn(itemCls(false), "w-full text-left")} title="Abre el widget en una pestaña nueva">
          <MessageSquareShare className="h-4 w-4 shrink-0" />
          <span className="flex-1">Probar chat</span>
        </button>
      </CollapsibleGroup>

      <CollapsibleGroup label="Canales" className="mt-4">
        {CANALES.map(c => (
          <Link key={c.href} href={c.href} className={itemCls(c.active)} aria-current={c.active ? "page" : undefined}>
            <c.icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
          </Link>
        ))}
      </CollapsibleGroup>
      {/* "Mi cuenta" NO va acá: es personal del usuario, no de la organización.
          Se accede por el avatar (popover desktop / pie del drawer mobile). */}
    </>
  );
}

/** Grupo plegable del panel (patrón referencia): título en negrita + chevron. */
function CollapsibleGroup({ label, className, defaultOpen = true, children }: {
  label: string;
  className?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={className}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-foreground transition-colors hover:bg-foreground/[0.06]"
      >
        {label}
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="mt-1 space-y-0.5" role="group" aria-label={label}>{children}</div>}
    </div>
  );
}
