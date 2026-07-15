#!/usr/bin/env python3
"""Harness de charlas reales contra el widget (ambiente local).

Cada escenario abre una conversación real (POST /widget/conversation/start) y
manda mensajes como lo haría un afiliado. Mide latencia por turno, chequea
facts esperados (substring case-insensitive, sin tildes; una lista anidada =
alternativas) y marcadores prohibidos (alucinación / fuga de datos).
El flujo de login inyecta un OTP conocido en Redis (DB 3 del contenedor
local_redis) — mismo formato que escribe services/otp.py — para no depender
del email real.

Uso:
    python3 scripts/chat_suite.py scripts/chat_suite_intellix.json /tmp/report.json

Requiere el stack local levantado (./scripts/dev-local.sh up + mock_pixs).
Respeta el rate limit del widget (30 msg/min) espaciando los turnos.
"""
import hashlib
import json
import re
import subprocess
import sys
import time
import unicodedata
import uuid

import requests

BASE = "http://localhost:8010/api/v1"
TENANT = "intellix"
OTP_CODE = "424242"
OTP_HASH = hashlib.sha256(OTP_CODE.encode()).hexdigest()

MIN_INTERVAL_S = 2.1  # rate limit widget: 30 msg/min por IP
_last_send = [0.0]


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "").lower()
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def get_token() -> str:
    r = requests.get(f"{BASE}/public/chat-token", headers={"X-Tenant-ID": TENANT}, timeout=10)
    r.raise_for_status()
    return r.json()["widget_token"]


def start_conv(token: str) -> tuple[str, str]:
    sid = f"harness-{uuid.uuid4()}"
    r = requests.post(
        f"{BASE}/widget/conversation/start",
        json={"widget_session_id": sid},
        headers={"Authorization": f"Bearer {token}", "X-Tenant-ID": TENANT},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()["conversation_id"], sid


def send(token: str, conv: str, sid: str, text: str) -> tuple[str, float]:
    # pacing para no pisar el rate limit
    wait = MIN_INTERVAL_S - (time.monotonic() - _last_send[0])
    if wait > 0:
        time.sleep(wait)
    t0 = time.monotonic()
    r = requests.post(
        f"{BASE}/widget/conversation/{conv}/message",
        json={"content": text, "widget_session_id": sid},
        headers={"Authorization": f"Bearer {token}", "X-Tenant-ID": TENANT},
        timeout=60,
    )
    dt = time.monotonic() - t0
    _last_send[0] = time.monotonic()
    if r.status_code == 429:
        time.sleep(35)
        return send(token, conv, sid, text)
    r.raise_for_status()
    body = r.json()
    answer = body.get("bot_response") or body.get("handoff_message") or "(sin respuesta)"
    return answer, dt


def inject_otp(conv: str, dni: str) -> None:
    blob = json.dumps({"identity": dni, "hash": OTP_HASH})
    subprocess.run(
        ["docker", "exec", "local_redis", "redis-cli", "-n", "3",
         "SET", f"otp:{TENANT}:{conv}", blob, "EX", "300"],
        check=True, capture_output=True,
    )


def check(answer: str, expect: list, forbid: list) -> tuple[bool, list]:
    a = _norm(answer)
    fails = []
    for e in expect or []:
        alts = e if isinstance(e, list) else [e]
        if not any(_norm(x) in a for x in alts):
            fails.append(f"FALTA: {alts}")
    for f in forbid or []:
        alts = f if isinstance(f, list) else [f]
        hits = [x for x in alts if _norm(x) in a]
        if hits:
            fails.append(f"PROHIBIDO presente: {hits}")
    return (not fails), fails


def run(scenarios: list, out_path: str) -> None:
    token = get_token()
    report = []
    for sc in scenarios:
        conv, sid = start_conv(token)
        entry = {"id": sc["id"], "cat": sc["cat"], "conv": conv, "turns": []}
        print(f"\n== [{sc['cat']}] {sc['id']} (conv {conv[:8]})", flush=True)
        for step in sc["turns"]:
            if step.get("inject_otp"):
                inject_otp(conv, step["inject_otp"])
            text = step["say"]
            try:
                answer, dt = send(token, conv, sid, text)
            except Exception as exc:
                answer, dt = f"(ERROR HTTP: {exc})", -1
            ok, fails = check(answer, step.get("expect"), step.get("forbid"))
            entry["turns"].append({
                "say": text, "answer": answer, "latency_s": round(dt, 2),
                "ok": ok, "fails": fails,
            })
            mark = "✓" if ok else "✗"
            print(f"  {mark} {dt:5.2f}s  «{text[:60]}»", flush=True)
            if not ok:
                for f in fails:
                    print(f"      {f}", flush=True)
                print(f"      → {answer[:300]}", flush=True)
        report.append(entry)

    with open(out_path, "w") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    # resumen
    lat = [t["latency_s"] for e in report for t in e["turns"] if t["latency_s"] > 0]
    bad = [(e["id"], t) for e in report for t in e["turns"] if not t["ok"]]
    lat.sort()
    n = len(lat)
    print(f"\n{'='*60}")
    print(f"Turnos: {n} | OK: {n - len(bad)} | FALLAS: {len(bad)}")
    if lat:
        print(f"Latencia p50: {lat[n//2]:.2f}s | p95: {lat[int(n*0.95)]:.2f}s | max: {lat[-1]:.2f}s")
    for sid_, t in bad:
        print(f"  ✗ {sid_}: «{t['say'][:50]}» → {t['fails']}")


if __name__ == "__main__":
    scen_file = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/report.json"
    with open(scen_file) as fh:
        run(json.load(fh), out)
