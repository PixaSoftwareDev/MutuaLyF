# Intellix — Plataforma de Conocimiento con IA

SaaS multitenant: cada organización carga sus documentos y sus usuarios los
consultan en lenguaje natural (RAG con anti-alucinación), con derivación a
operadores humanos por widget web y WhatsApp.

## Por dónde empezar

**Nuevo en el proyecto → leé [`CLAUDE.md`](./CLAUDE.md).** Es la fuente de
verdad: stack real, arquitectura, ambientes y ramas, feature flags, reglas de
trabajo y mapa del código. Después, según lo que vayas a hacer:

| Quiero… | Documento |
|---|---|
| Levantar el entorno local | [`docs/DEV_LOCAL.md`](./docs/DEV_LOCAL.md) |
| Operar el VPS (deploy, salud, monitoreo) | [`docs/OPERACIONES.md`](./docs/OPERACIONES.md) |
| Atender un incidente en producción | [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) |
| Mejorar el motor RAG | [`docs/PLAN_CALIDAD_MOTOR.md`](./docs/PLAN_CALIDAD_MOTOR.md) — regla: sin mejora medida no se avanza |
| Preparar documentos para la base de conocimiento | [`docs/KNOWLEDGE_BASE_GUIDE.md`](./docs/KNOWLEDGE_BASE_GUIDE.md) |
| Saber qué el bot todavía no responde bien | [`docs/LIMITES_CONOCIDOS.md`](./docs/LIMITES_CONOCIDOS.md) |

## Arranque rápido local

```bash
cp .env.example .env.local            # completar claves (OpenAI, JWT, etc.)
docker compose -f docker-compose.local.yml up -d
# Frontend: http://localhost:3010 · Backend: http://localhost:8010
# El primer arranque del backend tarda 2-3 min (descarga/carga de modelos).
```

- Tests: `docker exec local_backend python -m pytest tests/ -q`
- Suite de calidad del motor: `scripts/run_quality_suite.py` (consume API real, ver reglas en `CLAUDE.md`)

## Ambientes

| Ambiente | URL | Rama |
|---|---|---|
| Local | `localhost:3010` | `dev-local` |
| Staging | `dev.intellix.com.ar` | `dev` |
| Producción | `app.intellix.com.ar` | `main` |

El desarrollo diario va en `dev-local`. Los pasajes a staging y producción son
eventos coordinados entre los dos integrantes del equipo (reglas en `CLAUDE.md`).

## Estructura del repositorio

```
backend/          FastAPI + Celery — motor RAG, API, migraciones Alembic
frontend/         Next.js 14 — panel admin/operador, login, widget embebible
nginx/            Configuración del reverse proxy por ambiente
observability/    Prometheus, Grafana, Alertmanager y sus runbooks
scripts/          Deploy, suite de calidad, utilidades de operación
mock_pixs/        Servicio mock para probar el framework de conectores
docs/             Documentación (ver abajo)
progress.json     Bitácora de avance y decisiones de diseño
```

### Carpeta `docs/`

| Carpeta o archivo | Contenido |
|---|---|
| `docs/*.md` | Documentación viva: operación, diseño, planes y auditorías |
| `docs/manual/` | Manual de usuario de la plataforma (HTML) |
| `docs/referencia/` | Material de arquitectura y presentaciones entregadas (PDF/DOCX) — histórico, no se actualiza |
| `docs/evaluaciones/` | Resultados crudos de evaluaciones de calidad del bot |
| `docs/seed-demo/` | Corpus sintético del tenant de demostración `intellix` |
| `docs/generados/` | Exportaciones (PDF/HTML/TXT) de documentos cuya fuente vive en `docs/*.md` |
| `docs/design/` | Referencias visuales del rediseño del panel |
| `docs/PROMPT.md` | Visión original del proyecto — histórico, no refleja el estado actual |
