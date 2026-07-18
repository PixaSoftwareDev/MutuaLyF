"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Inbox, FileText, Users, BarChart3, Settings, Home, Building2, Network, Bot,
  ClipboardList, LogOut, Monitor, Sun, Moon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";

/**
 * Rail de navegación de íconos (estructura de referencia: Text App).
 * Logo redondeado arriba, una entrada por sección, usuario y salir abajo.
 * Vive sobre el lienzo gris, fuera del contenedor blanco de contenido.
 * Solo desktop — en mobile la navegación sigue siendo el drawer del Sidebar.
 */

type RailItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Prefijos de ruta que pertenecen a esta sección (para marcarla activa). */
  prefixes: string[];
};

const ADMIN_RAIL: RailItem[] = [
  { href: "/admin/conversations", label: "Conversaciones", icon: Inbox,
    prefixes: ["/admin/conversations"] },
  { href: "/admin/documents", label: "Conocimiento", icon: FileText,
    prefixes: ["/admin/documents", "/admin/duplicates", "/admin/intentions"] },
  { href: "/admin/sectors", label: "Equipo", icon: Users,
    prefixes: ["/admin/sectors", "/admin/operators"] },
  { href: "/admin/metrics", label: "Métricas", icon: BarChart3,
    prefixes: ["/admin/metrics"] },
];

// Rutas de "Sistema" — las marca la ruedita del pie del rail, no un ícono arriba.
const SYSTEM_PREFIXES = ["/admin/settings", "/admin/connectors", "/admin/cuenta"];

const SUPER_RAIL: RailItem[] = [
  { href: "/superadmin", label: "Inicio", icon: Home,
    prefixes: ["/superadmin"] },
  { href: "/superadmin/orgs", label: "Organizaciones", icon: Building2,
    prefixes: ["/superadmin/orgs", "/superadmin/tenants", "/superadmin/plans"] },
  { href: "/superadmin/monitoring", label: "Monitoreo", icon: Network,
    prefixes: ["/superadmin/monitoring"] },
  { href: "/superadmin/prompts", label: "Bots y prompts", icon: Bot,
    prefixes: ["/superadmin/prompts"] },
  { href: "/superadmin/audit", label: "Auditoría", icon: ClipboardList,
    prefixes: ["/superadmin/audit"] },
];

export function AppRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { userEmail, userRole, clearAuth } = useAuthStore();
  const userInitial = (userEmail?.trim()[0] ?? "?").toUpperCase();

  const isAdmin = userRole === "admin";
  const items = isAdmin ? ADMIN_RAIL : SUPER_RAIL;

  // Sección activa = prefijo MÁS específico que matchea (mismo criterio que el
  // panel secundario: con prefijos anidados tipo /superadmin, gana el más largo).
  const activeHref = items
    .flatMap(i => i.prefixes.map(p => ({ href: i.href, prefix: p })))
    .filter(m => pathname === m.prefix || pathname.startsWith(m.prefix + "/"))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.href ?? null;

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  // Micro-interacción de la referencia: al pasar el cursor el tile crece apenas
  // y vuelve con un resorte suave; al click se hunde un toque.
  const iconBtn = "flex h-10 w-10 items-center justify-center rounded-xl transition-[transform,background-color,color] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.12] active:scale-95 motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30";
  // Activo: en claro es tile oscuro con icono claro; en oscuro un bloque blanco
  // sólido queda muy duro, así que va un tile gris con el icono blanco.
  const iconActive = "bg-foreground text-background shadow-sm dark:bg-white/10 dark:text-white dark:shadow-none";
  const iconIdle = "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground";

  return (
    <aside
      aria-label="Secciones"
      className="hidden lg:flex w-14 shrink-0 flex-col items-center gap-1 pb-3 pt-1"
    >
      {/* Secciones (el logo y el avatar viven en la TopBar) */}
      <nav className="flex flex-col items-center gap-1" aria-label="Navegación por secciones">
        {items.map(item => {
          const Icon = item.icon;
          const active = item.href === activeHref;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={cn(iconBtn, active ? iconActive : iconIdle)}
            >
              <Icon className="h-[18px] w-[18px]" />
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Acciones inferiores */}
      {isAdmin && (() => {
        const systemActive = SYSTEM_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));
        return (
          <Link
            href="/admin/settings"
            title="Configuración"
            aria-label="Configuración"
            aria-current={systemActive ? "page" : undefined}
            className={cn(iconBtn, systemActive ? iconActive : iconIdle)}
          >
            <Settings className="h-[18px] w-[18px]" />
          </Link>
        );
      })()}
      <UserMenu
        isAdmin={isAdmin}
        userEmail={userEmail}
        userInitial={userInitial}
        roleLabel={isAdmin ? "Administrador" : "Super Admin"}
        onLogout={handleLogout}
      />
    </aside>
  );
}

// ── Popover de cuenta ─────────────────────────────────────────────────────────
// Se abre desde el avatar del rail, hacia arriba a la derecha. El selector de
// tema escribe la preferencia real (lib/theme.ts): auto / claro / oscuro.

function UserMenu({ isAdmin, userEmail, userInitial, roleLabel, onLogout }: {
  isAdmin: boolean;
  userEmail: string | null;
  userInitial: string;
  roleLabel: string;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { pref: theme, setPref: setTheme } = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const userName = userEmail ? userEmail.split("@")[0] : "Usuario";

  const THEMES = [
    { key: "auto"  as const, label: "Auto",   icon: Monitor },
    { key: "light" as const, label: "Claro",  icon: Sun },
    { key: "dark"  as const, label: "Oscuro", icon: Moon },
  ];

  return (
    <div ref={wrapRef} className="relative mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        title={userEmail || undefined}
        aria-label="Menú de cuenta"
        aria-expanded={open}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm transition-transform hover:scale-105",
          open && "ring-2 ring-foreground/20 ring-offset-2 ring-offset-canvas",
        )}
        style={{ background: "linear-gradient(135deg, #22d3ee 0%, #6366f1 55%, #7A2DFF 100%)" }}
      >
        {userInitial}
      </button>

      {open && (
        <div className="absolute bottom-0 left-full z-50 ml-2 w-60 overflow-hidden rounded-2xl border border-black/5 bg-card py-1.5 shadow-lg shadow-black/10 animate-fade-in">
          {/* Identidad — nombre + email, sin borde duro */}
          <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-2">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
              style={{ background: "linear-gradient(135deg, #22d3ee 0%, #6366f1 55%, #7A2DFF 100%)" }}
            >
              {userInitial}
            </div>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-foreground">{userName}</p>
              <p className="truncate text-xs text-muted-foreground" title={userEmail || undefined}>{userEmail || roleLabel}</p>
            </div>
          </div>

          <div className="mx-3.5 h-px bg-border/70" />

          {/* Filas de solo texto, accesorios a la derecha (patrón Text) */}
          <div className="py-1">
            {isAdmin && (
              <Link
                href="/admin/cuenta"
                onClick={() => setOpen(false)}
                className="flex h-9 items-center px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                Mi cuenta
              </Link>
            )}

            {/* Tema — fila con 3 iconitos a la derecha (visual por ahora) */}
            <div className="flex h-9 items-center justify-between px-3.5">
              <span className="text-[13px] font-medium text-foreground">Tema</span>
              <div className="flex items-center gap-0.5">
                {THEMES.map(t => (
                  <button
                    key={t.key}
                    onClick={() => setTheme(t.key)}
                    title={t.label}
                    aria-label={`Tema ${t.label}`}
                    aria-pressed={theme === t.key}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                      theme === t.key
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground/60 hover:text-foreground",
                    )}
                  >
                    <t.icon className="h-[15px] w-[15px]" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mx-3.5 h-px bg-border/70" />

          <div className="pt-1">
            <button
              onClick={onLogout}
              className="flex h-9 w-full items-center justify-between px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              Cerrar sesión
              <LogOut className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
