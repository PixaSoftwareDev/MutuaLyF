"""Operator panel endpoints — for human operators and admins.

Operators see only their assigned sectors.
Admins see all sectors and can transfer conversations between them.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, Role, require_admin, require_operator, get_widget_or_chat_user, create_public_chat_token
from core.tenant import get_tenant_id
from services.handoff import ConvStatus, invalidate_config_cache
from services.events import publish

logger = logging.getLogger(__name__)
router = APIRouter()


def _assert_tenant_access(current_user: CurrentUser, tenant_id: str) -> None:
    """Admins can only operate on their own tenant. Super-admins can operate on any."""
    if current_user.role == Role.SUPER_ADMIN:
        return
    if current_user.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No tenés permiso para operar en otro tenant",
        )


# ── Schemas ───────────────────────────────────────────────────────────────────

class ReplyRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)


class TransferRequest(BaseModel):
    sector_id: str = Field(..., min_length=1, max_length=64)
    message: str | None = Field(default=None, max_length=2000)


class SectorCreate(BaseModel):
    nombre: str = Field(..., min_length=1, max_length=100)
    descripcion: str | None = Field(default=None, max_length=500)


class HandoffConfigUpdate(BaseModel):
    inactivity_timeout_minutes:      int | None = None
    consecutive_insufficient_count:  int | None = None
    attention_hours:                 str | None = None
    contact_info:                    str | None = None   # tel/email/texto — reusado en no-operadores y fallback anti-alucinación
    transition_messages:             dict | None = None


def _operator_sector_scope(current_user: CurrentUser, column: str = "sector_id") -> tuple[str, dict]:
    """Filtro SQL para limitar una conversación a los sectores del operador.

    Admins y super-admins: sin filtro (ven todo el tenant).
    Operadores: solo conversaciones de los sectores que tienen asignados.

    Devuelve (sql_fragment, params) para concatenar al WHERE y mergear en los bind
    params. `column` permite 'sector_id' (UPDATE conversaciones) o 'c.sector_id'
    (SELECT con alias). Single source of truth del aislamiento inter-sector: todo
    endpoint que toque una conversación por id debe usarlo, no solo accept_handoff.
    """
    if current_user.role in (Role.ADMIN, Role.SUPER_ADMIN):
        return "", {}
    return (
        f" AND {column} IN (SELECT sector_id FROM operador_sectores WHERE operador_id = :op_id)",
        {"op_id": current_user.user_id},
    )


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
            # asyncpg doesn't support ANY(:param::uuid[]) — use IN with individual placeholders
            placeholders = ", ".join(f":sid_{i}" for i in range(len(sector_ids)))
            where_clauses.append(f"c.sector_id::text IN ({placeholders})")
            for i, sid in enumerate(sector_ids):
                params[f"sid_{i}"] = sid
        elif not is_admin:
            return {"sectors": [], "total": 0}

        if status_filter:
            where_clauses.append("c.status = :status")
            params["status"] = status_filter
        else:
            # Bandeja: solo lo accionable (handoff + atendiendo). Las cerradas
            # van al historial — antes traiamos las ultimas 24h aca pero
            # confundian al operador (parecian pendientes).
            where_clauses.append(
                "c.status IN ('handoff_requested', 'human_attending')"
            )

        # Operators see only their own conversations (assigned or pending in their sector).
        # handoff_requested are not yet assigned — visible to any operator in the sector.
        if not is_admin:
            where_clauses.append(
                "(c.assigned_operator_id = :op_id OR c.status = 'handoff_requested')"
            )
            params["op_id"] = current_user.user_id

        if sector_id:
            where_clauses.append("c.sector_id = :sector_id")
            params["sector_id"] = sector_id

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        conv_result = await session.execute(text(f"""
            SELECT
                c.id, c.widget_session_id, c.status, c.sector_id,
                c.afiliado_nombre, c.afiliado_email, c.afiliado_dni, c.afiliado_ip, c.is_test,
                c.created_at, c.updated_at, c.handoff_requested_at,
                s.nombre AS sector_nombre,
                u.name  AS operator_name,
                COUNT(m.id) FILTER (WHERE m.read_at IS NULL AND m.sender_type = 'user') AS unread_count,
                MAX(m.created_at) AS last_message_at,
                lm.sender_type AS last_message_sender
            FROM conversaciones c
            LEFT JOIN sectores s ON s.id = c.sector_id
            LEFT JOIN usuarios u ON u.id = c.assigned_operator_id
            LEFT JOIN mensajes m ON m.conversation_id = c.id
            LEFT JOIN LATERAL (
                SELECT sender_type FROM mensajes
                WHERE conversation_id = c.id
                ORDER BY created_at DESC LIMIT 1
            ) lm ON TRUE
            {where_sql}
            GROUP BY c.id, s.nombre, u.name, lm.sender_type
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
                "afiliado_dni":    conv["afiliado_dni"],
                "afiliado_ip":     conv["afiliado_ip"],
                "is_test":        conv["is_test"],
                "sector_id":       sid,
                "sector_nombre":   conv["sector_nombre"],
                "operator_name":   conv["operator_name"],
                "unread_count":    int(conv["unread_count"] or 0),
                "last_message_at": conv["last_message_at"].isoformat() if conv["last_message_at"] else None,
                "last_message_sender": conv["last_message_sender"],
                "created_at":      conv["created_at"].isoformat(),
                "handoff_requested_at": conv["handoff_requested_at"].isoformat() if conv["handoff_requested_at"] else None,
            })

    return {"sectors": list(grouped.values()), "total": len(conversations)}


# ── Conversations history (paginated, filterable) ─────────────────────────────

@router.get("/operator/conversations/history")
async def list_conversations_history(
    status_filter: str | None = None,
    sector_id:     str | None = None,
    q:             str | None = None,
    date_from:     str | None = None,  # ISO date (YYYY-MM-DD)
    date_to:       str | None = None,
    page:          int = 1,
    page_size:     int = 20,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Historial completo de conversaciones del sector del operador.

    Sin filtros temporales arbitrarios: devuelve TODO (incluyendo bot_active
    sin actividad y cerradas viejas), con paginación real y filtros.
    """
    is_admin = current_user.role in (Role.ADMIN, Role.SUPER_ADMIN)
    page = max(1, page)
    page_size = max(1, min(100, page_size))

    async with get_pg_session(tenant_id) as session:
        # Restrict to operator's sectors (admins see all)
        if is_admin:
            sector_result = await session.execute(text(
                "SELECT id FROM sectores WHERE is_active = TRUE"
            ))
        else:
            sector_result = await session.execute(text("""
                SELECT s.id
                FROM sectores s
                JOIN operador_sectores os ON os.sector_id = s.id
                WHERE os.operador_id = :uid AND s.is_active = TRUE
            """), {"uid": current_user.user_id})

        sector_ids = [str(r[0]) for r in sector_result.all()]

        if not sector_ids and not is_admin:
            return {"items": [], "total": 0, "page": page, "page_size": page_size}

        where_clauses = []
        params: dict = {}

        if sector_ids:
            placeholders = ", ".join(f":sid_{i}" for i in range(len(sector_ids)))
            where_clauses.append(f"c.sector_id::text IN ({placeholders})")
            for i, sid in enumerate(sector_ids):
                params[f"sid_{i}"] = sid

        if status_filter:
            where_clauses.append("c.status = :status")
            params["status"] = status_filter

        # Operators see only their own conversations in history
        if not is_admin:
            where_clauses.append("c.assigned_operator_id = :op_id")
            params["op_id"] = current_user.user_id

        if sector_id:
            where_clauses.append("c.sector_id = :sector_id")
            params["sector_id"] = sector_id

        if q:
            where_clauses.append(
                "(c.afiliado_nombre ILIKE :q OR c.afiliado_email ILIKE :q)"
            )
            params["q"] = f"%{q.strip()}%"

        if date_from:
            where_clauses.append("c.created_at >= :date_from")
            params["date_from"] = date_from

        if date_to:
            # Inclusive end-of-day
            where_clauses.append("c.created_at < (CAST(:date_to AS date) + INTERVAL '1 day')")
            params["date_to"] = date_to

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        # Total
        total_result = await session.execute(
            text(f"SELECT COUNT(*) FROM conversaciones c {where_sql}"),
            params,
        )
        total = int(total_result.scalar() or 0)

        # Page data
        params["limit"]  = page_size
        params["offset"] = (page - 1) * page_size

        rows_result = await session.execute(text(f"""
            SELECT
                c.id, c.status, c.sector_id,
                c.afiliado_nombre, c.afiliado_email, c.afiliado_dni, c.afiliado_ip, c.is_test,
                c.created_at, c.updated_at, c.closed_at,
                s.nombre AS sector_nombre,
                u.name   AS operator_name,
                (SELECT MAX(created_at) FROM mensajes WHERE conversation_id = c.id) AS last_message_at,
                (SELECT COUNT(*) FROM mensajes WHERE conversation_id = c.id) AS message_count
            FROM conversaciones c
            LEFT JOIN sectores s ON s.id = c.sector_id
            LEFT JOIN usuarios u ON u.id = c.assigned_operator_id
            {where_sql}
            ORDER BY c.updated_at DESC
            LIMIT :limit OFFSET :offset
        """), params)

        items = []
        for r in rows_result.mappings().all():
            items.append({
                "id":               str(r["id"]),
                "status":           r["status"],
                "sector_id":        str(r["sector_id"]) if r["sector_id"] else None,
                "sector_nombre":    r["sector_nombre"],
                "afiliado_nombre":  r["afiliado_nombre"],
                "afiliado_email":   r["afiliado_email"],
                "afiliado_dni":     r["afiliado_dni"],
                "afiliado_ip":      r["afiliado_ip"],
                "is_test":         r["is_test"],
                "operator_name":    r["operator_name"],
                "message_count":    int(r["message_count"] or 0),
                "created_at":       r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at":       r["updated_at"].isoformat() if r["updated_at"] else None,
                "closed_at":        r["closed_at"].isoformat() if r["closed_at"] else None,
                "last_message_at":  r["last_message_at"].isoformat() if r["last_message_at"] else None,
            })

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


# ── Conversation detail ───────────────────────────────────────────────────────

@router.get("/operator/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Full conversation history for the operator."""
    scope_sql, scope_params = _operator_sector_scope(current_user, "c.sector_id")
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text(f"""
            SELECT c.*, s.nombre AS sector_nombre, u.name AS operator_name
            FROM conversaciones c
            LEFT JOIN sectores s ON s.id = c.sector_id
            LEFT JOIN usuarios u ON u.id = c.assigned_operator_id
            WHERE c.id = :id{scope_sql}
        """), {"id": conversation_id, **scope_params})
        conv = result.mappings().fetchone()
        if not conv:
            # 404 (no 403) a propósito: no revelamos que la conversación existe en
            # otro sector — un operador ajeno la ve igual que a una inexistente.
            raise HTTPException(status_code=404, detail="La conversación no existe o ya no está disponible.")

        msg_result = await session.execute(text("""
            SELECT id, sender_type, content, read_at, created_at,
                   attachment_key, attachment_name, attachment_mime, attachment_size
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
        "afiliado_dni": conv["afiliado_dni"],
        "afiliado_ip": conv["afiliado_ip"],
        "is_test": conv["is_test"],
        "sector_id": str(conv["sector_id"]) if conv["sector_id"] else None,
        "created_at": conv["created_at"].isoformat(),
        "handoff_requested_at": conv["handoff_requested_at"].isoformat() if conv.get("handoff_requested_at") else None,
        "last_message_at": messages[-1]["created_at"].isoformat() if messages else None,
        "messages": [
            {
                "id": str(m["id"]),
                "sender_type": m["sender_type"],
                "content": m["content"],
                "created_at": m["created_at"].isoformat(),
                "attachment_name": m.get("attachment_name"),
                "attachment_mime": m.get("attachment_mime"),
                "attachment_size": m.get("attachment_size"),
            }
            for m in messages
        ],
    }


# ── Accept handoff ────────────────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/accept")
async def accept_handoff(
    conversation_id: str,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Operator accepts a handoff — conversation moves to human_attending."""
    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)

    async with get_pg_session(tenant_id) as session:
        # UPDATE conditional: si dos operadores aceptan a la vez, Postgres aplica
        # row lock — uno gana, el otro recibe RETURNING vacio y obtiene 400.
        # El scope de sector impide aceptar convs de sectores ajenos aunque el
        # conv_id esté expuesto. Admins/super-admins saltean el filtro.
        scope_sql, scope_params = _operator_sector_scope(current_user, "sector_id")
        result = await session.execute(text(f"""
            UPDATE conversaciones
            SET status = 'human_attending',
                assigned_operator_id = :op_id,
                updated_at = NOW()
            WHERE id = :id AND status = 'handoff_requested'{scope_sql}
            RETURNING id
        """), {"id": conversation_id, "op_id": current_user.user_id, **scope_params})
        if not result.fetchone():
            raise HTTPException(
                status_code=400,
                detail="Conversación no disponible (ya fue tomada o no pertenece a tus sectores).",
            )

        # human_assigned es key legacy que sacamos del panel admin pero algunos
        # tenants la tienen en DB y otros no. .get() con fallback evita KeyError.
        msg = config["transition_messages"].get("human_assigned") or "Un operador se unió a la conversación."
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    from services.handoff import reset_handoff_signals
    await reset_handoff_signals(conversation_id, tenant_id)

    logger.info("handoff_accepted conversation_id=%s operator=%s", conversation_id, current_user.user_id)
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="handoff.accepted",
        resource=conversation_id, request=request,
    ))
    fire_and_log(publish(tenant_id, "conversation_updated", {
        "conversation_id": conversation_id, "status": ConvStatus.HUMAN_ATTENDING,
    }))
    from services.whatsapp import relay_to_whatsapp
    fire_and_log(relay_to_whatsapp(tenant_id, conversation_id, msg), "whatsapp.relay")
    return {"status": ConvStatus.HUMAN_ATTENDING, "system_message": msg}


# ── Reply ─────────────────────────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/reply")
async def reply(
    conversation_id: str,
    body: ReplyRequest,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Operator sends a message to the afiliado.

    Bloquea:
      - Conversación no existente o ya cerrada
      - Conversación human_attending con último mensaje del user > 12h
        (la sesión está abandonada — evita 'mensajes a sesión fantasma').
    """
    scope_sql, scope_params = _operator_sector_scope(current_user, "c.sector_id")
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(f"""
                SELECT c.status,
                       COALESCE((
                         SELECT MAX(created_at) FROM mensajes
                         WHERE conversation_id = c.id AND sender_type = 'user'
                       ), c.created_at) AS last_user_activity
                FROM conversaciones c
                WHERE c.id = :id{scope_sql}
            """),
            {"id": conversation_id, **scope_params},
        )
        row = result.mappings().fetchone()
        if not row:
            # 404 también si la conversación es de otro sector (no revelar su existencia).
            raise HTTPException(status_code=404, detail="La conversación no existe o ya no está disponible.")
        if row["status"] == ConvStatus.CLOSED:
            raise HTTPException(
                status_code=409,
                detail="La conversación está cerrada. No se pueden enviar mensajes.",
            )
        # Sesión fantasma: human_attending pero el afiliado no escribe hace > 12h.
        # La conversación debería haber sido auto-cerrada por el cron, pero defensa
        # en profundidad acá por si el cron está caído o llega antes.
        from datetime import datetime, timezone, timedelta
        last_user = row["last_user_activity"]
        if last_user and (datetime.now(timezone.utc) - last_user) > timedelta(hours=12):
            raise HTTPException(
                status_code=409,
                detail="El afiliado lleva más de 12 horas inactivo. La conversación se considera abandonada.",
            )

        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'operator', :content)
        """), {"cid": conversation_id, "content": body.content})
        await session.execute(text(
            "UPDATE conversaciones SET updated_at = NOW() WHERE id = :id"
        ), {"id": conversation_id})

    from core.audit import fire_and_log
    fire_and_log(publish(tenant_id, "new_message", {
        "conversation_id": conversation_id, "sender": "operator",
    }))
    # Conversaciones de WhatsApp: la respuesta del operador sale por la Graph
    # API (no-op para canal widget). Fire-and-forget: la entrega al panel no
    # depende de Meta.
    from services.whatsapp import relay_to_whatsapp
    fire_and_log(relay_to_whatsapp(tenant_id, conversation_id, body.content), "whatsapp.relay")
    return {"status": "sent"}


# ── Transfer to another sector ────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/transfer")
async def transfer(
    conversation_id: str,
    body: TransferRequest,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Transfer conversation to another sector (admin or current operator)."""
    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)

    # Scope de sector: un operador solo transfiere conversaciones de SUS sectores
    # (el filtro evalúa el sector ACTUAL/origen, no el destino). Admin sin filtro.
    scope_sql, scope_params = _operator_sector_scope(current_user, "sector_id")
    async with get_pg_session(tenant_id) as session:
        # Guard de estado: solo se transfiere una conversación ACTIVA (en cola o
        # siendo atendida). Sin esto, transferir una conversación cerrada la
        # resucitaba en la cola con un "caso nuevo" que el afiliado ya abandonó.
        result = await session.execute(text(f"""
            UPDATE conversaciones
            SET sector_id = :sector_id,
                status = 'handoff_requested',
                assigned_operator_id = NULL,
                handoff_requested_at = NOW(),
                updated_at = NOW()
            WHERE id = :id AND status IN ('handoff_requested', 'human_attending'){scope_sql}
            RETURNING id
        """), {"id": conversation_id, "sector_id": body.sector_id, **scope_params})
        if result.fetchone() is None:
            raise HTTPException(
                status_code=409,
                detail="No se puede transferir esta conversación: está cerrada, no existe o no pertenece a tus sectores.",
            )

        msg = body.message or config["transition_messages"].get("sector_transferred") or "Tu consulta fue derivada al área correspondiente."
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    from services.handoff import reset_handoff_signals
    await reset_handoff_signals(conversation_id, tenant_id)

    logger.info("conversation_transferred id=%s to_sector=%s by=%s", conversation_id, body.sector_id, current_user.user_id)
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="handoff.transferred",
        resource=conversation_id, detail={"to_sector": body.sector_id}, request=request,
    ))
    fire_and_log(publish(tenant_id, "conversation_updated", {
        "conversation_id": conversation_id, "status": ConvStatus.HANDOFF_REQUESTED,
    }))
    return {"status": ConvStatus.HANDOFF_REQUESTED, "system_message": msg}


# ── Close conversation ────────────────────────────────────────────────────────

# ── Release back to queue ─────────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/release")
async def release_to_queue(
    conversation_id: str,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Send a conversation back to the handoff queue without closing it.

    Used when the operator accepted by mistake, is going off shift, or
    realises the case is for another operator but doesn't know which sector.
    Differs from /transfer in that it keeps the conversation in the same
    sector — just frees the operator slot so another operator can pick it up.
    """
    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)

    async with get_pg_session(tenant_id) as session:
        # Only the assigned operator (or admin via the same endpoint) can release.
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'handoff_requested',
                assigned_operator_id = NULL,
                handoff_requested_at = NOW(),
                updated_at = NOW()
            WHERE id = :id
              AND status = 'human_attending'
              AND assigned_operator_id = :op_id
            RETURNING id
        """), {"id": conversation_id, "op_id": current_user.user_id})
        if not result.fetchone():
            raise HTTPException(status_code=400, detail="Conversation not assigned to this operator")

        # Reuse the same "connecting to an operator" message the user already
        # saw when they first entered the queue, to avoid surprise.
        msg = config["transition_messages"].get("handoff_auto") or "Te conectamos con un operador."
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    from services.handoff import reset_handoff_signals
    await reset_handoff_signals(conversation_id, tenant_id)

    logger.info("handoff_released conversation_id=%s operator=%s", conversation_id, current_user.user_id)
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="handoff.released",
        resource=conversation_id, request=request,
    ))
    fire_and_log(publish(tenant_id, "conversation_updated", {
        "conversation_id": conversation_id, "status": ConvStatus.HANDOFF_REQUESTED,
    }))
    return {"status": ConvStatus.HANDOFF_REQUESTED, "system_message": msg}


@router.post("/operator/conversations/{conversation_id}/return-to-bot")
async def return_to_bot(
    conversation_id: str,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Devuelve la conversación al bot — sale de human_attending y vuelve a bot_active.

    Caso de uso (feedback del tester): el afiliado terminó el caso humano
    y quiere seguir consultando al bot. Sin esto, el operador tenía que
    cerrar la conversación y el usuario empezar de cero.

    Diferencias con otros endpoints:
      - /release  → vuelve a la cola (handoff_requested) para que otro operador la tome
      - /close    → cierra la conversación, fin del flujo
      - /return-to-bot → la conversación sigue activa pero ahora la atiende el bot
    """
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'bot_active',
                assigned_operator_id = NULL,
                updated_at = NOW()
            WHERE id = :id
              AND status = 'human_attending'
              AND assigned_operator_id = :op_id
            RETURNING id
        """), {"id": conversation_id, "op_id": current_user.user_id})
        if not result.fetchone():
            raise HTTPException(
                status_code=400,
                detail="La conversación no está asignada a este operador o no está en atención humana.",
            )

        # Mensaje para el afiliado: el bot vuelve a estar disponible.
        # Hardcoded de momento — si en el futuro el admin quiere personalizarlo,
        # agregar transition_messages.returned_to_bot en handoff_config.
        msg = (
            "Te devuelvo al asistente automático. Podés hacerle nuevas consultas "
            "o pedirme de nuevo si necesitás un operador."
        )
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    from services.handoff import reset_handoff_signals
    await reset_handoff_signals(conversation_id, tenant_id)

    logger.info("handoff_returned_to_bot conversation_id=%s operator=%s",
                conversation_id, current_user.user_id)
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="handoff.returned_to_bot",
        resource=conversation_id, request=request,
    ))
    fire_and_log(publish(tenant_id, "conversation_updated", {
        "conversation_id": conversation_id, "status": ConvStatus.BOT_ACTIVE,
    }))
    return {"status": ConvStatus.BOT_ACTIVE, "system_message": msg}


@router.post("/operator/conversations/{conversation_id}/close")
async def close_conversation(
    conversation_id: str,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Close a conversation."""
    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)

    # Aislamiento inter-sector: un operador solo puede cerrar conversaciones de
    # sus sectores (admins/super-admins sin filtro). Sin esto, cualquier operador
    # podía cerrar por id una conversación de otro sector del mismo tenant.
    scope_sql, scope_params = _operator_sector_scope(current_user, "sector_id")
    async with get_pg_session(tenant_id) as session:
        closed = await session.execute(text(f"""
            UPDATE conversaciones
            SET status = 'closed', closed_at = NOW(), updated_at = NOW()
            WHERE id = :id{scope_sql}
            RETURNING id
        """), {"id": conversation_id, **scope_params})
        if closed.fetchone() is None:
            raise HTTPException(status_code=404, detail="Conversación no encontrada o fuera de tu sector.")
        msg = config["transition_messages"].get("conversation_closed") or "La conversación fue cerrada. Gracias por contactarnos."
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": msg})

    from services.handoff import reset_handoff_signals
    await reset_handoff_signals(conversation_id, tenant_id)

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="handoff.closed",
        resource=conversation_id, request=request,
    ))
    fire_and_log(publish(tenant_id, "conversation_updated", {
        "conversation_id": conversation_id, "status": ConvStatus.CLOSED,
    }))
    from services.whatsapp import relay_to_whatsapp
    fire_and_log(relay_to_whatsapp(tenant_id, conversation_id, msg), "whatsapp.relay")
    return {"status": ConvStatus.CLOSED}


# ── SSE — real-time event stream ─────────────────────────────────────────────

@router.get("/operator/events")
async def operator_events(
    request: Request,
    token: str | None = None,
    tenant_id: str = Depends(get_tenant_id),
):
    """Server-Sent Events stream. Operators subscribe here instead of polling.

    EventSource doesn't support custom headers, so we accept the JWT as a
    query param and validate it manually.
    """
    from core.security import _get_current_user_from_token, Role
    from fastapi import HTTPException

    if not token:
        # Fall back to standard Bearer header
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip()

    if not token:
        raise HTTPException(status_code=401, detail="Missing token")

    try:
        user = _get_current_user_from_token(token)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Invalid token")

    if user.role not in (Role.OPERATOR, Role.ADMIN, Role.SUPER_ADMIN):
        raise HTTPException(status_code=403, detail="Forbidden")

    # Fetch operator name for presence display
    user_name = str(user.user_id)
    try:
        async with get_pg_session(tenant_id) as session:
            r = await session.execute(
                text("SELECT name FROM usuarios WHERE id = :id LIMIT 1"),
                {"id": user.user_id},
            )
            row = r.fetchone()
            if row and row[0]:
                user_name = row[0]
    except Exception:
        pass

    from services.events import subscribe
    return StreamingResponse(
        subscribe(tenant_id, user_id=str(user.user_id), user_name=user_name),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Operator presence ─────────────────────────────────────────────────────────

@router.get("/operator/presence")
async def operator_presence(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Return list of currently online operators.

    Doubles as heartbeat: when an OPERATOR polls this endpoint, refresh their
    own presence key in Redis. The operator frontend polls every 15s, so this
    keeps the 90s TTL fresh without depending on SSE keepalive (which has been
    observed to skip set_presence in some browser/uvicorn race conditions).
    Admins polling for status do NOT refresh their own presence.
    """
    from services.events import get_online_operators, set_presence

    if current_user.role == Role.OPERATOR:
        user_name = str(current_user.user_id)
        try:
            async with get_pg_session(tenant_id) as session:
                r = await session.execute(
                    text("SELECT name FROM usuarios WHERE id = :id LIMIT 1"),
                    {"id": current_user.user_id},
                )
                row = r.fetchone()
                if row and row[0]:
                    user_name = row[0]
        except Exception:
            pass
        await set_presence(tenant_id, str(current_user.user_id), user_name)

    online = await get_online_operators(tenant_id)
    return {"operators": online, "count": len(online)}


# ── Public chat endpoints (no auth required) ──────────────────────────────────

@router.get("/public/chat-token")
async def public_chat_token(tenant_id: str = Depends(get_tenant_id)):
    """Issue a widget token for the public /chat page.
    Only requires X-Tenant-ID header — no user login needed."""
    async with get_pg_session() as session:
        row = await session.execute(
            text("SELECT id FROM tenants WHERE id = :tid AND status != 'suspended'"),
            {"tid": tenant_id},
        )
        if not row.fetchone():
            raise HTTPException(status_code=404, detail="Tenant not found")
    return {"widget_token": create_public_chat_token(tenant_id), "tenant_id": tenant_id}


@router.get("/public/tenant-branding")
async def public_tenant_branding(tenant_id: str):
    """Return public branding info for a tenant (logo, colors, name).
    Used by /login and other pre-auth pages to render the tenant's identity.
    Accepts tenant_id as a query param so callers without an X-Tenant-ID header
    (login page, etc.) can fetch it explicitly.
    """
    tid = (tenant_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="tenant_id required")

    async with get_pg_session() as session:
        row = await session.execute(text("""
            SELECT id, name, display_name, logo_url, primary_color, secondary_color,
                   favicon_url, bot_name, greeting_message
            FROM tenants
            WHERE id = :tid AND status != 'suspended'
            LIMIT 1
        """), {"tid": tid})
        t = row.mappings().fetchone()

    if not t:
        raise HTTPException(status_code=404, detail="Tenant not found")

    return {
        "tenant_id":        t["id"],
        "display_name":     t["display_name"] or t["name"],
        "logo_url":         t["logo_url"],
        "primary_color":    t["primary_color"]   or "#99323D",
        "secondary_color":  t["secondary_color"],
        "favicon_url":      t["favicon_url"],
        "bot_name":         t["bot_name"],
        "greeting_message": t["greeting_message"],
    }


# ── Sector management (admin only) ────────────────────────────────────────────

@router.get("/widget/sectors")
async def widget_list_sectors(
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
):
    """Public sector list for the widget — returns active sectors, default flag, and bot greeting."""
    async with get_pg_session(tenant_id) as session:
        sectors_result = await session.execute(text("""
            SELECT id, nombre, descripcion, is_default
            FROM sectores
            WHERE is_active = TRUE
            ORDER BY is_default DESC, nombre ASC
        """))
        sectors = [dict(r) for r in sectors_result.mappings().all()]

    async with get_pg_session() as global_session:
        config_result = await global_session.execute(
            text("SELECT greeting_message FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        row = config_result.mappings().fetchone()
        greeting = row["greeting_message"] if row else None

    return {"sectors": sectors, "greeting_message": greeting}


@router.get("/admin/sectors")
async def list_sectors(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Lista de sectores. Los operadores la necesitan para transferir
    conversaciones a otros sectores, asi que el endpoint acepta tanto
    operadores como admins. operator_count y open_conversations no son
    info confidencial — todos los operadores del tenant la ven."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT s.id, s.nombre, s.descripcion, s.is_active, s.is_default, s.created_at,
                   COUNT(DISTINCT os.operador_id) AS operator_count,
                   COUNT(DISTINCT c.id) FILTER (WHERE c.status != 'closed') AS open_conversations
            FROM sectores s
            LEFT JOIN operador_sectores os ON os.sector_id = s.id
            LEFT JOIN conversaciones c ON c.sector_id = s.id
            GROUP BY s.id ORDER BY s.nombre
        """))
        return [dict(r) for r in result.mappings().all()]


@router.patch("/admin/sectors/{sector_id}/set-default", status_code=200)
async def set_default_sector(
    sector_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Mark one sector as default (unsets all others atomically)."""
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("UPDATE sectores SET is_default = FALSE"))
        result = await session.execute(
            text("UPDATE sectores SET is_default = TRUE WHERE id = :id AND is_active = TRUE RETURNING id"),
            {"id": sector_id},
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Sector no encontrado o inactivo")
        await session.commit()
    return {"id": sector_id, "is_default": True}


@router.post("/admin/sectors", status_code=status.HTTP_201_CREATED)
async def create_sector(
    body: SectorCreate,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            INSERT INTO sectores (nombre, descripcion) VALUES (:nombre, :desc)
            RETURNING id, nombre
        """), {"nombre": body.nombre, "desc": body.descripcion})
        row = result.fetchone()
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="sector.created",
        resource=str(row[0]), detail={"nombre": body.nombre}, request=request,
    ))
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
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    async with get_pg_session(tenant_id) as session:
        # No permitir borrar el sector por defecto: es el destino de reasignación
        # y el sector inicial de los operadores nuevos.
        is_default = (await session.execute(
            text("SELECT is_default FROM sectores WHERE id = :id AND is_active = TRUE"),
            {"id": sector_id},
        )).scalar_one_or_none()
        if is_default is None:
            raise HTTPException(status_code=404, detail="Sector no encontrado")
        if is_default:
            raise HTTPException(
                status_code=409,
                detail="No se puede borrar el sector por defecto. Marcá otro como predeterminado primero.",
            )

        # Reasignar las conversaciones abiertas del sector: al sector por defecto si
        # existe, si no devolverlas al bot. Sin esto quedaban apuntando a un sector
        # inactivo y no aparecían en ninguna cola (huérfanas).
        default_id = (await session.execute(
            text("SELECT id FROM sectores WHERE is_default = TRUE AND is_active = TRUE AND id <> :id LIMIT 1"),
            {"id": sector_id},
        )).scalar_one_or_none()
        if default_id is not None:
            await session.execute(text("""
                UPDATE conversaciones SET sector_id = :def, updated_at = NOW()
                WHERE sector_id = :id AND status IN ('handoff_requested', 'human_attending')
            """), {"def": str(default_id), "id": sector_id})
        else:
            await session.execute(text("""
                UPDATE conversaciones
                SET status = 'bot_active', assigned_operator_id = NULL, updated_at = NOW()
                WHERE sector_id = :id AND status IN ('handoff_requested', 'human_attending')
            """), {"id": sector_id})

        # Limpiar asignaciones operador-sector de este sector (si no, los operadores
        # quedan "asignados" a un sector que ya no existe).
        await session.execute(
            text("DELETE FROM operador_sectores WHERE sector_id = :id"),
            {"id": sector_id},
        )
        # Soft-delete del sector.
        await session.execute(
            text("UPDATE sectores SET is_active = FALSE WHERE id = :id"),
            {"id": sector_id},
        )
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="sector.deleted",
        resource=sector_id, request=request,
    ))


# ── Operator-sector assignment ────────────────────────────────────────────────

class SectorAssignment(BaseModel):
    sector_ids: list[str]


@router.post("/admin/operators/{operator_id}/sectors")
async def assign_sectors(
    operator_id: str,
    body: SectorAssignment,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    _assert_tenant_access(current_user, tenant_id)
    # Guardar sin sectores deja al operador invisible para el widget
    # (operators-online filtra por operador_sectores). Rechazar explicitamente
    # para que el admin tome una decision consciente — la UI puede sugerir
    # "Consultas Generales" como default.
    if not body.sector_ids:
        raise HTTPException(
            status_code=400,
            detail="Debes asignar al menos un sector al operador",
        )
    async with get_pg_session(tenant_id) as session:
        # Validar que el id sea un usuario activo del tenant (operador/admin) antes de
        # tocar operador_sectores: evita asignar sectores a un id arbitrario o inactivo.
        valid = await session.execute(text(
            "SELECT 1 FROM usuarios WHERE id = :uid AND is_active = TRUE "
            "AND role IN ('operator', 'admin')"
        ), {"uid": operator_id})
        if valid.fetchone() is None:
            raise HTTPException(status_code=404, detail="Operador no encontrado")
        await session.execute(
            text("DELETE FROM operador_sectores WHERE operador_id = :uid"),
            {"uid": operator_id},
        )
        for sid in body.sector_ids:
            await session.execute(text("""
                INSERT INTO operador_sectores (operador_id, sector_id)
                VALUES (:uid, :sid) ON CONFLICT DO NOTHING
            """), {"uid": operator_id, "sid": sid})
    return {"operator_id": operator_id, "sectors_assigned": len(body.sector_ids)}


@router.get("/admin/operators")
async def list_operators(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """List operators and admins in this tenant. Super-admins (global) are excluded."""
    _assert_tenant_access(current_user, tenant_id)
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT id, email, name, role, is_active, created_at
            FROM usuarios
            WHERE role IN ('operator', 'admin') AND is_active = TRUE
            ORDER BY role, name
        """))
        return [dict(r) for r in result.mappings().all()]


@router.get("/admin/operators/{operator_id}/sectors")
async def get_operator_sectors(
    operator_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    _assert_tenant_access(current_user, tenant_id)
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT s.id, s.nombre FROM sectores s
            JOIN operador_sectores os ON os.sector_id = s.id
            WHERE os.operador_id = :uid
        """), {"uid": operator_id})
        return [dict(r) for r in result.mappings().all()]


@router.get("/admin/sectors/{sector_id}/operators")
async def get_sector_operators(
    sector_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Return the operators assigned to a sector. Used by the sector edit modal."""
    _assert_tenant_access(current_user, tenant_id)
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT u.id, u.name, u.email, u.is_active
            FROM usuarios u
            JOIN operador_sectores os ON os.operador_id = u.id
            WHERE os.sector_id = :sid AND u.role = 'operator' AND u.is_active = true
            ORDER BY u.name
        """), {"sid": sector_id})
        return [dict(r) for r in result.mappings().all()]


class CreateOperatorRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    # Sin password → se envía invitación por email para que el usuario defina
    # la suya (verifica además que el email esté bien escrito). Con password →
    # alta manual clásica (fallback si el correo del usuario tiene problemas).
    password: str | None = Field(None, min_length=8, max_length=200)


@router.post("/admin/operators", status_code=201)
async def create_operator(
    body: CreateOperatorRequest,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Create a new operator in the tenant. Admins can only create in their own tenant."""
    _assert_tenant_access(current_user, tenant_id)
    import secrets as _secrets
    import uuid
    from core.security import hash_password

    # Alta por invitación: la cuenta nace con una contraseña aleatoria que nadie
    # conoce; el usuario define la suya desde el enlace del email.
    invite = body.password is None
    effective_password = body.password or _secrets.token_urlsafe(24)

    email_norm = body.email.lower().strip()
    async with get_pg_session(tenant_id) as session:
        existing = await session.execute(
            text("SELECT id, is_active, role FROM usuarios WHERE email = :email"),
            {"email": email_norm},
        )
        existing_row = existing.mappings().fetchone()
        if existing_row and existing_row["is_active"]:
            raise HTTPException(status_code=409, detail="Ya existe un usuario con ese email")

        reactivated_role = "operator"
        if existing_row:
            # El email pertenece a un usuario dado de baja (soft-delete is_active=false).
            # Como email es UNIQUE no se puede re-insertar: lo REACTIVAMOS con nombre/clave
            # nuevos. PRESERVAMOS el rol previo: si era admin NO lo degradamos a operator
            # (recrear sobre el email de un admin de baja lo bajaba en silencio).
            new_id = str(existing_row["id"])
            reactivated_role = existing_row["role"] or "operator"
            await session.execute(text("""
                UPDATE usuarios
                SET name = :name, hashed_password = :pwd,
                    is_active = TRUE, updated_at = NOW()
                WHERE id = :id
            """), {"id": new_id, "name": body.name.strip(), "pwd": hash_password(effective_password)})
            # Limpiar estado que sobrevive a la baja (el id se reusa): tokens de
            # invitación/reset vivos (revivirían) y sectores heredados del usuario viejo.
            await session.execute(text(
                "UPDATE public.password_reset_tokens SET used_at = NOW() "
                "WHERE user_id = :id AND tenant_id = :tid AND used_at IS NULL"
            ), {"id": new_id, "tid": tenant_id})
            await session.execute(text(
                "DELETE FROM operador_sectores WHERE operador_id = :id"
            ), {"id": new_id})
        else:
            new_id = str(uuid.uuid4())
            await session.execute(text("""
                INSERT INTO usuarios (id, email, name, hashed_password, role, is_active)
                VALUES (:id, :email, :name, :pwd, 'operator', true)
            """), {
                "id": new_id,
                "email": email_norm,
                "name": body.name.strip(),
                "pwd": hash_password(effective_password),
            })

        # Asignar sector por defecto ("Consultas Generales" en el schema base).
        # Sin esto el operador queda invisible para el widget — operators-online
        # filtra por operador_sectores y un JOIN vacio no devuelve nada.
        default_sector = await session.execute(text(
            "SELECT id FROM sectores WHERE is_default = TRUE AND is_active = TRUE LIMIT 1"
        ))
        default_sector_id = default_sector.scalar_one_or_none()
        if default_sector_id:
            await session.execute(text(
                "INSERT INTO operador_sectores (operador_id, sector_id) VALUES (:uid, :sid) "
                "ON CONFLICT DO NOTHING"  # el reactivado puede conservar el sector previo
            ), {"uid": new_id, "sid": str(default_sector_id)})
        else:
            logger.warning("operator_created_no_default_sector tenant=%s operator=%s", tenant_id, new_id)

    # Invitación DESPUÉS del commit del alta: si el email falla, la cuenta queda
    # creada igual (el admin puede reintentar con "olvidé mi contraseña").
    invitation_sent = False
    if invite:
        from services.invitations import send_account_invitation
        invitation_sent = await send_account_invitation(
            tenant_id, new_id, body.email.lower().strip(), body.name.strip())

    logger.info("operator_created id=%s email=%s tenant=%s by=%s default_sector=%s invited=%s",
                new_id, body.email, tenant_id, current_user.user_id, default_sector_id, invitation_sent)
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="user.created",
        resource=new_id,
        detail={"email": body.email.lower().strip(), "name": body.name.strip(),
                "invitation_sent": invitation_sent if invite else None},
        request=request,
    ))
    return {"id": new_id, "email": body.email.lower().strip(), "name": body.name.strip(),
            "role": reactivated_role, "is_active": True, "invitation_sent": invitation_sent if invite else None}


class UpdateOperatorRequest(BaseModel):
    name:  str | None = Field(default=None, min_length=1, max_length=120)
    email: EmailStr | None = None


@router.patch("/admin/operators/{operator_id}")
async def update_operator(
    operator_id: str,
    body: UpdateOperatorRequest,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Editar nombre y/o email de un usuario activo del tenant.

    No cambia rol ni contraseña (otros flujos). El email se re-valida contra el
    UNIQUE para no chocar con otro usuario. Sin esto, un email mal escrito al crear
    solo se podía corregir borrando y recreando.
    """
    _assert_tenant_access(current_user, tenant_id)
    updates: list[str] = []
    params: dict[str, str] = {"id": operator_id}

    async with get_pg_session(tenant_id) as session:
        target = await session.execute(text(
            "SELECT role FROM usuarios WHERE id = :id AND is_active = TRUE"
        ), {"id": operator_id})
        target_row = target.fetchone()
        if target_row is None:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")
        # Simetría con el borrado: un admin no edita a otro admin (solo super_admin).
        if target_row[0] == "admin" and current_user.role != Role.SUPER_ADMIN:
            raise HTTPException(status_code=403, detail="No tenés permiso para editar a un administrador")

        if body.name:
            updates.append("name = :name")
            params["name"] = body.name.strip()
        if body.email:
            email_norm = body.email.lower().strip()
            clash = await session.execute(text(
                "SELECT 1 FROM usuarios WHERE email = :email AND id <> :id"
            ), {"email": email_norm, "id": operator_id})
            if clash.fetchone():
                raise HTTPException(status_code=409, detail="Ya existe otro usuario con ese email")
            updates.append("email = :email")
            params["email"] = email_norm

        if not updates:
            raise HTTPException(status_code=400, detail="No hay cambios para guardar")

        await session.execute(text(
            f"UPDATE usuarios SET {', '.join(updates)}, updated_at = NOW() WHERE id = :id"
        ), params)

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="user.updated",
        resource=operator_id, detail={k: v for k, v in params.items() if k != "id"},
        request=request,
    ))
    return {"id": operator_id, "updated": True}


@router.delete("/admin/operators/{operator_id}", status_code=204)
async def deactivate_operator(
    operator_id: str,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Deactivate (soft-delete) an operator. Admins can only deactivate operators (not other admins)."""
    _assert_tenant_access(current_user, tenant_id)

    async with get_pg_session(tenant_id) as session:
        # Admins can only deactivate operators; super_admin can deactivate admins too
        role_filter = "role IN ('operator', 'admin')" if current_user.role == Role.SUPER_ADMIN else "role = 'operator'"
        result = await session.execute(
            text(f"UPDATE usuarios SET is_active = false WHERE id = :id AND {role_filter} RETURNING id"),
            {"id": operator_id},
        )
        if not result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Usuario no encontrado o sin permiso")

        # Liberar sus conversaciones activas a la cola (misma tx) para que no queden
        # huérfanas asignadas a un operador que ya no atiende.
        from services.handoff import release_operator_conversations
        freed = await release_operator_conversations(session, operator_id)
        if freed:
            logger.info("operator_deactivated_freed_convs operator=%s count=%d", operator_id, freed)

        # Limpiar el estado que sobrevive a la baja (el id se reusa si luego se reactiva):
        # sectores asignados (consistente con delete_sector) y tokens de invitación/reset
        # vivos, que de otro modo revivirían al reactivar la cuenta con el mismo id.
        await session.execute(text(
            "DELETE FROM operador_sectores WHERE operador_id = :id"
        ), {"id": operator_id})
        await session.execute(text(
            "UPDATE public.password_reset_tokens SET used_at = NOW() "
            "WHERE user_id = :id AND tenant_id = :tid AND used_at IS NULL"
        ), {"id": operator_id, "tid": tenant_id})

    logger.info("operator_deactivated id=%s tenant=%s by=%s", operator_id, tenant_id, current_user.user_id)
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="user.deactivated",
        resource=operator_id, request=request,
    ))


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
            # CAST(:k AS jsonb) en vez de :k::jsonb — el "::" PG castea pero
            # SQLAlchemy/asyncpg lo confunde con el separador de parametro
            # nombrado (":k::jsonb" → "named-param 'k' + named-param 'jsonb'").
            # Mismo bug que rompía _store_parent_chunks (fix en commit 3e53d4c).
            set_parts.append(f"{k} = CAST(:{k} AS jsonb)")
            params[k] = _json.dumps(v, ensure_ascii=False)
        else:
            set_parts.append(f"{k} = :{k}")
            params[k] = v

    set_sql = ", ".join(set_parts) + ", updated_at = NOW()"

    async with get_pg_session(tenant_id) as session:
        await session.execute(text(f"UPDATE handoff_config SET {set_sql}"), params)

    invalidate_config_cache(tenant_id)
    return {"status": "updated"}
