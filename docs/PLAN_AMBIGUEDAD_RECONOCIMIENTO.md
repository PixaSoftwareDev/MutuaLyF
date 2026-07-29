# Plan: los 4 hallazgos de la prueba de ambigüedad (2026-07-28)

Origen: batería de 30 preguntas en el navegador contra RAG + conectores
(transcript en la sesión del 28/07). Resultado 23✓/4~/2✗. Este plan ataca las
causas raíz de los 6 casos no-fuertes, con criterio: soluciones genéricas
(cero hardcodeo de tenant/rubro), que escalen con el catálogo y el corpus, y
que queden protegidas por evals — no parches por síntoma.

Regla transversal: **nada de regex-whack-a-mole ni casos especiales por
tenant**. Si la solución menciona "Pixs", "Handicapp" o "películas", está mal
diseñada.

---

## Hallazgo 1 — "hola, que tal?" → "No encontré esa información"

**Causa raíz (dos capas):**
1. Hay DOS detectores de charla trivial duplicados y ninguno cubre este caso:
   `prompt_builder.is_small_talk` (excluye "?" a propósito) y
   `handoff._CHITCHAT_RE` (otro regex, otra lista). Duplicación = el mismo
   patrón que ya nos costó dos bugs (personalidades, frontera).
2. El corte duro anti-alucinación (`hard_fallback`: score < piso → respuesta
   determinística SIN LLM) asume que **toda consulta de score bajo es un
   pedido de información**. Un saludo no lo es: no hay nada que alucinar, y la
   respuesta correcta la daría el módulo de tono por dos mangos de tokens.

**Solución (genérica, un solo dueño):**
- Extraer UN clasificador de tipo de turno (`turn_kind: chitchat | consulta`)
  a un módulo único (vive junto a prompt_builder), consumido por los tres
  callers: builder (poda), handoff (filtro de insuficiencia) y orquestador
  (bypass del hard_fallback). Une los dos regex existentes + saludos con "?".
- Semántica nueva del corte duro: `hard_fallback` solo aplica a
  `turn_kind=consulta`. Chitchat va al LLM con prompt podado (tono + alcance
  + idioma ≈ 2k tokens) — barato y responde como persona.
- El clasificador sigue siendo cobarde: ante la duda es `consulta` (el costo
  de equivocarse hacia consulta es un saludo seco; hacia chitchat es una
  consulta sin responder — asimetría que define el default).

**Por qué escala:** un solo punto de verdad para "esto es charla"; agregar
idiomas/patrones se hace una vez. **Verificación:** casos en
test_prompt_builder + turnos de saludo con "?" en la chat suite. Esfuerzo: S.

---

## Hallazgo 2 — "quiero ver algo bueno esta noche" → rechazo por alcance

**Causa raíz:** el router unificado decide con las descripciones del catálogo;
sin NINGUNA palabra del dominio en la consulta (ni "película"), no hay
superficie de match. El campo `examples` está vacío en todas las tools (el
flywheel existe pero nadie lo alimentó) — esto ya lo diagnosticamos a la
mañana: es el gap de catálogo, no un bug del prompt.

**Solución en dos piezas complementarias (ambas ya diseñadas, cero carga del
admin — decisión explícita de Guille):**
1. **Ejemplos autogenerados en el discovery**: al aplicar operaciones, un paso
   LLM genera N consultas de ejemplo por tool — incluyendo deliberadamente
   fraseos indirectos y coloquiales sin vocabulario del dominio ("quiero ver
   algo bueno", "qué me recomendás"). Se guardan en `examples` (la palanca que
   `_tool_description` ya concatena al schema). El admin puede podar en el
   panel, nunca redactar. El flywheel existente (`tool_example_candidates`,
   consultas reales ruteadas) los refina con el uso — modo sugerencia, como
   las intenciones.
2. **Shortlist de tools por turno** (docs/DISENO_TOOL_RETRIEVAL.md): prefiltro
   por embeddings consulta↔(descripción+ejemplos) → top-K schemas adjuntos en
   vez del catálogo entero. Doble ganancia: el router elige mejor con menos
   ruido (medido: más tools = peor pick) y el costo deja de crecer O(catálogo)
   — hoy 23 tools ≈ 2k tokens por turno hasta en "hola"; con 5 conectores
   sería impagable. Salvaguardas: K generoso, incluir siempre las tools usadas
   recientemente en la conversación, y "ninguna" siempre posible.

**Por qué escala:** los ejemplos viajan en el embedding del prefiltro, no solo
en el prompt — mejoran el recall del shortlist sin engordar el system.
**Verificación:** extender `eval_scope_phrasing.py` con variantes indirectas
autogeneradas (sin palabra de dominio) por tool — la eval se genera sola, no
se curan casos a mano. Umbral de regresión. Esfuerzo: M (ejemplos) + M-L
(shortlist).

**Anti-patrón a evitar:** agregar "recomendaciones" al texto del alcance o al
router — sería hardcodear el dominio del tenant actual en un prompt global
(la lección del 27/07).

---

## Hallazgo 3 — "¿tenemos algo por cobrarle?" ignora el "le" (Mutual de los Arroyos)

**Causa raíz (hipótesis a confirmar ANTES de tocar código):** la memoria
conversacional de recursos (x-resource-id, 2026-07-23) resuelve referencias
para rutas de DETALLE ("contame más del segundo" ✓ — funcionó), pero no se
inyecta como argumento/filtro en tools de LISTADO, y la síntesis de la
respuesta tampoco aplica la correferencia al resumir. Puede además que la tool
de cobros ni tenga parámetro de filtro (forma del API del proveedor).

**Plan de diagnóstico (primero):** leer `tool_call_audit` del turno real —
qué tool corrió, con qué args, qué devolvió — y el `params_schema` de la tool
de cobros. Tres desenlaces posibles con tres fixes distintos:

- **(a) La tool tiene filtro y el LLM no lo usó** → inyectar la memoria de
  entidades recientes (con procedencia) como bloque en la llamada unificada:
  "entidades de esta conversación: [...] — si la consulta las refiere,
  usalas como argumento". Genérico: la memoria ya existe, solo no llega al
  prompt de decisión.
- **(b) La tool no tiene filtro** → el fix va en la SÍNTESIS, no en el ruteo:
  regla genérica en el paso que redacta sobre resultados de tools: "si la
  consulta refiere a una entidad de la conversación y los resultados incluyen
  varias, respondé sobre ESA y ofrecé el resto; si no aparece, decilo
  explícitamente" (hoy respondió el listado entero como si fuera la
  respuesta). Cero conocimiento del schema — escala a cualquier proveedor.
- **(c) Ambas** → (a) + (b); (b) es la red de seguridad universal.

**Verificación:** caso multi-turno en la chat suite (lista → "el segundo" →
pregunta filtrada) + caso en eval. Esfuerzo: S (diagnóstico) + M (fix).

---

## Hallazgo 4 — "el mail de ventas NUESTRO" → dio el de Handicapp (producto), no el de Pixs (empresa)

**Causa raíz:** el corpus tiene el mismo TIPO de dato (contacto) para VARIOS
sujetos (la empresa y cada producto). El retrieval trajo el chunk del
producto (léxicamente competitivo) y el LLM no desambiguó el sujeto. No es
alucinación (ambos datos son reales y verificados en el corpus): es selección
de sujeto equivocada. Misma familia que los 2 gaps del QA50 de la otra sesión
(Enzo ausente como contacto comercial; Play Store→app.handicapp) y que el
caso histórico Junín 2956/2961.

**Ya tenemos la infraestructura para esto y no disparó** — el detector de
contradicciones con facts canónicos POR SUJETO (2026-07-08) existe
exactamente para "mismo campo, sujetos distintos", con inyección query-time.

**Plan:**
1. **Diagnóstico primero:** ¿el detector extrajo los facts de contacto de este
   corpus (re-ingestado el 22/07)? ¿La inyección query-time matcheó "ventas
   nuestro"? Hipótesis: los facts existen pero la clave de matcheo de la
   query no cubre posesivos/"nuestro".
2. **Fix genérico A (facts):** cuando la consulta pide un dato de contacto en
   posesivo/1ª persona del plural ("nuestro", "de ustedes", "de la
   organización"), la inyección de facts prioriza el sujeto ORGANIZACIÓN por
   sobre sujetos producto/sede — el grafo de sujetos ya distingue niveles.
3. **Fix genérico B (prompt, red de seguridad):** generalizar el módulo
   `nombres` (que ya maneja "varias entidades coinciden → presentá todas"):
   si el contexto trae el mismo tipo de dato para varios sujetos, etiquetar
   de quién es cada uno o preguntar — nunca elegir uno en silencio. Es una
   oración en un módulo existente, no un módulo nuevo (política de alta).
4. **Coordinación obligatoria:** la OTRA sesión de Claude tiene estos gaps
   anotados de su QA50 — antes de implementar, revisar si ya empezó algo para
   no duplicar (y COMMITEAR: 5+ sesiones acumuladas hacen imposible saber
   quién tocó qué).

**Verificación:** los 3 casos de la familia (mail/wa nuestro, Enzo comercial,
Play Store) como turnos de la suite. Esfuerzo: S-M.

---

## Secuencia propuesta y por qué

0. **Commit del working tree** (bloqueante para trabajar en paralelo sano).
1. Hallazgo 1 (S, autocontenido, mejora visible inmediata).
2. Hallazgo 4 diagnóstico + fixes (S-M, coordinado con la otra sesión).
3. Hallazgo 3 diagnóstico + fix (S+M — el diagnóstico decide el fix).
4. Hallazgo 2 pieza 1 (ejemplos autogenerados, M) → medir con la eval
   extendida → pieza 2 (shortlist, M-L) que además es el trabajo de
   escalabilidad/costo ya analizado (prompt caching + tools O(K)).

Presupuesto de verificación por paso: tests unitarios (gratis) + eval
dirigida del área tocada + 2-3 turnos de smoke. Las suites completas solo
antes de deploy (disciplina de consumo acordada).
