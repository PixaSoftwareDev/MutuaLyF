"""Seed comprehensive demo data into the 'demo' tenant for full UX/functionality testing.

Carga media: 1 admin + 3 operadores, 4 sectores, ~15 conversaciones (mix bot/handoff/human/closed),
~80 mensajes, ~10 intenciones, ~30 logs de consultas. Tematica: mutual / obra social.

Idempotente: limpia conversaciones, mensajes, operadores no-admin, sectores extra e intenciones
antes de insertar, para evitar duplicados en re-ejecuciones.

Uso (dentro del container backend):
    docker compose exec backend python scripts/seed_full_demo.py

Uso (desde host con .env cargado):
    python scripts/seed_full_demo.py
"""

import asyncio
import hashlib
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import asyncpg  # noqa: E402

from core.config import settings  # noqa: E402
from core.security import hash_password  # noqa: E402

TENANT_ID = "demo"
SCHEMA = f"tenant_{TENANT_ID}"

# ── Catalogo de usuarios ──────────────────────────────────────────────────────
ADMIN = {
    "email": "admin@demo.local",
    "name": "Admin Demo",
    "password": "demo1234!",
    "role": "admin",
}

OPERATORS = [
    {"email": "laura.gomez@demo.local",    "name": "Laura Gómez",    "password": "operador123!", "role": "operator"},
    {"email": "martin.alvarez@demo.local", "name": "Martín Álvarez", "password": "operador123!", "role": "operator"},
    {"email": "sofia.perez@demo.local",    "name": "Sofía Pérez",    "password": "operador123!", "role": "operator"},
]

# ── Sectores ──────────────────────────────────────────────────────────────────
SECTORES = [
    ("Consultas Generales",  "Consultas que no encajan en otro sector"),
    ("Atención al Afiliado", "Altas, bajas, modificaciones y reclamos de afiliados"),
    ("Facturación",          "Estados de cuenta, pagos, facturas y reintegros"),
    ("Prestaciones Médicas", "Autorizaciones, turnos, cartilla y cobertura"),
]

# Mapeo operador → sectores
OPERATOR_SECTORS = {
    "laura.gomez@demo.local":    ["Atención al Afiliado", "Consultas Generales"],
    "martin.alvarez@demo.local": ["Facturación"],
    "sofia.perez@demo.local":    ["Prestaciones Médicas", "Atención al Afiliado"],
}

# ── Intenciones ───────────────────────────────────────────────────────────────
INTENCIONES = [
    ("consulta_cartilla",          "Búsqueda de prestadores y especialidades en la cartilla", 42, 8),
    ("solicitud_autorizacion",     "Pedido de autorización de práctica médica o estudio",     35, 5),
    ("estado_pago",                "Consulta sobre estado de pagos, mora o vencimientos",     28, 12),
    ("reintegro",                  "Solicitud o seguimiento de reintegros",                   22, 4),
    ("alta_afiliado",              "Alta de nuevo afiliado o grupo familiar",                 18, 2),
    ("baja_afiliado",              "Baja de afiliado por cualquier motivo",                   15, 3),
    ("turno_medico",               "Solicitud o cancelación de turno",                        31, 9),
    ("cobertura_medicamento",      "Consulta de cobertura sobre medicamentos",                26, 6),
    ("cambio_plan",                "Cambio de plan o categoría",                              12, 1),
    ("contacto_humano",            "Pedido explícito de hablar con un operador",              45, 0),
]

# ── Conversaciones de ejemplo ─────────────────────────────────────────────────
# Cada tupla: (status, sector_nombre, afiliado_nombre, afiliado_email, operador_asignado_email|None,
#              insufficient_count, human_request_count, [(sender_type, content, offset_minutes)])
CONVERSACIONES = [
    # ── bot_active: el bot todavia maneja la conversacion ─────────────────────
    ("bot_active", "Consultas Generales", "Juan Carlos Suárez", "juancarlos@example.com", None, 0, 0, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -30),
        ("user", "Hola, quería saber cómo doy de alta a mi hija recién nacida", -28),
        ("bot",  "Para incorporar un nuevo integrante al grupo familiar necesitás presentar partida de nacimiento, DNI del recién nacido y formulario F-08 firmado. Podés iniciar el trámite online desde la sección 'Mi Grupo Familiar'.", -27),
        ("user", "Perfecto, ¿y cuánto demora?", -25),
        ("bot",  "El alta queda efectiva dentro de las 48 horas hábiles luego de cargada la documentación completa.", -24),
    ]),
    ("bot_active", "Consultas Generales", "Marcela Iglesias", "marcela.i@example.com", None, 0, 0, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -120),
        ("user", "Necesito el horario de atención de la sede centro", -118),
        ("bot",  "La sede centro atiende de lunes a viernes de 8:30 a 17:00 hs y los sábados de 9:00 a 13:00 hs.", -117),
    ]),
    ("bot_active", "Consultas Generales", None, None, None, 0, 0, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -15),
        ("user", "¿Tienen convenio con el sanatorio Norte?", -14),
        ("bot",  "Sí, el Sanatorio del Norte está dentro de la cartilla en convenio directo. Las prácticas ambulatorias y guardia 24hs están cubiertas al 100%.", -13),
        ("user", "Y para internación?", -12),
        ("bot",  "Internación clínica y quirúrgica también está cubierta. Para procedimientos programados necesitás autorización previa de auditoría médica.", -11),
    ]),
    ("bot_active", "Prestaciones Médicas", "Roberto Calabró", "r.calabro@example.com", None, 1, 0, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -200),
        ("user", "Quiero saber si la resonancia magnética está cubierta", -198),
        ("bot",  "Las resonancias magnéticas tienen cobertura. Necesitás orden médica vigente y autorización previa de auditoría, que se tramita en 48hs hábiles.", -197),
        ("user", "ok y si es urgente?", -195),
        ("bot",  "Para urgencias, la guardia del prestador autoriza en el momento contra orden médica con diagnóstico de urgencia.", -194),
    ]),
    ("bot_active", "Atención al Afiliado", "Diana Romero", "diana.r@example.com", None, 0, 0, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -45),
        ("user", "Cómo cambio mi domicilio?", -44),
        ("bot",  "Podés actualizar tu domicilio desde la sección 'Mis Datos' en el portal del afiliado. Necesitás una constancia de domicilio (factura de servicio o DNI con domicilio actualizado).", -43),
    ]),

    # ── handoff_requested: el bot pidió pasar a operador, nadie tomó aun ──────
    ("handoff_requested", "Atención al Afiliado", "Esteban Funes", "esteban.f@example.com", None, 2, 1, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -60),
        ("user", "Hace 3 meses pedí la baja de mi hijo mayor y todavía me siguen cobrando", -58),
        ("bot",  "Para revisar el estado de una solicitud de baja necesito que me indiques el número de afiliado o DNI.", -57),
        ("user", "42.115.806", -56),
        ("bot",  "No estoy pudiendo acceder a información específica del trámite. ¿Querés intentar reformular la consulta?", -55),
        ("user", "no, necesito hablar con alguien que me solucione esto", -54),
        ("bot",  "Parece que no pude responder tu consulta correctamente. Te estoy conectando con un operador. En breve alguien te atenderá.", -53),
        ("system", "Conversación derivada al sector Atención al Afiliado.", -53),
    ]),
    ("handoff_requested", "Facturación", "Vanesa Otero", "v.otero@example.com", None, 0, 1, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -25),
        ("user", "quiero hablar con un humano por favor, tengo un problema con una factura mal emitida", -24),
        ("bot",  "Te estoy conectando con un operador. En breve alguien te atenderá.", -23),
        ("system", "Conversación derivada al sector Facturación.", -23),
    ]),
    ("handoff_requested", "Prestaciones Médicas", "Hugo Beltrán", "h.beltran@example.com", None, 3, 0, [
        ("bot",  "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -90),
        ("user", "necesito una autorización urgente para una cirugía programada el lunes", -88),
        ("bot",  "Las autorizaciones de cirugías programadas se gestionan desde el portal en la sección 'Autorizaciones'. ¿Tenés ya el resumen de historia clínica?", -87),
        ("user", "sí pero el sistema no me deja cargarla", -85),
        ("bot",  "Disculpá, no estoy pudiendo ayudarte con problemas técnicos del portal. ¿Reformulamos la consulta?", -84),
        ("user", "esto no funciona, no me ayuda nada", -83),
        ("bot",  "Disculpá, no estoy pudiendo ayudarte con problemas técnicos del portal. ¿Reformulamos la consulta?", -82),
        ("user", "te dije que no, necesito una persona urgente", -81),
        ("bot",  "Parece que no pude responder tu consulta correctamente. Te estoy conectando con un operador.", -80),
        ("system", "Conversación derivada al sector Prestaciones Médicas.", -80),
    ]),

    # ── human_attending: operador conectado y conversando ────────────────────
    ("human_attending", "Atención al Afiliado", "Cristina Maidana", "cris.m@example.com", "laura.gomez@demo.local", 1, 1, [
        ("bot",      "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -180),
        ("user",     "necesito modificar la titularidad del grupo familiar", -178),
        ("bot",      "Los cambios de titularidad requieren documentación específica y verificación de identidad. Te derivo con un operador para que te guíe.", -177),
        ("system",   "Conversación derivada al sector Atención al Afiliado.", -177),
        ("system",   "Laura Gómez se ha unido a la conversación.", -160),
        ("operator", "Hola Cristina, soy Laura del sector Atención al Afiliado. ¿Cuál es el motivo del cambio de titularidad?", -159),
        ("user",     "Mi marido falleció el mes pasado, necesito ponerme yo como titular", -157),
        ("operator", "Lamento mucho tu pérdida. Para hacer el cambio necesitamos: acta de defunción, DNI tuyo y formulario F-12 que te puedo enviar por mail. ¿Querés que te lo mande ahora?", -155),
        ("user",     "Sí por favor, mi mail es cris.m@example.com", -153),
        ("operator", "Listo, te lo acabo de enviar. Una vez completado lo subís al portal y en 5 días hábiles queda actualizado. Cualquier duda escribime.", -150),
    ]),
    ("human_attending", "Facturación", "Pablo Sandoval", "p.sandoval@example.com", "martin.alvarez@demo.local", 0, 1, [
        ("bot",      "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -75),
        ("user",     "quiero hablar con facturación, me cobraron dos veces la cuota de abril", -73),
        ("bot",      "Te estoy conectando con un operador.", -72),
        ("system",   "Conversación derivada al sector Facturación.", -72),
        ("system",   "Martín Álvarez se ha unido a la conversación.", -70),
        ("operator", "Hola Pablo, soy Martín de Facturación. Ya estoy revisando tu cuenta. ¿Me confirmás el número de afiliado?", -69),
        ("user",     "183.940/02", -68),
        ("operator", "Confirmo, veo el doble débito del 12/04. Voy a generar el reintegro ahora mismo, te lo acreditan en 72hs hábiles en la misma tarjeta.", -65),
        ("user",     "Perfecto, muchas gracias Martín", -64),
        ("operator", "A vos. Cualquier cosa volvé a escribir.", -63),
    ]),
    ("human_attending", "Prestaciones Médicas", "Lorena Cabrera", "l.cabrera@example.com", "sofia.perez@demo.local", 1, 0, [
        ("bot",      "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -40),
        ("user",     "Necesito autorización para una endoscopía", -38),
        ("bot",      "Las endoscopías diagnósticas requieren autorización previa. Necesitás orden médica con código de práctica y resumen de historia clínica. ¿Lo tenés?", -37),
        ("user",     "Tengo la orden pero el resumen no, mi médico está de vacaciones", -36),
        ("bot",      "Disculpá, no estoy pudiendo resolver esta excepción. Te derivo con un operador.", -35),
        ("system",   "Conversación derivada al sector Prestaciones Médicas.", -35),
        ("system",   "Sofía Pérez se ha unido a la conversación.", -30),
        ("operator", "Hola Lorena, soy Sofía. Si el médico está de vacaciones podemos avanzar con la orden y el resumen lo presentás después. Cargame la orden por el portal y yo gestiono la auto con auditoría.", -28),
        ("user",     "buenísimo, ya lo subo", -27),
    ]),
    ("human_attending", "Atención al Afiliado", "Federico Lemos", "f.lemos@example.com", "laura.gomez@demo.local", 0, 0, [
        ("bot",      "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -10),
        ("user",     "hola necesito hablar con un operador", -9),
        ("bot",      "Te estoy conectando con un operador.", -9),
        ("system",   "Conversación derivada al sector Consultas Generales.", -9),
        ("system",   "Laura Gómez se ha unido a la conversación.", -7),
        ("operator", "Hola Federico, ¿en qué te puedo ayudar?", -6),
        ("user",     "necesito un certificado de afiliación para presentar en mi trabajo", -5),
    ]),

    # ── closed: conversaciones cerradas ──────────────────────────────────────
    ("closed", "Atención al Afiliado", "Norma Quiroga", "n.quiroga@example.com", "laura.gomez@demo.local", 0, 1, [
        ("bot",      "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -2880),
        ("user",     "quiero hablar con alguien por favor", -2878),
        ("bot",      "Te estoy conectando con un operador.", -2877),
        ("system",   "Conversación derivada al sector Atención al Afiliado.", -2877),
        ("system",   "Laura Gómez se ha unido a la conversación.", -2870),
        ("operator", "Hola Norma, contame", -2869),
        ("user",     "necesitaba un duplicado de credencial, ya me lo solucionaron por mail. Gracias!", -2868),
        ("operator", "Perfecto Norma, cierro la consulta entonces. Buen día!", -2867),
        ("system",   "La conversación fue cerrada. Gracias por contactarnos.", -2866),
    ]),
    ("closed", "Facturación", "Andrés Spinetta", "a.spinetta@example.com", "martin.alvarez@demo.local", 0, 0, [
        ("bot",      "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -10080),
        ("user",     "consulta sobre vencimiento de cuota", -10078),
        ("bot",      "La cuota mensual vence el día 10 de cada mes. Pasada esa fecha se aplica recargo del 5% más interés diario.", -10077),
        ("user",     "ok gracias", -10076),
        ("system",   "La conversación fue cerrada por inactividad.", -10000),
    ]),
    ("closed", "Prestaciones Médicas", "Mónica Caballero", "m.caballero@example.com", "sofia.perez@demo.local", 0, 1, [
        ("bot",      "Hola, soy el asistente virtual de la mutual. ¿En qué puedo ayudarte hoy?", -4320),
        ("user",     "Necesito un turno con cardiología urgente", -4318),
        ("bot",      "Para turnos con especialistas podés agendar desde el portal o llamar al 0800. Te derivo con un operador.", -4317),
        ("system",   "Conversación derivada al sector Prestaciones Médicas.", -4317),
        ("system",   "Sofía Pérez se ha unido a la conversación.", -4310),
        ("operator", "Hola Mónica, te consigo turno con el Dr. Bertotti para el jueves 17hs en sede centro, ¿te sirve?", -4308),
        ("user",     "sí perfecto, muchas gracias", -4306),
        ("operator", "Te confirmo por mail. Buen finde!", -4305),
        ("system",   "La conversación fue cerrada. Gracias por contactarnos.", -4304),
    ]),
]

# ── Consultas de log (para HDBSCAN, reportes, billing) ────────────────────────
CONSULTAS_LOG = [
    ("¿qué horario tiene la sede centro?",                      "consulta_general",      0.91, 850,  False),
    ("dónde queda la sede de zona norte",                       "consulta_general",      0.88, 720,  False),
    ("cuándo vence la cuota de este mes",                       "estado_pago",           0.96, 1100, False),
    ("vencimiento cuota mayo",                                  "estado_pago",           0.94, 60,   True),
    ("cómo doy de alta a mi hijo",                              "alta_afiliado",         0.97, 1200, False),
    ("alta de mi hija recién nacida",                           "alta_afiliado",         0.93, 55,   True),
    ("baja del plan",                                           "baja_afiliado",         0.95, 900,  False),
    ("quiero dar de baja a mi esposo",                          "baja_afiliado",         0.89, 1050, False),
    ("cobertura para resonancia magnética",                     "solicitud_autorizacion",0.92, 1300, False),
    ("autorización endoscopía",                                 "solicitud_autorizacion",0.88, 1180, False),
    ("turno con cardiólogo",                                    "turno_medico",          0.94, 990,  False),
    ("agendar turno dermatología",                              "turno_medico",          0.91, 870,  False),
    ("reintegro de medicamentos",                               "reintegro",             0.93, 1020, False),
    ("cómo solicito un reintegro",                              "reintegro",             0.95, 1110, False),
    ("cubren la insulina lantus?",                              "cobertura_medicamento", 0.90, 1080, False),
    ("ozempic está cubierto?",                                  "cobertura_medicamento", 0.87, 950,  False),
    ("qué prestadores hay en zona oeste",                       "consulta_cartilla",     0.93, 1200, False),
    ("listado de oftalmólogos",                                 "consulta_cartilla",     0.91, 1130, False),
    ("cómo cambio de plan",                                     "cambio_plan",           0.92, 1020, False),
    ("upgrade a plan premium",                                  "cambio_plan",           0.76, 1240, False),
    ("necesito hablar con un humano",                           "contacto_humano",       0.99, 40,   True),
    ("quiero hablar con un operador",                           "contacto_humano",       0.98, 38,   True),
    ("este chatbot no me ayuda",                                "contacto_humano",       0.81, 1340, False),
    ("certificado de afiliación",                               "consulta_general",      0.85, 980,  False),
    ("constancia para presentar en el trabajo",                 "consulta_general",      0.78, 1100, False),
    ("acta de defunción para cambio de titular",                None,                    None, 1450, False),  # sin clasificar
    ("documentación para baja por fallecimiento",               None,                    None, 1320, False),
    ("problema con la app no me deja loguear",                  None,                    None, 1500, False),
    ("error al subir documentación",                            None,                    None, 1480, False),
    ("recuperar contraseña del portal",                         "consulta_general",      0.79, 1100, False),
]


async def main() -> None:
    print(f"[seed] Conectando a PostgreSQL ({settings.postgres_host}:{settings.postgres_port})...")
    dsn = (
        f"postgresql://{settings.postgres_user}:{settings.postgres_password}"
        f"@{settings.postgres_host}:{settings.postgres_port}/{settings.postgres_db}"
        f"?sslmode=disable"
    )
    conn = await asyncpg.connect(dsn)

    try:
        # Verificar que el tenant exista
        row = await conn.fetchrow("SELECT id FROM public.tenants WHERE id = $1", TENANT_ID)
        if not row:
            print(f"[seed] ERROR: tenant '{TENANT_ID}' no existe. Corré primero: python scripts/seed_dev.py")
            sys.exit(1)

        await conn.execute(f'SET search_path TO "{SCHEMA}"')
        print(f"[seed] Usando schema {SCHEMA}")

        # ── Limpieza idempotente ─────────────────────────────────────────────
        print("[seed] Limpiando datos previos (conversaciones, mensajes, operadores no-admin)...")
        await conn.execute("DELETE FROM mensajes")
        await conn.execute("DELETE FROM conversaciones")
        await conn.execute("DELETE FROM operador_sectores")
        await conn.execute("DELETE FROM usuarios WHERE role != 'admin'")
        await conn.execute("DELETE FROM sectores WHERE nombre != 'Consultas Generales'")
        await conn.execute("DELETE FROM intencion_ejemplos")
        await conn.execute("DELETE FROM intenciones")
        await conn.execute("DELETE FROM consultas_log")

        # ── Usuarios ─────────────────────────────────────────────────────────
        print("[seed] Insertando operadores...")
        operator_ids: dict[str, str] = {}
        for op in OPERATORS:
            uid = await conn.fetchval(
                """
                INSERT INTO usuarios (email, name, hashed_password, role)
                VALUES ($1, $2, $3, $4)
                RETURNING id::text
                """,
                op["email"], op["name"], hash_password(op["password"]), op["role"],
            )
            operator_ids[op["email"]] = uid
            print(f"    + {op['name']:25} ({op['email']}) — pwd: {op['password']}")

        # ── Sectores ─────────────────────────────────────────────────────────
        print("[seed] Insertando sectores...")
        sector_ids: dict[str, str] = {}
        existing = await conn.fetchval("SELECT id::text FROM sectores WHERE nombre = 'Consultas Generales'")
        sector_ids["Consultas Generales"] = existing
        for nombre, desc in SECTORES:
            if nombre == "Consultas Generales":
                continue
            sid = await conn.fetchval(
                "INSERT INTO sectores (nombre, descripcion) VALUES ($1, $2) RETURNING id::text",
                nombre, desc,
            )
            sector_ids[nombre] = sid
            print(f"    + {nombre}")

        # ── Asignacion operador → sectores ──────────────────────────────────
        print("[seed] Asignando operadores a sectores...")
        for email, sectores in OPERATOR_SECTORS.items():
            op_id = operator_ids[email]
            for s_nombre in sectores:
                await conn.execute(
                    "INSERT INTO operador_sectores (operador_id, sector_id) VALUES ($1::uuid, $2::uuid)",
                    op_id, sector_ids[s_nombre],
                )

        # ── Intenciones + ejemplos sinteticos ────────────────────────────────
        print("[seed] Insertando intenciones...")
        for label, desc, ex_count, auto_count in INTENCIONES:
            int_id = await conn.fetchval(
                """
                INSERT INTO intenciones (label, description, example_count, auto_learned_count, is_active, model_version, last_accuracy)
                VALUES ($1, $2, $3, $4, TRUE, 'v1', $5)
                RETURNING id::text
                """,
                label, desc, ex_count, auto_count, round(random.uniform(0.88, 0.97), 3),
            )
            # Algunos ejemplos validados + auto-aprendidos para que la UI muestre datos
            for i in range(min(5, ex_count)):
                q = f"ejemplo {i+1} de {label}"
                await conn.execute(
                    """
                    INSERT INTO intencion_ejemplos
                    (intencion_id, question_hash, question_text, version_id, is_auto_learned, is_approved)
                    VALUES ($1::uuid, $2, $3, 'v1', $4, TRUE)
                    """,
                    int_id, hashlib.sha256(q.encode()).hexdigest(), q, i >= 3,
                )

        # ── Conversaciones + mensajes ────────────────────────────────────────
        print("[seed] Insertando conversaciones y mensajes...")
        now = datetime.now(timezone.utc)
        total_msgs = 0
        for idx, conv in enumerate(CONVERSACIONES):
            status, sector_nombre, afi_nombre, afi_email, op_email, insuf, hreq, mensajes = conv
            sector_id = sector_ids[sector_nombre]
            op_id = operator_ids.get(op_email) if op_email else None
            session_id = f"sess_{uuid4().hex[:12]}"

            # Tiempo base de la conversacion = offset del primer mensaje
            first_offset = mensajes[0][2]
            created_at = now + timedelta(minutes=first_offset)
            updated_at = now + timedelta(minutes=mensajes[-1][2])
            closed_at = updated_at if status == "closed" else None

            conv_id = await conn.fetchval(
                """
                INSERT INTO conversaciones
                (widget_session_id, sector_id, status, assigned_operator_id,
                 insufficient_count, human_request_count, afiliado_nombre, afiliado_email,
                 created_at, updated_at, closed_at)
                VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id::text
                """,
                session_id, sector_id, status, op_id,
                insuf, hreq, afi_nombre, afi_email,
                created_at, updated_at, closed_at,
            )

            for sender, content, offset in mensajes:
                msg_time = now + timedelta(minutes=offset)
                # Mensajes 'user' viejos en conversaciones non-closed quedan unread para badges
                read_at = msg_time if (status == "closed" or sender != "user") else None
                await conn.execute(
                    """
                    INSERT INTO mensajes (conversation_id, sender_type, content, read_at, created_at)
                    VALUES ($1::uuid, $2, $3, $4, $5)
                    """,
                    conv_id, sender, content, read_at, msg_time,
                )
                total_msgs += 1

        # ── Consultas log ────────────────────────────────────────────────────
        print("[seed] Insertando consultas_log...")
        for q_text, intent, conf, latency, cached in CONSULTAS_LOG:
            await conn.execute(
                """
                INSERT INTO consultas_log
                (question_hash, question_text, intent_label, intent_confidence,
                 cluster_status, latency_ms, from_cache, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                hashlib.sha256(q_text.encode()).hexdigest(),
                q_text,
                intent,
                conf,
                "assigned" if intent else "unassigned",
                latency,
                cached,
                now - timedelta(minutes=random.randint(5, 60 * 24 * 14)),
            )

        # ── Resumen ──────────────────────────────────────────────────────────
        print()
        print("─" * 60)
        print(f"[seed] OK — tenant '{TENANT_ID}' cargado.")
        print("─" * 60)
        print(f"  Operadores:     {len(OPERATORS)} (+ 1 admin)")
        print(f"  Sectores:       {len(SECTORES)}")
        print(f"  Intenciones:    {len(INTENCIONES)}")
        print(f"  Conversaciones: {len(CONVERSACIONES)}")
        print(f"  Mensajes:       {total_msgs}")
        print(f"  Consultas log:  {len(CONSULTAS_LOG)}")
        print()
        print("  Credenciales para probar:")
        print(f"    ADMIN     {ADMIN['email']:35} {ADMIN['password']}")
        for op in OPERATORS:
            print(f"    OPERATOR  {op['email']:35} {op['password']}")
        print()
        print("  Distribución de conversaciones:")
        by_status: dict[str, int] = {}
        for c in CONVERSACIONES:
            by_status[c[0]] = by_status.get(c[0], 0) + 1
        for st, n in by_status.items():
            print(f"    {st:25} {n}")
        print()
        print("  Login en: http://localhost:3000/login")
        print(f"  Tenant header/subdomain: {TENANT_ID}")

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
