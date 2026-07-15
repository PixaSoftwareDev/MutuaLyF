"""Base de datos Pixs — servicio externo simulado para el framework de conectores.

Simula el sistema interno de Pixs (software studio, Pergamino, Argentina) con la
información REAL de la base de conocimiento del tenant intellix: servicios,
proyectos y los 3 socios fundadores. Solo los 3 dueños pueden identificarse en
el chat (login DNI + OTP de la plataforma).

Autenticación del API: JSON Web Token (JWT).
  POST /auth/token  {client_id, client_secret}  → JWT HS256, vence en 90 días.
  Todas las demás rutas (incluido /openapi.json) exigen Authorization: Bearer <jwt>
  con firma y expiración válidas. Solo /health queda público.

5 rutas de datos:
  PÚBLICAS:
    GET /servicios                      → los 6 servicios del estudio
    GET /proyectos?estado=X             → portfolio (activo | entregado)
  PERSONALES (solo socios):
    GET /socios/{dni}                   → perfil + contacto (lookup para el OTP)
    GET /socios/{dni}/proyectos         → proyectos asignados al socio
    GET /socios/{dni}/finanzas          → facturación y pendientes del socio
"""

import sqlite3
import time
from contextlib import closing
from typing import Literal

import jwt
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Base de datos Pixs", version="1.0")

DB_PATH = "/data/pixs.db"

# ── Autenticación JWT ──────────────────────────────────────────────────────────
JWT_SECRET = "pixs-jwt-firma-demo"          # secreto de firma (interno del proveedor)
CLIENT_ID = "intellix"                       # credenciales que Pixs le da al integrador
CLIENT_SECRET = "pixs-integracion-2026"
TOKEN_TTL_S = 90 * 24 * 3600                 # 90 días
PUBLIC_PATHS = {"/health", "/auth/token"}


@app.middleware("http")
async def require_jwt(request: Request, call_next):
    if request.url.path not in PUBLIC_PATHS:
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
        try:
            jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        except jwt.PyJWTError as exc:
            return JSONResponse(status_code=401, content={"detail": f"JWT inválido: {exc}"})
    return await call_next(request)


class TokenIn(BaseModel):
    client_id: str
    client_secret: str


@app.post("/auth/token")
def issue_token(body: TokenIn):
    """Canjea credenciales de integración por un JWT de 90 días."""
    if body.client_id != CLIENT_ID or body.client_secret != CLIENT_SECRET:
        return JSONResponse(status_code=401, content={"detail": "Credenciales inválidas"})
    now = int(time.time())
    token = jwt.encode({"sub": body.client_id, "scope": "read", "iat": now, "exp": now + TOKEN_TTL_S},
                       JWT_SECRET, algorithm="HS256")
    return {"access_token": token, "token_type": "bearer", "expires_in": TOKEN_TTL_S}


# ── Datos (de la base de conocimiento real de Pixs) ────────────────────────────

def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def seed():
    with closing(_conn()) as c:
        c.executescript("""
        DROP TABLE IF EXISTS servicios;
        DROP TABLE IF EXISTS proyectos;
        DROP TABLE IF EXISTS socios;
        DROP TABLE IF EXISTS socio_proyectos;
        DROP TABLE IF EXISTS finanzas;

        CREATE TABLE servicios (id TEXT PRIMARY KEY, nombre TEXT, descripcion TEXT, tecnologias TEXT);
        CREATE TABLE proyectos (nombre TEXT, cliente TEXT, tipo TEXT, estado TEXT, entrega TEXT);
        CREATE TABLE socios (dni TEXT PRIMARY KEY, nombre TEXT, cargo TEXT, area TEXT, email TEXT, celular TEXT);
        CREATE TABLE socio_proyectos (dni TEXT, proyecto TEXT, rol TEXT, estado TEXT, horas_semana INTEGER);
        CREATE TABLE finanzas (dni TEXT PRIMARY KEY, facturado_mes REAL, pendiente_cobro REAL, moneda TEXT, detalle TEXT);
        """)

        servicios = [
            ("web", "Web Apps", "Aplicaciones web modernas, escalables y rápidas.", "Next.js, React, Node"),
            ("mobile", "Mobile Apps", "Apps nativas y cross-platform para iOS y Android.", "React Native"),
            ("mvp", "MVPs y productos completos", "De la idea a producción en semanas, no en trimestres.", "Next.js, Python"),
            ("integraciones", "Integraciones y APIs", "Conectamos sistemas y construimos APIs a medida.", "Node.js, Python, FastAPI"),
            ("ia", "IA y automatización", "Agentes, RAG, copilots y workflows con LLMs.", "Python, LLMs, Qdrant"),
            ("ecommerce", "E-commerce", "Tiendas online a medida.", "Next.js, Node"),
        ]
        proyectos = [
            ("Intellix", "Producto propio", "Plataforma SaaS de IA conversacional multi-tenant", "activo", "en producción"),
            ("Handicapp", "Producto propio", "Plataforma SaaS de gestión ecuestre", "activo", "en producción"),
            ("Chatbot Mutual LyF", "Mutual LyF", "Asistente IA con datos en vivo (Intellix)", "activo", "2026-08-30"),
            ("E-commerce Agropecuaria del Norte", "Agro del Norte SA", "Tienda online B2B", "entregado", "2026-04-12"),
            ("App de turnos Clínica Modelo", "Clínica Modelo Pergamino", "App mobile de turnos", "entregado", "2026-02-28"),
        ]
        # Los 3 socios fundadores — los ÚNICOS que pueden identificarse en el chat.
        socios = [
            ("28555666", "Enzo Italo Batistelli", "Co-founder & Head of Sales", "Comercial y desarrollo de negocios",
             "enzo@pixs.dev", "+54 9 2477 50-1001"),
            # Resend free sin dominio verificado SOLO entrega a la casilla dueña de
            # la cuenta (pixa.software.dev@gmail.com) → el socio de la demo usa esa,
            # así el OTP llega de verdad. Con dominio verificado, volver al real.
            ("34447758", "Guillermo German Fernandez", "Co-founder & Lead Developer", "Desarrollo de software (backend)",
             "pixa.software.dev@gmail.com", "+54 9 2477 50-1002"),
            ("35777888", "Alejo Maros", "Co-founder & Lead Developer", "Desarrollo y Business Intelligence",
             "alejo@pixs.dev", "+54 9 2477 50-1003"),
        ]
        socio_proyectos = [
            ("28555666", "Chatbot Mutual LyF", "Comercial / relación con el cliente", "activo", 10),
            ("28555666", "Intellix", "Ventas y partnerships", "activo", 20),
            ("34447758", "Intellix", "Tech Lead / backend", "activo", 30),
            ("34447758", "Chatbot Mutual LyF", "Desarrollo del bot y conectores", "activo", 15),
            ("35777888", "Handicapp", "Lead Developer / datos y BI", "activo", 25),
            ("35777888", "Intellix", "Analítica y reportes", "activo", 10),
        ]
        finanzas = [
            ("28555666", 4200000.0, 1500000.0, "ARS", "Facturación de julio al día. Pendiente: 2ª cuota Mutual LyF (vence 2026-07-25)."),
            ("34447758", 3800000.0, 0.0, "ARS", "Facturación de julio al día. Sin pendientes de cobro."),
            ("35777888", 3500000.0, 800000.0, "ARS", "Pendiente: licencias Handicapp haras San Jorge (vence 2026-07-20)."),
        ]

        c.executemany("INSERT INTO servicios VALUES (?,?,?,?)", servicios)
        c.executemany("INSERT INTO proyectos VALUES (?,?,?,?,?)", proyectos)
        c.executemany("INSERT INTO socios VALUES (?,?,?,?,?,?)", socios)
        c.executemany("INSERT INTO socio_proyectos VALUES (?,?,?,?,?)", socio_proyectos)
        c.executemany("INSERT INTO finanzas VALUES (?,?,?,?,?)", finanzas)
        c.commit()


@app.on_event("startup")
def _startup():
    import os
    os.makedirs("/data", exist_ok=True)
    seed()


@app.get("/health")
def health():
    return {"status": "ok", "service": "base_datos_pixs"}


# ── Rutas públicas ─────────────────────────────────────────────────────────────

@app.get("/servicios")
def listar_servicios():
    """Servicios que ofrece el estudio."""
    with closing(_conn()) as c:
        rows = c.execute("SELECT * FROM servicios").fetchall()
    return {"servicios": [dict(r) for r in rows]}


@app.get("/proyectos")
def listar_proyectos(estado: Literal["activo", "entregado"] = Query(...)):
    """Portfolio de proyectos por estado."""
    with closing(_conn()) as c:
        rows = c.execute("SELECT * FROM proyectos WHERE estado=?", (estado,)).fetchall()
    return {"estado": estado, "proyectos": [dict(r) for r in rows]}


# ── Rutas personales (solo socios) ─────────────────────────────────────────────

@app.get("/socios/{dni}")
def perfil_socio(dni: str):
    """Perfil del socio con datos de contacto — lo que la plataforma consulta
    para enviar su propio código de verificación."""
    with closing(_conn()) as c:
        r = c.execute("SELECT * FROM socios WHERE dni=?", (dni,)).fetchone()
        if not r:
            return {"socio": dni, "encontrado": False}
        return {"socio": dni, "encontrado": True, "nombre": r["nombre"], "cargo": r["cargo"],
                "area": r["area"], "email": r["email"], "celular": r["celular"]}


@app.get("/socios/{dni}/proyectos")
def proyectos_socio(dni: str):
    """Proyectos asignados al socio."""
    with closing(_conn()) as c:
        s = c.execute("SELECT * FROM socios WHERE dni=?", (dni,)).fetchone()
        if not s:
            return {"socio": dni, "encontrado": False, "proyectos": []}
        rows = c.execute("SELECT proyecto, rol, estado, horas_semana FROM socio_proyectos WHERE dni=?", (dni,)).fetchall()
    return {"socio": dni, "encontrado": True, "proyectos": [dict(r) for r in rows]}


@app.get("/socios/{dni}/finanzas")
def finanzas_socio(dni: str):
    """Facturación del mes y pendientes de cobro del socio."""
    with closing(_conn()) as c:
        r = c.execute("SELECT * FROM finanzas WHERE dni=?", (dni,)).fetchone()
        if not r:
            return {"socio": dni, "encontrado": False}
        return {"socio": dni, "encontrado": True, "facturado_mes": r["facturado_mes"],
                "pendiente_cobro": r["pendiente_cobro"], "moneda": r["moneda"], "detalle": r["detalle"]}
