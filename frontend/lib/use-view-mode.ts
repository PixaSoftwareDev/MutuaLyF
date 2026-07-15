"use client";

import { useEffect, useState } from "react";

export type ViewMode = "cards" | "list";

// Preferencia de vista (tarjetas vs lista) persistida en localStorage por
// pantalla. SSR-safe: arranca en el default en el server y en el primer render
// del cliente (para no romper la hidratación) y recién en useEffect lee lo
// guardado. La escritura es tolerante a fallos (modo incógnito, storage lleno).
export function useViewMode(key: string, initial: ViewMode = "cards") {
  const [view, setView] = useState<ViewMode>(initial);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`viewmode:${key}`);
      if (saved === "cards" || saved === "list") setView(saved);
    } catch {
      /* storage inaccesible — nos quedamos con el default */
    }
  }, [key]);

  const update = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(`viewmode:${key}`, v);
    } catch {
      /* no-op */
    }
  };

  return [view, update] as const;
}
