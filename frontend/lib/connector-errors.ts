// Traducción de fallos técnicos de conectores a lenguaje que un admin no-técnico
// entiende, con el próximo paso concreto. La idea de Capa 4: que el que conecta su
// API pueda resolver solo, sin saber qué es un 401 ni un timeout.

/** Explica un código de estado HTTP de una prueba de operación, en criollo.
 *  Devuelve { label, hint }: label es una palabra corta para la pastilla,
 *  hint es la explicación con el próximo paso. null si el status es OK/desconocido. */
export function explainHttpStatus(status: number | string | null | undefined): { label: string; hint: string } | null {
  const n = typeof status === "string" ? parseInt(status, 10) : status;
  if (!n || (n >= 200 && n < 300)) return null;
  if (n === 400 || n === 422)
    return { label: "falta un dato", hint: "El proveedor esperaba un dato obligatorio que no le mandamos, o vino con otro formato. Suele pasar al probar con un valor de ejemplo; en uso real el bot manda datos válidos." };
  if (n === 401)
    return { label: "credencial", hint: "La credencial no es válida o está vencida. Cargala de nuevo en “Configurar → Credencial”." };
  if (n === 403)
    return { label: "sin permiso", hint: "El proveedor rechazó el acceso con esta credencial. Puede que le falten permisos para esta ruta." };
  if (n === 404)
    return { label: "no existe", hint: "El proveedor no encontró esa dirección. Revisá la URL base (¿sobra o falta un tramo como /api?) o que el dato de prueba exista." };
  if (n === 429)
    return { label: "límite", hint: "El proveedor cortó por demasiadas consultas seguidas. Esperá un momento y reintentá." };
  if (n >= 500)
    return { label: "error del proveedor", hint: "El servidor del proveedor tuvo un error interno. No es tu configuración: probá más tarde o avisale al proveedor." };
  return { label: `HTTP ${n}`, hint: "El proveedor respondió con un estado inesperado." };
}

/** Traduce un mensaje de error crudo (detail del backend o texto de excepción) a
 *  una explicación accionable. Si no reconoce el patrón, devuelve el crudo tal cual
 *  (nunca esconde información). */
export function humanizeConnectorError(raw: string | undefined | null): string {
  const s = (raw || "").toLowerCase();
  if (!s) return "Ocurrió un error.";

  // Aprobación de host (activar) — el backend ya lista los hosts pendientes; sumamos el paso.
  if (s.includes("pendientes de aprob") || s.includes("aprobación por el super") || s.includes("super-admin")) {
    return `${raw} Pedile al super-admin que apruebe el host para tu organización y reintentá.`;
  }
  if (s.includes("timeout") || s.includes("read timed out") || s.includes("timed out"))
    return "El proveedor tardó demasiado en responder. Puede estar lento o caído — probá de nuevo en un rato.";
  if (s.includes("getaddrinfo") || s.includes("name or service") || s.includes("connection refused") || s.includes("failed to establish") || s.includes("connecterror"))
    return "No pude conectarme a esa dirección. Revisá que la URL base sea correcta y que el servidor esté online.";
  if (s.includes("401") || s.includes("unauthorized"))
    return "La credencial no es válida o está vencida. Cargala de nuevo en “Configurar → Credencial”.";
  if (s.includes("403") || s.includes("forbidden"))
    return "El proveedor rechazó el acceso con esta credencial (le pueden faltar permisos).";
  if (s.includes("404") || s.includes("not found"))
    return "No encontré esa dirección en el proveedor. Revisá la URL base (¿sobra o falta un tramo como /api?).";
  if (s.includes("requiere username") || s.includes("falta el usuario") || s.includes("username"))
    return "Esta autenticación (Basic) necesita un usuario además de la contraseña. Cargalo en la credencial.";
  if (s.includes("json") || s.includes("expecting") || s.includes("parse") || s.includes("no devolvió"))
    return "El proveedor respondió algo que no pude interpretar. Puede que la documentación no describa rutas claras — probá subiendo el archivo completo.";
  if (s.includes("ya existe un conector con slug") || (s.includes("slug") && s.includes("existe")))
    return "Ya tenés un conector con un nombre parecido. Cambiá el nombre por uno distinto y probá de nuevo.";
  if (s.includes("no pude analizar el api"))
    return "No encontré el catálogo del API en esa dirección. Si el proveedor no lo publica, subí la documentación (PDF/Word) con el botón “Subir documentación”.";

  return raw || "Ocurrió un error.";
}
