#!/usr/bin/env python3
"""
test_quality.py — Test de velocidad y calidad de respuestas sobre un documento real.

Qué hace:
  1. Login con las credenciales que pasás
  2. Sube el documento al tenant que elegís
  3. Espera hasta que esté indexado
  4. Genera automáticamente N preguntas relevantes usando Groq (basadas en el texto real del doc)
  5. Ronda 1 (cold cache): lanza todas las preguntas y mide latencia + calidad
  6. Ronda 2 (warm cache): repite las mismas preguntas y mide cache hits
  7. Imprime un reporte completo con stats de velocidad y calidad

Uso:
  python3 scripts/test_quality.py \\
    --url http://localhost:8080 \\
    --email admin@miempresa.com \\
    --password MiPassword123! \\
    --tenant miempresa \\
    --file /ruta/al/documento.pdf \\
    --n-queries 20

  # Con preguntas propias (una por línea en un .txt):
  python3 scripts/test_quality.py ... --questions mis_preguntas.txt

Requisitos: pip install httpx groq (ya están en requirements.txt del proyecto)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from statistics import mean, median, stdev

# ── colores ANSI ──────────────────────────────────────────────────────────────
G  = "\033[92m"   # verde
Y  = "\033[93m"   # amarillo
R  = "\033[91m"   # rojo
B  = "\033[94m"   # azul
W  = "\033[97m"   # blanco
DIM = "\033[2m"   # gris
RST = "\033[0m"   # reset

def _c(color: str, text: str) -> str:
    return f"{color}{text}{RST}"

def ok(msg):   print(f"  {_c(G,'✓')} {msg}")
def warn(msg): print(f"  {_c(Y,'!')} {msg}")
def err(msg):  print(f"  {_c(R,'✗')} {msg}", file=sys.stderr)
def hdr(msg):  print(f"\n{_c(B,'══')} {_c(W, msg)} {_c(B,'══')}")
def info(msg): print(f"  {_c(DIM,'·')} {msg}")


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _login(session, base_url: str, email: str, password: str, tenant_id: str) -> str:
    """Devuelve access_token."""
    import httpx
    headers = {"X-Tenant-ID": tenant_id}
    r = session.post(
        f"{base_url}/api/v1/auth/login",
        data={"username": email, "password": password},
        headers=headers,
        timeout=30,
    )
    if r.status_code != 200:
        err(f"Login fallido ({r.status_code}): {r.text[:300]}")
        sys.exit(1)
    return r.json()["access_token"]


def _upload(session, base_url: str, token: str, tenant_id: str, file_path: Path) -> str:
    """Sube el documento y devuelve document_id."""
    import httpx
    headers = {"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant_id}
    with open(file_path, "rb") as f:
        r = session.post(
            f"{base_url}/api/v1/ingest",
            headers=headers,
            files={"file": (file_path.name, f)},
            timeout=60,
        )
    if r.status_code not in (200, 202):
        if r.status_code == 409:
            doc_id = r.json().get("detail", {}).get("duplicate_of", {}).get("id")
            if doc_id:
                warn(f"Documento ya existe → usando existente: {doc_id}")
                return doc_id
        err(f"Upload fallido ({r.status_code}): {r.text[:400]}")
        sys.exit(1)
    return r.json()["document_id"]


def _wait_ready(session, base_url: str, token: str, tenant_id: str, doc_id: str, timeout: int = 300) -> dict:
    """Espera hasta que el doc esté listo. Devuelve el status final."""
    import httpx
    headers = {"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant_id}
    deadline = time.monotonic() + timeout
    last_status = "pending"
    dots = 0
    while time.monotonic() < deadline:
        r = session.get(
            f"{base_url}/api/v1/documents/{doc_id}/status",
            headers=headers,
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            last_status = data.get("status", "pending")
            if last_status == "ready":
                return data
            if last_status == "failed":
                err(f"Ingesta falló para documento {doc_id}")
                sys.exit(1)
        dots += 1
        print(f"\r  {_c(Y,'⏳')} Procesando{'.' * (dots % 4)}   ", end="", flush=True)
        time.sleep(3)
    err(f"Timeout esperando ingesta ({timeout}s). Último estado: {last_status}")
    sys.exit(1)


def _query(session, base_url: str, token: str, tenant_id: str, question: str) -> dict:
    """Lanza una consulta y devuelve el resultado con latencia medida localmente."""
    import httpx
    headers = {"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant_id}
    t0 = time.monotonic()
    r = session.post(
        f"{base_url}/api/v1/query",
        headers=headers,
        json={"question": question, "language": "es"},
        timeout=60,
    )
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    if r.status_code != 200:
        return {"error": r.status_code, "detail": r.text[:200], "elapsed_ms": elapsed_ms}
    data = r.json()
    data["elapsed_ms"] = elapsed_ms
    return data


# ── Generación automática de preguntas con Groq ───────────────────────────────

def _generate_questions(text: str, n: int, groq_key: str) -> list[str]:
    """Usa Groq para generar N preguntas variadas sobre el documento."""
    from groq import Groq
    client = Groq(api_key=groq_key)

    excerpt = text[:6000]  # primeros ~6000 chars son suficientes para generar preguntas

    system = (
        "Sos un evaluador de sistemas de búsqueda de información institucional. "
        "Tu tarea es generar preguntas de prueba variadas y realistas sobre el documento dado."
    )
    user = f"""Documento (fragmento):
---
{excerpt}
---

Generá exactamente {n} preguntas de prueba en español. Deben ser:
- Variadas: mezcla de preguntas simples (1 dato puntual), preguntas de relación (A y B), \
preguntas de procedimiento (¿cómo se hace X?), preguntas de lista (¿cuáles son los...?), \
y 2-3 preguntas que probablemente NO tengan respuesta en el documento (para probar que el bot no alucina).
- Realistas: como las haría un empleado o cliente de la organización.
- Específicas: sin pronombres vagos, autosuficientes.

Respondé SOLO con un JSON array de strings, sin texto adicional:
["pregunta 1", "pregunta 2", ...]"""

    r = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.7,
        max_tokens=1500,
    )
    raw = r.choices[0].message.content.strip()
    # tolerar markdown code blocks
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        questions = json.loads(raw)
        return [str(q).strip() for q in questions if str(q).strip()][:n]
    except Exception:
        err(f"No pude parsear las preguntas generadas:\n{raw[:500]}")
        sys.exit(1)


# ── Reporte ───────────────────────────────────────────────────────────────────

def _latency_color(ms: int) -> str:
    if ms < 500:   return G
    if ms < 2000:  return G
    if ms < 5000:  return Y
    return R

def _quality_icon(result: dict) -> str:
    if "error" in result:    return _c(R, "ERR")
    n_sources = len(result.get("sources") or [])
    low_conf  = result.get("low_confidence", False)
    if n_sources == 0:       return _c(Y, " ∅ ")  # sin fuentes
    if low_conf:             return _c(Y, "LOW")   # baja confianza
    return _c(G, " OK")


def _print_round(label: str, results: list[dict], questions: list[str]) -> dict:
    latencies = [r.get("elapsed_ms", 0) for r in results if "error" not in r]
    cache_hits = sum(1 for r in results if r.get("from_cache"))
    errors     = sum(1 for r in results if "error" in r)
    no_sources = sum(1 for r in results if not r.get("sources") and "error" not in r)
    low_conf   = sum(1 for r in results if r.get("low_confidence"))

    print(f"\n{'─'*64}")
    print(f"  {_c(W, label)}")
    print(f"{'─'*64}")

    for i, (q, r) in enumerate(zip(questions, results), 1):
        ms = r.get("elapsed_ms", 0)
        icon = _quality_icon(r)
        cache = _c(B, "CACHE") if r.get("from_cache") else "     "
        ms_str = _c(_latency_color(ms), f"{ms:>5}ms")
        q_short = q[:65] + ("…" if len(q) > 65 else "")
        print(f"  {i:>2}. [{icon}] {ms_str} {cache}  {q_short}")
        if "error" in r:
            print(f"       {_c(R, str(r.get('detail',''))[:80])}")

    print(f"{'─'*64}")
    if latencies:
        p50 = sorted(latencies)[len(latencies)//2]
        p95 = sorted(latencies)[int(len(latencies)*0.95)]
        avg = int(mean(latencies))
        print(f"  Latencia   avg={_c(W,f'{avg}ms')}  p50={_c(W,f'{p50}ms')}  p95={_c(W,f'{p95}ms')}  min={min(latencies)}ms  max={max(latencies)}ms")
    print(f"  Cache hits  {_c(B, str(cache_hits))}/{len(results)}")
    print(f"  Sin fuentes {_c(Y if no_sources else G, str(no_sources))}/{len(results)}")
    print(f"  Baja conf   {_c(Y if low_conf else G, str(low_conf))}/{len(results)}")
    if errors:
        print(f"  Errores     {_c(R, str(errors))}/{len(results)}")

    return {
        "total": len(results),
        "latency_avg_ms": int(mean(latencies)) if latencies else 0,
        "latency_p50_ms": sorted(latencies)[len(latencies)//2] if latencies else 0,
        "latency_p95_ms": sorted(latencies)[int(len(latencies)*0.95)] if latencies else 0,
        "latency_min_ms": min(latencies) if latencies else 0,
        "latency_max_ms": max(latencies) if latencies else 0,
        "cache_hits": cache_hits,
        "no_sources": no_sources,
        "low_confidence": low_conf,
        "errors": errors,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Test de velocidad y calidad del bot")
    parser.add_argument("--url",        default="http://localhost:8080", help="Base URL del ambiente (default: staging via tunnel)")
    parser.add_argument("--email",      required=True,  help="Email del admin del tenant")
    parser.add_argument("--password",   required=True,  help="Password")
    parser.add_argument("--tenant",     required=True,  help="tenant_id")
    parser.add_argument("--file",       required=True,  help="Archivo a ingestar (.pdf, .docx, .txt)")
    parser.add_argument("--n-queries",  type=int, default=20, help="Cantidad de preguntas a generar (default: 20)")
    parser.add_argument("--questions",  help="Archivo .txt con preguntas propias (una por línea) — reemplaza la generación automática")
    parser.add_argument("--groq-key",   default=os.environ.get("GROQ_API_KEY", ""), help="API key de Groq (o GROQ_API_KEY env var)")
    parser.add_argument("--output",     help="Guardar reporte JSON en este archivo")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        err(f"Archivo no encontrado: {args.file}")
        sys.exit(1)

    try:
        import httpx
    except ImportError:
        err("Falta httpx: pip install httpx")
        sys.exit(1)

    # ── 1. Login ──────────────────────────────────────────────────────────────
    hdr("1 / 5   LOGIN")
    with httpx.Client(verify=False) as session:
        token = _login(session, args.url, args.email, args.password, args.tenant)
    ok(f"Autenticado como {args.email} en tenant {args.tenant}")

    # ── 2. Subir documento ────────────────────────────────────────────────────
    hdr("2 / 5   UPLOAD")
    with httpx.Client(verify=False) as session:
        doc_id = _upload(session, args.url, token, args.tenant, file_path)
    ok(f"Documento subido: {file_path.name} → {doc_id}")

    # ── 3. Esperar indexación ─────────────────────────────────────────────────
    hdr("3 / 5   INDEXACIÓN")
    info("Esperando a que el documento esté listo para consultas...")
    t_ingest_start = time.monotonic()
    with httpx.Client(verify=False) as session:
        status = _wait_ready(session, args.url, token, args.tenant, doc_id)
    ingest_time = int((time.monotonic() - t_ingest_start))
    print()
    ok(f"Documento listo — {status.get('chunk_count', '?')} chunks  |  quality: {status.get('quality_gate_status','?')}  |  tiempo: {ingest_time}s")

    # ── 4. Generar o cargar preguntas ─────────────────────────────────────────
    hdr("4 / 5   PREGUNTAS")
    if args.questions:
        questions = [l.strip() for l in Path(args.questions).read_text().splitlines() if l.strip()]
        ok(f"Cargadas {len(questions)} preguntas desde {args.questions}")
    else:
        if not args.groq_key:
            err("Se necesita --groq-key o la env var GROQ_API_KEY para generar preguntas automáticamente.")
            err("Alternativa: pasá tus propias preguntas con --questions archivo.txt")
            sys.exit(1)
        info(f"Generando {args.n_queries} preguntas automáticas con Groq...")
        try:
            from groq import Groq
        except ImportError:
            err("Falta groq: pip install groq")
            sys.exit(1)
        # Leer texto del archivo para generar preguntas relevantes
        text = ""
        try:
            if file_path.suffix.lower() == ".pdf":
                import fitz  # PyMuPDF
                doc = fitz.open(str(file_path))
                text = "\n".join(page.get_text() for page in doc)
            elif file_path.suffix.lower() == ".docx":
                import docx
                d = docx.Document(str(file_path))
                text = "\n".join(p.text for p in d.paragraphs)
            else:
                text = file_path.read_text(errors="ignore")
        except Exception as exc:
            warn(f"No pude leer el texto del archivo localmente ({exc}), usando nombre del archivo como contexto")
            text = f"Documento: {file_path.name}"

        questions = _generate_questions(text, args.n_queries, args.groq_key)
        ok(f"Generadas {len(questions)} preguntas")

    print()
    for i, q in enumerate(questions, 1):
        print(f"  {_c(DIM, str(i).rjust(2)+'.')} {q}")

    # ── 5. Queries ────────────────────────────────────────────────────────────
    hdr("5 / 5   QUERIES")

    # Ronda 1 — cold cache
    print(f"\n  {_c(Y,'⚡ Ronda 1 — cold cache (sin caché previo)')}")
    cold_results = []
    with httpx.Client(verify=False) as session:
        for i, q in enumerate(questions, 1):
            print(f"  {i}/{len(questions)} enviando...", end="\r", flush=True)
            cold_results.append(_query(session, args.url, token, args.tenant, q))

    cold_stats = _print_round("RONDA 1 — COLD CACHE", cold_results, questions)

    # Ronda 2 — warm cache
    print(f"\n  {_c(B,'⚡ Ronda 2 — warm cache (mismas preguntas)')}")
    warm_results = []
    with httpx.Client(verify=False) as session:
        for i, q in enumerate(questions, 1):
            print(f"  {i}/{len(questions)} enviando...", end="\r", flush=True)
            warm_results.append(_query(session, args.url, token, args.tenant, q))

    warm_stats = _print_round("RONDA 2 — WARM CACHE", warm_results, questions)

    # ── Resumen final ─────────────────────────────────────────────────────────
    hdr("RESUMEN")
    print()

    cache_rate = warm_stats["cache_hits"] / len(questions) * 100 if questions else 0
    speedup = cold_stats["latency_avg_ms"] / max(warm_stats["latency_avg_ms"], 1)

    quality_score = 100 - (
        (cold_stats["no_sources"] / len(questions) * 40) +
        (cold_stats["low_confidence"] / len(questions) * 20) +
        (cold_stats["errors"] / len(questions) * 40)
    )

    print(f"  {'Tiempo de ingesta':<30} {ingest_time}s")
    print(f"  {'Chunks indexados':<30} {status.get('chunk_count','?')}")
    print(f"  {'Quality gate':<30} {status.get('quality_gate_status','?')}")
    print()
    print(f"  {'Latencia cold (avg/p95)':<30} {cold_stats['latency_avg_ms']}ms / {cold_stats['latency_p95_ms']}ms")
    print(f"  {'Latencia warm (avg/p95)':<30} {warm_stats['latency_avg_ms']}ms / {warm_stats['latency_p95_ms']}ms")
    print(f"  {'Cache hit rate':<30} {_c(G if cache_rate>60 else Y, f'{cache_rate:.0f}%')}")
    print(f"  {'Speedup con cache':<30} {_c(G, f'{speedup:.1f}x más rápido')}")
    print()
    print(f"  {'Respuestas con fuentes':<30} {_c(G if cold_stats['no_sources']==0 else Y, str(len(questions)-cold_stats['no_sources']))}/{len(questions)}")
    print(f"  {'Baja confianza':<30} {_c(Y if cold_stats['low_confidence']>0 else G, str(cold_stats['low_confidence']))}/{len(questions)}")
    print(f"  {'Errores':<30} {_c(R if cold_stats['errors']>0 else G, str(cold_stats['errors']))}/{len(questions)}")
    print()

    # SLA checks
    sla_latency = cold_stats["latency_p95_ms"] <= 8000
    sla_quality = quality_score >= 75
    sla_cache   = cache_rate >= 40

    print(f"  {'SLA latencia p95 ≤ 8s':<30} {_c(G,'PASS') if sla_latency else _c(R,'FAIL')}  ({cold_stats['latency_p95_ms']}ms)")
    print(f"  {'SLA calidad ≥ 75%':<30}  {_c(G,'PASS') if sla_quality else _c(R,'FAIL')}  ({quality_score:.0f}%)")
    print(f"  {'SLA cache ≥ 40%':<30}  {_c(G,'PASS') if sla_cache else _c(R,'FAIL')}  ({cache_rate:.0f}%)")

    overall = all([sla_latency, sla_quality, sla_cache])
    print()
    if overall:
        print(f"  {_c(G, '✓ LISTO PARA PROMOVER A PRODUCCIÓN')}")
    else:
        print(f"  {_c(R, '✗ NO LISTO — revisar los SLAs que fallaron')}")

    # ── Guardar reporte ───────────────────────────────────────────────────────
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "config": {"url": args.url, "tenant": args.tenant, "file": str(file_path)},
        "ingestion": {"time_s": ingest_time, "chunk_count": status.get("chunk_count"), "quality": status.get("quality_gate_status")},
        "cold": cold_stats,
        "warm": warm_stats,
        "sla": {"latency": sla_latency, "quality": sla_quality, "cache": sla_cache, "overall": overall},
        "questions": questions,
        "cold_answers": [{"q": q, "a": r.get("answer","")[:200], "sources": len(r.get("sources") or []), "ms": r.get("elapsed_ms"), "cache": r.get("from_cache"), "low_conf": r.get("low_confidence")} for q, r in zip(questions, cold_results)],
    }

    out_path = args.output or f"report_{args.tenant}_{time.strftime('%Y%m%d_%H%M%S')}.json"
    Path(out_path).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\n  Reporte guardado en: {_c(W, out_path)}\n")


if __name__ == "__main__":
    main()
