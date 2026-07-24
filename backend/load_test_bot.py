"""Prueba de carga y calidad del bot — LOCAL ONLY.

5 usuarios concurrentes × 20 requests c/u (100 turnos) contra el endpoint REAL
del widget (HTTP, mismo camino que un afiliado). Mezcla RAG + conector Pixs +
encadenadas + paráfrasis (consistencia) + trampas (alucinación).

Sesiones de conector sembradas por conversación (equivale al login OTP con el
código fijo de dev). Resultados crudos → /app/load_test_results.json.

Uso (dentro del contenedor backend):  python load_test_bot.py
"""

import asyncio
import json
import random
import time

import httpx

BASE = "http://localhost:8000/api/v1"
TENANT = "intellix"
RUN = time.strftime("%H%M%S")

# ── Banco de preguntas: 20 grupos × 5 paráfrasis (usuario i usa la variante i) ──
GROUPS: dict[str, dict] = {
    # RAG — verdad en intellixConocimiento.txt
    "g01_fundacion":   {"cat": "rag", "v": ["¿En qué año se fundó Intellix?", "¿Cuándo nació la empresa?", "¿Hace cuánto existe Intellix?", "¿De qué año es la empresa?", "¿Cuándo arrancó Intellix?"]},
    "g02_backend":     {"cat": "rag", "v": ["¿Quién se encarga del backend?", "¿Quién es el responsable de la infraestructura?", "¿Quién maneja la arquitectura del sistema?", "¿Quién programa el backend en el equipo?", "¿A quién le hablo por un tema de backend?"]},
    "g03_comercial":   {"cat": "rag", "v": ["¿Quién es el responsable comercial?", "¿Con quién hablo por ventas?", "¿Quién lleva la relación con los clientes?", "¿Quién hace las ventas en Intellix?", "¿Quién es el encargado del área comercial?"]},
    "g04_oficinas":    {"cat": "rag", "v": ["¿Dónde están las oficinas de Intellix?", "¿En qué ciudad está la empresa?", "¿Dónde queda Intellix?", "¿Desde dónde operan?", "¿Trabajan presencial o remoto?"]},
    "g05_contacto":    {"cat": "rag", "v": ["¿Cuál es el email de Enzo?", "¿Cómo contacto al área comercial?", "Pasame el mail del comercial", "¿A qué correo escribo por ventas?", "Email de contacto comercial"]},
    "g06_que_es":      {"cat": "rag", "v": ["¿Qué hace Intellix?", "¿A qué se dedica la empresa?", "Contame sobre Intellix", "¿Qué servicios ofrece la empresa?", "¿Qué es Intellix?"]},
    # Conector — listas
    "g07_proyectos":   {"cat": "conector", "v": ["¿Qué proyectos tenemos?", "Mostrame los proyectos", "¿En qué proyectos estamos trabajando?", "Listado de proyectos en curso", "Decime los proyectos activos"]},
    "g08_finanzas":    {"cat": "conector", "v": ["¿Cómo venimos de plata?", "Dame el resumen financiero", "¿Cuál es el neto actual?", "¿Cuánto tenemos de ingresos y gastos?", "¿Cómo están las finanzas?"]},
    "g09_oportun":     {"cat": "conector", "v": ["¿Qué oportunidades de venta hay?", "Mostrame el pipeline de ventas", "¿Qué negocios tenemos en curso?", "Listado de oportunidades", "¿Qué ventas están abiertas?"]},
    "g10_tareas":      {"cat": "conector", "v": ["¿Qué tareas pendientes hay?", "Mostrame las tareas", "¿Qué tenemos para hacer?", "Pendientes del equipo", "¿Qué tareas están abiertas?"]},
    "g13_cobrar":      {"cat": "conector", "v": ["¿Qué cuentas por cobrar tenemos?", "¿Quién nos debe plata?", "Mostrame las cuentas a cobrar", "¿Qué nos deben?", "Cuentas por cobrar pendientes"]},
    "g19_contactos":   {"cat": "conector", "v": ["¿Qué contactos tenemos cargados?", "Mostrame los contactos", "Listado de clientes en el CRM", "¿Qué contactos hay?", "¿Quiénes son nuestros contactos?"]},
    "g20_leads":      {"cat": "conector", "v": ["¿Cuántos leads tenemos?", "Mostrame los leads", "¿Qué prospectos hay?", "Estadísticas de leads", "¿Cómo vienen los leads?"]},
    # Conector — encadenadas (lista→detalle / entityType+entityId)
    "g11_det_erp":     {"cat": "encadenada", "v": ["Dame el detalle del proyecto ERP", "¿Cómo viene el proyecto ERP?", "Contame más del proyecto ERP", "¿En qué estado está el proyecto ERP?", "Info del proyecto ERP"]},
    "g12_act_erp":     {"cat": "encadenada", "v": ["¿Qué actividades tuvo el proyecto ERP?", "Mostrame las actividades del proyecto ERP", "¿Qué se registró en el proyecto ERP?", "Actividades del proyecto ERP", "¿Qué movimientos tuvo el proyecto ERP?"]},
    # Número exacto (verdad: ingresos 1.300.000, gastos 155.850, neto 1.144.150)
    "g18_neto":        {"cat": "numero", "v": ["¿Cuál es el neto del resumen financiero?", "¿Cuánto es el neto?", "¿Cuál es la ganancia neta actual?", "¿Cuánto queda neto entre ingresos y gastos?", "Neto actual de la empresa"]},
    # Trampas — deben rechazar, no inventar
    "g14_proy_fake":   {"cat": "trampa", "v": ["Dame el detalle del proyecto Zeus", "¿Cómo viene el proyecto Fénix?", "Detalle del proyecto Aurora", "¿En qué estado está el proyecto Atlas?", "Info del proyecto Titán"]},
    "g15_dato_fake":   {"cat": "trampa", "v": ["¿Cuál es el CBU de Intellix?", "¿Cuántos empleados tiene la sucursal de Mendoza?", "¿Cuál es el teléfono de la oficina de Buenos Aires?", "¿Qué precio tiene el plan premium?", "¿Cuál es la dirección exacta de la oficina de Córdoba?"]},
    "g16_fuera_dom":   {"cat": "trampa", "v": ["¿Quién ganó el mundial 2026?", "¿A cuánto está el dólar hoy?", "Recomendame una película", "¿Cuál es la capital de Francia?", "Escribime un poema sobre el mar"]},
    "g17_reunion":     {"cat": "trampa", "v": ["¿Qué dijo el cliente de Las Marías en la reunión de ayer?", "¿Qué se habló en la última reunión con MutuaLyF?", "Dame el resumen de la reunión de esta mañana", "¿Qué acordamos con el cliente ayer?", "Pasame la minuta de la reunión del lunes"]},
}

NOMBRES = ["Carla", "Diego", "Marina", "Pablo", "Sofía"]


async def run_user(i: int, token: str, results: list) -> None:
    from services import session_store

    headers = {"Authorization": f"Bearer {token}", "X-Tenant-ID": TENANT,
               "Content-Type": "application/json",
               # El rate limit del widget es por IP (como en prod, vía Nginx).
               # Cada usuario simulado declara la suya — el limitador queda ACTIVO.
               "X-Forwarded-For": f"10.77.0.{i + 1}"}
    sid = f"loadtest-{RUN}-u{i}"
    async with httpx.AsyncClient(timeout=90) as client:
        r = await client.post(f"{BASE}/widget/conversation/start", headers=headers,
                              json={"widget_session_id": sid, "afiliado_nombre": NOMBRES[i]})
        r.raise_for_status()
        conv_id = r.json()["conversation_id"]

        # Sesión de conector sembrada (= login OTP ya hecho con código fijo dev).
        await session_store.create_session(TENANT, conv_id, identity=f"tester{i}",
                                           rol="personal", nombre=NOMBRES[i])

        questions = [(gid, g["cat"], g["v"][i]) for gid, g in GROUPS.items()]
        random.Random(42 + i).shuffle(questions)

        for n, (gid, cat, q) in enumerate(questions):
            t0 = time.monotonic()
            row = {"user": i, "n": n, "gid": gid, "cat": cat, "q": q}
            try:
                r = await client.post(f"{BASE}/widget/conversation/{conv_id}/message",
                                      headers=headers,
                                      json={"content": q, "widget_session_id": sid})
                row["latency_ms"] = int((time.monotonic() - t0) * 1000)
                row["http"] = r.status_code
                body = r.json() if r.status_code == 200 else {}
                row["answer"] = (body.get("bot_response") or {}).get("content") if isinstance(body.get("bot_response"), dict) else body.get("bot_response")
                if row["answer"] is None and r.status_code == 200:
                    row["answer"] = json.dumps(body)[:300]
            except Exception as exc:  # noqa: BLE001 — el error ES un resultado
                row["latency_ms"] = int((time.monotonic() - t0) * 1000)
                row["http"] = 0
                row["error"] = f"{type(exc).__name__}: {exc}"[:200]
            results.append(row)
            print(f"u{i} {n + 1:02d}/20 {row.get('http')} {row['latency_ms']:>6}ms  [{cat}] {q[:50]}", flush=True)


async def main() -> None:
    from core.security import create_public_chat_token
    token = create_public_chat_token(TENANT)
    results: list = []
    t0 = time.monotonic()
    await asyncio.gather(*(run_user(i, token, results) for i in range(5)))
    total_s = time.monotonic() - t0
    out = {"run": RUN, "total_s": round(total_s, 1), "results": results}
    with open("/app/load_test_results.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\nListo: {len(results)} requests en {total_s:.0f}s → load_test_results.json")


if __name__ == "__main__":
    asyncio.run(main())
