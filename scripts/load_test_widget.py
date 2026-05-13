"""Load test del widget conversacional.

10 usuarios virtuales × 5 mensajes c/u, todos en paralelo, sin pausa
(cada user envía el próximo mensaje apenas recibe respuesta).

Mide por request: latencia, status, longitud de respuesta, intent_label,
sources_count, handoff_offered. Reporta agregado al final.

Ejecutar (dentro del container backend, donde httpx ya está instalado):
    docker compose exec -T backend python /app/load_test_widget.py

O desde host con httpx instalado:
    python scripts/load_test_widget.py
"""

import asyncio
import json
import os
import statistics
import sys
import time
import uuid
from pathlib import Path

import httpx

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL = os.environ.get("LOAD_TEST_URL", "http://localhost:8000")
ADMIN_EMAIL = "admin@demo.local"
ADMIN_PASSWORD = "demo1234!"
TENANT_ID = "demo"
NUM_USERS = int(os.environ.get("LOAD_TEST_USERS", "10"))
MSGS_PER_USER = int(os.environ.get("LOAD_TEST_MSGS", "20"))
REQUEST_TIMEOUT = 90.0
PROVIDER_LABEL = os.environ.get("LOAD_TEST_LABEL", "groq")  # for report header

# Cada usuario tiene su lista de 20 mensajes — variedad de intenciones reales
SCRIPTS = [
    # User 0 — Sedes y horarios
    ["hola, donde queda la sede centro?",
     "que horario tienen los sabados?",
     "cubren la sede de zona norte tambien?",
     "y los feriados estan abiertos?",
     "aceptan dni digital?",
     "tienen sede en mar del plata?",
     "el telefono de la sede de cordoba?",
     "hasta que hora atienden los lunes?",
     "y los domingos hay alguna sede abierta?",
     "cuantas sedes tienen en buenos aires?",
     "atienden por whatsapp tambien?",
     "puedo sacar turno por la app?",
     "tengo el dni en la mi argentina, sirve?",
     "y la credencial digital donde se descarga?",
     "se atiende por email para consultas no urgentes?",
     "el 0800 es gratuito desde celular?",
     "cuantos minutos de espera promedio?",
     "tienen atencion en lengua de senas?",
     "y si tengo discapacidad motriz, hay accesibilidad?",
     "perfecto gracias por toda la info"],

    # User 1 — Reintegros
    ["necesito un reintegro de medicamentos",
     "como cargo la factura?",
     "que plazo tienen para devolver?",
     "puedo presentar tickets sumados?",
     "los panales del bebe estan cubiertos?",
     "que porcentaje me cubren del plan plata?",
     "demoran mucho en pagar?",
     "me transfieren al cbu?",
     "necesito factura A o B sirve?",
     "facturas C de monotributista no?",
     "perdi el ticket original, hay forma?",
     "desde que fecha cuenta el plazo de 60 dias?",
     "puedo apelar si me lo rechazan?",
     "donde envio la apelacion?",
     "cuanto demora la apelacion?",
     "los cosmeticos entran en algun caso?",
     "vitaminas con receta del medico se cubren?",
     "y los anticonceptivos tienen 100%?",
     "cuanto cubre de insulina lantus el plan oro?",
     "perfecto entendi, gracias"],

    # User 2 — Autorizaciones
    ["quiero autorizar una endoscopia",
     "que documentacion necesito subir?",
     "cuanto demora la autorizacion?",
     "y si la auditoria la rechaza?",
     "puedo elegir cualquier prestador?",
     "una resonancia magnetica tambien necesita autorizacion?",
     "para una cirugia con cuanta antelacion la pido?",
     "si es urgencia se autoriza despues?",
     "cuanto demoran en alta complejidad?",
     "y para una colonoscopia?",
     "si voy fuera de la cartilla que pasa?",
     "la quimioterapia se autoriza por ciclo?",
     "y la radioterapia?",
     "psicoterapia cuantas sesiones cubre?",
     "necesito el codigo de practica del nomenclador?",
     "el tratamiento en domicilio se autoriza?",
     "como me notifican que esta aprobada?",
     "y por sms tambien?",
     "si es de noche urgente quien autoriza?",
     "ok perfecto, una mas: las apelaciones tambien por la app?"],

    # User 3 — Afiliacion bebe
    ["cuanto demora dar de alta a un recien nacido?",
     "necesito presentar partida de nacimiento?",
     "se incluye automaticamente en mi plan?",
     "y la cobertura desde cuando rige?",
     "tengo que pagar diferencia el primer ano?",
     "los hijos hasta que edad se cubren?",
     "y mi conyuge cuanto recarga la cuota?",
     "padres a cargo se pueden incluir?",
     "que documentacion piden para alta de adulto?",
     "tengo monotributo, sirve constancia?",
     "carencia para internacion clinica cuanto es?",
     "y para parto cuanto demora?",
     "que pasa con un hijo discapacitado?",
     "la declaracion jurada de salud F-100 donde la consigo?",
     "el comprobante de domicilio actualizado de cuanto tiene que ser?",
     "puedo dar de alta sin presencia fisica?",
     "los abuelos como conviviente entran?",
     "el cambio entre planes cuando aplica para el grupo?",
     "y si nace prematuro hay cobertura especial?",
     "ok claro, gracias"],

    # User 4 — Pagos
    ["quiero saber el estado de mi cuota de mayo",
     "vence el 10 o el 15?",
     "que pasa si pago tarde?",
     "puedo pagar con tarjeta?",
     "me mandan recibo por mail?",
     "se puede debito automatico?",
     "aceptan mercado pago?",
     "y modo o transferencia inmediata?",
     "el cbu de la mutual cual es?",
     "si pago dos meses juntos hay descuento?",
     "se puede pagar en efectivo en sede?",
     "rapipago o pago facil?",
     "y la app del banco galicia tiene la mutual?",
     "cuanto recargo si pago a los 5 dias del vencimiento?",
     "y si me suspenden puedo recuperar la cobertura?",
     "los recibos de los ultimos 12 meses puedo descargarlos?",
     "para el monotributo F-1387 lo emiten?",
     "el cuit de la mutual cual es?",
     "factura A para empresa puedo pedir?",
     "perfecto, gracias por todo"],

    # User 5 — Cartilla y especialistas
    ["estoy buscando un cardiologo en zona oeste",
     "que prestadores tienen turno esta semana?",
     "atienden por demanda espontanea?",
     "y para hacer un ecocardiograma?",
     "el copago lo paga la mutual?",
     "tienen ginecologo en moron?",
     "pediatra urgente esta tarde donde voy?",
     "dermatologo con disponibilidad rapida?",
     "que oftalmologos hay en zona norte?",
     "endocrinologo para diabetes infantil?",
     "neurologo pediatrico atienden?",
     "y un fonoaudiologo?",
     "el centro medico mas cercano a barrio norte?",
     "que sanatorios estan adheridos para internacion?",
     "para cirugia ambulatoria a donde voy?",
     "trauma puedo ir a cualquier guardia?",
     "el hospital aleman esta adherido?",
     "y el italiano?",
     "para salud mental que tienen?",
     "gracias me re sirvio"],

    # User 6 — Cambio de plan
    ["necesito cambiar de plan al premium",
     "que diferencia de cobertura tiene?",
     "el incremento de cuota es proporcional?",
     "se aplica para el grupo familiar entero?",
     "cuando puedo empezar a usarlo?",
     "que carencias se mantienen?",
     "puedo bajar a basico despues?",
     "cuanto dura la cobertura internacional del premium?",
     "el concierge medico que hace?",
     "ortodoncia esta cubierta?",
     "implantes dentales?",
     "anteojos sin tope cuanto sale?",
     "el plan oro cuanto cobra por hijos?",
     "el premium incluye habitacion premium?",
     "y para el grupo familiar es cuota individual o consolidada?",
     "puedo tener planes distintos por cada miembro?",
     "como pido el cambio?",
     "tarda en hacerse efectivo?",
     "cuanto sale el premium para 4 personas?",
     "okey gracias por toda la info"],

    # User 7 — Urgencia operadora
    ["esto no funciona, necesito hablar con alguien",
     "mi consulta es urgente",
     "ya intente con el chatbot y no me ayuda",
     "quiero hablar con un humano por favor",
     "operadora!",
     "necesito hablar con un supervisor",
     "tienen jefe de servicio?",
     "esto es una emergencia",
     "mi mama esta internada",
     "quiero presentar un reclamo formal",
     "donde se hace una denuncia?",
     "voy a iniciar accion legal",
     "el bot no entiende lo que necesito",
     "transferime a una persona ya",
     "soy abogado y necesito hablar con legales",
     "esto es una verguenza",
     "deme el telefono del gerente",
     "comuniqueme con direccion",
     "tengo audio del operador anterior diciendo otra cosa",
     "voy a ir personalmente a sede"],

    # User 8 — Medicamentos especiales
    ["la cobertura del ozempic la tienen?",
     "y la insulina lantus?",
     "para un diabetico tipo 2 cuantos blister cubren?",
     "puedo retirarlos en farmacia adherida?",
     "necesito receta de cabecera o del especialista?",
     "el trulicity esta?",
     "y el saxenda para bajar de peso?",
     "humalog cuantas unidades cubre por mes?",
     "tiras reactivas cuantas dan?",
     "la jeringa para insulina entra?",
     "para tratamiento oncologico cuanto cubren?",
     "inmunoterapia tienen?",
     "el rituximab si necesito?",
     "vacuna contra dengue cubren?",
     "y la del herpes zoster en adultos mayores?",
     "el HPV en mujer de 30 anos?",
     "anticonceptivos al 100% siempre?",
     "el DIU lo cubren?",
     "vacuna de la gripe particular o pmo?",
     "perfecto cualquier duda vuelvo, gracias"],

    # User 9 — Mix queries dificiles
    ["mi padre tiene 78 anos y necesita panales por incontinencia, plan plata cubre?",
     "cuantas unidades me dan por mes?",
     "y si necesita silla de ruedas, hay cobertura?",
     "internacion geriatrica esta cubierta?",
     "el acompanante terapeutico cuantas horas?",
     "necesita prescripcion?",
     "kinesiologia respiratoria a domicilio?",
     "y si es post operatorio cuantas sesiones?",
     "los traslados en ambulancia se reintegran?",
     "para quimio en domicilio?",
     "la radioterapia se hace donde?",
     "y la diálisis es semanal o por sesion?",
     "psiquiatra cuanto cubre?",
     "tienen guardia neurologica 24hs?",
     "hospital de rehabilitacion en zona sur tienen?",
     "y centros de medicina paliativa?",
     "para una segunda opinion oncologica?",
     "la junta medica como funciona?",
     "puedo pedir cambio de prestador si no me convence?",
     "millones de gracias por toda la informacion"],
]


async def login_admin(client: httpx.AsyncClient) -> str:
    """Returns access_token."""
    r = await client.post(
        f"{BASE_URL}/api/v1/auth/login",
        data={"username": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        headers={"X-Tenant-ID": TENANT_ID},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()["access_token"]


async def get_widget_token(client: httpx.AsyncClient, admin_tok: str) -> str:
    r = await client.post(
        f"{BASE_URL}/api/v1/tenants/{TENANT_ID}/widget-token",
        headers={"Authorization": f"Bearer {admin_tok}", "X-Tenant-ID": TENANT_ID},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()["widget_token"]


async def run_user(
    user_id: int,
    widget_tok: str,
    script: list[str],
    results: list,
) -> None:
    """Inicia conversación y envía N mensajes secuenciales."""
    session_id = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {widget_tok}"}

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        # ── Start conversation ─────────────────────────────────────
        t0 = time.monotonic()
        try:
            r = await client.post(
                f"{BASE_URL}/api/v1/widget/conversation/start",
                json={"widget_session_id": session_id, "afiliado_nombre": f"User{user_id:02d}"},
                headers=headers,
            )
            r.raise_for_status()
            conv_id = r.json()["conversation_id"]
            t_start = (time.monotonic() - t0) * 1000
            results.append({
                "user": user_id, "step": "start", "ok": True,
                "latency_ms": round(t_start, 1), "status": r.status_code,
            })
        except Exception as exc:
            results.append({
                "user": user_id, "step": "start", "ok": False,
                "latency_ms": (time.monotonic() - t0) * 1000,
                "error": str(exc)[:120],
            })
            return

        # ── Send N messages ────────────────────────────────────────
        for i, question in enumerate(script, 1):
            t0 = time.monotonic()
            try:
                r = await client.post(
                    f"{BASE_URL}/api/v1/widget/conversation/{conv_id}/message",
                    json={"widget_session_id": session_id, "content": question},
                    headers=headers,
                )
                latency_ms = (time.monotonic() - t0) * 1000
                ok = r.status_code == 200
                payload = r.json() if ok else {}
                results.append({
                    "user": user_id,
                    "step": f"msg_{i}",
                    "ok": ok,
                    "latency_ms": round(latency_ms, 1),
                    "status": r.status_code,
                    "bot_len": len(payload.get("bot_response") or ""),
                    "sources": payload.get("sources_count", 0),
                    "handoff_offered": bool(payload.get("handoff_offered")),
                    "handoff_activated": bool(payload.get("handoff_activated")),
                    "conv_status": payload.get("status"),
                    "question_preview": question[:60],
                })
            except httpx.TimeoutException:
                results.append({
                    "user": user_id, "step": f"msg_{i}", "ok": False,
                    "latency_ms": (time.monotonic() - t0) * 1000,
                    "error": f"timeout {REQUEST_TIMEOUT}s",
                })
            except Exception as exc:
                results.append({
                    "user": user_id, "step": f"msg_{i}", "ok": False,
                    "latency_ms": (time.monotonic() - t0) * 1000,
                    "error": str(exc)[:120],
                })


def percentile(data: list[float], p: float) -> float:
    if not data:
        return 0.0
    data = sorted(data)
    k = (len(data) - 1) * (p / 100)
    f = int(k)
    c = min(f + 1, len(data) - 1)
    return data[f] + (data[c] - data[f]) * (k - f)


def report(results: list[dict], total_wall_ms: float) -> None:
    print()
    print("═" * 72)
    print(f"  LOAD TEST REPORT [{PROVIDER_LABEL.upper()}] — {NUM_USERS} users × {MSGS_PER_USER} msgs ({len(results)} requests)")
    print("═" * 72)

    msgs = [r for r in results if r["step"].startswith("msg_")]
    starts = [r for r in results if r["step"] == "start"]
    ok_msgs = [r for r in msgs if r.get("ok")]
    err_msgs = [r for r in msgs if not r.get("ok")]
    latencies = [r["latency_ms"] for r in ok_msgs]

    print(f"\n▶ Tiempo total wall-clock : {total_wall_ms/1000:.2f}s")
    print(f"▶ Sesiones iniciadas      : {sum(1 for s in starts if s.get('ok'))}/{NUM_USERS}")
    print(f"▶ Mensajes enviados       : {len(msgs)} (esperados {NUM_USERS*MSGS_PER_USER})")
    print(f"▶ Éxitos / Errores        : {len(ok_msgs)} / {len(err_msgs)}")
    if msgs:
        print(f"▶ Tasa de error           : {len(err_msgs)*100/len(msgs):.1f}%")
        print(f"▶ Throughput              : {len(ok_msgs)*1000/total_wall_ms:.2f} msg/s sostenido")

    if latencies:
        print(f"\n▶ Latencia de respuesta (solo OK)")
        print(f"    min     : {min(latencies):>8.0f} ms")
        print(f"    p50     : {percentile(latencies, 50):>8.0f} ms")
        print(f"    p75     : {percentile(latencies, 75):>8.0f} ms")
        print(f"    p95     : {percentile(latencies, 95):>8.0f} ms")
        print(f"    p99     : {percentile(latencies, 99):>8.0f} ms")
        print(f"    max     : {max(latencies):>8.0f} ms")
        print(f"    mean    : {statistics.mean(latencies):>8.0f} ms")
        print(f"    stdev   : {statistics.stdev(latencies) if len(latencies) > 1 else 0:>8.0f} ms")

    if ok_msgs:
        rag_hits = sum(1 for r in ok_msgs if r.get("sources", 0) > 0)
        avg_len = statistics.mean(r.get("bot_len", 0) for r in ok_msgs)
        handoffs_offered = sum(1 for r in ok_msgs if r.get("handoff_offered"))
        handoffs_activated = sum(1 for r in ok_msgs if r.get("handoff_activated"))
        print(f"\n▶ Calidad de respuesta")
        print(f"    RAG hit              : {rag_hits}/{len(ok_msgs)} ({rag_hits*100/len(ok_msgs):.0f}%)")
        print(f"    Avg sources/answer   : {statistics.mean(r.get('sources', 0) for r in ok_msgs):.1f}")
        print(f"    Avg respuesta length : {avg_len:.0f} chars")
        print(f"    Handoff ofrecido     : {handoffs_offered}")
        print(f"    Handoff activado     : {handoffs_activated}")

    if err_msgs:
        print(f"\n▶ Errores ({len(err_msgs)} req)")
        by_err = {}
        for r in err_msgs:
            err = r.get("error") or f"HTTP {r.get('status')}"
            by_err[err] = by_err.get(err, 0) + 1
        for err, n in sorted(by_err.items(), key=lambda x: -x[1])[:5]:
            print(f"    [{n:>3}]  {err}")

    # Per-user breakdown
    print(f"\n▶ Latencias por usuario (mean ms / errores)")
    per_user = {}
    for r in msgs:
        per_user.setdefault(r["user"], {"lat": [], "err": 0})
        if r.get("ok"):
            per_user[r["user"]]["lat"].append(r["latency_ms"])
        else:
            per_user[r["user"]]["err"] += 1
    for u in sorted(per_user):
        lat = per_user[u]["lat"]
        m = statistics.mean(lat) if lat else 0
        p95 = percentile(lat, 95) if lat else 0
        print(f"    user{u:02d}  mean={m:>6.0f}  p95={p95:>6.0f}  errs={per_user[u]['err']}")

    # SLA compliance
    print(f"\n▶ Compliance vs SLA (CLAUDE.md objetivos)")
    if latencies:
        sla_target_ms = 2500   # target llama-3.3
        sla_max_ms = 8000      # max llama-4-maverick
        under_target = sum(1 for l in latencies if l <= sla_target_ms) * 100 / len(latencies)
        under_max = sum(1 for l in latencies if l <= sla_max_ms) * 100 / len(latencies)
        print(f"    Bajo 2.5s (target)   : {under_target:.0f}%")
        print(f"    Bajo 8s (máx)        : {under_max:.0f}%")

    print("═" * 72)


async def main() -> None:
    print(f"[load] {NUM_USERS} usuarios × {MSGS_PER_USER} mensajes — target {BASE_URL}")
    async with httpx.AsyncClient() as client:
        admin_tok = await login_admin(client)
        widget_tok = await get_widget_token(client, admin_tok)
        print(f"[load] widget_token obtenido, lanzando {NUM_USERS} sesiones en paralelo...")

    results: list[dict] = []
    t0 = time.monotonic()
    await asyncio.gather(*[
        run_user(i, widget_tok, SCRIPTS[i % len(SCRIPTS)], results)
        for i in range(NUM_USERS)
    ])
    total_wall_ms = (time.monotonic() - t0) * 1000

    # Save detail
    out_path = Path("/tmp/load_test_detail.json")
    try:
        out_path.write_text(json.dumps(results, indent=2))
        print(f"[load] detalle guardado en {out_path}")
    except Exception:
        pass

    report(results, total_wall_ms)


if __name__ == "__main__":
    asyncio.run(main())
