"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TenantBranding } from "./api";

export const DEFAULT_PRIMARY = "#99323D";

/** Darken (negative) or lighten (positive) a hex color by `pct` percent. */
function shade(hex: string, pct: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const num = parseInt(h, 16);
  let r = (num >> 16) + Math.round(2.55 * pct);
  let g = ((num >> 8) & 0xff) + Math.round(2.55 * pct);
  let b = (num & 0xff) + Math.round(2.55 * pct);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * Convert "#RRGGBB" to the tuple Tailwind expects inside `hsl(...)`: "H S% L%"
 * (sin envolver con hsl() — tailwind ya lo hace en tailwind.config.ts).
 */
function hexToHslTuple(hex: string): string | null {
  const h = hex.replace("#", "");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: hue = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: hue = (b - r) / d + 2; break;
      case b: hue = (r - g) / d + 4; break;
    }
    hue *= 60;
  }
  return `${hue.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
}

/**
 * Apply branding colors as global CSS variables consumed by Tailwind.
 *
 * Tailwind expects HSL tuples (e.g. "352 52% 32%") because `tailwind.config.ts`
 * wraps each var inside `hsl(...)`. Passing HEX here breaks every utility that
 * reads --brand / --brand-light / --brand-dark.
 */
export function applyBrandingVars(branding: Pick<TenantBranding, "primary_color" | "secondary_color">) {
  if (typeof document === "undefined") return;
  const primary = branding.primary_color || DEFAULT_PRIMARY;
  const root = document.documentElement;

  const primaryHsl = hexToHslTuple(primary);
  const darkHsl    = hexToHslTuple(shade(primary, -15));
  const lightHsl   = hexToHslTuple(shade(primary,  15));

  if (primaryHsl) root.style.setProperty("--brand",        primaryHsl);
  if (darkHsl)    root.style.setProperty("--brand-dark",   darkHsl);
  if (lightHsl)   root.style.setProperty("--brand-light",  lightHsl);

  // Mantener también el HEX crudo para componentes que pintan inline
  // (style={{ backgroundColor: accent }} en login/topbar/widget).
  root.style.setProperty("--brand-primary", primary);

  if (branding.secondary_color) {
    const secHsl = hexToHslTuple(branding.secondary_color);
    if (secHsl) root.style.setProperty("--brand-secondary", secHsl);
  }
}

/**
 * Resolves the active tenant from (in order):
 *   1. ?tenant= query param
 *   2. NEXT_PUBLIC_DEFAULT_TENANT env var
 *   3. localStorage 'tenant_id' (set after login)
 *   4. null → caller falls back to generic branding
 */
function resolveTenantId(): string | null {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("tenant");
  if (fromQuery) return fromQuery;

  const fromEnv = process.env.NEXT_PUBLIC_DEFAULT_TENANT;
  if (fromEnv) return fromEnv;

  const fromStorage = localStorage.getItem("tenant_id");
  if (fromStorage && fromStorage !== "__platform__") return fromStorage;

  return null;
}

export const GENERIC_BRANDING: TenantBranding = {
  tenant_id:        "",
  display_name:     "Plataforma IA",
  logo_url:         null,
  primary_color:    DEFAULT_PRIMARY,
  secondary_color:  null,
  favicon_url:      null,
  bot_name:         null,
  greeting_message: null,
};

/**
 * Loads the tenant's branding (logo, colors, display name) and applies the
 * primary color as a CSS variable `--brand-primary` on <html>.
 *
 * Returns generic fallback while loading or if no tenant could be resolved,
 * so the UI never shows hardcoded brand assets.
 */
export function useTenantBranding(): { branding: TenantBranding; isLoading: boolean } {
  const tenantId = typeof window !== "undefined" ? resolveTenantId() : null;

  const { data, isLoading } = useQuery({
    queryKey: ["tenant-branding", tenantId],
    queryFn: () => api.branding.get(tenantId!),
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const branding = data ?? GENERIC_BRANDING;

  useEffect(() => { applyBrandingVars(branding); }, [branding.primary_color, branding.secondary_color]);

  return { branding, isLoading: isLoading && !!tenantId };
}
