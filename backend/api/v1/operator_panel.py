"""Operator panel endpoints — for human operators and admins.

Operators see only their assigned sectors.
Admins see all sectors and can transfer conversations between them.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, Role, get_current_user, require_admin, require_operator
from core.tenant import get_tenant_id
from services.handoff import ConvStatus, invalidate_config_cache

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class ReplyRequest(BaseModel):
    content: str


class TransferRequest(BaseModel):
    sector_id: str
    message: str | None = None


class SectorCreate(BaseModel):
    nombre: str
    descripcion: str | None = None


class HandoffConfigUpdate(BaseModel):
    inactivity_timeout_minutes:      int | None = None
    consecutive_insufficient_count:  int | None = None
    frustration_phrases:             list[str] | None = None
    transition_messages:             dict | None = None


# ── Conversations list (by sector + status) ───────────────────────────────────

@router.get("/operator/conversations")
async def list_conversations(
    status_filter: str | None = None,
    sector_id:     str | None = None,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """List conversations the operator can see, grouped by sector.

    Operators see only their assigned sectors.
    Admins and super_admins see all sectors.
    """
    is_admin = current_user.role in (Role.ADMIN, Role.SUPER_ADMIN)

    async with get_pg_session(tenant_id) as session:
        # Get operator's assigned sectors (admins get all)
        if is_admin:
            sector_result = await session.execute(text(
                "SELECT id, nombre FROM sectores WHERE is_active = TRUE ORDER BY nombre"
            ))
        else:
            sector_result = await session.execute(text("""
                SELECT s.id, s.nombre
                FROM sectores s
                JOIN operador_sectores os ON os.sector_id = s.id
                WHERE os.operador_id = :uid AND s.is_active = TRUE
                ORDER BY s.nombre
            """), {"uid": current_user.user_id})

        sectors = [dict(r) for r in sector_result.mappings().all()]
        sector_ids = [str(s["id"]) for s in sectors]

        # Build conversation query
        where_clauses = []
        params: dict = {}

        if sector_ids:
            where_clauses.append("c.sector_id = ANY(:sector_ids::uuid[])")
            params["sector_ids"] = sector_ids
        elif not is_admin:
            return {"sectors": [], "total": 0}

        if status_filter:
            where_clauses.append("c.status = :status")
            params["status"] = status_filter

        if sector_id:
            where_clauses.append("c.sector_id = :sector_id")
            params["sector_id"] = sector_id

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        conv_result = await session.execute(text(f"""
            SELECT
                c.id, c.widget_session_id, c.status, c.sector_id,
                c.afiliado_nombre, c.afiliado_email,
                c.created_at, c.updated_at,
                s.nombre AS sector_nombre,
                u.name  AS operator_name,
                COUNT(m.id) FILTER (WHERE m.read_at IS NULL AND m.sender_type = 'user') AS unread_count,
                MAX(m.created_at) AS last_message_at
            FROM conversaciones c
            LEFT JOIN sectores s ON s.id = c.sector_id
            LEFT JOIN usuarios u ON u.id = c.assigned_operator_id
            LEFT JOIN mensajes m ON m.conversation_id = c.id
            {where_sql}
            GROUP BY c.id, s.nombre, u.name
            ORDER BY c.updated_at DESC
            LIMIT 200
        """), params)
        conversations = [dict(r) for r in conv_result.mappings().all()]

    # Group by sector
    grouped: dict[str, list] = {}
    for s in sectors:
        grouped[str(s["id"])] = {"sector": s, "conversations": []}
    for conv in conversations:
        sid = str(conv["sector_id"]) if conv["sector_id"] else None
        if sid and sid in grouped:
            grouped[sid]["conversations"].append({
                "id":             str(conv["id"]),
                "status":         conv["status"],
                "afiliado_nombre": conv["afiliado_nombre"],
                "afiliado_email":  conv["afiliado_email"],
                "sector_nombre":   conv["sector_nombre"],
                "operator_name":   conv["operator_name"],
                "unread_count":    int(conv["unread_count"] or 0),
                "last_message_at": conv["last_message_at"].isoformat() if conv["last_message_at"] else None,
                "created_at":      conv["created_at"].isoformat(),
            })

    return {"sectors": list(grouped.values()), "total": len(conversations)}


# ── Conversation detail ───────────────────────────────────────────────────────

@router.get("/operator/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Full conversation history for the operator."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT c.*, s.nombre AS sector_nombre, u.name AS operator_name
            FROM conversaciones c
            LEFT JOIN sectores s ON s.id = c.sector_id
            LEFT JOIN usuarios u ON u.id = c.assigned_operator_id
            WHERE c.id = :id
        """), {"id": conversation_id})
        conv = result.mappings().fetchone()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")

        msg_result = await session.execute(text("""
            SELECT id, sender_type, content, read_at, created_at
            FROM mensajes WHERE conversation_id = :id ORDER BY created_at ASC
        """), {"id": conversation_id})
        messages = [dict(r) for r in msg_result.mappings().all()]

        # Mark user messages as read
        await session.execute(text("""
            UPDATE mensajes SET read_at = NOW()
            WHERE conversation_id = :id AND sender_type = 'user' AND read_at IS NULL
        """), {"id": conversation_id})

    return {
        "id": str(conv["id"]),
        "status": conv["status"],
        "sector_nombre": conv["sector_nombre"],
        "operator_name": conv["operator_name"],
        "afiliado_nombre": conv["afiliado_nombre"],
        "afiliado_email": conv["afiliado_email"],
        "created_at": conv["created_at"].isoformat(),
        "messages": [
            {
                "id": str(m["id"]),
                "sender_type": m["sender_type"],
                "content": m["content"],
                "created_at": m["created_at"].isoformat(),
            }
            for m in messages
        ],
    }


# ── Accept handoff ────────────────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/accept")
async def accept_handoff(
    conversation_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Operator accepts a handoff — conversation moves to human_attending."""
    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'human_attending',
                assigned_operator_id = :op_id,
                updated_at = NOW()
            WHERE id = :id AND status = 'handoff_requested'
            RETURNING id
        """), {"id": conversation_id, "op_id": current_user.user_id})
        if not result.fetchone():
            raise HTTPException(status_code=400, detail="Conversation not in handoff_requested state")

        msg = config["transition_messages"]["human_assigned"]
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    logger.info("handoff_accepted conversation_id=%s operator=%s", conversation_id, current_user.user_id)
    return {"status": ConvStatus.HUMAN_ATTENDING, "system_message": msg}


# ── Reply ─────────────────────────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/reply")
async def reply(
    conversation_id: str,
    body: ReplyRequest,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Operator sends a message to the afiliado."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT status FROM conversaciones WHERE id = :id"),
            {"id": conversation_id},
        )
        row = result.fetchone()
        if not row or row[0] == ConvStatus.CLOSED:
            raise HTTPException(status_code=400, detail="Conversation closed or not found")

        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'operator', :content)
        """), {"cid": conversation_id, "content": body.content})
        await session.execute(text(
            "UPDATE conversaciones SET updated_at = NOW() WHERE id = :id"
        ), {"id": conversation_id})

    return {"status": "sent"}


# ── Transfer to another sector ────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/transfer")
async def transfer(
    conversation_id: str,
    body: TransferRequest,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Transfer conversation to another sector (admin or current operator)."""
    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)

    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            UPDATE conversaciones
            SET sector_id = :sector_id,
                status = 'handoff_requested',
                assigned_operator_id = NULL,
                updated_at = NOW()
            WHERE id = :id
        """), {"id": conversation_id, "sector_id": body.sector_id})

        msg = body.message or config["transition_messages"]["sector_transferred"]
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    logger.info("conversation_transferred id=%s to_sector=%s by=%s", conversation_id, body.sector_id, current_user.user_id)
    return {"status": ConvStatus.HANDOFF_REQUESTED, "system_message": msg}


# ── Close conversation ────────────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/close")
async def close_conversation(
    conversation_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Close a conversation."""
    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)

    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            UPDATE conversaciones
            SET status = 'closed', closed_at = NOW(), updated_at = NOW()
            WHERE id = :id
        """), {"id": conversation_id})
        msg = config["transition_messages"]["conversation_closed"]
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    return {"status": ConvStatus.CLOSED}


# ── Sector management (admin only) ────────────────────────────────────────────

@router.get("/admin/sectors")
async def list_sectors(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT s.id, s.nombre, s.descripcion, s.is_active, s.created_at,
                   COUNT(DISTINCT os.operador_id) AS operator_count,
                   COUNT(DISTINCT c.id) FILTER (WHERE c.status != 'closed') AS open_conversations
            FROM sectores s
            LEFT JOIN operador_sectores os ON os.sector_id = s.id
            LEFT JOIN conversaciones c ON c.sector_id = s.id
            GROUP BY s.id ORDER BY s.nombre
        """))
        return [dict(r) for r in result.mappings().all()]


@router.post("/admin/sectors", status_code=status.HTTP_201_CREATED)
async def create_sector(
    body: SectorCreate,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            INSERT INTO sectores (nombre, descripcion) VALUES (:nombre, :desc)
            RETURNING id, nombre
        """), {"nombre": body.nombre, "desc": body.descripcion})
        row = result.fetchone()
    return {"id": str(row[0]), "nombre": row[1]}


@router.patch("/admin/sectors/{sector_id}")
async def update_sector(
    sector_id: str,
    body: SectorCreate,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            UPDATE sectores SET nombre = :nombre, descripcion = :desc WHERE id = :id
        """), {"id": sector_id, "nombre": body.nombre, "desc": body.descripcion})
    return {"id": sector_id, "status": "updated"}


@router.delete("/admin/sectors/{sector_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sector(
    sector_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("UPDATE sectores SET is_active = FALSE WHERE id = :id"),
            {"id": sector_id},
        )


# ── Operator-sector assignment ────────────────────────────────────────────────

@router.post("/admin/operators/{operator_id}/sectors")
async def assign_sectors(
    operator_id: str,
    sector_ids: list[str],
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("DELETE FROM operador_sectores WHERE operador_id = :uid"),
            {"uid": operator_id},
        )
        for sid in sector_ids:
            await session.execute(text("""
                INSERT INTO operador_sectores (operador_id, sector_id)
                VALUES (:uid, :sid) ON CONFLICT DO NOTHING
            """), {"uid": operator_id, "sid": sid})
    return {"operator_id": operator_id, "sectors_assigned": len(sector_ids)}


@router.get("/admin/operators")
async def list_operators(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """List all users with operator or admin role."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT id, email, name, role, is_active
            FROM usuarios
            WHERE role IN ('operator', 'admin', 'super_admin')
            ORDER BY role, name
        """))
        return [dict(r) for r in result.mappings().all()]


@router.get("/admin/operators/{operator_id}/sectors")
async def get_operator_sectors(
    operator_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT s.id, s.nombre FROM sectores s
            JOIN operador_sectores os ON os.sector_id = s.id
            WHERE os.operador_id = :uid
        """), {"uid": operator_id})
        return [dict(r) for r in result.mappings().all()]


# ── Handoff config (admin) ────────────────────────────────────────────────────

@router.get("/admin/handoff-config")
async def get_handoff_config(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("SELECT * FROM handoff_config LIMIT 1"))
        row = result.mappings().fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Config not found")
        return dict(row)


@router.patch("/admin/handoff-config")
async def update_handoff_config(
    body: HandoffConfigUpdate,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    import json as _json
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_parts = []
    params: dict = {}
    for k, v in updates.items():
        if isinstance(v, (list, dict)):
            set_parts.append(f"{k} = :{k}::jsonb")
            params[k] = _json.dumps(v, ensure_ascii=False)
        else:
            set_parts.append(f"{k} = :{k}")
            params[k] = v

    set_sql = ", ".join(set_parts) + ", updated_at = NOW()"

    async with get_pg_session(tenant_id) as session:
        await session.execute(text(f"UPDATE handoff_config SET {set_sql}"), params)

    invalidate_config_cache(tenant_id)
    return {"status": "updated"}
