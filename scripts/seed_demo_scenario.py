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

# (nombre, dni, consulta inicial, minutos_en_cola)
WAITING = [
    ("Carolina Méndez",  "28456123", "Necesito ayuda con la facturación de mayo, hay un cargo que no reconozco", 0.5),
    ("Jorge Palacios",   "20987456", "¿Me pueden dar el estado de mi reclamo? Es el número 4521", 1.7),
    ("Marta Iglesias",   "16234789", "Hace una semana mandé los papeles para el alta y nadie me contestó", 3.5),
    ("Raúl Domínguez",   "12678345", "Es urgente, necesito la autorización hoy porque viajo mañana", 7.0),
]

ATTENDING = [
    # (nombre, dni, [(sender, contenido, leido)], minutos_desde_ultimo_msg)
    ("Lucía Ferrero", "31245678", [
        ("user",     "Hola, quería consultar por el plan corporativo", True),
        ("operator", "¡Hola Lucía! Sí, contame qué necesitás saber", True),
        ("user",     "¿Qué incluye para equipos de menos de 10 personas?", False),
        ("user",     "Y si se puede facturar a nombre de la empresa", False),
    ], 2),
    ("Esteban Gutiérrez", "25890123", [
        ("user",     "Buenas, no puedo acceder al portal con mi usuario", True),
        ("operator", "Hola Esteban, ¿probaste restablecer la contraseña desde el login?", True),
        ("user",     "Sí, pero no me llega el correo", True),
        ("operator", "Revisá spam por las dudas — te reenvié el enlace recién", True),
    ], 8),
]

BOT_ACTIVE = [
    ("anon-1", [
        ("user", "¿Cuál es el horario de atención?"),
        ("bot",  "Nuestro horario de atención es de lunes a viernes de 9 a 18 hs. ¿Puedo ayudarte con algo más?"),
        ("user", "¿Y atienden los sábados?"),
        ("bot",  "No, los sábados no hay atención. Podés dejarnos tu consulta y la respondemos el lunes a primera hora."),
    ]),
    ("anon-2", [
        ("user", "¿Cómo doy de alta un nuevo servicio?"),
        ("bot",  "Para dar de alta un servicio necesitás completar el formulario de alta con tus datos y elegir el plan. ¿Querés que te indique los pasos?"),
    ]),
]

CLOSED = [
    ("Andrea Sosa", "27456890", [
        ("user",     "Quería saber si recibieron mi pago de este mes"),
        ("bot",      "Voy a derivarte con un operador para verificar tu cuenta."),
        ("system",   "Listo, tu solicitud fue recibida. Un operador te atenderá en breve."),
        ("operator", "Hola Andrea, sí — el pago figura acreditado desde el martes. ¡Quedate tranquila!"),
        ("user",     "¡Genial, muchas gracias!"),
        ("operator", "¡De nada! Cualquier cosa volvé a escribirnos."),
    ]),
    ("Pablo Quiroga", "33124567", [
        ("user",     "¿Tienen oficina en Rosario?"),
        ("bot",      "Sí, la oficina de Rosario está en Córdoba 1452, atiende de 9 a 17 hs."),
        ("user",     "Perfecto, gracias"),
    ]),
]


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

        # ── En espera: los 4 niveles de la cola ──────────────────────────────
        for i, (nombre, dni, consulta, mins) in enumerate(WAITING):
            cid = await new_conv(status="handoff_requested", nombre=nombre, dni=dni,
                                 sec=sector(i), minutes_ago=mins, handoff_minutes=mins)
            await add_msg(cid, "user", consulta, mins + 2, read=False)
            await add_msg(cid, "bot", "Veo que tengo dificultades para resolver tu consulta. ¿Querés que te conecte con un operador?", mins + 1, offer=True)
            await add_msg(cid, "system", "Listo, tu solicitud fue recibida. Un operador te atenderá en breve.", mins, read=False)
            total += 1

        # ── En atención ──────────────────────────────────────────────────────
        for i, (nombre, dni, msgs, last_min) in enumerate(ATTENDING):
            cid = await new_conv(status="human_attending", nombre=nombre, dni=dni, sec=sector(i),
                                 minutes_ago=last_min, handoff_minutes=last_min + 10,
                                 operator_id=(str(operador[0]) if operador else None))
            step = max(1, len(msgs))
            for j, (sender, contenido, leido) in enumerate(msgs):
                await add_msg(cid, sender, contenido, last_min + (step - j), read=leido)
            total += 1

        # ── Bot activo ───────────────────────────────────────────────────────
        for i, (tag, msgs) in enumerate(BOT_ACTIVE):
            cid = await new_conv(status="bot_active", ip=f"190.224.51.{10 + i}", sec=sector(i + 1), minutes_ago=3 + i * 4)
            for j, (sender, contenido) in enumerate(msgs):
                await add_msg(cid, sender, contenido, 3 + i * 4 + (len(msgs) - j))
            total += 1

        # ── Cerradas ─────────────────────────────────────────────────────────
        for i, (nombre, dni, msgs) in enumerate(CLOSED):
            cid = await new_conv(status="closed", nombre=nombre, dni=dni, sec=sector(i),
                                 minutes_ago=60 + i * 30, closed=True)
            for j, m in enumerate(msgs):
                sender, contenido = m[0], m[1]
                await add_msg(cid, sender, contenido, 60 + i * 30 + (len(msgs) - j))
            total += 1

    print(f"[seed] {TENANT}: {total} conversaciones de demo creadas (prefijo {PREFIX})")
    print("Cola en espera: 30s (calma) · ~1.7m (punto ámbar) · ~3.5m (fondo ámbar) · ~7m (rojo pulsante)")


asyncio.run(main())
