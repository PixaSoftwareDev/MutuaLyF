import * as React from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/**
 * Paginación unificada (compacta con elipsis). Reemplaza los 3 mecanismos
 * distintos que había (prev/next, "cargar más", rango compacto).
 */
function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/** Devuelve los items a mostrar: números y "ellipsis". Siempre incluye 1 y total. */
function paginate(current: number, total: number, siblings = 1): (number | "...")[] {
  const totalNumbers = siblings * 2 + 5;
  if (total <= totalNumbers) return range(1, total);

  const left = Math.max(current - siblings, 1);
  const right = Math.min(current + siblings, total);
  const showLeftDots = left > 2;
  const showRightDots = right < total - 1;

  if (!showLeftDots && showRightDots) {
    return [...range(1, 3 + siblings * 2), "...", total];
  }
  if (showLeftDots && !showRightDots) {
    return [1, "...", ...range(total - (3 + siblings * 2) + 1, total)];
  }
  return [1, "...", ...range(left, right), "...", total];
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  className,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  className?: string;
}) {
  if (totalPages <= 1) return null;
  const items = paginate(page, totalPages);

  return (
    <nav className={cn("flex items-center justify-center gap-1", className)} aria-label="Paginación">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
        aria-label="Anterior"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {items.map((it, i) =>
        it === "..." ? (
          <span key={`dots-${i}`} className="flex h-8 w-8 items-center justify-center text-muted-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </span>
        ) : (
          <button
            key={it}
            type="button"
            onClick={() => onPageChange(it)}
            aria-current={it === page ? "page" : undefined}
            className={cn(
              buttonVariants({ variant: it === page ? "default" : "ghost", size: "icon" }),
              "h-8 w-8 text-sm tabular-nums"
            )}
          >
            {it}
          </button>
        )
      )}

      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
        aria-label="Siguiente"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  );
}
