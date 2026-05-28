#!/usr/bin/env python3
"""
test_quality.py — Benchmark completo de velocidad, calidad y concurrencia.

Qué mide:
  • Latencia p50 / p95 / p99 / max
  • Calidad: % con fuentes, % baja confianza, % sin respuesta
  • Cache: hit rate y speedup real
  • Concurrencia: qué pasa con N queries simultáneas
  • Ingesta: tiempo real y chunks generados

Flujo:
  1. Login + upload + esperar indexación
  2. Generar preguntas con Groq (o cargar desde --questions)
  3. Ronda COLD  — queries secuenciales, sin cache previo
  4. Ronda CARGA — N queries concurrentes (default: 5)
  5. Ronda WARM  — mismas queries secuenciales, mide cache
  6. Reporte final + SLA pass/fail + JSON exportado

Uso típico (dos consolas simultáneas):

  Consola 1 — staging:
    python3 scripts/test_quality.py \\
      --url http://localhost:8080 \\
      --email staging@interno.local --password StagingPass123! \\
      --tenant staging --file doc.pdf \\
      --save-questions /tmp/preguntas.txt

  Consola 2 — producción (mismas preguntas):
    python3 scripts/test_quality.py \\
      --url http://200.58.109.110 \\
      --email admin@mutual.com --password AdminPass123! \\
      --tenant mutual \\
      --questions /tmp/preguntas.txt

  → Corrés ambas al mismo tiempo. La diferencia de latencia en prod
    muestra el impacto real de tener staging en el mismo VPS.
"""

import argparse
import json
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from statistics import mean, median, stdev, quantiles

# ── colores ANSI ──────────────────────────────────────────────────────────────
GREEN  = "\033[92m"
YELLOW = "\033[93m"
RED    = "\033[91m"
BLUE   = "\033[94m"
CYAN   = "\033[96m"
WHITE  = "\033[97m"
DIM    = "\033[2m"
BOLD   = "\033[1m"
RST    = "\033[0m"

def _c(col, txt): return f"{col}{txt}{RST}"
def ok(m):   print(f"  {_c(GREEN,'✓')} {m}")
def warn(m): print(f"  {_c(YELLOW,'!')} {m}")
def err(m):  print(f"  {_c(RED,'✗')} {m}", file=sys.stderr)
def hdr(m):  print(f"\n{_c(CYAN,'▶')} {_c(BOLD+WHITE, m)}")
def sep():   print(f"  {'─'*70}")
def info(m): print(f"  {_c(DIM,'·')} {m}")

ENV_LABEL = ""  # se setea en main()


# ── HTTP ──────────────────────────────────────────────────────────────────────

def _login(base_url, email, password, tenant_id):
    import httpx
    r = httpx.post(
        f"{base_url}/api/v1/auth/login",
        data={"username": email, "password": password},
        headers={"X-Tenant-ID": tenant_id},
        timeout=30, verify=False,
    )
    if r.status_code != 200:
        err(f"Login fallido {r.status_code}: {r.text[:300]}")
        sys.exit(1)
    return r.json()["access_token"]


def _upload(base_url, token, tenant_id, file_path):
    import httpx
    headers = {"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant_id}
    with open(file_path, "rb") as f:
        r = httpx.post(
            f"{base_url}/api/v1/ingest",
            headers=headers,
            files={"file": (file_path.name, f)},
            timeout=60, verify=False,
        )
    if r.status_code == 409:
        dup = r.json().get("detail", {}).get("duplicate_of", {})
        doc_id = dup.get("id")
        if doc_id:
            warn(f"Ya existe → reutilizando {doc_id[:8]}…")
            return doc_id, True
    if r.status_code not in (200, 202):
        err(f"Upload fallido {r.status_code}: {r.text[:400]}")
        sys.exit(1)
    return r.json()["document_id"], False


def _poll_ready(base_url, token, tenant_id, doc_id, timeout=300):
    import httpx
    headers = {"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant_id}
    deadline = time.monotonic() + timeout
    n = 0
    while time.monotonic() < deadline:
        r = httpx.get(f"{base_url}/api/v1/documents/{doc_id}/status",
                      headers=headers, timeout=10, verify=False)
        if r.status_code == 200:
            st = r.json()
            status = st.get("status", "pending")
            if status == "ready":   return st
            if status == "failed":
                err("La ingesta falló en el servidor"); sys.exit(1)
        n += 1
        print(f"\r  {_c(YELLOW,'⏳')} procesando{'.'*(n%4)}   ", end="", flush=True)
        time.sleep(3)
    err(f"Timeout ({timeout}s) esperando indexación"); sys.exit(1)


def _query_one(base_url, token, tenant_id, question):
    """Lanza una query y devuelve dict con métricas."""
    import httpx
    headers = {"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant_id}
    t0 = time.monotonic()
    try:
        r = httpx.post(
            f"{base_url}/api/v1/query",
            headers=headers,
            json={"question": question, "language": "es"},
            timeout=60, verify=False,
        )
        elapsed = int((time.monotonic() - t0) * 1000)
        if r.status_code != 200:
            return {"q": question, "error": r.status_code, "ms": elapsed,
                    "detail": r.text[:200]}
        d = r.json()
        return {
            "q":          question,
            "ms":         elapsed,
            "server_ms":  d.get("latency_ms", elapsed),
            "sources":    len(d.get("sources") or []),
            "cache":      d.get("from_cache", False),
            "low_conf":   d.get("low_confidence", False),
            "answer":     (d.get("answer") or "")[:300],
            "intent":     d.get("intent_label"),
        }
    except Exception as exc:
        elapsed = int((time.monotonic() - t0) * 1000)
        return {"q": question, "error": str(exc), "ms": elapsed}


# ── Generación de preguntas ───────────────────────────────────────────────────

def _read_text(file_path):
    try:
        if file_path.suffix.lower() == ".pdf":
            import fitz
            return "\n".join(p.get_text() for p in fitz.open(str(file_path)))
        if file_path.suffix.lower() == ".docx":
            import docx
            return "\n".join(p.text for p in docx.Document(str(file_path)).paragraphs)
        return file_path.read_text(errors="ignore")
    except Exception:
        return f"Documento: {file_path.name}"


def _generate_questions(text, n, groq_key):
    from groq import Groq
    client = Groq(api_key=groq_key)
    excerpt = text[:6000]
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content":
             "Sos un evaluador experto de sistemas de búsqueda institucional. "
             "Generás preguntas de prueba realistas y variadas."},
            {"role": "user", "content":
             f"Documento (fragmento):\n---\n{excerpt}\n---\n\n"
             f"Generá exactamente {n} preguntas de prueba en español. Criterios:\n"
             f"- 40% preguntas directas sobre datos concretos del documento\n"
             f"- 20% preguntas de proceso/procedimiento ('¿cómo se hace...?')\n"
             f"- 20% preguntas de lista ('¿cuáles son los...?')\n"
             f"- 10% preguntas ambiguas o con sinónimos distintos a los del texto\n"
             f"- 10% preguntas que NO tienen respuesta en el documento "
             f"(para medir si el bot alucina)\n\n"
             f"Respondé SOLO con JSON array de strings:\n"
             f'["pregunta 1", "pregunta 2", ...]'},
        ],
        temperature=0.7, max_tokens=1500,
    )
    raw = resp.choices[0].message.content.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"): raw = raw[4:]
    try:
        qs = json.loads(raw)
        return [str(q).strip() for q in qs if str(q).strip()][:n]
    except Exception:
        err(f"No pude parsear las preguntas:\n{raw[:400]}")
        sys.exit(1)


# ── Análisis de una ronda ─────────────────────────────────────────────────────

def _stats(results):
    latencies = [r["ms"] for r in results if "error" not in r]
    if not latencies:
        return {}
    s = sorted(latencies)
    n = len(s)
    return {
        "n":       n,
        "avg":     int(mean(s)),
        "median":  int(median(s)),
        "p75":     s[int(n*0.75)],
        "p95":     s[int(n*0.95)],
        "p99":     s[min(int(n*0.99), n-1)],
        "min":     s[0],
        "max":     s[-1],
        "stddev":  int(stdev(s)) if n > 1 else 0,
        "cache":   sum(1 for r in results if r.get("cache")),
        "no_src":  sum(1 for r in results if not r.get("sources") and "error" not in r),
        "low_conf":sum(1 for r in results if r.get("low_confidence")),
        "errors":  sum(1 for r in results if "error" in r),
    }


def _ms_color(ms):
    if ms < 1500: return GREEN
    if ms < 4000: return YELLOW
    return RED

def _row(i, r, label="", show_answer=False):
    ms   = r.get("ms", 0)
    err_ = "error" in r
    if err_:
        icon  = _c(RED,    "ERR")
        ms_s  = _c(RED,    f"{ms:>5}ms")
    elif not r.get("sources"):
        icon  = _c(YELLOW, " ∅ ")
        ms_s  = _c(_ms_color(ms), f"{ms:>5}ms")
    elif r.get("low_conf"):
        icon  = _c(YELLOW, "LOW")
        ms_s  = _c(_ms_color(ms), f"{ms:>5}ms")
    else:
        icon  = _c(GREEN,  " OK")
        ms_s  = _c(_ms_color(ms), f"{ms:>5}ms")
    cache = _c(BLUE, "CACHE") if r.get("cache") else "     "
    q     = r["q"][:65] + ("…" if len(r["q"]) > 65 else "")
    extra = f"  {_c(DIM, label)}" if label else ""
    print(f"  {i:>2}. [{icon}] {ms_s} {cache}  {q}{extra}")
    if err_:
        print(f"       {_c(RED, str(r.get('detail',''))[:80])}")
    elif show_answer:
        answer = (r.get("answer") or "").strip()
        if not answer:
            print(f"       {_c(YELLOW,'(sin respuesta)')}")
        else:
            # Mostrar respuesta en líneas de max 70 chars con indent
            words = answer.split()
            line, lines = [], []
            for w in words:
                if sum(len(x)+1 for x in line) + len(w) > 70:
                    lines.append(" ".join(line))
                    line = [w]
                else:
                    line.append(w)
            if line: lines.append(" ".join(line))
            for l in lines[:4]:   # máx 4 líneas por respuesta
                print(f"       {_c(DIM, l)}")
            if len(lines) > 4:
                print(f"       {_c(DIM,'[…]')}")
        print()


def _print_round(title, results, label_fn=None, show_answers=False):
    sep()
    print(f"  {_c(BOLD+WHITE, title)}")
    sep()
    for i, r in enumerate(results, 1):
        _row(i, r, label_fn(r) if label_fn else "", show_answer=show_answers)
    sep()
    st = _stats(results)
    if not st:
        print(f"  {_c(RED,'Sin resultados válidos')}")
        return st
    n = len(results)
    avg_s  = _c(WHITE,       f"{st['avg']}ms")
    p50_s  = _c(WHITE,       f"{st['median']}ms")
    p95_s  = _c(_ms_color(st['p95']), f"{st['p95']}ms")
    p99_s  = _c(_ms_color(st['p99']), f"{st['p99']}ms")
    max_s  = _c(_ms_color(st['max']), f"{st['max']}ms")
    print(f"  Latencia   avg={avg_s}  p50={p50_s}  p75={st['p75']}ms  "
          f"p95={p95_s}  p99={p99_s}  max={max_s}")
    print(f"  Dispersión stddev={st['stddev']}ms  min={st['min']}ms")
    print(f"  Cache hits {_c(BLUE, str(st['cache']))}/{n}  "
          f"Sin fuentes {_c(YELLOW if st['no_src'] else GREEN, str(st['no_src']))}/{n}  "
          f"Baja conf {_c(YELLOW if st['low_conf'] else GREEN, str(st['low_conf']))}/{n}  "
          f"Errores {_c(RED if st['errors'] else GREEN, str(st['errors']))}/{n}")
    return st


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Benchmark de velocidad, calidad y concurrencia del bot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--url",      default="http://localhost:8080",
                        help="URL base (default: staging via SSH tunnel)")
    parser.add_argument("--email",    required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--tenant",   required=True)
    parser.add_argument("--file",     help="Documento a ingestar (.pdf/.docx/.txt)")
    parser.add_argument("--n-queries",type=int, default=20,
                        help="Cantidad de preguntas a generar (default: 20)")
    parser.add_argument("--questions",help="Archivo .txt con preguntas propias (una por línea)")
    parser.add_argument("--save-questions", metavar="FILE",
                        help="Guardar preguntas generadas en un .txt para reutilizar en la otra consola")
    parser.add_argument("--concurrent", type=int, default=5,
                        help="Queries simultáneas en la ronda de carga (default: 5)")
    parser.add_argument("--groq-key", default=os.environ.get("GROQ_API_KEY",""))
    parser.add_argument("--output",  help="Guardar reporte JSON (default: auto-nombre)")
    parser.add_argument("--label",   default="", help="Etiqueta del ambiente (ej: 'STAGING' o 'PROD')")
    args = parser.parse_args()

    label = args.label or ("STAGING" if "8080" in args.url else "PROD")
    print(f"\n{'═'*72}")
    print(f"  {_c(BOLD+CYAN,'TEST BOT')}  ambiente={_c(BOLD+WHITE,label)}  "
          f"url={args.url}  tenant={args.tenant}")
    print(f"{'═'*72}")

    # ── 1. Login ──────────────────────────────────────────────────────────────
    hdr(f"1 / 5   LOGIN  [{label}]")
    token = _login(args.url, args.email, args.password, args.tenant)
    ok(f"Autenticado → {args.email}")

    # ── 2. Documento ──────────────────────────────────────────────────────────
    hdr(f"2 / 5   DOCUMENTO  [{label}]")
    ingest_time = 0
    chunk_count = "?"
    quality_gate = "?"
    already_existed = False

    if args.file:
        file_path = Path(args.file)
        if not file_path.exists():
            err(f"Archivo no encontrado: {args.file}"); sys.exit(1)
        ok(f"Subiendo {file_path.name} ({file_path.stat().st_size//1024} KB)…")
        doc_id, already_existed = _upload(args.url, token, args.tenant, file_path)
        if already_existed:
            info("Documento ya indexado — saltando espera de ingesta")
            chunk_count = "?"
        else:
            info("Esperando indexación…")
            t0 = time.monotonic()
            st = _poll_ready(args.url, token, args.tenant, doc_id)
            print()
            ingest_time = int(time.monotonic() - t0)
            chunk_count  = st.get("chunk_count", "?")
            quality_gate = st.get("quality_gate_status", "?")
            ok(f"Listo — {chunk_count} chunks  quality={quality_gate}  tiempo={ingest_time}s")
    else:
        warn("--file no especificado. Usando documentos ya existentes en el tenant.")

    # ── 3. Preguntas ──────────────────────────────────────────────────────────
    hdr(f"3 / 5   PREGUNTAS  [{label}]")
    if args.questions:
        questions = [l.strip() for l in Path(args.questions).read_text().splitlines() if l.strip()]
        ok(f"Cargadas {len(questions)} preguntas desde {args.questions}")
    else:
        if not args.groq_key:
            err("Necesitás --groq-key o GROQ_API_KEY para generar preguntas.")
            err("Alternativa: --questions archivo.txt")
            sys.exit(1)
        try: from groq import Groq
        except ImportError:
            err("pip install groq"); sys.exit(1)
        text = _read_text(file_path) if args.file else "Documento institucional"
        info(f"Generando {args.n_queries} preguntas con Groq…")
        questions = _generate_questions(text, args.n_queries, args.groq_key)
        ok(f"Generadas {len(questions)} preguntas")

    if args.save_questions:
        Path(args.save_questions).write_text("\n".join(questions))
        ok(f"Preguntas guardadas en {args.save_questions} — copiá este archivo a la otra consola")

    print()
    for i, q in enumerate(questions, 1):
        print(f"  {_c(DIM, str(i).rjust(2)+'.')} {q}")

    n = len(questions)

    # ── 4. Rondas de queries ──────────────────────────────────────────────────
    hdr(f"4 / 5   QUERIES  [{label}]")

    # ── 4a. Cold cache ────────────────────────────────────────────────────────
    print(f"\n  {_c(YELLOW+BOLD,'⚡ RONDA 1 — COLD CACHE')}  (secuencial, sin caché previo)")
    cold = []
    for i, q in enumerate(questions, 1):
        print(f"  {i}/{n}…", end="\r", flush=True)
        cold.append(_query_one(args.url, token, args.tenant, q))
    cold_st = _print_round(f"COLD CACHE — {label}", cold, show_answers=True)

    # ── 4b. Carga concurrente ─────────────────────────────────────────────────
    print(f"\n  {_c(RED+BOLD,'⚡ RONDA 2 — CARGA CONCURRENTE')}  "
          f"({args.concurrent} queries simultáneas)")
    info(f"Enviando {n} queries en batches de {args.concurrent}…")
    conc = []
    t_conc_start = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.concurrent) as ex:
        futures = {ex.submit(_query_one, args.url, token, args.tenant, q): q
                   for q in questions}
        done = 0
        for fut in as_completed(futures):
            conc.append(fut.result())
            done += 1
            print(f"  {done}/{n}…", end="\r", flush=True)
    t_conc_total = int((time.monotonic() - t_conc_start) * 1000)
    qps = round(n / (t_conc_total / 1000), 2)

    conc_st = _print_round(f"CARGA CONCURRENTE — {label}", conc,
                           label_fn=lambda r: f"server={r.get('server_ms','?')}ms")
    print(f"  Throughput total={t_conc_total}ms  qps={_c(WHITE,str(qps))}")

    # ── 4c. Warm cache ────────────────────────────────────────────────────────
    print(f"\n  {_c(BLUE+BOLD,'⚡ RONDA 3 — WARM CACHE')}  (mismas preguntas, mide cache)")
    warm = []
    for i, q in enumerate(questions, 1):
        print(f"  {i}/{n}…", end="\r", flush=True)
        warm.append(_query_one(args.url, token, args.tenant, q))
    warm_st = _print_round(f"WARM CACHE — {label}", warm)

    # ── 5. Resumen ────────────────────────────────────────────────────────────
    hdr(f"5 / 5   RESUMEN  [{label}]")
    sep()

    cache_rate  = (warm_st.get("cache",0) / n * 100) if n else 0
    speedup     = cold_st["avg"] / max(warm_st["avg"],1) if cold_st and warm_st else 1
    quality_pct = 100 - (
        (cold_st.get("no_src",0)/n*40) +
        (cold_st.get("low_conf",0)/n*20) +
        (cold_st.get("errors",0)/n*40)
    ) if cold_st else 0

    print(f"  {'Ambiente':<34} {_c(BOLD+WHITE, label)}")
    print(f"  {'URL':<34} {args.url}")
    print(f"  {'Tenant':<34} {args.tenant}")
    if args.file:
        print(f"  {'Documento':<34} {Path(args.file).name}")
        print(f"  {'Chunks indexados':<34} {chunk_count}")
        print(f"  {'Quality gate':<34} {quality_gate}")
        print(f"  {'Tiempo de ingesta':<34} {ingest_time}s")
    print()
    print(f"  {'─── LATENCIA (cold / sin cache) ─'}")
    print(f"  {'  avg':<34} {_c(_ms_color(cold_st.get('avg',0)), str(cold_st.get('avg','?'))+'ms')}")
    print(f"  {'  p50':<34} {cold_st.get('median','?')}ms")
    print(f"  {'  p75':<34} {cold_st.get('p75','?')}ms")
    print(f"  {'  p95':<34} {_c(_ms_color(cold_st.get('p95',0)), str(cold_st.get('p95','?'))+'ms')}")
    print(f"  {'  p99':<34} {_c(_ms_color(cold_st.get('p99',0)), str(cold_st.get('p99','?'))+'ms')}")
    print(f"  {'  max':<34} {_c(_ms_color(cold_st.get('max',0)), str(cold_st.get('max','?'))+'ms')}")
    print(f"  {'  stddev':<34} {cold_st.get('stddev','?')}ms  ← variabilidad")
    print()
    print(f"  {'─── LATENCIA (carga concurrente) ─'}")
    print(f"  {'  avg':<34} {_c(_ms_color(conc_st.get('avg',0)), str(conc_st.get('avg','?'))+'ms')}")
    print(f"  {'  p95':<34} {_c(_ms_color(conc_st.get('p95',0)), str(conc_st.get('p95','?'))+'ms')}")
    print(f"  {'  throughput':<34} {_c(WHITE, str(qps))} queries/seg")
    conc_penalty = conc_st.get('avg',0) - cold_st.get('avg',0) if cold_st and conc_st else 0
    print(f"  {'  penalidad vs secuencial':<34} {_c(YELLOW if conc_penalty>500 else GREEN, f'+{conc_penalty}ms')}")
    print()
    print(f"  {'─── CACHE ─'}")
    print(f"  {'  hit rate':<34} {_c(GREEN if cache_rate>=60 else YELLOW, f'{cache_rate:.0f}%')}")
    print(f"  {'  avg warm':<34} {_c(GREEN, str(warm_st.get('avg','?'))+'ms')}")
    print(f"  {'  speedup':<34} {_c(GREEN, f'{speedup:.1f}x más rápido con cache')}")
    print()
    print(f"  {'─── CALIDAD ─'}")
    print(f"  {'  con fuentes':<34} {n - cold_st.get('no_src',0)}/{n}  ({100-cold_st.get('no_src',0)/n*100:.0f}%)")
    print(f"  {'  baja confianza':<34} {cold_st.get('low_conf',0)}/{n}")
    print(f"  {'  errores':<34} {cold_st.get('errors',0)}/{n}")
    print(f"  {'  score calidad':<34} {_c(GREEN if quality_pct>=80 else YELLOW if quality_pct>=65 else RED, f'{quality_pct:.0f}%')}")
    print()

    # SLA
    sla = {
        "latencia_p95_le_8s": cold_st.get("p95",9999) <= 8000,
        "calidad_ge_75pct":   quality_pct >= 75,
        "cache_ge_40pct":     cache_rate >= 40,
        "sin_errores":        cold_st.get("errors",0) == 0,
        "carga_p95_le_12s":   conc_st.get("p95",9999) <= 12000,
    }
    print(f"  {'─── SLA ─'}")
    for sla_name, passed in sla.items():
        icon = _c(GREEN,"PASS") if passed else _c(RED,"FAIL")
        print(f"  [{icon}]  {sla_name}")
    sep()

    overall = all(sla.values())
    if overall:
        print(f"\n  {_c(GREEN+BOLD, '✓ TODO OK — listo para promover a producción')}\n")
    else:
        failed = [k for k,v in sla.items() if not v]
        print(f"\n  {_c(RED+BOLD, f'✗ FALLÓ: {chr(44).join(failed)}')}\n")

    # ── Guardar JSON ──────────────────────────────────────────────────────────
    ts    = time.strftime("%Y%m%d_%H%M%S")
    out   = args.output or f"report_{label.lower()}_{ts}.json"
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "label":     label,
        "config":    {"url": args.url, "tenant": args.tenant,
                      "file": str(args.file or ""), "concurrent": args.concurrent},
        "ingestion": {"time_s": ingest_time, "chunks": chunk_count, "quality": quality_gate},
        "cold":      cold_st,
        "concurrent":{"stats": conc_st, "total_ms": t_conc_total, "qps": qps,
                      "concurrency": args.concurrent},
        "warm":      warm_st,
        "cache_rate_pct": round(cache_rate,1),
        "speedup_x":      round(speedup,2),
        "quality_pct":    round(quality_pct,1),
        "sla":       sla,
        "overall_pass": overall,
        "questions": questions,
        "cold_detail": [
            {"q": r["q"], "ms": r.get("ms"), "sources": r.get("sources"),
             "cache": r.get("cache"), "low_conf": r.get("low_conf"),
             "intent": r.get("intent"), "answer": r.get("answer","")[:200]}
            for r in cold
        ],
    }
    Path(out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    ok(f"Reporte JSON → {out}")


if __name__ == "__main__":
    main()
