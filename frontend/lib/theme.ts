"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Sistema de tema del panel: "auto" (sigue al sistema operativo), "light" u
 * "dark". Una sola fuente de verdad:
 *   - Preferencia en localStorage (THEME_KEY).
 *   - Efecto = clase `dark` en <html> (tailwind darkMode: "class").
 *   - Sin flash al cargar: el script inline de app/layout.tsx aplica la clase
 *     ANTES del primer paint leyendo la misma clave.
 */

export type ThemePref = "auto" | "light" | "dark";

export const THEME_KEY = "ui-theme";

const listeners = new Set<() => void>();

export function getThemePref(): ThemePref {
  if (typeof window === "undefined") return "auto";
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  if (typeof document === "undefined") return;
  const dark = pref === "dark" || (pref === "auto" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function setThemePref(pref: ThemePref): void {
  if (pref === "auto") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
  listeners.forEach(fn => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Hook de UI: preferencia actual + setter. Reacciona también al cambio del SO en modo auto. */
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(subscribe, getThemePref, () => "auto" as ThemePref);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (getThemePref() === "auto") applyTheme("auto"); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return { pref, setPref: setThemePref };
}
