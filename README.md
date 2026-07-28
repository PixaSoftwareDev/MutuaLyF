# Intellix — Plataforma de Conocimiento con IA

SaaS multitenant: cada organización carga sus documentos y sus usuarios los
consultan en lenguaje natural (RAG con anti-alucinación), con derivación a
operadores humanos por widget web y WhatsApp.

**¿Nuevo en el proyecto? Leé [`CLAUDE.md`](./CLAUDE.md)** — es la fuente de
verdad: stack real, arquitectura, ambientes/ramas, flags, reglas de trabajo y
mapa del código. Después, según lo que vayas a hacer:

- Levantar el entorno local → [`docs/DEV_LOCAL.md`](./docs/DEV_LOCAL.md)
- Operar el VPS (deploy, salud, monitoreo) → [`docs/OPERACIONES.md`](./docs/OPERACIONES.md)
- Incidente en producción → [`docs/RUNBOOK.md`](./docs/RUNBOOK.md)
- Mejorar el motor RAG → [`docs/PLAN_CALIDAD_MOTOR.md`](./docs/PLAN_CALIDAD_MOTOR.md) (regla: sin mejora medida no se avanza)

## Arranque rápido local

```bash
cp .env.example .env.local            # completar claves (OpenAI, JWT, etc.)
docker compose -f docker-compose.local.yml up -d
# Frontend: http://localhost:3010 · Backend: http://localhost:8010
# El primer arranque del backend tarda 2-3 min (descarga/carga de modelos).
```

Tests: `docker exec local_backend python -m pytest tests/ -q`
Suite de calidad del motor: `scripts/run_quality_suite.py`

## Ambientes

| | URL | Rama |
|---|---|---|
| Local | `localhost:3010` | `dev-local` |
| Staging | `dev.intellix.com.ar` | `dev` |
| Producción | `intellix.com.ar` | `main` |

El desarrollo diario va en `dev-local`; los pasajes a staging/prod son eventos
coordinados (ver reglas en `CLAUDE.md`).
