"use client";

import { useEffect } from "react";
import { applyTheme, getThemePref } from "@/lib/theme";

/**
 * Aplica el tema del panel al montar y sigue los cambios del SO en modo auto.
 * Vive en los layouts de admin/superadmin: cubre la transición SPA desde el
 * login (donde el script de <head> no aplicó dark por estar fuera del panel).
 * Al desmontar (salir del panel) vuelve a claro: las caras al afiliado y el
 * login son siempre light.
 */
export function ThemeApplier() {
  useEffect(() => {
    applyTheme();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (getThemePref() === "auto") applyTheme("auto"); };
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      document.documentElement.classList.remove("dark");
    };
  }, []);
  return null;
}
