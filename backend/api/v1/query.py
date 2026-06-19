"""Main query endpoint: embed → classify → retrieve → rerank → LLM → respond."""

import logging

from fastapi import APIRouter, Depends

from core.rate_limit import check_rate_limit, check_widget_rate_limit
from core.security import CurrentUser, get_current_user, get_widget_user
from core.tenant import get_tenant_id
from models.query import QueryRequest, QueryResponse, SourceChunk

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/query", response_model=QueryResponse, dependencies=[Depends(check_rate_limit)])
async def query(
    request: QueryRequest,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Process a natural language question against the tenant's knowledge base."""
    from core.plan_limits import enforce_query_limit
    await enforce_query_limit(tenant_id)

    from services.orchestrator import handle_query

    result = await handle_query(
        question=request.question,
        tenant_id=tenant_id,
        user_id=current_user.user_id,
        language=request.language,
        conversation_history=[(t.role, t.content) for t in request.conversation_history],
    )
    return QueryResponse(
        answer=result["answer"],
        sources=[SourceChunk(**s) for s in result["sources"]],
        intent_label=result.get("intent_label"),
        intent_confidence=result.get("intent_confidence"),
        from_cache=result.get("from_cache", False),
        latency_ms=result.get("latency_ms", 0),
    )


@router.post("/query/widget", response_model=QueryResponse, dependencies=[Depends(check_widget_rate_limit)])
async def query_widget(
    request: QueryRequest,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Widget-scoped query endpoint. Accepts widget_token instead of user token.

    Rate-limit POR IP (check_widget_rate_limit), igual que /widget/conversation/
    message — el vector de abuso del widget es una IP martillando, no el tenant.
    Ambos frenos son desactivables para pruebas de carga/concurrencia:
      - rate por IP: WIDGET_RATE_LIMIT_PER_MINUTE=0
      - cuota mensual: plan del tenant con queries_month=-1 (ilimitado) → no chequea.
    """
    from core.plan_limits import enforce_query_limit
    await enforce_query_limit(tenant_id)

    from services.orchestrator import handle_query

    result = await handle_query(
        question=request.question,
        tenant_id=tenant_id,
        user_id=None,
        language=request.language,
        conversation_history=[(t.role, t.content) for t in request.conversation_history],
    )
    return QueryResponse(
        answer=result["answer"],
        sources=[SourceChunk(**s) for s in result["sources"]],
        intent_label=result.get("intent_label"),
        intent_confidence=result.get("intent_confidence"),
        from_cache=result.get("from_cache", False),
        latency_ms=result.get("latency_ms", 0),
    )
