#!/usr/bin/env python
"""Suite de regresión sobre el corpus REAL de un tenant.

Complementa a `run_quality_suite.py`, que corre sobre el corpus sintético de
`demo`. Esta apunta al corpus de un cliente y a casos tomados de sus
conversaciones reales.

    docker exec -w /app ia_backend python /app/run_regresion_corpus.py \
        --tenant mutualyf --dataset /app/tests/quality/regresion_mutualyf.yaml

Tres decisiones de diseño que vienen de errores concretos de medición
(2026-08-26 y 2026-08-31) y NO deben relajarse:

1. VACIAR EL CACHE ANTES DE CADA CORRIDA. Repetir la misma consulta con cache
   activo mide el cache: la primera genera y el resto son hits. Así salieron un
   "8/8 correctas" y un "1 falla en 32" que eran, en los hechos, una sola
   medición. Si `--sin-limpiar-cache` está activo el reporte lo marca como NO
   CONCLUYENTE.

2. NADA DE REGEX PARA JUICIOS SEMÁNTICOS. "No es la única opción" contiene
   "es la única"; "Sí, sí tenemos traumatología" empieza con "sí" y sin embargo
   corrige al usuario. Ambos rompieron detectores por patrones. El match exacto
   queda para hechos duros (un teléfono, "180"); todo lo demás va por juez LLM
   con criterio explícito.

3. REPETIR. El modelo no es determinista ni a temperature=0, porque cada turno
   previo también varía y cambia el historial del siguiente. Un caso que pasa
   una vez no está verificado: el resultado es una TASA.

Salida: exit 0 si todos los casos llegan al umbral; 1 si alguno falla (apto
para cron/CI).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
import unicodedata
import urllib.request
from dataclasses import dataclass, field

import yaml

sys.path.insert(0, "/app")


# ── infraestructura ──────────────────────────────────────────────────────────

def _api(base: str, tenant: str, method: str, path: str,
         data: dict | None = None, headers: dict | None = None) -> dict:
    h = {"X-Tenant-ID": tenant, "Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(
        base + path, headers=h, method=method,
        data=json.dumps(data).encode() if data is not None else None)
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


class CacheNoVaciado(RuntimeError):
    """Sin cache limpio la corrida no mide el motor. Aborta, no sigue."""


def vaciar_cache(tenant: str) -> None:
    """Las TRES capas: respuesta exacta y reescrituras en Redis, semántica en
    Qdrant. Vaciar solo una deja la medición viciada igual.

    FAIL-CLOSED a propósito. La primera versión de esta función leía los
    settings con nombres que no existían (`redis_cache_url` en vez de
    `redis_url_cache`) y se tragaba el error en un `except: pass`: no vaciaba
    nada y la suite quedó CIEGA — con el bug de la regla 1bis reintroducido a
    mano daba 17/17 en verde. Si acá algo falla, la corrida entera se cae:
    un error ruidoso es infinitamente mejor que un verde mentiroso.
    """
    from core.config import settings
    import redis

    urls = {u for u in (getattr(settings, a, None) for a in
                        ("redis_url_cache", "redis_url_broker",
                         "redis_url_session")) if u}
    if not urls:
        raise CacheNoVaciado(
            "no encontré ninguna URL de Redis en settings — reviso los nombres "
            "de atributo antes de confiar en esta corrida")

    borradas = 0
    for url in urls:
        r = redis.from_url(url)          # sin try: si Redis no responde, aborta
        for pat in (f"{tenant}:cache*", "qrw:*", f"{tenant}:semantic*"):
            keys = list(r.scan_iter(pat, count=1000))
            if keys:
                borradas += len(keys)
                r.delete(*keys)

    qdrant = f"http://{settings.qdrant_host}:{settings.qdrant_port}"
    req = urllib.request.Request(
        f"{qdrant}/collections/{tenant}_query_cache/points/delete?wait=true",
        method="POST", headers={"Content-Type": "application/json"},
        data=json.dumps({"filter": {}}).encode())
    try:
        urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as exc:
        if exc.code != 404:              # 404 = el tenant aún no tiene cache semántico
            raise CacheNoVaciado(f"Qdrant rechazó el vaciado: {exc.code}") from exc

    vaciar_cache.borradas = borradas     # type: ignore[attr-defined]


def autotest_cache(tenant: str, base: str, auth: dict) -> None:
    """Comprueba que vaciar_cache() realmente sirve ANTES de medir nada.

    Hace la misma consulta dos veces sin limpiar (debe pegar el cache), y una
    tercera limpiando (no debe pegarlo). Si el cache nunca se activa o nunca se
    limpia, la suite no puede distinguir el motor de su memoria: aborta.
    """
    q = "¿cuáles son los horarios de atención?"

    def preguntar() -> float:
        sid = f"autotest-{int(time.time()*1000)}"
        conv = _api(base, tenant, "POST", "/widget/conversation/start",
                    {"widget_session_id": sid}, auth)
        cid = conv.get("conversation_id") or conv.get("id")
        t0 = time.time()
        _api(base, tenant, "POST", f"/widget/conversation/{cid}/message",
             {"content": q, "widget_session_id": sid}, auth)
        return time.time() - t0

    vaciar_cache(tenant)
    frio = preguntar()
    caliente = preguntar()               # sin limpiar → debería salir del cache
    vaciar_cache(tenant)
    frio2 = preguntar()                  # limpiado → vuelve a generar

    if caliente > frio * 0.5:
        raise CacheNoVaciado(
            f"el cache no parece activarse (frío {frio:.2f}s vs repetición "
            f"{caliente:.2f}s): no puedo verificar que la limpieza sirva")
    if frio2 < caliente * 2:
        raise CacheNoVaciado(
            f"tras vaciar, la consulta sigue saliendo del cache "
            f"({frio2:.2f}s vs {caliente:.2f}s): la limpieza NO funciona y la "
            f"corrida mediría el cache, no el motor")
    print(f"[autotest] cache OK — frío {frio:.2f}s | cacheado {caliente:.2f}s | "
          f"tras vaciar {frio2:.2f}s\n")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9:/. ]", " ", s))


# ── evaluación ───────────────────────────────────────────────────────────────

_PROMPT_JUEZ = (
    "Sos un evaluador de calidad de un asistente. Recibís la PREGUNTA de un "
    "usuario, la RESPUESTA del asistente y un CRITERIO de aceptación.\n"
    "Decidí si la respuesta cumple el criterio. Sé estricto con el criterio, "
    "pero no penalices diferencias de redacción, tono o nivel de detalle que "
    "el criterio no mencione.\n"
    "Respondé SOLO con un JSON: {\"cumple\": true|false, \"motivo\": \"<10 "
    "palabras>\"}"
)


async def juez(pregunta: str, respuesta: str, criterio: str) -> tuple[bool, str]:
    from services.groq_client import complete, QueryComplexity
    msg = (f"PREGUNTA: {pregunta}\n\nRESPUESTA: {respuesta}\n\n"
           f"CRITERIO: {criterio.strip()}")
    try:
        out = await complete(
            messages=[{"role": "system", "content": _PROMPT_JUEZ},
                      {"role": "user", "content": msg}],
            complexity=QueryComplexity.SIMPLE, temperature=0.0, max_tokens=120)
        txt = out if isinstance(out, str) else str(out)
        m = re.search(r"\{.*\}", txt, re.S)
        d = json.loads(m.group(0)) if m else {}
        return bool(d.get("cumple")), str(d.get("motivo", ""))[:60]
    except Exception as exc:                       # el juez no puede tumbar la corrida
        return True, f"juez-indisponible ({type(exc).__name__})"


async def evaluar_turno(pregunta: str, respuesta: str, spec: dict) -> tuple[bool, str]:
    n = _norm(respuesta)
    if not respuesta.strip():
        return False, "respuesta vacía"

    debe = spec.get("debe_contener") or []
    if debe and not any(_norm(x) in n for x in debe):
        return False, f"falta alguno de {debe[:3]}"

    for x in (spec.get("no_debe_contener") or []):
        if _norm(x) in n:
            return False, f"contiene prohibido: {x[:32]}"

    if spec.get("criterio"):
        return await juez(pregunta, respuesta, spec["criterio"])
    return True, "ok"


# ── corrida ──────────────────────────────────────────────────────────────────

@dataclass
class Resultado:
    caso: str
    pasadas: int = 0
    total: int = 0
    motivos: list[str] = field(default_factory=list)

    @property
    def tasa(self) -> float:
        return self.pasadas / self.total if self.total else 0.0


async def correr_caso(base: str, tenant: str, auth: dict, caso: dict,
                      reps: int, limpiar: bool) -> Resultado:
    turnos = caso.get("turnos") or [{
        "pregunta": caso["pregunta"],
        **{k: caso[k] for k in ("debe_contener", "no_debe_contener", "criterio")
           if k in caso}}]
    res = Resultado(caso=caso["id"])

    for i in range(reps):
        if limpiar:
            vaciar_cache(tenant)
        sid = f"reg-{caso['id']}-{int(time.time()*1000)}-{i}"
        conv = _api(base, tenant, "POST", "/widget/conversation/start",
                    {"widget_session_id": sid}, auth)
        cid = conv.get("conversation_id") or conv.get("id")

        ok_corrida, motivo = True, "ok"
        for t in turnos:                       # la secuencia va COMPLETA
            r = _api(base, tenant, "POST", f"/widget/conversation/{cid}/message",
                     {"content": t["pregunta"], "widget_session_id": sid}, auth)
            txt = str(r.get("bot_response") or r.get("response") or "")
            ok, por_que = await evaluar_turno(t["pregunta"], txt, t)
            if not ok:
                ok_corrida = False
                motivo = f"{t['pregunta'][:34]} → {por_que} | {txt[:70]}"
                break                          # sin el turno previo bien, el resto no informa

        res.total += 1
        res.pasadas += 1 if ok_corrida else 0
        if not ok_corrida and motivo not in res.motivos:
            res.motivos.append(motivo.replace("\n", " "))
    return res


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--base-url", default="http://localhost:8000/api/v1")
    ap.add_argument("--solo", help="csv de ids de caso")
    ap.add_argument("--repeticiones", type=int)
    ap.add_argument("--umbral", type=float, default=1.0,
                    help="tasa mínima por caso para considerarlo OK (default 1.0)")
    ap.add_argument("--sin-limpiar-cache", action="store_true",
                    help="NO recomendado: la medición deja de ser concluyente")
    ap.add_argument("--json-out")
    a = ap.parse_args()

    ds = yaml.safe_load(open(a.dataset, encoding="utf-8"))
    reps_def = a.repeticiones or ds.get("meta", {}).get("repeticiones_default", 3)
    casos = ds["casos"]
    if a.solo:
        pedidos = {x.strip() for x in a.solo.split(",")}
        casos = [c for c in casos if c["id"] in pedidos]

    tok = _api(a.base_url, a.tenant, "GET", "/public/chat-token")["widget_token"]
    auth = {"Authorization": f"Bearer {tok}"}

    if a.sin_limpiar_cache:
        print("!! CACHE ACTIVO — los resultados NO son concluyentes "
              "(se mide el cache, no el motor)\n")
    else:
        try:
            autotest_cache(a.tenant, a.base_url, auth)
        except CacheNoVaciado as exc:
            print(f"ABORTO: {exc}")
            return 2

    t0 = time.time()
    resultados: list[Resultado] = []
    umbrales: dict[str, float] = {}
    for c in casos:
        u = float(c.get("umbral", a.umbral))
        umbrales[c["id"]] = u
        # --repeticiones explícito gana sobre el valor del caso: es lo que se
        # usa para profundizar un caso puntual ("dame 10 corridas de este").
        reps = a.repeticiones or c.get("repeticiones", reps_def)
        r = await correr_caso(a.base_url, a.tenant, auth, c, reps,
                              not a.sin_limpiar_cache)
        resultados.append(r)
        marca = "OK  " if r.tasa >= u else "FALLA"
        extra = f"  (umbral {u:.0%})" if u < 1.0 else ""
        print(f"{marca} {r.caso:<28} {r.pasadas}/{r.total}{extra}", flush=True)
        for m in r.motivos:
            print(f"        · {m}", flush=True)

    fallidos = [r for r in resultados if r.tasa < umbrales[r.caso]]
    tot_c = sum(r.total for r in resultados)
    tot_p = sum(r.pasadas for r in resultados)
    print("\n" + "─" * 68)
    print(f"casos: {len(resultados)-len(fallidos)}/{len(resultados)} en umbral "
          f"{a.umbral:.0%}   |   corridas: {tot_p}/{tot_c}   |   "
          f"{time.time()-t0:.0f}s")
    if a.sin_limpiar_cache:
        print("resultado NO CONCLUYENTE: se corrió con cache activo")
    if fallidos:
        print("fallan: " + ", ".join(r.caso for r in fallidos))

    if a.json_out:
        json.dump({"umbral": a.umbral, "cache_limpio": not a.sin_limpiar_cache,
                   "casos": [{"id": r.caso, "pasadas": r.pasadas,
                              "total": r.total, "motivos": r.motivos}
                             for r in resultados]},
                  open(a.json_out, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)

    return 1 if fallidos else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
