import type { ReadonlyURLSearchParams } from "next/navigation";

// Navegación de Canales — la URL es la ÚNICA fuente de verdad:
//   ?canal=all | widget (default) | link | whatsapp
//   ?sub=instalar (default) | personalizar   (solo aplica al canal widget)
// Parseo centralizado: si mañana se agrega un canal, se toca solo acá.

export type CanalKey = "all" | "widget" | "link" | "whatsapp";
export type WidgetSub = "instalar" | "personalizar";

export function parseCanal(params: ReadonlyURLSearchParams): CanalKey {
  const raw = params.get("canal");
  return raw === "whatsapp" ? "whatsapp" : raw === "link" ? "link" : raw === "all" ? "all" : "widget";
}

export function parseWidgetSub(params: ReadonlyURLSearchParams): WidgetSub {
  return params.get("sub") === "personalizar" ? "personalizar" : "instalar";
}

export function canalHref(canal: Exclude<CanalKey, "all">, sub?: WidgetSub): string {
  return `/admin/settings/canales?canal=${canal}${sub ? `&sub=${sub}` : ""}`;
}
