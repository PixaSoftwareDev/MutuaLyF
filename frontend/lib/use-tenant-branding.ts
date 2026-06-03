"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TenantBranding } from "./api";

export const DEFAULT_PRIMARY = "#99323D";

/** Darken (negative) or lighten (positive) a hex color by `pct` percent. */
export function shade(hex: string, pct: number): string {
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
 * Calcula luminancia relativa segun WCAG (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
 * 0 = negro, 1 = blanco.
 */
function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length !== 6) return 1;
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(h.slice(0, 2), 16));
  const g = channel(parseInt(h.slice(2, 4), 16));
  const b = channel(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hex1: string, hex2: string): number {
  const L1 = relativeLuminance(hex1);
  const L2 = relativeLuminance(hex2);
  const [bright, dark] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (bright + 0.05) / (dark + 0.05);
}

/**
 * Devuelve "#ffffff" o "#0f172a" segun cual contrasta mejor con el primary.
 * Garantiza que texto puesto encima del color de marca cumpla WCAG AA (>=4.5:1)
 * cuando es posible — si el primary es tan medio que ninguno cumple, devuelve
 * el menos malo y dejamos que el panel admin avise al usuario.
 */
export function pickReadableTextColor(primary: string): "#ffffff" | "#0f172a" {
  const whiteRatio = contrastRatio(primary, "#ffffff");
  const darkRatio  = contrastRatio(primary, "#0f172a");
  return whiteRatio >= darkRatio ? "#ffffff" : "#0f172a";
}

/**
 * Color de fondo apropiado para mostrar el LOGO del tenant.
 *
 * Problema concreto: si el cliente sube un PNG transparente con un logo
 * blanco (caso muy comun en branding profesional) y lo ponemos sobre fondo
 * blanco, el logo desaparece. Idem logos negros sobre fondo oscuro.
 *
 * Estrategia:
 *  - Si el primary_color del tenant es OSCURO (luminancia baja), usarlo:
 *    los logos blancos van a destacar perfecto, los oscuros tambien
 *    porque el contraste es suficiente.
 *  - Si el primary_color es CLARO (>0.7 luminancia), usar un slate-800
 *    en su lugar: el logo del cliente (sea claro u oscuro) se va a ver.
 *  - Sin primary_color, devolver slate-800 como default.
 *
 * En el peor caso (logo blanco + primary blanco-puro), igual queda sobre
 * slate-800 y se ve. Cubre el 99% de los casos sin pedir nada al admin.
 */
export function pickLogoBackgroundColor(primary: string | null | undefined): string {
  if (!primary) return "#1e293b"; // slate-800
  const h = primary.replace("#", "");
  if (h.length !== 6) return "#1e293b";
  // Reutiliza la formula WCAG via contrastRatio contra blanco:
  // logos blancos necesitan fondo cuyo contraste con blanco sea decente.
  const contrastVsWhite = contrastRatio(primary, "#ffffff");
  if (contrastVsWhite < 2.0) {
    // primary muy claro (casi blanco) → fallback a slate-800
    return "#1e293b";
  }
  return primary;
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

  // Color de texto WCAG-safe para encima del primary. Sin esto, si el cliente
  // elige un primary claro (#ffe000, #b9f6ca) los botones quedaban con texto
  // blanco sobre claro = ilegibles. Componentes que necesiten "texto sobre brand"
  // deben usar var(--brand-foreground).
  //
  // CRÍTICO: tailwind consume esta var como `hsl(var(--brand-foreground))`, así
  // que DEBE ser una tupla HSL ("H S% L%"), nunca un hex. Setear un hex acá
  // generaba `hsl(#0f172a)` (inválido) → el browser descartaba la regla y el
  // texto heredaba negro sobre el fondo de marca (bug: letra negra sobre rojo).
  const fgHsl = hexToHslTuple(pickReadableTextColor(primary));
  if (fgHsl) root.style.setProperty("--brand-foreground", fgHsl);

  if (branding.secondary_color) {
    const secHsl = hexToHslTuple(branding.secondary_color);
    if (secHsl) root.style.setProperty("--brand-secondary", secHsl);
  }
}

/**
 * Resolves the active tenant from (in order):
 *   1. localStorage 'tenant_id' (set after login, fuente de verdad de la sesion)
 *   2. ?tenant= query param (override manual: previews, soporte)
 *   3. null → caller falls back to generic branding
 *
 * Antes mirabamos NEXT_PUBLIC_DEFAULT_TENANT (env var hardcoded en build prod
 * = "mutual") con prioridad sobre localStorage, lo que pisaba el tenant del
 * usuario logueado. Sacado: el branding viene SIEMPRE del JWT del usuario.
 */
function resolveTenantId(): string | null {
  if (typeof window === "undefined") return null;

  const fromStorage = localStorage.getItem("tenant_id");
  if (fromStorage && fromStorage !== "__platform__") return fromStorage;

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("tenant");
  if (fromQuery) return fromQuery;

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

// Cache sincronico del branding en localStorage para evitar flash al refrescar.
// React Query trae el branding async (~100-300ms) — durante ese tiempo el navbar
// renderizaba con GENERIC_BRANDING y despues saltaba al del tenant. Persistimos
// la ultima respuesta para usarla como placeholder instantaneo.
//
// El cache es un mapa { tenant_id -> branding }: el chat publico abre /chat
// con distintos tenants en el mismo browser (admin de novatech prueba mientras
// otro tab tiene mutual abierto) — si guardamos solo un branding pisamos al
// del tab anterior y aparece el flash igual.
const BRANDING_CACHE_KEY = "tenant_branding_cache";

type BrandingCacheV2 = Record<string, TenantBranding>;

function readCacheMap(): BrandingCacheV2 {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(BRANDING_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Backward compat: si el cache viejo (v1) tenia forma { tenant_id, branding },
    // lo migramos a mapa. Si ya es mapa, lo devolvemos tal cual.
    if (parsed && typeof parsed === "object" && "tenant_id" in parsed && "branding" in parsed) {
      return { [parsed.tenant_id]: parsed.branding };
    }
    return parsed as BrandingCacheV2;
  } catch {
    return {};
  }
}

export function readCachedBranding(tenantId: string): TenantBranding | null {
  if (!tenantId) return null;
  const map = readCacheMap();
  return map[tenantId] ?? null;
}

export function writeCachedBranding(tenantId: string, branding: TenantBranding): void {
  if (typeof window === "undefined" || !tenantId) return;
  try {
    const map = readCacheMap();
    map[tenantId] = branding;
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(map));
  } catch {
    /* localStorage full or disabled — flash en proximo refresh, no es critico */
  }
}

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
    queryFn: async () => {
      const fresh = await api.branding.get(tenantId!);
      writeCachedBranding(tenantId!, fresh);
      return fresh;
    },
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    // placeholderData hace que el primer render no parpadee: usa el branding
    // cacheado del refresh anterior (sincronico) hasta que el fetch confirme.
    placeholderData: tenantId ? readCachedBranding(tenantId) ?? undefined : undefined,
  });

  const branding = data ?? GENERIC_BRANDING;

  useEffect(() => { applyBrandingVars(branding); }, [branding.primary_color, branding.secondary_color]);

  return { branding, isLoading: isLoading && !!tenantId };
}
