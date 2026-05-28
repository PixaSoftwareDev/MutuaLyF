# Guía para crear archivos de base de conocimiento

Esta guía explica cómo armar el archivo de conocimiento de tu organización para que el sistema de IA pueda responder preguntas con precisión absoluta.

---

## Formato del archivo

**Tipo:** archivo de texto plano `.txt`
**Encoding:** UTF-8
**Nombre sugerido:** `conocimiento_[nombre-empresa].txt`

No usar Word (.docx), Excel (.xlsx) ni PDF. El archivo de texto plano es el formato que garantiza la mejor lectura por parte del sistema.

---

## Reglas de oro

### Hacer

- Numerar cada sección: `1.1 Título`, `2.3 Título`
- Poner todos los datos de una persona en un solo bloque
- Usar `¿Pregunta?` para preguntas frecuentes
- Etiquetar datos de contacto explícitamente: `Email:`, `Teléfono:`, `Dirección:`
- Escribir oraciones completas para descripciones
- Incluir en cada respuesta de FAQ todos los datos necesarios (nombre, email, horario) sin depender de que el lector consulte otra sección

### No hacer

- Tablas (ni copiadas de Word ni de Excel)
- Bullets (`-`, `•`, `*`) para datos importantes
- Dividir los datos de una persona en distintas secciones
- Referencias cruzadas del tipo "ver sección 3"
- Abreviaciones sin aclarar

---

## Template completo

Copiá este template, completá cada campo entre corchetes y eliminá los corchetes.

```
1. INFORMACIÓN GENERAL

1.1 Datos de la organización

Nombre: [Nombre completo de la organización]
Razón social: [Razón social si aplica]
Fundación: [Año]
Sector: [Sector o industria]
Descripción: [2-3 oraciones describiendo qué hace la organización y a quién sirve]

---

1.2 Sede y contacto principal

Dirección: [Calle Número, Piso/Oficina, Ciudad, Provincia, CP XXXXX]
Teléfono central: [+XX (XX) XXXX-XXXX]
Email general: [contacto@empresa.com]
Sitio web: [www.empresa.com]
Horario de atención: [Lunes a viernes de 9 a 18 horas]

---

1.3 Redes sociales y canales digitales

LinkedIn: [linkedin.com/company/empresa]
Instagram: [@empresa]
WhatsApp de contacto: [+XX X XXXX-XXXX]

---

2. EQUIPO

[Repetir el bloque 2.X por cada persona. Si no tenés un dato, escribir "No disponible".]

2.1 [Nombre Completo] — [Cargo]

Nombre: [Nombre Completo]
Cargo: [Cargo exacto]
Área: [Área o departamento]
Email: [email@empresa.com]
Teléfono directo: [+XX X XXXX-XXXX]
LinkedIn: [linkedin.com/in/perfil]
Horario de atención: [Días y horario, ej: Lunes a viernes de 9 a 17 h]
Responsabilidades: [2-3 oraciones en prosa describiendo de qué se encarga esta persona]

---

2.2 [Nombre Completo] — [Cargo]

Nombre: [Nombre Completo]
Cargo: [Cargo exacto]
Área: [Área o departamento]
Email: [email@empresa.com]
Teléfono directo: [+XX X XXXX-XXXX]
LinkedIn: [linkedin.com/in/perfil]
Horario de atención: [Días y horario]
Responsabilidades: [2-3 oraciones en prosa]

---

3. PRODUCTOS Y SERVICIOS

[Repetir el bloque 3.X por cada producto o servicio]

3.1 [Nombre del producto o servicio]

Descripción: [Qué es y para qué sirve, en 2-4 oraciones]
Destinado a: [A quién está dirigido]
Precio: [Precio o rango, o escribir "Consultar"]
Modalidad: [Presencial / Online / Híbrido / etc.]
Duración: [Si aplica]
Requisitos: [Si aplica]
Cómo contratarlo: [Pasos o contacto para contratarlo]

---

4. PROCEDIMIENTOS INTERNOS

[Repetir el bloque 4.X por cada proceso o procedimiento importante]

4.1 [Nombre del procedimiento]

Descripción: [Qué es este procedimiento y cuándo aplica]
Responsable: [Nombre y cargo de quien lo gestiona]
Pasos: [Describir los pasos en prosa, sin bullets. Ej: "Primero el empleado debe completar
el formulario F-001 y enviarlo al área de RRHH. Luego el responsable tiene 5 días hábiles
para aprobar o rechazar la solicitud y notificar por email al solicitante."]
Plazo: [Si aplica]
Documentos necesarios: [Si aplica]
Contacto para consultas: [Nombre, email o teléfono]

---

5. PREGUNTAS FRECUENTES

[Formato obligatorio: línea con ¿Pregunta?, línea siguiente con la respuesta completa.
La respuesta debe funcionar sola — incluir nombres, emails y horarios dentro de ella.]

¿[Pregunta frecuente 1]?
[Respuesta completa con todos los datos necesarios para responder sin leer otra sección.]

¿[Pregunta frecuente 2]?
[Respuesta completa.]

¿[Pregunta frecuente 3]?
[Respuesta completa.]

---

6. INFORMACIÓN ADICIONAL

[Sección libre para historia, valores, certificaciones, convenios, políticas, etc.
Usar el mismo formato de numeración.]

6.1 [Tema]

[Texto en prosa]

---
```

---

## Ejemplos

### Bloque de persona bien completado

```
2.3 María González — Coordinadora de Recursos Humanos

Nombre: María González
Cargo: Coordinadora de Recursos Humanos
Área: Recursos Humanos
Email: m.gonzalez@empresa.com
Teléfono directo: +54 9 11 5555-2233
LinkedIn: linkedin.com/in/mariagonzalez-rrhh
Horario de atención: Lunes, miércoles y viernes de 9 a 17 horas
Responsabilidades: María González coordina el proceso de incorporación de nuevos
empleados, gestiona las solicitudes de vacaciones y licencias, y es el contacto
principal para consultas sobre beneficios y convenios colectivos de trabajo.
```

### FAQ bien completada

```
¿Cómo solicito vacaciones?
Las vacaciones se solicitan completando el formulario de solicitud disponible en la
intranet con al menos 15 días de anticipación. El formulario debe enviarse por email a
m.gonzalez@empresa.com o entregarse en persona en Recursos Humanos (piso 3, oficina 301).
La aprobación se confirma dentro de los 5 días hábiles siguientes.

¿Cuál es el horario de la oficina central?
La oficina central ubicada en Avenida Corrientes 1234 piso 5, Buenos Aires, atiende de
lunes a viernes de 8 a 20 horas. Los sábados funciona de 9 a 13 horas. Para consultas
fuera de horario escribir a contacto@empresa.com.
```

### Qué NO hacer

```
❌ MAL — datos fragmentados y con bullets:
• Juan Pérez - RRHH
• Email: juan@empresa.com
(ver sección de contactos para más info)

✅ BIEN — datos completos en un solo bloque:
2.1 Juan Pérez — Gerente de Recursos Humanos

Nombre: Juan Pérez
Cargo: Gerente de Recursos Humanos
Email: juan@empresa.com
Teléfono: +54 9 11 4444-5555
Horario: Lunes a viernes de 9 a 17 horas
Responsabilidades: Juan Pérez lidera el área de Recursos Humanos, gestiona
los procesos de selección y capacitación, y es el referente principal para
consultas del personal sobre beneficios y normativa laboral.
```

---

## Por qué este formato funciona mejor

El sistema divide el archivo en fragmentos pequeños para indexarlo. Cada fragmento se convierte en un vector matemático que representa su significado. Cuando alguien hace una pregunta, el sistema busca los fragmentos cuyo significado es más cercano a la pregunta.

Si los datos de Juan Pérez están todos juntos en un bloque con su nombre en el título, el sistema sabe que ese fragmento habla de Juan Pérez. Si sus datos están repartidos en distintas secciones, el sistema no puede conectarlos.

Las preguntas frecuentes con respuestas completas funcionan bien porque cuando alguien pregunta lo mismo de otra manera, el sistema encuentra la respuesta aunque las palabras sean distintas.

---

## Checklist antes de subir el archivo

- [ ] El archivo está guardado como `.txt` (no `.docx` ni `.pdf`)
- [ ] Cada sección tiene número (`1.1`, `2.3`, etc.)
- [ ] Cada persona tiene su propio bloque con todos sus datos
- [ ] Ningún dato importante está en bullets
- [ ] Las FAQs tienen `¿` al inicio de cada pregunta
- [ ] Cada respuesta de FAQ tiene todos los datos necesarios para responder sin leer otra sección
- [ ] No hay tablas copiadas de Excel o Word
- [ ] Los datos de contacto tienen etiqueta explícita (`Email:`, `Teléfono:`, `Dirección:`)
