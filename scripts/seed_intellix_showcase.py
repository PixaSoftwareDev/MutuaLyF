"""Escenario "showcase" del tenant intellix — datos de demo sobre el PRODUCTO.

Puebla un tenant con contenido que habla de Intellix mismo (la plataforma),
para tomar capturas del panel sin exponer datos de ningún cliente: sectores,
operadores ficticios, derivación configurada, conversaciones en todos los
estados (cola con urgencias, en atención, bot activo, cerradas con feedback,
WhatsApp) y consultas_log de 14 días para que las métricas tengan forma.

Todo lo que inserta lleva el prefijo `showcase_` en widget_session_id (o el
dominio @intellix.local en usuarios) → SHOWCASE_CLEAN=1 borra exactamente eso.
No toca usuarios ni conversaciones preexistentes.

Uso (dentro del backend del ambiente, vía stdin):
  docker exec -i -e SHOWCASE_TENANT=intellix ia_backend_staging python - < scripts/seed_intellix_showcase.py
  docker exec -i -e SHOWCASE_TENANT=intellix -e SHOWCASE_CLEAN=1 ia_backend_staging python - < scripts/seed_intellix_showcase.py

Los documentos de conocimiento NO van por acá: se suben por la API de ingesta
(scripts/showcase_docs/*.txt) para que pasen por el pipeline real.
Inserta por SQL directo: no consume LLM.
"""
import asyncio
import hashlib
import os
import random
import uuid

from sqlalchemy import text

TENANT = os.getenv("SHOWCASE_TENANT", "intellix")
CLEAN = os.getenv("SHOWCASE_CLEAN", "") == "1"
PREFIX = "showcase_"
# consultas_log.user_id es uuid: un id fijo y reconocible para poder limpiar.
METRICS_USER = str(uuid.uuid5(uuid.NAMESPACE_DNS, "showcase.intellix.metrics"))
OP_PASSWORD = os.getenv("SHOWCASE_OP_PASSWORD", "intellix2026!")
random.seed(7)

SECTORES = ["Ventas", "Soporte técnico", "Onboarding"]

OPERADORES = [
    ("valentina.rios@intellix.local", "Valentina Ríos", "Ventas"),
    ("tomas.herrera@intellix.local", "Tomás Herrera", "Soporte técnico"),
    ("camila.bustos@intellix.local", "Camila Bustos", "Onboarding"),
]

BOT_DESCRIPTION = (
    "Sos el asistente de Intellix, la plataforma de conocimiento con IA para "
    "organizaciones. Respondés a personas interesadas en el producto y a clientes "
    "que ya lo usan: qué es Intellix, cómo funciona el asistente, cómo se instala "
    "el widget web, cómo se conecta WhatsApp, cómo se deriva a operadores, planes, "
    "seguridad de los datos y soporte.\n\n"
    "Cómo respondés: apoyate en los documentos del contexto; si un dato no figura, "
    "decilo con claridad y ofrecé hablar con el equipo. Cuando alguien quiere "
    "contratar, pedir una demo o tiene un problema técnico que no podés resolver, "
    "derivá a un operador.\n\n"
    "Tono: claro, cercano y profesional. Voseo rioplatense."
)

GREETING = "¡Hola! Soy el asistente de Intellix. Preguntame lo que quieras sobre la plataforma 👋"

# Personas ficticias (prospectos y clientes)
PERSONAS = [
    ("Lucía Ferreyra", "lucia@clinicanorte.com.ar"),
    ("Martín Sosa", "msosa@coopagro.coop"),
    ("Julieta Paz", "julieta.paz@estudiopaz.com"),
    ("Nicolás Ledesma", "nledesma@municipiovilla.gob.ar"),
    ("Florencia Vidal", "fvidal@universidadsur.edu.ar"),
    ("Agustín Romero", "aromero@logisticadelsur.com"),
    ("Carla Benítez", "carla@inmobiliariabenitez.com"),
    ("Diego Molina", "dmolina@sanatoriocentral.com.ar"),
    ("Paula Giménez", "pgimenez@mutualdocente.org.ar"),
    ("Sebastián Quiroga", "squiroga@fintechlab.io"),
    ("Mariana Castro", "mcastro@colegioandes.edu.ar"),
    ("Rodrigo Acosta", "racosta@obrasocialunion.org.ar"),
    ("Valeria Núñez", "vnunez@hotelesdelvalle.com"),
    ("Gonzalo Ibáñez", "gibanez@cooperativaluz.coop"),
    ("Antonella Ruiz", "aruiz@consultoradata.com"),
    ("Federico Bravo", "fbravo@gremioempleados.org.ar"),
]

# ── Cola de espera (handoff_requested): minutos en cola mezclados ─────────────
ESPERA = [
    ("Quiero contratar el plan Profesional para mi clínica, ¿con quién lo veo?", 0.5),
    ("Necesito una demo para mostrarle al directorio la semana que viene", 6.8),
    ("El widget no aparece en nuestro sitio, ya pegué el script y nada", 2.4),
    ("¿Pueden migrar nuestras preguntas frecuentes desde un Excel?", 1.3),
    ("Tenemos 40 mil socios, ¿el plan Enterprise cubre ese volumen por WhatsApp?", 4.1),
]

# ── En atención (human_attending): (sender, texto, leído) ─────────────────────
ATENCION = [
    [
        ("user", "Hola, estamos evaluando Intellix para el área de socios de la cooperativa", True),
        ("operator", "¡Hola Martín! Contame un poco: ¿por qué canal atienden hoy a los socios?", True),
        ("user", "Casi todo por WhatsApp, dos personas contestando a mano", False),
        ("user", "¿El asistente puede responder desde nuestro reglamento?", False),
    ],
    [
        ("user", "Subí el manual de procedimientos y quedó en 'En cola' hace 20 minutos", True),
        ("operator", "Hola Julieta, ya lo veo. Es un PDF escaneado de 180 páginas: el OCR tarda un poco más", True),
        ("user", "Ah, ok. ¿Y después va a responder con eso?", True),
        ("operator", "Sí. Cuando termine lo vas a ver en 'Listo' con la cantidad de fragmentos indexados", True),
    ],
    [
        ("user", "¿Cómo hago para que derive a una persona cuando alguien pregunta por precios?", True),
        ("operator", "Se configura en Derivación, con palabras clave. Te paso una captura", True),
        ("user", "Genial, ¿y puedo elegir el mensaje que muestra?", False),
    ],
    [
        ("user", "Estamos en el paso 3 del asistente de configuración y no nos deja avanzar", True),
        ("operator", "Hola Diego, ¿podés decirme qué mensaje muestra?", True),
        ("user", "Dice que falta el color primario, pero lo cargamos", True),
        ("operator", "Probá con el formato #RRGGBB completo, sin abreviar. Ya lo anoto para mejorar la validación", True),
    ],
]

# ── Bot activo ────────────────────────────────────────────────────────────────
BOT = [
    [
        ("user", "¿Qué es Intellix?"),
        ("bot", "Intellix es una plataforma que centraliza el conocimiento de tu organización y lo pone a disposición de tus usuarios en lenguaje natural, por widget web y WhatsApp, con derivación a operadores humanos cuando hace falta. ¿Querés que te cuente cómo se instala?"),
        ("user", "¿Funciona con WhatsApp?"),
        ("bot", "Sí. Intellix se conecta a la API oficial de WhatsApp Cloud: tus usuarios escriben al número de la organización y el asistente responde desde tu base de conocimiento. Si la consulta lo requiere, deriva a un operador desde el mismo chat."),
    ],
    [
        ("user", "¿Los datos de mi organización se mezclan con los de otros clientes?"),
        ("bot", "No. Cada organización tiene su propio esquema de base de datos y sus propios índices de búsqueda, aislados del resto. Ningún documento ni conversación de una organización es visible desde otra."),
    ],
    [
        ("user", "cuanto tarda en quedar listo un documento"),
        ("bot", "Depende del tamaño: un PDF de texto de 50 páginas suele quedar indexado en menos de 2 minutos. Los escaneados pasan por OCR y pueden tardar más. Podés seguir el estado en la pantalla de Documentos."),
    ],
]

# ── Cerradas (con feedback en algunas) ────────────────────────────────────────
CERRADAS = [
    ([
        ("user", "¿Qué formatos de documento aceptan?"),
        ("bot", "Podés subir PDF, DOCX, TXT, HTML y JSON. Cada archivo se verifica por su contenido real antes de procesarse, y las secciones de baja calidad se marcan para revisión."),
        ("user", "Perfecto, gracias"),
    ], "widget", 5, None),
    ([
        ("user", "Quiero una demo para mi equipo"),
        ("bot", "Con gusto. Para coordinar una demo te derivo con el equipo comercial."),
        ("system", "Listo, tu solicitud fue recibida. Un operador te atenderá en breve."),
        ("operator", "¡Hola Lucía! Soy Valentina. ¿Te viene bien el jueves a las 11? Son 30 minutos por videollamada"),
        ("user", "Sí, perfecto. Somos 4 personas"),
        ("operator", "Listo, te mando la invitación al correo. ¡Nos vemos el jueves!"),
    ], "widget", 5, "Rápido y claro"),
    ([
        ("user", "el bot respondió mal una pregunta sobre nuestros horarios"),
        ("bot", "Lamento eso. Para revisarlo con el equipo de soporte te derivo con un operador."),
        ("system", "Listo, tu solicitud fue recibida. Un operador te atenderá en breve."),
        ("operator", "Hola Nicolás, soy Tomás. Vi la conversación: el documento tenía dos horarios distintos en secciones diferentes. Te marqué la contradicción en Documentos para que elijas cuál vale"),
        ("user", "Ah, no lo había visto. Ya lo corrijo, gracias"),
    ], "widget", 4, "Encontraron el problema enseguida"),
    ([
        ("user", "¿Puedo tener más de un operador atendiendo a la vez?"),
        ("bot", "Sí. Los operadores se organizan por sectores y cada conversación derivada entra en la bandeja del sector correspondiente. Varios operadores pueden atender al mismo tiempo, y el panel muestra quién está con cada conversación."),
    ], "widget", None, None),
    ([
        ("user", "Hola, ¿cómo pruebo el asistente antes de publicarlo?"),
        ("bot", "Como administrador podés usar el modo de prueba: las conversaciones que hacés vos quedan etiquetadas como TEST y no se mezclan con las de tus usuarios reales en las métricas."),
        ("user", "Buenísimo"),
    ], "widget", 5, None),
    ([
        ("user", "Necesito conectar nuestro número de WhatsApp"),
        ("bot", "Para conectar una línea necesitás una cuenta de WhatsApp Business en Meta. Desde el panel, en Canales, cargás el identificador del número y el token, y verificás el webhook. Si querés, te derivo con Onboarding para hacerlo juntos."),
        ("user", "Sí, por favor"),
        ("system", "Listo, tu solicitud fue recibida. Un operador te atenderá en breve."),
        ("operator", "¡Hola Paula! Soy Camila, de Onboarding. Te comparto la guía paso a paso y lo hacemos en una llamada de 20 minutos"),
        ("user", "Genial, mañana a la mañana puedo"),
        ("operator", "Perfecto, te agendo a las 10. ¡Hasta mañana!"),
    ], "whatsapp", 5, "Excelente acompañamiento"),
    ([
        ("user", "¿El plan Starter incluye WhatsApp?"),
        ("bot", "El plan Starter incluye el widget web. El canal de WhatsApp está disponible desde el plan Profesional. Si querés, te cuento las diferencias entre planes."),
        ("user", "ok, lo vemos internamente"),
    ], "widget", 3, "Esperaba WhatsApp en el básico"),
    ([
        ("user", "cómo cambio el color del chat para que combine con nuestra web"),
        ("bot", "Desde Configuración, en la sección de Branding, podés definir el color primario, el secundario, el logo y la posición del widget. Los cambios se aplican sin volver a instalar el script."),
    ], "widget", 5, None),
    ([
        ("user", "hola, tengo una duda sobre el aislamiento de datos para una licitación"),
        ("bot", "Cada organización tiene su propio esquema de base de datos, índices de búsqueda separados y archivos verificados por contenido. Para documentación formal de seguridad te derivo con el equipo."),
        ("system", "Listo, tu solicitud fue recibida. Un operador te atenderá en breve."),
        ("operator", "Hola Rodrigo, soy Tomás. Te mando el documento de arquitectura y seguridad por correo, ¿a qué dirección?"),
        ("user", "racosta@obrasocialunion.org.ar, gracias"),
        ("operator", "Enviado. Cualquier pregunta del área de sistemas, quedamos a disposición"),
    ], "whatsapp", 5, None),
    ([
        ("user", "¿Qué pasa si el asistente no sabe la respuesta?"),
        ("bot", "Dice que no encontró esa información en las fuentes disponibles y sugiere consultar con el área correspondiente. Nunca inventa un dato. Si se repite, ofrece derivar a un operador."),
        ("user", "Eso es justo lo que necesitamos"),
    ], "widget", 5, "No inventa, eso vale oro"),
    ([
        ("user", "quiero dar de baja a un operador que dejó la empresa"),
        ("bot", "Desde Usuarios, un administrador puede desactivar a cualquier operador. Sus conversaciones cerradas quedan en el historial y las abiertas pueden reasignarse a otro sector."),
    ], "widget", 4, None),
    ([
        ("user", "se puede exportar el historial de conversaciones?"),
        ("bot", "Sí. Desde el panel podés exportar las conversaciones y las métricas en formato CSV para analizarlas fuera de la plataforma."),
        ("user", "perfecto"),
    ], "widget", None, None),
]

# ── consultas_log: preguntas típicas para que las métricas tengan forma ───────
PREGUNTAS_LOG = [
    "¿Qué es Intellix?", "¿Cuánto cuesta el plan Profesional?", "¿Cómo instalo el widget?",
    "¿Funciona con WhatsApp?", "¿Qué formatos de documento aceptan?", "¿Cómo derivo a un operador?",
    "¿Los datos están aislados por organización?", "¿Puedo cambiar los colores del chat?",
    "¿Cuántos operadores puedo tener?", "¿Qué pasa si el asistente no sabe la respuesta?",
    "¿Tienen API?", "¿Cómo pruebo antes de publicar?", "¿Se puede exportar el historial?",
    "¿Cuánto tarda en indexar un documento?", "¿Cómo invito a un operador?",
    "¿Qué idiomas soporta?", "¿Hay período de prueba?", "¿Cómo conecto mi número de WhatsApp?",
    "¿Se integra con nuestro CRM?", "¿Quién ve las conversaciones?",
]


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


async def main() -> None:
    from core.database import get_pg_session
    from core.security import hash_password

    async with get_pg_session(TENANT) as s:
        if CLEAN:
            r = await s.execute(text("DELETE FROM conversaciones WHERE widget_session_id LIKE :p"), {"p": PREFIX + "%"})
            r2 = await s.execute(text("DELETE FROM consultas_log WHERE user_id = :u"), {"u": METRICS_USER})
            await s.execute(text("DELETE FROM operador_sectores WHERE operador_id IN (SELECT id FROM usuarios WHERE email LIKE '%@intellix.local')"))
            r3 = await s.execute(text("DELETE FROM usuarios WHERE email LIKE '%@intellix.local'"))
            print(f"[clean] {TENANT}: {r.rowcount} conversaciones, {r2.rowcount} consultas_log, {r3.rowcount} usuarios showcase eliminados")
            return

        # ── Tenant: descripción del bot y saludo (hablan del producto) ────────
        await s.execute(text("""
            UPDATE public.tenants SET bot_description = :d, greeting_message = :g, bot_name = 'Intellix',
                   display_name = 'Intellix', updated_at = NOW() WHERE id = :t
        """), {"d": BOT_DESCRIPTION, "g": GREETING, "t": TENANT})

        # ── Sectores ──────────────────────────────────────────────────────────
        sector_ids: dict[str, str] = {}
        for nombre in SECTORES:
            row = (await s.execute(text("SELECT id FROM sectores WHERE nombre = :n"), {"n": nombre})).fetchone()
            if row:
                sector_ids[nombre] = str(row[0])
            else:
                sid = str(uuid.uuid4())
                await s.execute(text("INSERT INTO sectores (id, nombre, is_active, is_default) VALUES (:id, :n, TRUE, FALSE)"), {"id": sid, "n": nombre})
                sector_ids[nombre] = sid

        # ── Operadores ficticios (uno por sector) ─────────────────────────────
        op_ids: dict[str, str] = {}
        for email, name, sector in OPERADORES:
            row = (await s.execute(text("SELECT id FROM usuarios WHERE email = :e"), {"e": email})).fetchone()
            if row:
                oid = str(row[0])
            else:
                oid = str(uuid.uuid4())
                await s.execute(text("""
                    INSERT INTO usuarios (id, email, name, hashed_password, role, is_active)
                    VALUES (:id, :e, :n, :p, 'operator', TRUE)
                """), {"id": oid, "e": email, "n": name, "p": hash_password(OP_PASSWORD)})
            op_ids[sector] = oid
            await s.execute(text("""
                INSERT INTO operador_sectores (operador_id, sector_id) VALUES (:o, :s) ON CONFLICT DO NOTHING
            """), {"o": oid, "s": sector_ids[sector]})

        # ── Derivación ────────────────────────────────────────────────────────
        await s.execute(text("""
            UPDATE handoff_config SET attention_hours = 'Lunes a Viernes de 9:00 a 18:00',
                contact_info = 'soporte@intellix.com.ar',
                keyword_triggers = CAST(:kw AS jsonb), updated_at = NOW()
        """), {"kw": '[{"words": ["contratar", "demo", "precio", "presupuesto", "licitación"], "message": "¿Querés que te conecte con alguien del equipo para verlo en detalle?"}]'})

        sec_list = list(sector_ids.values())

        async def new_conv(*, status, persona=None, sec, minutes_ago, channel="widget",
                           handoff_minutes=None, operator_id=None, closed=False, rating=None, reason=None):
            cid = str(uuid.uuid4())
            nombre, email = persona if persona else (None, None)
            await s.execute(text("""
                INSERT INTO conversaciones
                    (id, widget_session_id, sector_id, status, assigned_operator_id, afiliado_nombre, afiliado_email,
                     afiliado_ip, channel, created_at, updated_at, handoff_requested_at, closed_at,
                     feedback_rating, feedback_reason, feedback_at)
                VALUES
                    (:id, :sid, :sec, :st, :op, :nom, :mail, :ip, :ch,
                     NOW() - (:age || ' minutes')::interval,
                     NOW() - (:upd || ' minutes')::interval,
                     CASE WHEN CAST(:hreq AS text) IS NOT NULL THEN NOW() - (CAST(:hreq AS text) || ' minutes')::interval END,
                     CASE WHEN CAST(:closed AS boolean) THEN NOW() - (:upd || ' minutes')::interval END,
                     CAST(:rating AS smallint), :reason,
                     CASE WHEN CAST(:rating AS smallint) IS NOT NULL THEN NOW() - (:upd || ' minutes')::interval END)
            """), {
                "id": cid, "sid": PREFIX + uuid.uuid4().hex[:10], "sec": sec, "st": status, "op": operator_id,
                "nom": nombre, "mail": email, "ip": f"181.{random.randint(1, 200)}.{random.randint(1, 250)}.{random.randint(2, 250)}",
                "ch": channel, "age": str(minutes_ago + 6), "upd": str(minutes_ago),
                "hreq": (str(handoff_minutes) if handoff_minutes is not None else None),
                "closed": closed, "rating": rating, "reason": reason,
            })
            return cid

        async def add_msg(cid, sender, content, minutes_ago, read=True, offer=False):
            await s.execute(text("""
                INSERT INTO mensajes (conversation_id, sender_type, content, is_handoff_offer, read_at, created_at)
                VALUES (:c, :st, :tx, :of,
                        CASE WHEN :rd THEN NOW() - (:age || ' minutes')::interval END,
                        NOW() - (:age || ' minutes')::interval)
            """), {"c": cid, "st": sender, "tx": content, "of": offer, "rd": read, "age": str(minutes_ago)})

        total = 0
        # Cola de espera
        for i, (consulta, mins) in enumerate(ESPERA):
            sec = sec_list[i % len(sec_list)]
            cid = await new_conv(status="handoff_requested", persona=PERSONAS[i], sec=sec, minutes_ago=mins, handoff_minutes=mins)
            await add_msg(cid, "user", consulta, mins + 2, read=False)
            await add_msg(cid, "bot", "Para verlo en detalle con alguien del equipo, te derivo con un operador.", mins + 1, offer=True)
            await add_msg(cid, "system", "Listo, tu solicitud fue recibida. Un operador te atenderá en breve.", mins, read=False)
            total += 1

        # En atención
        for i, msgs in enumerate(ATENCION):
            sector = SECTORES[i % len(SECTORES)]
            last = 2 + i * 3
            cid = await new_conv(status="human_attending", persona=PERSONAS[5 + i], sec=sector_ids[sector],
                                 minutes_ago=last, handoff_minutes=last + 12, operator_id=op_ids[sector])
            for j, (sender, contenido, leido) in enumerate(msgs):
                await add_msg(cid, sender, contenido, last + (len(msgs) - j), read=leido)
            total += 1

        # Bot activo
        for i, msgs in enumerate(BOT):
            cid = await new_conv(status="bot_active", sec=sec_list[i % len(sec_list)], minutes_ago=3 + i * 5)
            for j, (sender, contenido) in enumerate(msgs):
                await add_msg(cid, sender, contenido, 3 + i * 5 + (len(msgs) - j))
            total += 1

        # Cerradas, repartidas en los últimos 14 días
        for i, (msgs, channel, rating, reason) in enumerate(CERRADAS):
            age = 90 + i * 1_500 + random.randint(0, 600)   # minutos → ~1 h a ~13 días
            sector = SECTORES[i % len(SECTORES)]
            cid = await new_conv(status="closed", persona=PERSONAS[(i + 3) % len(PERSONAS)], sec=sector_ids[sector],
                                 minutes_ago=age, channel=channel, closed=True, rating=rating, reason=reason,
                                 operator_id=(op_ids[sector] if any(m[0] == "operator" for m in msgs) else None),
                                 handoff_minutes=(age + 4 if any(m[0] == "system" for m in msgs) else None))
            for j, (sender, contenido) in enumerate(msgs):
                await add_msg(cid, sender, contenido, age + (len(msgs) - j) * 2)
            total += 1

        # consultas_log de 14 días (métricas): más volumen en días hábiles y horario laboral
        await s.execute(text("DELETE FROM consultas_log WHERE user_id = :u"), {"u": METRICS_USER})
        n_log = 0
        for day in range(14):
            weekday = (14 - day) % 7
            n = random.randint(9, 22) if weekday < 5 else random.randint(1, 5)
            for _ in range(n):
                q = random.choice(PREGUNTAS_LOG)
                cache = random.random() < 0.28
                action = random.choices(["answer", "refuse"], weights=[0.9, 0.1])[0]
                lat = 0 if cache else random.randint(1_400, 4_200)
                mins = day * 1_440 + random.randint(0, 1_439)
                await s.execute(text("""
                    INSERT INTO consultas_log (user_id, question_hash, question_text, latency_ms, from_cache, created_at,
                                               trust_action, trust_lex, trust_best_cos, trust_judge, trust_reason)
                    VALUES (:u, :h, :q, :l, :c, NOW() - (:m || ' minutes')::interval, :a, :lex, :cos, :j, :r)
                """), {"u": METRICS_USER, "h": _h(q + str(mins)), "q": q, "l": lat, "c": cache, "m": str(mins),
                       "a": None if cache else action, "lex": None if cache else round(random.uniform(0.4, 1.0), 2),
                       "cos": None if cache else round(random.uniform(0.5, 0.8), 3), "j": (not cache) and random.random() < 0.25,
                       "r": None if cache else ("lexical_pass" if action == "answer" else "judge_refuse: no responde")})
                n_log += 1

    print(f"[showcase] {TENANT}: {total} conversaciones (espera={len(ESPERA)}, atención={len(ATENCION)}, "
          f"bot={len(BOT)}, cerradas={len(CERRADAS)}), {n_log} consultas_log, sectores={SECTORES}")
    print(f"Operadores ficticios: {[e for e, _, _ in OPERADORES]} / contraseña: {OP_PASSWORD}")


asyncio.run(main())
