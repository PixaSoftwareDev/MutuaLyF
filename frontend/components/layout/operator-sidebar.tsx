"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { MessageSquare, Clock, UserCheck, Bot, Archive, Pin, PinOff, Inbox, History, X, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useUIStore, useAuthStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CollapsibleGroup } from "@/components/layout/sidebar";

/**
 * Submenú contextual del operador (mismo patrón que el Sidebar del admin):
 * panel secundario sobre el lienzo, con las vistas por estado y filtro por
 * sector. El estado vive en la URL (?status=&sector=) → la lista lo lee y filtra.
 *
 * Es contextual por sección:
 *   /operator            → Bandeja: solo lo accionable (Todas / En espera / En atención)
 *   /operator/historial  → Historial: todos los estados (incluye Bot activo / Cerradas)
 *
 * Desktop-only: en mobile el filtro por estado vive como segmented control
 * dentro de la propia lista (la navegación mobile es la OperatorTopbar).
 */

type ViewDef = { key: string; label: string; icon: typeof MessageSquare };

const BANDEJA_VIEWS: ViewDef[] = [
  { key: "all",               label: "Todas",       icon: MessageSquare },
  { key: "handoff_requested", label: "En espera",   icon: Clock },
  { key: "human_attending",   label: "En atención", icon: UserCheck },
];

const HISTORY_VIEWS: ViewDef[] = [
  { key: "all",               label: "Todas",       icon: MessageSquare },
  { key: "bot_active",        label: "Bot activo",  icon: Bot },
  { key: "handoff_requested", label: "En espera",   icon: Clock },
  { key: "human_attending",   label: "En atención", icon: UserCheck },
  { key: "closed",            label: "Cerradas",    icon: Archive },
];

type Section = { basePath: string; title: string; views: ViewDef[] };

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25";

export function OperatorSidebar() {
  const { sidebarPinned, toggleSidebarPin, mobileSidebarOpen, closeMobileSidebar } = useUIStore();
  const { userEmail, clearAuth } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };
  const userInitial = (userEmail?.trim()?.[0] ?? "O").toUpperCase();

  // Sección activa según la ruta. Fuera de la bandeja/historial no hay vistas
  // contextuales (ej. /operator/cuenta) → el rail queda solo.
  const section: Section | null =
    pathname === "/operator"
      ? { basePath: "/operator", title: "Bandeja de entrada", views: BANDEJA_VIEWS }
      : pathname.startsWith("/operator/historial")
        ? { basePath: "/operator/historial", title: "Historial", views: HISTORY_VIEWS }
        : null;

  // Drawer mobile (mismo patrón que el Sidebar del admin): hamburguesa en la
  // barra angosta → panel vertical con secciones + vistas. Se renderiza SIEMPRE
  // (fixed, translate) — el aside desktop abajo depende de que haya sección.
  const drawer = (
    <>
      {mobileSidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm"
          onClick={closeMobileSidebar}
          aria-hidden
        />
      )}
      <aside
        aria-label="Navegación del operador"
        className={cn(
          "lg:hidden fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r bg-card shadow-xl",
          "transition-transform duration-200 ease-out",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <p className="text-[15px] font-semibold tracking-tight text-foreground">
            {section?.title ?? "Operador"}
          </p>
          <button
            onClick={closeMobileSidebar}
            aria-label="Cerrar menú"
            className={cn("flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors", focusRing)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar-slim p-3 space-y-4">
          {/* Secciones — el equivalente al rail del desktop */}
          <div className="space-y-0.5">
            {[
              { href: "/operator",           label: "Bandeja de entrada", icon: Inbox,   active: pathname === "/operator" },
              { href: "/operator/historial", label: "Historial",          icon: History, active: pathname.startsWith("/operator/historial") },
            ].map(item => (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeMobileSidebar}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                  item.active
                    ? "bg-muted text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/70",
                  focusRing,
                )}
              >
                <item.icon className={cn("h-4 w-4", item.active && "text-action")} />
                {item.label}
              </Link>
            ))}
          </div>

          {/* Vistas de la sección activa (estados + sectores) */}
          {section && (
            <Suspense fallback={null}>
              <OperatorViews section={section} onNavigate={closeMobileSidebar} />
            </Suspense>
          )}
        </nav>

        {/* Pie: identidad + salir — mismo patrón que el drawer del admin. */}
        <div className="shrink-0 border-t p-3">
          <div className="flex items-center gap-2">
            <Link
              href="/operator/cuenta"
              onClick={closeMobileSidebar}
              title={userEmail ? `Mi cuenta · ${userEmail}` : "Mi cuenta"}
              className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-muted/70", focusRing)}
            >
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm"
                style={{ background: "linear-gradient(135deg, #22d3ee 0%, #6366f1 55%, #7A2DFF 100%)" }}
              >
                {userInitial}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13px] font-semibold text-foreground" title={userEmail || undefined}>
                  {userEmail || "Mi cuenta"}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">Operador</p>
              </div>
            </Link>
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

  if (!section) return drawer;

  return (
    <>
    {drawer}
    <aside
      className={cn(
        // group/aside: el botón de pin aparece al pasar el mouse por el panel.
        // Desktop-only: el submenú vive sobre el lienzo gris (fondo transparente).
        "group/aside hidden flex-col lg:flex",
        sidebarPinned
          // Fijado: en el flujo, empuja el contenido.
          ? "lg:w-[224px] lg:shrink-0"
          // Sin fijar: colapsa a 0 y se expande al pasar el mouse por la zona de
          // navegación (rail o panel) — igual que el admin.
          : cn(
              "lg:w-0 lg:overflow-hidden lg:shrink-0",
              "lg:group-hover/nav:w-[224px] lg:group-focus-within/nav:w-[224px]",
              "lg:transition-[width] lg:duration-200 lg:ease-out",
            ),
      )}
    >
      {/* Título de la sección, alineado con el primer ícono del rail. */}
      <div className="mt-1 flex h-10 w-[224px] shrink-0 items-center gap-1.5 px-3">
        <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-foreground">
          {section.title}
        </p>
        <button
          onClick={(e) => { toggleSidebarPin(); e.currentTarget.blur(); }}
          aria-pressed={sidebarPinned}
          title={sidebarPinned
            ? "Desfijar panel — se oculta y aparece al pasar el mouse"
            : "Fijar panel — queda siempre abierto"}
          aria-label={sidebarPinned ? "Desfijar panel" : "Fijar panel"}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-[opacity,background-color,color]",
            sidebarPinned
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground opacity-0 hover:bg-foreground/[0.06] hover:text-foreground group-hover/aside:opacity-100 focus-visible:opacity-100",
            focusRing,
          )}
        >
          {sidebarPinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
        </button>
      </div>

      <nav aria-label={`Vistas de ${section.title}`} className="w-[224px] flex-1 overflow-y-auto scrollbar-slim px-3 pb-3 pt-3">
        <Suspense fallback={null}>
          <OperatorViews section={section} />
        </Suspense>
      </nav>
    </aside>
    </>
  );
}

function OperatorViews({ section, onNavigate }: { section: Section; onNavigate?: () => void }) {
  const params = useSearchParams();
  const status = params.get("status") ?? "all";
  const sector = params.get("sector") ?? "";

  // Contadores en vivo (espera / atención) — misma queryKey que el panel y la
  // topbar: comparten cache. Sirve también de fuente de los sectores del operador.
  const { data } = useQuery({
    queryKey: ["operator-conversations", "all", "operator"],
    queryFn: () => api.operator.listConversations(),
    staleTime: 5_000,
    refetchInterval: 8_000,
  });
  const all       = data?.sectors?.flatMap((s: any) => s.conversations) ?? [];
  const waiting   = all.filter((c: any) => c.status === "handoff_requested").length;
  const attending = all.filter((c: any) => c.status === "human_attending").length;

  // Sectores del OPERADOR — solo los que la empresa le asignó, no todos los del
  // tenant. El backend ya los restringe: /operator/conversations agrupa por los
  // sectores asignados (cada grupo trae su `sector`). NO usar api.sectors.list
  // (esa es la vista admin y expone sectores que el operador no atiende).
  const sectorList = (data?.sectors ?? [])
    .map((s: any) => s.sector)
    .filter((s: any) => s && s.id) as any[];

  const hrefFor = (patch: { status?: string; sector?: string }) => {
    const s   = patch.status ?? status;
    const sec = patch.sector !== undefined ? patch.sector : sector;
    const p = new URLSearchParams();
    if (s !== "all") p.set("status", s);
    if (sec)         p.set("sector", sec);
    const q = p.toString();
    return section.basePath + (q ? `?${q}` : "");
  };

  const countFor = (key: string) =>
    key === "handoff_requested" ? waiting : key === "human_attending" ? attending : 0;
  const countClassFor = (key: string) =>
    key === "handoff_requested" ? "text-warning" : "text-success";

  const itemCls = (isActive: boolean) => cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors",
    isActive
      ? "bg-card text-foreground font-semibold shadow-xs"
      : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]",
    focusRing,
  );

  return (
    <>
      <CollapsibleGroup label={section.title === "Historial" ? "Estado" : "Bandeja"}>
        {section.views.map(v => {
          const count = countFor(v.key);
          return (
            <Link
              key={v.key}
              href={hrefFor({ status: v.key })}
              onClick={onNavigate}
              className={itemCls(status === v.key)}
              aria-current={status === v.key ? "page" : undefined}
            >
              <v.icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{v.label}</span>
              {count > 0 && (
                <span className={cn("text-xs font-semibold tabular-nums", countClassFor(v.key))}>{count}</span>
              )}
            </Link>
          );
        })}
      </CollapsibleGroup>

      {sectorList.length > 1 && (
        <CollapsibleGroup label="Sectores" className="mt-4">
          <Link href={hrefFor({ sector: "" })} onClick={onNavigate} className={itemCls(!sector)} aria-current={!sector ? "page" : undefined}>
            <span className="flex-1">Todos</span>
          </Link>
          {sectorList.map(s => (
            <Link key={s.id} href={hrefFor({ sector: s.id })} onClick={onNavigate} className={itemCls(sector === s.id)} aria-current={sector === s.id ? "page" : undefined}>
              <span className="flex-1 truncate">{s.nombre}</span>
            </Link>
          ))}
        </CollapsibleGroup>
      )}
    </>
  );
}
