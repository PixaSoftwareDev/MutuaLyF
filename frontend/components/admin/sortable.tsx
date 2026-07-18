"use client";

import { useState } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";
export type Sort<K extends string> = { key: K; dir: SortDir } | null;

/**
 * Orden de tabla reutilizable: estado + toggle (clic en el header alterna
 * asc/desc). `defaultDir` fija la dirección inicial por columna (ej. números de
 * mayor a menor). Usado por cualquier tabla del back-office.
 */
export function useTableSort<K extends string>(defaultDir?: Partial<Record<K, SortDir>>) {
  const [sort, setSort] = useState<Sort<K>>(null);
  const toggle = (key: K) =>
    setSort(prev => prev?.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: defaultDir?.[key] ?? "asc" });
  return { sort, toggle };
}

/** Aplica el orden a una lista con un comparador por clave. */
export function applySort<T, K extends string>(
  items: T[],
  sort: Sort<K>,
  compare: (a: T, b: T, key: K) => number,
): T[] {
  if (!sort) return items;
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => dir * compare(a, b, sort.key));
}

/** Encabezado de columna ordenable: label + flechita (asc/desc/neutral). */
export function SortHeader<K extends string>({ label, sortKey, sort, onToggle }: {
  label: string;
  sortKey: K;
  sort: Sort<K>;
  onToggle: (key: K) => void;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort!.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      onClick={() => onToggle(sortKey)}
      className={cn("inline-flex items-center gap-1 transition-colors hover:text-foreground", active && "text-foreground")}
    >
      {label}
      <Icon className={cn("h-3.5 w-3.5", active ? "opacity-100" : "opacity-40")} />
    </button>
  );
}
