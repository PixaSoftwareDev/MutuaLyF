/**
 * Normaliza el error de una request (axios) a un texto legible en español.
 *
 * Cubre los casos que rompían la UI o mostraban jerga:
 *  - `detail` string → se usa tal cual (el backend ya responde en español).
 *  - `detail` array (422 de FastAPI/Pydantic) → toma el primer `msg` en vez de
 *    renderizar `[object Object]` o el JSON crudo.
 *  - Sin respuesta del server (red caída / server abajo) → mensaje de conexión.
 *  - Cualquier otro → el `fallback` provisto.
 *
 * Usar SIEMPRE esto en los `onError`/`catch` en vez de leer `err.response.data.detail`
 * directo, para no exponer texto técnico ni "[object Object]" al usuario.
 */
export function extractErrorMessage(
  err: any,
  fallback = "Algo salió mal. Probá de nuevo.",
): string {
  const detail = err?.response?.data?.detail;

  if (typeof detail === "string" && detail.trim()) return detail;

  if (Array.isArray(detail) && detail.length && typeof detail[0]?.msg === "string") {
    return detail[0].msg;
  }

  // axios no setea `response` cuando la request no llegó (red / server abajo).
  if (
    err?.response === undefined &&
    (err?.request || err?.code === "ERR_NETWORK" || err?.message === "Network Error")
  ) {
    return "No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.";
  }

  return fallback;
}
