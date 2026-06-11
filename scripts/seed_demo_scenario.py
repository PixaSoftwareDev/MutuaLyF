"""Escenario de demo para probar la app con volumen realista.

Crea en el tenant indicado un set de conversaciones en TODOS los estados,
con tiempos calibrados para que el panel del operador muestre los tres
niveles de urgencia a la vez (calma / ámbar / rojo pulsante), mensajes
creíbles, no-leídos y "tu turno".

Qué genera:
  - 4 en espera de operador (30s, ~1.5m, ~3.5m y ~7m en cola)
  - 2 en atención (1 con mensajes sin leer → "tu turno" + badge)
  - 2 con el bot activo
  - 2 cerradas

Uso (dentro del container del backend, via stdin):
  docker exec -i -e DEMO_TENANT=nexo ia_backend_staging python - < scripts/seed_demo_scenario.py
  docker exec -i -e DEMO_TENANT=nexo -e DEMO_CLEAN=1 ia_backend_staging python - < scripts/seed_demo_scenario.py

Todas las conversaciones llevan widget_session_id con prefijo 'demo_scenario_'
→ DEMO_CLEAN=1 borra exactamente eso y nada más (mensajes caen por CASCADE).
Inserta por SQL directo: no consume Groq ni depende del RAG; el panel las
levanta por su polling normal (~6s).
"""

import asyncio
import os
import uuid

from sqlalchemy import text

TENANT = os.getenv("DEMO_TENANT", "nexo")
CLEAN = os.getenv("DEMO_CLEAN", "") == "1"
PREFIX = "demo_scenario_"

# Volumen configurable: DEMO_WAITING=20 DEMO_ATTENDING=8 DEMO_CLOSED=15 ...
N_WAITING   = int(os.getenv("DEMO_WAITING",   "12"))
N_ATTENDING = int(os.getenv("DEMO_ATTENDING", "6"))
N_BOT       = int(os.getenv("DEMO_BOT",       "4"))
N_CLOSED    = int(os.getenv("DEMO_CLOSED",    "10"))

# Pools para generar variedad (se ciclan y combinan)
NOMBRES = [
    "Carolina Méndez", "Jorge Palacios", "Marta Iglesias", "Raúl Domínguez",
    "Lucía Ferrero", "Esteban Gutiérrez", "Andrea Sosa", "Pablo Quiroga",
    "Verónica Aguirre", "Damián Cabrera", "Silvia Romero", "Federico Ponce",
    "Gabriela Núñez", "Marcos Villalba", "Patricia Ledesma", "Hernán Bravo",
    "Natalia Coronel", "Sergio Maldonado", "Rocío Benítez", "Claudio Vera",
    "Florencia Ríos", "Oscar Giménez", "Mónica Herrera", "Diego Acosta",
]

CONSULTAS = [
    "Necesito ayuda con la facturación de este mes, hay un cargo que no reconozco",
    "¿Me pueden dar el estado de mi reclamo? Es el número 4521",
    "Hace una semana mandé los papeles para el alta y nadie me contestó",
    "Es urgente, necesito la autorización hoy porque viajo mañana",
    "No puedo acceder al portal con mi usuario, ya probé restablecer la contraseña",
    "Quiero dar de baja un servicio y no encuentro la opción",
    "¿Cómo actualizo los datos de contacto de mi cuenta?",
    "Me llegó una factura duplicada, ¿con quién lo veo?",
    "Necesito hablar con alguien por un problema con mi último pago",
    "¿Pueden confirmarme si recibieron la documentación que envié ayer?",
    "Tengo una consulta sobre el plan corporativo para mi empresa",
    "El sistema me rechaza el comprobante que estoy subiendo",
]

# Esperas distribuidas (minutos): mezcla de calma / ámbar / rojo en toda la cola
WAIT_MINUTES = [0.4, 7.2, 2.8, 1.1, 5.5, 3.9, 0.8, 6.4, 4.7, 2.2, 8.5, 1.6]

# Plantillas de diálogo (se ciclan para generar volumen)
ATTENDING_TEMPLATES = [
    [
        ("user",     "Hola, quería consultar por el plan corporativo", True),
        ("operator", "¡Hola! Sí, contame qué necesitás saber", True),
        ("user",     "¿Qué incluye para equipos de menos de 10 personas?", False),
        ("user",     "Y si se puede facturar a nombre de la empresa", False),
    ],
    [
        ("user",     "Buenas, no puedo acceder al portal con mi usuario", True),
        ("operator", "Hola, ¿probaste restablecer la contraseña desde el login?", True),
        ("user",     "Sí, pero no me llega el correo", True),
        ("operator", "Revisá spam por las dudas — te reenvié el enlace recién", True),
    ],
    [
        ("user",     "Necesito el detalle de mi última factura", True),
        ("operator", "¡Hola! Ya te lo busco, dame un minuto", True),
        ("user",     "Dale, gracias. ¿Me lo podés mandar por acá?", False),
    ],
]

BOT_TEMPLATES = [
    [
        ("user", "¿Cuál es el horario de atención?"),
        ("bot",  "Nuestro horario de atención es de lunes a viernes de 9 a 18 hs. ¿Puedo ayudarte con algo más?"),
        ("user", "¿Y atienden los sábados?"),
        ("bot",  "No, los sábados no hay atención. Podés dejarnos tu consulta y la respondemos el lunes a primera hora."),
    ],
    [
        ("user", "¿Cómo doy de alta un nuevo servicio?"),
        ("bot",  "Para dar de alta un servicio necesitás completar el formulario de alta con tus datos y elegir el plan. ¿Querés que te indique los pasos?"),
    ],
]

CLOSED_TEMPLATES = [
    [
        ("user",     "Quería saber si recibieron mi pago de este mes"),
        ("bot",      "Voy a derivarte con un operador para verificar tu cuenta."),
        ("system",   "Listo, tu solicitud fue recibida. Un operador te atenderá en breve."),
        ("operator", "¡Hola! Sí — el pago figura acreditado desde el martes. ¡Quedate tranquila!"),
        ("user",     "¡Genial, muchas gracias!"),
        ("operator", "¡De nada! Cualquier cosa volvé a escribirnos."),
    ],
    [
        ("user",     "¿Tienen oficina en Rosario?"),
        ("bot",      "Sí, la oficina de Rosario está en Córdoba 1452, atiende de 9 a 17 hs."),
        ("user",     "Perfecto, gracias"),
    ],
    [
        ("user",     "Quiero cambiar el medio de pago de mi cuenta"),
        ("system",   "Listo, tu solicitud fue recibida. Un operador te atenderá en breve."),
        ("operator", "Hola, te paso los pasos para actualizar el medio de pago desde el portal."),
        ("user",     "Listo, ya lo pude hacer. ¡Gracias!"),
    ],
]


def _dni(i: int) -> str:
    return str(12_000_000 + (i * 837_241) % 30_000_000)[:8]


async def main() -> None:
    from core.database import get_pg_session

    async with get_pg_session(TENANT) as s:
        if CLEAN:
            r = await s.execute(
                text("DELETE FROM conversaciones WHERE widget_session_id LIKE :p"),
                {"p": PREFIX + "%"},
            )
            print(f"[clean] {TENANT}: {r.rowcount} conversaciones de demo eliminadas")
            return

        sectores = (await s.execute(
            text("SELECT id, nombre FROM sectores WHERE is_active ORDER BY is_default DESC")
        )).fetchall()
        if not sectores:
            print(f"ERROR: el tenant {TENANT} no tiene sectores activos")
            return
        operador = (await s.execute(
            text("SELECT id FROM usuarios WHERE role = 'operator' AND is_active LIMIT 1")
        )).fetchone()

        def sector(i: int) -> str:
            return str(sectores[i % len(sectores)][0])

        async def new_conv(*, status, nombre=None, dni=None, ip=None, sec, minutes_ago,
                           handoff_minutes=None, operator_id=None, closed=False):
            cid = str(uuid.uuid4())
            await s.execute(text("""
                INSERT INTO conversaciones
                    (id, widget_session_id, sector_id, status, assigned_operator_id,
                     afiliado_nombre, afiliado_dni, afiliado_ip,
                     created_at, updated_at, handoff_requested_at, closed_at)
                VALUES
                    (:id, :sid, :sec, :st, :op, :nom, :dni, :ip,
                     NOW() - (:age || ' minutes')::interval,
                     NOW() - (:upd || ' minutes')::interval,
                     CASE WHEN CAST(:hreq AS text) IS NOT NULL
                          THEN NOW() - (CAST(:hreq AS text) || ' minutes')::interval END,
                     CASE WHEN CAST(:closed AS boolean) THEN NOW() - INTERVAL '30 minutes' END)
            """), {
                "id": cid, "sid": PREFIX + uuid.uuid4().hex[:10], "sec": sec, "st": status,
                "op": operator_id, "nom": nombre, "dni": dni, "ip": ip,
                "age": str(minutes_ago + 5), "upd": str(minutes_ago),
                "hreq": (str(handoff_minutes) if handoff_minutes is not None else None),
                "closed": closed,
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

        # ── En espera: cola con urgencias mezcladas ──────────────────────────
        for i in range(N_WAITING):
            nombre = NOMBRES[i % len(NOMBRES)]
            consulta = CONSULTAS[i % len(CONSULTAS)]
            mins = WAIT_MINUTES[i % len(WAIT_MINUTES)] + (i // len(WAIT_MINUTES)) * 0.3
            cid = await new_conv(status="handoff_requested", nombre=nombre, dni=_dni(i),
                                 sec=sector(i), minutes_ago=mins, handoff_minutes=mins)
            await add_msg(cid, "user", consulta, mins + 2, read=False)
            await add_msg(cid, "bot", "Veo que tengo dificultades para resolver tu consulta. ¿Querés que te conecte con un operador?", mins + 1, offer=True)
            await add_msg(cid, "system", "Listo, tu solicitud fue recibida. Un operador te atenderá en breve.", mins, read=False)
            total += 1

        # ── En atención: la mitad con mensajes sin leer ("tu turno") ─────────
        for i in range(N_ATTENDING):
            nombre = NOMBRES[(i + N_WAITING) % len(NOMBRES)]
            msgs = ATTENDING_TEMPLATES[i % len(ATTENDING_TEMPLATES)]
            last_min = 2 + i * 3
            all_read = i % 2 == 1   # alterna: pares con no-leídos, impares al día
            cid = await new_conv(status="human_attending", nombre=nombre, dni=_dni(i + 50),
                                 sec=sector(i), minutes_ago=last_min, handoff_minutes=last_min + 10,
                                 operator_id=(str(operador[0]) if operador else None))
            step = max(1, len(msgs))
            for j, (sender, contenido, leido) in enumerate(msgs):
                await add_msg(cid, sender, contenido, last_min + (step - j), read=(True if all_read else leido))
            total += 1

        # ── Bot activo ───────────────────────────────────────────────────────
        for i in range(N_BOT):
            msgs = BOT_TEMPLATES[i % len(BOT_TEMPLATES)]
            cid = await new_conv(status="bot_active", ip=f"190.224.51.{10 + i}", sec=sector(i + 1), minutes_ago=3 + i * 4)
            for j, (sender, contenido) in enumerate(msgs):
                await add_msg(cid, sender, contenido, 3 + i * 4 + (len(msgs) - j))
            total += 1

        # ── Cerradas ─────────────────────────────────────────────────────────
        for i in range(N_CLOSED):
            nombre = NOMBRES[(i + 7) % len(NOMBRES)]
            msgs = CLOSED_TEMPLATES[i % len(CLOSED_TEMPLATES)]
            cid = await new_conv(status="closed", nombre=nombre, dni=_dni(i + 100),
                                 sec=sector(i), minutes_ago=60 + i * 25, closed=True)
            for j, m in enumerate(msgs):
                sender, contenido = m[0], m[1]
                await add_msg(cid, sender, contenido, 60 + i * 25 + (len(msgs) - j))
            total += 1

    print(f"[seed] {TENANT}: {total} conversaciones creadas "
          f"(espera={N_WAITING}, atencion={N_ATTENDING}, bot={N_BOT}, cerradas={N_CLOSED})")
    print("Esperas distribuidas entre 30s y ~8.5m → calma, ámbar y rojo conviviendo en la cola.")


asyncio.run(main())
