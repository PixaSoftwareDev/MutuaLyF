"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { MessageSquare, Clock, UserCheck, Bot, Archive, Pin, PinOff } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useUIStore } from "@/lib/store";
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
  const { sidebarPinned, toggleSidebarPin } = useUIStore();
  const pathname = usePathname();

  // Sección activa según la ruta. Fuera de la bandeja/historial no hay vistas
  // contextuales (ej. /operator/cuenta) → el rail queda solo.
  const section: Section | null =
    pathname === "/operator"
      ? { basePath: "/operator", title: "Bandeja de entrada", views: BANDEJA_VIEWS }
      : pathname.startsWith("/operator/historial")
        ? { basePath: "/operator/historial", title: "Historial", views: HISTORY_VIEWS }
        : null;

  if (!section) return null;

  return (
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
  );
}

function OperatorViews({ section }: { section: Section }) {
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
          <Link href={hrefFor({ sector: "" })} className={itemCls(!sector)} aria-current={!sector ? "page" : undefined}>
            <span className="flex-1">Todos</span>
          </Link>
          {sectorList.map(s => (
            <Link key={s.id} href={hrefFor({ sector: s.id })} className={itemCls(sector === s.id)} aria-current={sector === s.id ? "page" : undefined}>
              <span className="flex-1 truncate">{s.nombre}</span>
            </Link>
          ))}
        </CollapsibleGroup>
      )}
    </>
  );
}
