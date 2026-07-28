// Flags de build por ambiente (NEXT_PUBLIC_* se inlinean en compilación).
//
// CONNECTORS_UI: superficie de "Fuentes de datos" (conectores) en el panel
// admin. Default HABILITADO — dev y staging no necesitan configurar nada.
// Prod se buildea con NEXT_PUBLIC_CONNECTORS_UI=false hasta que la feature
// esté validada: mismo código en todos los ambientes, solo cambia el flag
// (nunca comentar código para ocultar features — genera drift entre ramas).
// El runtime del backend se apaga aparte con CONNECTORS_ENABLED=false.
export const CONNECTORS_UI_ENABLED = process.env.NEXT_PUBLIC_CONNECTORS_UI !== "false";

// FEEDBACK_UI: caritas al cierre del chat + cola de revisión del admin.
// Default HABILITADO (dev-local). Staging/prod se buildean con
// NEXT_PUBLIC_FEEDBACK_UI=false hasta validar la feature — mismo criterio
// que conectores: mismo código en todos los ambientes, solo cambia el flag.
export const FEEDBACK_UI_ENABLED = process.env.NEXT_PUBLIC_FEEDBACK_UI !== "false";
