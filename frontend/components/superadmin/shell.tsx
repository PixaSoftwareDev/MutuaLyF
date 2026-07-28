"use client";

// SuperShell — EL marco único de todas las vistas del superadmin.
// Barra de título compacta (back opcional + título + badge + acciones) y
// body scrolleable centrado. Reemplaza a las barras h-12 copiadas y al mix
// PageShell/PageHeader: un solo lugar para tocar el encuadre de todo el panel.

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export function SuperShell({ title, badge, actions, back, width = "default", children }: {
  title: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label?: string };
  width?: "default" | "narrow";
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4 sm:px-6">
        {back && (
          <Link
            href={back.href}
            className="-ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={back.label ?? "Volver"}
            title={back.label ?? "Volver"}
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
        )}
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">{title}</h1>
        {badge}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
        <div className={cn(
          "mx-auto p-4 pb-8 sm:p-6 sm:pb-10",
          width === "narrow" ? "max-w-3xl" : "max-w-[1400px]",
        )}>
          {children}
        </div>
      </div>
    </div>
  );
}
