"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TenantBranding } from "./api";

const DEFAULT_PRIMARY = "#99323D";

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

/** Apply branding colors as global CSS variables. Used by hook + public pages. */
export function applyBrandingVars(branding: Pick<TenantBranding, "primary_color" | "secondary_color">) {
  if (typeof document === "undefined") return;
  const primary = branding.primary_color || DEFAULT_PRIMARY;
  document.documentElement.style.setProperty("--brand-primary", primary);
  document.documentElement.style.setProperty("--brand-dark",   shade(primary, -15));
  document.documentElement.style.setProperty("--brand-light",  shade(primary,  15));
  if (branding.secondary_color) {
    document.documentElement.style.setProperty("--brand-secondary", branding.secondary_color);
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

const GENERIC_BRANDING: TenantBranding = {
  tenant_id:        "",
  display_name:     "Plataforma",
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
