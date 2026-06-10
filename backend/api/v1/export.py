"""KB export endpoint — JSON portable, re-importable, legible.

Exporta la base de conocimiento de un tenant en un JSON estructurado
con metadata + chunks + intenciones + (opcional) conversaciones + (opcional)
embeddings. Pensado para:
  - Backup manual del contenido
  - Migracion entre instancias del SaaS
  - Auditoria / portabilidad de datos (GDPR-friendly)
  - Re-importar mañana si se rompe la DB

NO incluye los archivos originales (PDF/DOCX) — viven en MinIO y se descargan
via /documents/{id}/download. El JSON tiene el storage_key como referencia.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from sqlalchemy import text

from core.audit import record as audit_record
from core.database import get_pg_session, get_qdrant_client
from core.security import CurrentUser, require_admin
from core.tenant import get_tenant_id

logger = logging.getLogger(__name__)
router = APIRouter()

# Schema version: subir cuando se cambia la estructura del export.
# Importers pueden chequear esto para saber si pueden parsearlo.
EXPORT_SCHEMA_VERSION = "1.0"


@router.get("/admin/export/json")
async def export_kb_json(
    request: Request,
    include_conversations: bool = Query(False, description="Incluir conversaciones + mensajes (datos de usuarios)"),
    include_embeddings: bool = Query(False, description="Incluir vectores embedding (engrosa ~10x el archivo)"),
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
) -> Response:
    """Exporta toda la KB del tenant como JSON descargable.

    Estructura del JSON:
        export_meta:        info del export (fecha, version, quien lo hizo)
        tenant_config:      bot_name, bot_description, greeting, branding
        sectors:            sectores del tenant
        documents:          docs con sus parent_chunks (texto + metadata)
        intentions:         intenciones aprendidas con ejemplos
        conversations:      (opcional) historial de chats con mensajes
        embeddings:         (opcional) vectores Qdrant por chunk

    Devuelve: application/json con Content-Disposition attachment.
    """
    logger.info(
        "kb_export_started tenant_id=%s actor=%s include_conv=%s include_emb=%s",
        tenant_id, current_user.user_id, include_conversations, include_embeddings,
    )

    payload: dict[str, Any] = {
        "export_meta": {
            "tenant_id": tenant_id,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "exported_by": current_user.email,
            "schema_version": EXPORT_SCHEMA_VERSION,
            "include_conversations": include_conversations,
            "include_embeddings": include_embeddings,
        },
    }

    # ── 1. Config global del tenant (bot_name, bot_description, etc) ─────────
    async with get_pg_session() as session:  # __platform__ schema for tenants table
        result = await session.execute(
            text(
                "SELECT id, display_name, bot_name, bot_description, bot_scope, "
                "greeting_message, primary_color, secondary_color, logo_url, "
                "favicon_url, onboarding_completed, plan, created_at "
                "FROM tenants WHERE id = :tid"
            ),
            {"tid": tenant_id},
        )
        row = result.mappings().fetchone()
        if row:
            payload["tenant_config"] = {
                "id": row["id"],
                "display_name": row["display_name"],
                "bot_name": row["bot_name"],
                "bot_description": row["bot_description"],
                "bot_scope": row["bot_scope"],
                "greeting_message": row["greeting_message"],
                "primary_color": row["primary_color"],
                "secondary_color": row["secondary_color"],
                "logo_url": row["logo_url"],
                "favicon_url": row["favicon_url"],
                "onboarding_completed": row["onboarding_completed"],
                "plan": row["plan"],
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            }
        else:
            payload["tenant_config"] = {}

    # ── 2. Datos del tenant schema: sectores, docs, intents, etc ────────────
    async with get_pg_session(tenant_id) as session:
        # Sectores
        result = await session.execute(
            text("SELECT id, nombre, descripcion, created_at FROM sectores ORDER BY nombre")
        )
        payload["sectors"] = [
            {
                "id": str(r["id"]),
                "nombre": r["nombre"],
                "descripcion": r["descripcion"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in result.mappings().all()
        ]

        # Documentos + parent_chunks (en 2 queries para no explotar memoria)
        docs_result = await session.execute(
            text(
                "SELECT id, title, filename, status, chunk_count, quality_gate_status, "
                "storage_key, created_at, updated_at "
                "FROM documentos ORDER BY created_at DESC"
            )
        )
        docs_rows = docs_result.mappings().all()
        doc_ids = [r["id"] for r in docs_rows]

        # Parent chunks de TODOS los docs en una sola query
        parent_chunks_by_doc: dict[str, list[dict]] = {}
        if doc_ids:
            chunks_result = await session.execute(
                text(
                    "SELECT id, document_id, text, chunk_index, token_count, metadata "
                    "FROM parent_chunks WHERE document_id = ANY(:doc_ids) "
                    "ORDER BY document_id, chunk_index"
                ),
                {"doc_ids": doc_ids},
            )
            for c in chunks_result.mappings().all():
                doc_key = str(c["document_id"])
                parent_chunks_by_doc.setdefault(doc_key, []).append(
                    {
                        "id": c["id"],
                        "text": c["text"],
                        "chunk_index": c["chunk_index"],
                        "token_count": c["token_count"],
                        "metadata": c["metadata"] or {},
                    }
                )

        payload["documents"] = [
            {
                "id": str(r["id"]),
                "title": r["title"],
                "filename": r["filename"],
                "status": r["status"],
                "chunk_count": r["chunk_count"],
                "quality_gate_status": r["quality_gate_status"],
                "storage_key": r["storage_key"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
                "parent_chunks": parent_chunks_by_doc.get(str(r["id"]), []),
            }
            for r in docs_rows
        ]

        # Intenciones + ejemplos (las intenciones aprendidas del bot)
        intents_result = await session.execute(
            text(
                "SELECT id, label, description, example_count, auto_learned_count, "
                "is_active, model_version, last_accuracy, created_at "
                "FROM intenciones ORDER BY label"
            )
        )
        intents_rows = intents_result.mappings().all()
        intent_ids = [r["id"] for r in intents_rows]

        examples_by_intent: dict[str, list[dict]] = {}
        if intent_ids:
            examples_result = await session.execute(
                text(
                    "SELECT id, intencion_id, question_text, question_hash, created_at "
                    "FROM intencion_ejemplos WHERE intencion_id = ANY(:intent_ids) "
                    "ORDER BY intencion_id, created_at"
                ),
                {"intent_ids": intent_ids},
            )
            for e in examples_result.mappings().all():
                key = str(e["intencion_id"])
                examples_by_intent.setdefault(key, []).append(
                    {
                        "texto": e["question_text"],
                        "source": e["question_hash"],
                        "created_at": e["created_at"].isoformat() if e["created_at"] else None,
                    }
                )

        payload["intentions"] = [
            {
                "id": str(r["id"]),
                "label": r["label"],
                "description": r["description"],
                "example_count": r["example_count"],
                "auto_learned_count": r["auto_learned_count"],
                "is_active": r["is_active"],
                "model_version": r["model_version"],
                "last_accuracy": r["last_accuracy"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "examples": examples_by_intent.get(str(r["id"]), []),
            }
            for r in intents_rows
        ]

        # Conversaciones (opcional — contienen datos de usuarios)
        if include_conversations:
            # CONTRATO DE PRIVACIDAD: afiliado_dni NUNCA se exporta (ni acá ni
            # en el payload de abajo). El DNI es el dato más sensible del
            # afiliado y un export descargable no es lugar para portarlo.
            # Si alguna vez hace falta, requiere decisión explícita + step-up
            # de autenticación, no solo agregarlo al SELECT.
            convs_result = await session.execute(
                text(
                    "SELECT id, widget_session_id, sector_id, status, "
                    "afiliado_nombre, afiliado_email, "
                    "created_at, updated_at, closed_at "
                    "FROM conversaciones ORDER BY created_at DESC LIMIT 10000"
                )
            )
            convs_rows = convs_result.mappings().all()
            conv_ids = [r["id"] for r in convs_rows]

            messages_by_conv: dict[str, list[dict]] = {}
            if conv_ids:
                msgs_result = await session.execute(
                    text(
                        "SELECT conversation_id, sender_type, content, created_at "
                        "FROM mensajes WHERE conversation_id = ANY(:conv_ids) "
                        "ORDER BY conversation_id, created_at"
                    ),
                    {"conv_ids": conv_ids},
                )
                for m in msgs_result.mappings().all():
                    key = str(m["conversation_id"])
                    messages_by_conv.setdefault(key, []).append(
                        {
                            "sender_type": m["sender_type"],
                            "content": m["content"],
                            "created_at": m["created_at"].isoformat() if m["created_at"] else None,
                        }
                    )

            payload["conversations"] = [
                {
                    "id": str(r["id"]),
                    "sector_id": str(r["sector_id"]) if r["sector_id"] else None,
                    "status": r["status"],
                    "afiliado_nombre": r["afiliado_nombre"],
                    "afiliado_email": r["afiliado_email"],
                    "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                    "closed_at": r["closed_at"].isoformat() if r["closed_at"] else None,
                    "messages": messages_by_conv.get(str(r["id"]), []),
                }
                for r in convs_rows
            ]
        else:
            payload["conversations"] = None

    # ── 3. Embeddings (opcional — engrosa el JSON ~10x) ──────────────────────
    if include_embeddings:
        try:
            qdrant = get_qdrant_client()
            collection = f"{tenant_id}_docs"
            # Scroll por toda la coleccion en batches de 256
            all_points: list[dict] = []
            offset = None
            while True:
                points, next_offset = await qdrant.scroll(
                    collection_name=collection,
                    limit=256,
                    offset=offset,
                    with_payload=True,
                    with_vectors=True,
                )
                for p in points:
                    all_points.append(
                        {
                            "id": str(p.id),
                            "vector": p.vector,
                            "payload": p.payload,
                        }
                    )
                if next_offset is None:
                    break
                offset = next_offset
            payload["embeddings"] = all_points
        except Exception as exc:
            logger.warning("kb_export_embeddings_failed tenant=%s error=%s", tenant_id, exc)
            payload["embeddings"] = {"error": str(exc), "points": []}
    else:
        payload["embeddings"] = None

    # ── 4. Audit log (fire-and-forget, no bloquea) ───────────────────────────
    counts = {
        "documents": len(payload.get("documents") or []),
        "intentions": len(payload.get("intentions") or []),
        "conversations": len(payload["conversations"]) if include_conversations and payload.get("conversations") else 0,
        "embeddings": len(payload["embeddings"]) if include_embeddings and isinstance(payload.get("embeddings"), list) else 0,
    }
    import asyncio
    asyncio.create_task(
        audit_record(
            tenant_id=tenant_id,
            actor_id=current_user.user_id,
            actor_email=current_user.email,
            actor_role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
            action="admin.kb_export",
            detail={
                "include_conversations": include_conversations,
                "include_embeddings": include_embeddings,
                **counts,
            },
            request=request,
        )
    )

    # ── 5. Respuesta JSON descargable ────────────────────────────────────────
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    filename = f"{tenant_id}-kb-export-{datetime.now(timezone.utc).strftime('%Y-%m-%d-%H%M')}.json"

    logger.info(
        "kb_export_completed tenant_id=%s docs=%d intents=%d convs=%d size_bytes=%d",
        tenant_id, counts["documents"], counts["intentions"], counts["conversations"], len(body),
    )

    return Response(
        content=body,
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Export-Schema-Version": EXPORT_SCHEMA_VERSION,
        },
    )
