# Recuperación de las correcciones — MutuaLyF · 10/08/2026

> **ESTADO (actualizado 17/08/2026): APLICADO.** Los 6 archivos corregidos se
> subieron a producción el mismo 10/08 (entre las 17:44 y las 23:06). Verificado
> contra la base el 15/08: las correcciones clave están vigentes ("la App no
> tiene turnero", grupo familiar por Afiliaciones, teléfonos de turnos) y la URL
> vieja `ns.luzyfuerza.org.ar:90` no dejó rastros. La respuesta correcta que el
> bot le dio a un afiliado el 15/08 sobre cómo sacar turno salió de estos
> documentos. Lo único vivo de este incidente es la sección "Pendiente" al final.

Todo lo de abajo se preparó leyendo el servidor, sin modificar un solo dato, y
describe la situación AL 10/08 — se conserva como registro del incidente.

## Qué pasó, en corto

El reproceso del 05/08 rearmó los documentos desde los archivos originales, que no
contienen las correcciones hechas a mano desde el panel. Se revisó documento por
documento qué se perdió realmente.

**El daño fue mucho menor de lo que parecía.** La mayor parte de las correcciones
sigue vigente. Lo que hay que reponer son **dos aclaraciones concretas**, y además
hay **cuatro documentos** cuyas correcciones funcionan hoy pero viven solo en la
base: si se reprocesan, se pierden igual que las otras.

## Qué hay en cada carpeta

| Carpeta | Contenido |
|---|---|
| `00_resguardo/` | Copia de seguridad de la base al 10/08 y el backup del 04/08 del que se recuperó todo |
| `01_version_actual/` | Lo que el bot usa hoy, documento por documento |
| `02_originales_minio/` | Los archivos tal como están cargados hoy en el sistema |
| `03_correcciones_backup/` | El texto con las correcciones, rescatado del backup del 04/08 |
| `04_propuesta_final/` | **Los 6 archivos corregidos, listos para subir** + un `.diff` por archivo |

## Los 6 archivos a subir y qué cambia en cada uno

| Archivo | Qué se repone |
|---|---|
| `Autorizaciones_-_por_dónde_autorizar.txt` | Qué se pide por App (Orden de Consulta) y qué por Web (Orden de Práctica), con el listado de estudios. Incluye la pregunta "¿Puedo autorizar una práctica desde la App?" |
| `Informacion_General_..._02062026-3.txt` | **La App no tiene turnero ni reserva de turnos** (hoy dice lo contrario) y la habilitación de grupo familiar/apoderado se tramita en Afiliaciones. Corrige además dos secciones numeradas 2.5.1 |
| `app_mimutualyf_..._09062026.txt` | La habilitación de apoderados y grupo familiar **no se configura desde la App**: se tramita en Afiliaciones |
| `Canales_de_atención_y_medios_de_pago_...txt` | Pago por débito directo del Sindicato · doble auditoría en Discapacidad/APE/SUR · turnos del Centro Médico online |
| `Consultorios_-_contexto.txt` | Cómo se sacan los turnos: Mi MutuaLyF Web, el link directo y la línea gratuita 0800 777 4413. **Reemplaza una dirección web vieja** (`ns.luzyfuerza.org.ar:90`) por la vigente |
| `Protocolo_de_Internaciones_-_para_prestadores.txt` | Las urgencias también se informan al número del Protocolo de Internación |

Los otros **12 documentos no necesitan ningún cambio**: su archivo ya coincide con
lo que el bot responde.

## De dónde sale cada palabra

**Todo el texto es de ellos. No hay una sola frase redactada por nosotros.**

Cada archivo se armó a partir de tres fuentes, todas escritas por la mutual:

1. el archivo original tal como está cargado hoy,
2. la versión que el bot usa (el documento con las ediciones que hicieron), y
3. el backup del 04/08, de donde salen las correcciones que el reproceso borró.

Se verificó automáticamente frase por frase: **521 frases, ninguna sin respaldo** en
alguna de esas tres fuentes. El único tratamiento aplicado fue quitar los marcadores
que agrega el procesador (los corchetes) y volver a unir las frases que el procesador
había cortado al partir el texto en fragmentos.

### Un punto que sí necesita decisión de ellos

En `app_mimutualyf` quedan dos respuestas que **contradicen** la corrección que la
mutual hizo:

- *"¿Puedo usar la aplicación si soy integrante del grupo familiar de un titular?"* →
  hoy responde que la habilitación **la configura el titular desde su cuenta**.
- *"¿Puedo operar en nombre de otra persona desde la aplicación?"* → hoy responde
  *"si el titular de la cuenta lo habilitó"*.

Pero en la misma página, la respuesta sobre el inicio de sesión —que ellos sí
corrigieron— dice que la habilitación **se tramita en Afiliaciones, no en la App**.

Esas dos respuestas quedaron **sin tocar**, tal como están hoy. La mutual tiene que
decir cuál es el circuito real para poder corregirlas.

## Cómo revisar antes de subir

Cada archivo tiene al lado un `_cambios_<archivo>.diff` que muestra únicamente lo
que cambia. Las líneas con `+` son lo que se agrega; con `-`, lo que se reemplaza.
Todo lo demás del archivo queda **idéntico**, byte por byte.

## Cómo subirlos (en el panel, por cada documento)

1. Entrar al documento y **borrarlo**.
2. **Subir** el archivo corregido de `04_propuesta_final/`.

El orden importa: si se sube sin borrar antes, el sistema lo rechaza por nombre
repetido. Al borrar se limpian los fragmentos viejos, así que no quedan restos.

Conviene hacerlo de a un documento por vez y verificar que quede en estado "listo"
antes de pasar al siguiente.

## Después de subir, probar el bot con estas preguntas

- ¿Puedo sacar turno desde la App? → debe decir que la App **no** tiene turnero
- ¿Puedo autorizar una radiografía desde la App? → **no**, va por MiMutualyf Web
- ¿Cómo habilito a mi grupo familiar en la App? → se tramita en **Afiliaciones**
- ¿Cómo saco turno en Odontología? → web, link directo o 0800 777 4413
- ¿Puedo pagar por débito directo? → sí, con cuenta en el Sindicato

## Si algo sale mal

En `00_resguardo/` está `mutualyf_estado_20260810.dump`, la base completa del tenant
al momento de empezar. También quedó una copia de la colección de búsqueda en el
servidor (`mutualyf_docs-...-2026-08-10-19-04-56.snapshot`).

## Lo que quedaba pendiente — resuelto el 10-11/08 (commit ad365aa y sus dos acompañantes, en prod desde el 11/08)

1. ~~Que subir la corrección de un documento no choque contra el control de
   duplicados.~~ ✅ El 409 ahora ofrece "Reemplazar el anterior" con aviso de
   cuántas partes tienen correcciones a mano.
2. ~~Que un reproceso avise antes de reemplazar correcciones manuales, o parta
   de la versión editada.~~ ✅ Existe el reproceso oficial
   (`POST /documents/{id}/reprocess` + botón) que parte de la VERSIÓN VIGENTE,
   y borrar/reemplazar avisa si hay ediciones manuales.
3. ~~Que la auditoría guarde el texto de cada edición.~~ ✅ Guarda
   `text_before`/`text_after` (hasta 8000 caracteres): recuperable sin backup.

## Pendiente (lo único vivo de este incidente, al 17/08)

- **La decisión de la mutual sobre el grupo familiar** (sección "Un punto que sí
  necesita decisión de ellos", arriba): las 2 respuestas contradictorias de
  `app_mimutualyf` siguen tal cual — falta que Josué confirme el circuito real.
- **El mojibake de los archivos originales** ("Calchaqu", "Arruf", "San Agust",
  "Logro"): sigue igual; se corrige cuando se actualicen esos documentos.
  Hacerlo ya es seguro: el reproceso nuevo no pisa correcciones.

## Una observación aparte

Los archivos originales tienen palabras con caracteres perdidos ("Calchaqu" por
Calchaquí, "Arruf" por Arrufó, "San Agust" por San Agustín, "Logro" por Logroño).
**Ya venían así desde el archivo cargado**, no es algo que haya pasado ahora. Se
puede corregir cuando se actualicen esos documentos.
