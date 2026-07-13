"""Mock NEXA — servicio externo simulado para probar el framework de conectores.

NO es NEXA real. Es una API HTTP propia con su DB SQLite y datos inventados, que
imita el contrato de una obra social médica. Sirve para ejercitar el camino HTTP
REAL del executor (httpx + egress_guard + response_map + circuit breaker) sin
depender de NEXA ni de OpenAI.

4 rutas:
  PÚBLICAS (sin auth):
    GET /profesionales?especialidad=X       → profesionales + horarios
    GET /profesionales/{matricula}/horarios  → horarios de atención
  PERSONALES (el afiliado se identifica; acá el mock confía en el DNI de la URL,
  la autenticación real la hace el backend antes de llamar):
    GET /afiliados/{dni}/ordenes             → órdenes pendientes
    GET /afiliados/{dni}/cuenta              → cuenta corriente / deuda
  AUTH (2º factor):
    GET /afiliados/{dni}/validar?codigo=X    → valida el código (acepta 111111)
"""

import sqlite3
from contextlib import closing
from typing import Literal

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Mock NEXA", version="0.1")

DB_PATH = "/data/mock_nexa.db"
VALID_CODE = "111111"

# ── Verificación por API key ───────────────────────────────────────────────────
# Simula un proveedor real que exige credencial: toda ruta (incluido el catálogo
# /openapi.json) requiere el header X-API-Key. Solo /health queda público.
API_KEY = "nexa-demo-key-123"
PUBLIC_PATHS = {"/health"}


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    if request.url.path not in PUBLIC_PATHS and request.headers.get("X-API-Key") != API_KEY:
        return JSONResponse(status_code=401, content={"detail": "API key inválida o ausente"})
    return await call_next(request)


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def seed():
    with closing(_conn()) as c:
        c.executescript("""
        DROP TABLE IF EXISTS profesionales;
        DROP TABLE IF EXISTS horarios;
        DROP TABLE IF EXISTS afiliados;
        DROP TABLE IF EXISTS ordenes;
        DROP TABLE IF EXISTS cuenta;

        CREATE TABLE profesionales (matricula TEXT PRIMARY KEY, nombre TEXT, especialidad TEXT, consultorio TEXT);
        CREATE TABLE horarios (matricula TEXT, dia TEXT, desde TEXT, hasta TEXT);
        CREATE TABLE afiliados (dni TEXT PRIMARY KEY, nombre TEXT, email TEXT, celular TEXT);
        CREATE TABLE ordenes (dni TEXT, tipo TEXT, prestador TEXT, estado TEXT, vence TEXT);
        CREATE TABLE cuenta (dni TEXT PRIMARY KEY, saldo REAL, al_dia INTEGER, detalle TEXT);
        """)

        profesionales = [
            ("MP-1001", "Dra. Ana Gómez",    "Cardiología",    "Consultorio 3"),
            ("MP-1002", "Dr. Luis Paredes",  "Cardiología",    "Consultorio 5"),
            ("MP-1003", "Dra. Carla Ruiz",   "Pediatría",      "Consultorio 1"),
            ("MP-1004", "Dr. Jorge Díaz",    "Traumatología",  "Consultorio 7"),
            ("MP-1005", "Dra. Marta Sosa",   "Dermatología",   "Consultorio 2"),
        ]
        horarios = [
            ("MP-1001", "Lunes", "09:00", "13:00"), ("MP-1001", "Miércoles", "09:00", "13:00"),
            ("MP-1001", "Viernes", "14:00", "18:00"),
            ("MP-1002", "Martes", "08:00", "12:00"), ("MP-1002", "Jueves", "08:00", "12:00"),
            ("MP-1003", "Lunes", "08:00", "12:00"), ("MP-1003", "Martes", "08:00", "12:00"),
            ("MP-1003", "Miércoles", "08:00", "12:00"), ("MP-1003", "Jueves", "08:00", "12:00"),
            ("MP-1003", "Viernes", "08:00", "12:00"),
            ("MP-1004", "Martes", "14:00", "19:00"), ("MP-1004", "Jueves", "14:00", "19:00"),
            ("MP-1005", "Miércoles", "09:00", "13:00"), ("MP-1005", "Viernes", "09:00", "13:00"),
        ]
        afiliados = [
            ("30111222", "Guillermo Fernández", "guillermo.f@ejemplo.com.ar", "+54 9 351 555-0101"),
            ("27888999", "María López", "maria.lopez@ejemplo.com.ar", "+54 9 351 555-0202"),
        ]
        ordenes = [
            ("30111222", "Consulta cardiología", "Dra. Ana Gómez", "pendiente", "2026-08-15"),
            ("30111222", "Laboratorio - análisis de sangre", "Lab Central", "pendiente", "2026-07-30"),
        ]
        cuenta = [
            ("30111222", 0.0, 1, "Sin deuda. Última cuota paga el 2026-07-01."),
            ("27888999", 12500.0, 0, "Cuota de julio impaga ($12.500)."),
        ]

        c.executemany("INSERT INTO profesionales VALUES (?,?,?,?)", profesionales)
        c.executemany("INSERT INTO horarios VALUES (?,?,?,?)", horarios)
        c.executemany("INSERT INTO afiliados VALUES (?,?,?,?)", afiliados)
        c.executemany("INSERT INTO ordenes VALUES (?,?,?,?,?)", ordenes)
        c.executemany("INSERT INTO cuenta VALUES (?,?,?,?)", cuenta)
        c.commit()


@app.on_event("startup")
def _startup():
    import os
    os.makedirs("/data", exist_ok=True)
    seed()


@app.get("/health")
def health():
    return {"status": "ok", "service": "mock_nexa"}


def _horarios_de(c, matricula: str) -> list[dict]:
    rows = c.execute("SELECT dia, desde, hasta FROM horarios WHERE matricula=?", (matricula,)).fetchall()
    return [{"dia": r["dia"], "desde": r["desde"], "hasta": r["hasta"]} for r in rows]


# ── PÚBLICAS ───────────────────────────────────────────────────────────────────
@app.get("/profesionales")
def profesionales_por_especialidad(
    especialidad: Literal["Cardiología", "Pediatría", "Traumatología", "Dermatología"] = Query(...),
):
    with closing(_conn()) as c:
        rows = c.execute(
            "SELECT * FROM profesionales WHERE lower(especialidad)=lower(?)",
            (especialidad,)).fetchall()
        profs = [{
            "matricula": r["matricula"], "nombre": r["nombre"],
            "especialidad": r["especialidad"], "consultorio": r["consultorio"],
            "horarios": _horarios_de(c, r["matricula"]),
        } for r in rows]
    return {"especialidad": especialidad, "profesionales": profs}


@app.get("/profesionales/{matricula}/horarios")
def horarios_profesional(matricula: str):
    with closing(_conn()) as c:
        r = c.execute("SELECT * FROM profesionales WHERE matricula=?", (matricula,)).fetchone()
        if not r:
            return {"encontrado": False, "matricula": matricula, "horarios": []}
        return {
            "encontrado": True, "matricula": matricula, "nombre": r["nombre"],
            "especialidad": r["especialidad"], "consultorio": r["consultorio"],
            "horarios": _horarios_de(c, matricula),
        }


# ── PERSONALES ─────────────────────────────────────────────────────────────────
@app.get("/afiliados/{dni}")
def perfil_afiliado(dni: str):
    """Perfil con datos de contacto — lo que la plataforma consulta para enviar
    su propio OTP (la 'base del cliente' siempre tiene email/celular)."""
    with closing(_conn()) as c:
        r = c.execute("SELECT * FROM afiliados WHERE dni=?", (dni,)).fetchone()
        if not r:
            return {"afiliado": dni, "encontrado": False}
        return {"afiliado": dni, "encontrado": True, "nombre": r["nombre"],
                "email": r["email"], "celular": r["celular"]}


@app.get("/afiliados/{dni}/ordenes")
def ordenes_afiliado(dni: str):
    with closing(_conn()) as c:
        af = c.execute("SELECT * FROM afiliados WHERE dni=?", (dni,)).fetchone()
        if not af:
            return {"afiliado": dni, "encontrado": False, "ordenes": []}
        rows = c.execute("SELECT * FROM ordenes WHERE dni=? AND estado='pendiente'", (dni,)).fetchall()
        ordenes = [{"tipo": r["tipo"], "prestador": r["prestador"],
                    "estado": r["estado"], "vence": r["vence"]} for r in rows]
    return {"afiliado": dni, "encontrado": True, "ordenes": ordenes}


@app.get("/afiliados/{dni}/cuenta")
def cuenta_afiliado(dni: str):
    with closing(_conn()) as c:
        r = c.execute("SELECT * FROM cuenta WHERE dni=?", (dni,)).fetchone()
        if not r:
            return {"afiliado": dni, "encontrado": False}
        return {"afiliado": dni, "encontrado": True, "saldo": r["saldo"],
                "al_dia": bool(r["al_dia"]), "detalle": r["detalle"]}


# ── AUTH (2º factor) ───────────────────────────────────────────────────────────
@app.get("/afiliados/{dni}/validar")
def validar(dni: str, codigo: str = Query(...)):
    with closing(_conn()) as c:
        af = c.execute("SELECT * FROM afiliados WHERE dni=?", (dni,)).fetchone()
    if not af:
        return {"ok": False, "reason": "not_found"}
    if codigo != VALID_CODE:
        return {"ok": False, "reason": "wrong_code"}
    return {"ok": True, "nombre": af["nombre"]}
