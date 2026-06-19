"""Transactional tenant onboarding script.

Rolls back ALL changes if any step fails. Run standalone or imported.

Usage:
    python scripts/provision_tenant.py --id acme --name "Acme Corp" \
        --plan starter --admin-email admin@acme.com \
        --admin-name "Admin User" --admin-password "s3cr3t!"
"""

import argparse
import asyncio
import logging
import os
import smtplib
import sys
from email.mime.text import MIMEText
from pathlib import Path

# Make backend importable when running from project root
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import asyncpg
from neo4j import AsyncGraphDatabase
from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Distance, VectorParams

from core.config import settings
from core.security import hash_password, create_access_token, Role

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

EMBEDDING_DIM = 1024  # multilingual-e5-large output dimension


async def provision_tenant(
    tenant_id: str,
    name: str,
    plan: str,
    admin_email: str,
    admin_name: str,
    admin_password: str,
) -> None:
    """Run full tenant provisioning. Raises on any failure — caller must handle rollback."""
    logger.info("provision_start tenant_id=%s", tenant_id)

    pg_conn = await asyncpg.connect(settings.postgres_dsn_sync.replace("+asyncpg", "").replace("postgresql", "postgresql"))
    neo4j_driver = AsyncGraphDatabase.driver(
        settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)
    )
    qdrant = AsyncQdrantClient(host=settings.qdrant_host, port=settings.qdrant_port)

    # Track what was created for rollback
    created: dict[str, bool] = {
        "pg_schema": False,
        "pg_global_row": False,
        "qdrant_docs": False,
        "qdrant_intents": False,
        "neo4j_db": False,
        "models_dir": False,
    }

    try:
        # ── Step 1: Global tenant row ──────────────────────────────────────────
        async with pg_conn.transaction():
            await pg_conn.execute(
                """
                INSERT INTO public.tenants (id, name, plan, status, admin_email)
                VALUES ($1, $2, $3, 'onboarding', $4)
                """,
                tenant_id, name, plan, admin_email,
            )
        created["pg_global_row"] = True
        logger.info("step_1_done global_tenant_row tenant_id=%s", tenant_id)

        # ── Step 2: PostgreSQL schema + tables ────────────────────────────────
        safe_id = tenant_id.replace("-", "_")
        schema_name = f"tenant_{safe_id}"
        # Support running from scripts/ (dev) or from /app/ (Docker container)
        _candidates = [
            Path(__file__).parent.parent / "backend" / "db" / "schemas" / "tenant_schema.sql",
            Path(__file__).parent / "db" / "schemas" / "tenant_schema.sql",
        ]
        schema_sql_path = next((p for p in _candidates if p.exists()), _candidates[0])
        schema_sql = schema_sql_path.read_text().replace(":schema", schema_name)

        async with pg_conn.transaction():
            await pg_conn.execute(f'CREATE SCHEMA "{schema_name}"')
            await pg_conn.execute(f'SET search_path TO "{schema_name}"')
            # Ejecutar el schema COMPLETO en un solo execute: asyncpg corre
            # múltiples statements DDL de una. NO partir por ';' — el split
            # ingenuo rompía cualquier literal (un DEFAULT JSON en español) o
            # bloque DO $$ ... $$ que contuviera un ';'.
            if schema_sql.strip():
                await pg_conn.execute(schema_sql)

            # Create initial admin user inside tenant schema
            hashed = hash_password(admin_password)
            await pg_conn.execute(
                f"""
                INSERT INTO "{schema_name}".usuarios (email, name, hashed_password, role)
                VALUES ($1, $2, $3, 'admin')
                """,
                admin_email, admin_name, hashed,
            )
        created["pg_schema"] = True
        logger.info("step_2_done pg_schema schema=%s", schema_name)

        # ── Step 3: Qdrant collections ─────────────────────────────────────────
        docs_collection = f"{tenant_id}_docs"
        intents_collection = f"{tenant_id}_intenciones"

        await qdrant.create_collection(
            collection_name=docs_collection,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        created["qdrant_docs"] = True

        await qdrant.create_collection(
            collection_name=intents_collection,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        created["qdrant_intents"] = True
        logger.info("step_3_done qdrant_collections tenant_id=%s", tenant_id)

        # ── Step 4: Neo4j database ─────────────────────────────────────────────
        # Community Edition doesn't support multiple databases — tenant isolation
        # is achieved via tenant_id property on all nodes (see neo4j_client.py).
        # Enterprise Edition supports CREATE DATABASE per tenant.
        try:
            async with neo4j_driver.session(database="system") as session:
                await session.run(f"CREATE DATABASE `{tenant_id}` IF NOT EXISTS")
        except Exception as neo4j_err:
            if "UnsupportedAdministrationCommand" in str(neo4j_err) or "unsupported" in str(neo4j_err).lower():
                logger.warning("neo4j_community_edition_skipping_create_db tenant_id=%s", tenant_id)
            else:
                raise
        created["neo4j_db"] = True
        logger.info("step_4_done neo4j_db tenant_id=%s", tenant_id)

        # ── Step 5: Models directory ───────────────────────────────────────────
        models_dir = Path("/app/ml_artifacts") / tenant_id
        models_dir.mkdir(parents=True, exist_ok=True)
        created["models_dir"] = True
        logger.info("step_5_done models_dir path=%s", models_dir)

        # ── Step 6: Mark tenant as active ─────────────────────────────────────
        await pg_conn.execute(
            "UPDATE public.tenants SET status = 'active' WHERE id = $1", tenant_id
        )
        logger.info("step_6_done tenant_activated tenant_id=%s", tenant_id)

        # ── Step 7: Welcome email ─────────────────────────────────────────────
        _send_welcome_email(admin_email, admin_name, tenant_id)
        logger.info("provision_complete tenant_id=%s", tenant_id)

    except Exception as exc:
        logger.error("provision_failed tenant_id=%s error=%s", tenant_id, exc)
        await _rollback(pg_conn, neo4j_driver, qdrant, tenant_id, created)
        raise
    finally:
        await pg_conn.close()
        await neo4j_driver.close()
        await qdrant.close()


async def _rollback(pg_conn, neo4j_driver, qdrant, tenant_id: str, created: dict) -> None:
    """Best-effort rollback of each created resource."""
    logger.warning("rollback_start tenant_id=%s", tenant_id)
    safe_id = tenant_id.replace("-", "_")

    if created.get("pg_schema"):
        try:
            await pg_conn.execute(f'DROP SCHEMA "tenant_{safe_id}" CASCADE')
        except Exception as e:
            logger.error("rollback_pg_schema_failed error=%s", e)

    if created.get("pg_global_row"):
        try:
            await pg_conn.execute("DELETE FROM public.tenants WHERE id = $1", tenant_id)
        except Exception as e:
            logger.error("rollback_pg_global_failed error=%s", e)

    if created.get("qdrant_docs"):
        try:
            await qdrant.delete_collection(f"{tenant_id}_docs")
        except Exception as e:
            logger.error("rollback_qdrant_docs_failed error=%s", e)

    if created.get("qdrant_intents"):
        try:
            await qdrant.delete_collection(f"{tenant_id}_intenciones")
        except Exception as e:
            logger.error("rollback_qdrant_intents_failed error=%s", e)

    if created.get("neo4j_db"):
        try:
            async with neo4j_driver.session(database="system") as session:
                await session.run(f"DROP DATABASE `{tenant_id}` IF EXISTS")
        except Exception as e:
            logger.error("rollback_neo4j_failed error=%s", e)

    logger.warning("rollback_complete tenant_id=%s", tenant_id)


def _send_welcome_email(to_email: str, name: str, tenant_id: str) -> None:
    """Send a welcome email to the new tenant admin. Non-fatal if SMTP is not configured."""
    if not settings.smtp_host:
        logger.info("smtp_not_configured skipping_welcome_email")
        return
    try:
        body = f"Hola {name},\n\nTu tenant '{tenant_id}' fue provisionado exitosamente.\n\nSaludos."
        msg = MIMEText(body)
        msg["Subject"] = f"Bienvenido a la plataforma — {tenant_id}"
        msg["From"] = settings.email_from
        msg["To"] = to_email
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.sendmail(settings.email_from, [to_email], msg.as_string())
    except Exception as exc:
        logger.warning("welcome_email_failed error=%s", exc)


def main() -> None:
    parser = argparse.ArgumentParser(description="Provision a new tenant")
    parser.add_argument("--id", required=True, dest="tenant_id")
    parser.add_argument("--name", required=True)
    parser.add_argument("--plan", default="starter", choices=["starter", "professional", "enterprise"])
    parser.add_argument("--admin-email", required=True)
    parser.add_argument("--admin-name", required=True)
    parser.add_argument("--admin-password", required=True)
    args = parser.parse_args()

    asyncio.run(
        provision_tenant(
            tenant_id=args.tenant_id,
            name=args.name,
            plan=args.plan,
            admin_email=args.admin_email,
            admin_name=args.admin_name,
            admin_password=args.admin_password,
        )
    )


if __name__ == "__main__":
    main()
