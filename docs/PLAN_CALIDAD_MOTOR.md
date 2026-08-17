# Plan de consolidación del motor RAG — controlado y medido

> Regla de oro: **ningún cambio del motor avanza sin demostrar mejora medida.**
> Si una métrica guardián empeora, el cambio se revierte y se documenta acá por qué.
> Estado vivo: actualizar la tabla de fases al cerrar cada checkpoint.

## Las métricas (se miden TODAS, en cada corrida)

| Métrica | Qué mide | Regla |
|---|---|---|
| **Correctas** | respuestas correctas sobre preguntas respondibles | nunca puede bajar |
| **Alucinadas** | afirmaciones sin respaldo en documentos | solo puede bajar |
| **Evasivas** | "no sé" sobre preguntas que la KB responde | solo puede bajar |
| **Honestas** | "no tengo info" sobre preguntas sin cobertura real | debe acompañar a las trampas |
| **Latencia p50 / p95** | por categoría de pregunta | p50 no puede subir >10%; p95 no puede superar SLA (2.5s simple / 8s compleja) |
| **Costo por consulta** | tokens LLM (generación + juez) | se reporta; subas requieren justificación explícita |

Calificación: juez LLM contra respuesta esperada (rúbrica: correcta / parcial /
incorrecta / alucinada / evasiva), con prompt DISTINTO al juez del trust gate
(un juez no se auto-aprueba) + muestra revisada a mano por corrida.

## El instrumento: dataset de evaluación (Fase 1)

- **150-300 casos**, no baterías de juguete. Fuentes:
  1. Consultas reales de prod (`consultas_log`, muestreo estratificado, solo lectura)
  2. Gold sets de las Pruebas 2 y 3 (respuestas esperadas ya escritas)
  3. Cobertura por documento: N preguntas que cada doc del corpus responde
  4. Trampas de temas ausentes, **verificadas contra el corpus** (el corpus decide
     la etiqueta, no la intuición — lección radiografías 2026-07-23)
  5. Variantes duras: paráfrasis, typos, sinónimos, mixtas, listados
- Cada bug real de prod se agrega al dataset y no puede volver (test de regresión).
- El dataset corre contra dev-local (corpus clonado en tenant de prueba) y contra
  staging antes de cada pasaje.

## Protocolo por cambio (sin excepciones)

1. **Baseline**: correr el dataset ANTES del cambio → snapshot versionado.
2. Cambio en dev-local, detrás de **flag** cuando sea posible (comparación ON/OFF).
3. Correr el dataset DESPUÉS → comparar contra baseline, tabla por categoría.
4. **Gate**: pasa solo si mejora lo que dice mejorar y no empeora ninguna guardián.
5. Commit chico y temático (revertible solo). Score baja → revert + nota acá.
6. Nada llega a prod sin repetir la corrida en staging.

## Fases y checkpoints

| Fase | Contenido | Criterio de salida (checkpoint) | Estado |
|---|---|---|---|
| **F0** | Trust gate (hecho) | 33/33 batería dura en staging; 0 alucinaciones, 0 regresiones en controles | ✅ 2026-07-23 |
| **F1** | Dataset completo + runner con rúbrica y latencias | dataset ≥150 casos estratificados; corrida baseline versionada y revisada a mano (muestra) | ✅ 2026-07-23 — 168 casos ejecutables: 149 single-turn + 16 turnos multi-turno (cat 10, antes no se ejecutaba) + 3 escenarios de derivación por flujo real del widget (cat 12, nueva; 3/3 PASS). Pendiente menor: muestreo de consultas_log de prod |
| **F2a** | Instrumentar señal de confianza (log de scores crudos + veredicto del gate por consulta) | datos de ≥500 consultas reales acumulados | ✅ instrumentado (best_rrf/best_cos en log trust_gate, commit 48fea1f); acumulación de datos reales en curso |
| **F2b** | Calibrar umbral único + reactivar corte duro + achicar zona gris del juez | evasivas ↓ y p95 ↓ vs baseline; correctas sin bajar | ◐ lex_strong calibrado empíricamente (0.5; 0.7 probado y revertido — evasivas x2). Corte duro espera datos de F2a (2026-08-17: solo ~50 de 500 consultas, y la señal vive en logs que ROTAN — persistirla en consultas_log es el próximo paso). **Resuelto 2026-08-17** (commits c2e2f63+982aba8, A/B 130 casos, cat 10 85→90% PASS, cat 11 100%, 0 regresiones): la contextualización de repreguntas — el enriquecedor de keywords corría ENCIMA del rewriter y lo salteaba; ahora el rewriter recibe la consulta limpia + historial (con historial reescribe siempre) y corre EN PARALELO con el embedding y la búsqueda original. Cayeron conv_02_t2 y tp_04. ⚠️ QUERY_REWRITING_ENABLED sigue false en staging/prod: se prende al medir latencia en staging (el A/B de junio que lo apagó era pre-cat-10). Casos abiertos: s_10/s_12 (multi-hop), f_19 (numérico en tabla: la fila pierde su encabezado al chunkear), y conv_02_t3/conv_08_t2 que ya NO son de retrieval (la consulta llega perfecta, cos 0.83) sino del JUEZ, que rechaza material parcialmente respondiente en vez de responder lo que sí está |
| **F3** | Poda: reranker muerto fuera, parches compensatorios redundantes, invalidación de caches centralizada | cada poda = 1 commit + corrida verde; los parches que el dataset defienda se QUEDAN | ✅ reranker eliminado (-320 líneas, gate verde idéntico pre/post; commit 48fea1f). Parche max(score,cosine) DEFENDIDO por la suite, se queda. Pendiente: helper de invalidación de caches |
| **F4** | Pasaje: converger las 3 ramas, revertir parche staging, TEI fuera del compose, CLAUDE.md al stack real | dataset verde en staging + smoke prod + drift VPS rescatado | ✅ **2026-07-26/27** — las 3 ramas quedaron IDÉNTICAS (main=dev=dev-local), cadena de migraciones convergida en rev 044 (el doble "033" renumerado a 036), drift eb2a014 respaldado en tag `rescate-trustgate-eb2a014` y superado, pasaje a prod validado por Alejo en staging + smoke prod verde (70/70 tests en contenedor), CLAUDE.md reescrito al stack real (2026-07-27). Conectores quedó OCULTO en prod por flags hasta validarse |

### Lecciones incorporadas al método (2026-07-23)
- Verificar presencia en corpus SIEMPRE con raíz sin tildes (3 etiquetas mal
  puestas por "óptica"≠"optica"). El corpus decide, no la intuición.
- Una corrida con todas las respuestas rotas pasó la rúbrica vieja con 90% —
  correctness debe ser eliminatorio y el instrumento debe medir su propia
  validez (latencia del lado cliente, retry de sentinels de rate-limit).
- El costo de calibrar sin datos: lex_strong 0.7 parecía razonable y duplicó
  las evasivas. Toda perilla nueva se mueve con la suite mirando.

## Riesgos aceptados y su control

- **Bot más evasivo por umbrales agresivos** → métrica guardián "evasivas" + los
  controles respondibles del dataset. Es LA métrica que decide en F2b.
- **Una poda rompe un caso borde que el parche sostenía** → podas de a un commit,
  dataset como juez, revert inmediato documentado.
- **El juez del dataset se equivoca** → muestra manual por corrida + prompt
  independiente del juez del runtime.
- **Deriva staging/prod durante el plan** → F4 al final converge todo; hasta
  entonces, prod no se toca salvo incidente.
