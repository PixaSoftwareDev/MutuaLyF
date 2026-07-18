"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/store";
import { navGroups, searchExtras, type NavItem } from "@/components/layout/sidebar";

/**
 * Barra horizontal superior (estructura de referencia: Text App): vive sobre el
 * lienzo gris, arriba del contenedor blanco. Logo a la izquierda (alineado con
 * el rail), buscador Ctrl+K centrado que navega a cualquier pantalla, avatar a
 * la derecha. Solo desktop — en mobile sigue la MobileNavBar.
 */
export function TopBar() {
  const router = useRouter();
  const { userRole } = useAuthStore();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const isAdmin = userRole === "admin";
  const isSuperAdmin = userRole === "super_admin";

  // Destinos navegables según el rol (misma fuente que el panel secundario),
  // más los deep-links de vistas y canales (searchExtras).
  const destinations = useMemo(() => {
    const visible = (i: NavItem) =>
      (!i.adminOnly || isAdmin) && (!i.superAdminOnly || isSuperAdmin);
    return [
      ...navGroups.flatMap(g => g.items.filter(visible).map(i => ({ ...i, group: g.label ?? "" }))),
      ...searchExtras.filter(visible),
    ];
  }, [isAdmin, isSuperAdmin]);

  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const results = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return destinations;
    return destinations.filter(d => norm(d.label).includes(q) || norm(d.group).includes(q));
  }, [query, destinations]);

  // Ctrl+K enfoca el buscador; Escape cierra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click afuera cierra el dropdown.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => { setHighlight(0); }, [query, open]);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(href);
  }

  return (
    <header className="hidden h-12 shrink-0 items-center gap-2 pl-2 pr-3 lg:flex" aria-label="Barra superior">
      {/* Logo — alineado con la columna del rail (56px) */}
      <Link
        href={isSuperAdmin ? "/superadmin" : "/admin/conversations"}
        aria-label="Intellix"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-card shadow-xs transition-shadow hover:shadow-sm"
      >
        <Image
          src="/brand/intellix-mark.png"
          alt=""
          width={1400}
          height={1400}
          priority
          unoptimized
          className="h-5.5 w-5.5 max-h-[22px] max-w-[22px] object-contain"
        />
      </Link>

      {/* Buscador centrado */}
      <div className="flex min-w-0 flex-1 justify-center">
        <div ref={boxRef} className="relative w-full max-w-md">
          <div className={cn(
            "flex h-9 items-center gap-2 rounded-lg bg-card px-3 shadow-xs transition-shadow",
            open && "shadow-sm ring-1 ring-foreground/10",
          )}>
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={e => {
                if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
                else if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(h => Math.min(h + 1, results.length - 1)); }
                else if (e.key === "ArrowUp")   { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
                else if (e.key === "Enter" && results[highlight]) { go(results[highlight].href); }
              }}
              placeholder="Buscar o ir a…"
              aria-label="Buscar o ir a una sección"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            <kbd className="shrink-0 rounded border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">ctrl K</kbd>
          </div>

          {/* Paleta de resultados */}
          {open && (
            <div className="absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border bg-card shadow-md">
              <div className="max-h-80 overflow-y-auto p-1">
                {results.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">Sin resultados para "{query}"</p>
                ) : results.map((d, i) => {
                  const Icon = d.icon;
                  return (
                    <button
                      key={d.href}
                      onClick={() => go(d.href)}
                      onMouseEnter={() => setHighlight(i)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                        i === highlight ? "bg-muted text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate font-medium">{d.label}</span>
                      {d.group && <span className="shrink-0 text-[11px] text-muted-foreground/70">{d.group}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Equilibrio visual del buscador centrado (la config vive en el rail) */}
      <div className="w-9 shrink-0" aria-hidden />
    </header>
  );
}
