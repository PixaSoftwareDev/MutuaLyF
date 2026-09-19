# Límites conocidos — qué sabemos que el bot no responde bien

> Actualizado al **2026-09-19**. Sirve para dos cosas: que nadie se sorprenda
> cuando un evaluador pegue justo acá, y que la respuesta al cliente sea "está
> identificado y medido" en vez de una improvisación.
>
> Regla: si un caso deja de fallar, se saca de acá con la medición que lo
> prueba. Si aparece uno nuevo, se agrega con su caso de la suite.

## Estado de la medición (2026-09-18, corpus REAL de MutuaLyF, staging)

```
casos: 30/30 en umbral   |   corridas: 89/92   |   483 s
```

Las 3 corridas que fallan son **un solo caso, conocido y aceptado** (el
teléfono de OSFATLYF, abajo). Pasan al 100%: datos duros (ubicación, horarios,
turnos, afiliación, cronicidad), conversaciones multi-turno con cambio de tema,
premisas falsas, trampas (dato inexistente, URL inventada, fuera de alcance,
inyección de prompt), ambigüedad de nombres de profesionales y reglas de
alcance.

Cómo reproducirlo:

```bash
docker cp scripts/run_regresion_corpus.py ia_backend_staging:/tmp/
docker exec -w /app ia_backend_staging python /tmp/run_regresion_corpus.py \
  --tenant mutualyf --dataset /app/tests/quality/regresion_mutualyf.yaml
```

Vacía el cache antes de correr: sin eso se mide el cache, no el motor.

---

## 1. Teléfono de OSFATLYF — límite aceptado por decisión de producto

**Qué pasa:** el corpus tiene, como dato de contacto de facturación, el
teléfono de **otra** organización (OSFATLYF). Preguntado directo, el bot lo
niega 2 de cada 3 veces ("no encontré esa información").

**Por qué no se fuerza:** se investigó a fondo (rewriter, regla de tenant,
ablación del prompt) sin encontrar una causa puntual, y forzarlo implicaba que
la plataforma pise al tenant en vez de interpretarlo. La decisión (2026-09-05)
fue dejarlo como límite conocido, con umbral 0 en la suite.

**Qué decir si aparece:** es un dato de un tercero dentro del corpus del
cliente; el bot es conservador con datos que no puede atribuir a la
organización. Se resuelve del lado del contenido, marcando ese dato como
propio del tenant en el documento fuente.

## 2. "¿Qué horario tienen ustedes?" — xfail documentado

Preguntado de forma genérica, el bot puede atribuir el horario de la sede al
Centro Médico. Con la pregunta específica ("horario del Centro Médico",
"horario de la sede") responde bien.

## 3. Datos dentro de tablas (caso `f_19`)

Al partir una tabla, la fila puede perder su encabezado y el dato numérico
llega incompleto al modelo. **Medido sobre el corpus sintético de `demo`, no
sobre el de MutuaLyF**, donde hoy no se manifiesta. Riesgo latente si el
cliente carga documentos con tablas de montos o plazos.

## 4. Preguntas compuestas / multi-hop (casos `s_10`, `s_12`)

Preguntas que exigen combinar dos hechos de documentos distintos. Igual que el
anterior: abierto en el corpus sintético, sin manifestarse en el real.

## 5. El juez del trust gate rechaza lo parcialmente respondible

En algunos turnos el contexto responde **parte** de la pregunta y el juez lo
descarta entero, y el bot se ve evasivo. Casos `conv_02_t3` y `conv_08_t2` del
dataset sintético.

---

## Límites operativos (no son del motor)

| Límite | Valor real medido | Implicancia |
|---|---|---|
| Cuota de OpenAI | 10.000 pedidos/min y **200.000 tokens/min** | Techo práctico **30-60 consultas/min**. Con 200 preguntas por día hay margen de sobra; una prueba de carga agresiva puede tocarlo |
| Concurrencia LLM interna | 6 por proceso × 4 procesos = **24 simultáneas** | Por encima, las consultas hacen cola: no dan error, suben los tiempos |
| Latencia típica | 3-4 s (p50 3,7; p90 5,9) | Son 3-4 llamadas a OpenAI encadenadas; la infraestructura no es el cuello |
| Límites de consultas propios | **Desactivados** (0 = sin tope) | No nos autobloqueamos en una prueba de carga. Conviene reactivarlos después del go-live |
| Cache de respuestas | 1 hora (exacto + semántico ≥0,97) | Una prueba que repite preguntas mide el cache, no el motor: purgar antes de medir |
| Token del widget | Vence a los 90 días | **mutualyf 2026-11-02**, galo 2026-11-08, intellix 2026-11-30 (ver [RUNBOOK #15](RUNBOOK.md)) |

## Cosas que NO son límites (mitos descartados con medición)

- *"La red al proveedor de IA es lenta"* → abrir conexión cuesta **28 ms**.
- *"El primer mensaje del día es lento porque está todo frío"* → el frío real
  son ~350 ms (leer el prompt de la base la primera vez en cada proceso).
- *"El contexto es demasiado grande"* → con el triple de contexto, el modelo
  tarda lo mismo.
- *"Falta un reranker"* → `bge-reranker-base` era ciego al español (0,0 en todo
  español, A/B 2026-07-23). Su función la cumple el trust gate. No
  reintroducir sin medición contra la suite.
