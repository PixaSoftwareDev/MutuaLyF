/**
 * Decodifica el payload de un JWT del lado del cliente (solo para leer claims
 * como role/tenant_id tras el login — la validación real es del backend).
 *
 * El payload de un JWT es **base64url** (usa '-' y '_' en vez de '+' y '/') y
 * puede venir sin padding. `atob()` solo acepta base64 estándar con padding:
 * sin esta normalización, un claim que generara '-'/'_' rompía el decode y el
 * login no entraba aunque las credenciales fueran correctas. Además se decodifica
 * como UTF-8 para soportar claims con tildes/ñ (ej. nombres).
 *
 * Devuelve null si el token es inválido — el caller decide qué hacer.
 */
export function decodeJwtPayload<T = Record<string, unknown>>(token: string): T | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    let b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4); // padding faltante
    const json = decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
