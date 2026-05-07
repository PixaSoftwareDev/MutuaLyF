"""Main query endpoint: embed → classify → retrieve → rerank → LLM → respond."""

import logging

from fastapi import APIRouter, Depends

from core.rate_limit import check_rate_limit
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
    from services.orchestrator import handle_query

    result = await handle_query(
        question=request.question,
        tenant_id=tenant_id,
        user_id=current_user.user_id,
        language=request.language,
    )
    return QueryResponse(
        answer=result["answer"],
        sources=[SourceChunk(**s) for s in result["sources"]],
        intent_label=result.get("intent_label"),
        intent_confidence=result.get("intent_confidence"),
        from_cache=result.get("from_cache", False),
        latency_ms=result.get("latency_ms", 0),
    )


@router.post("/query/widget", response_model=QueryResponse, dependencies=[Depends(check_rate_limit)])
async def query_widget(
    request: QueryRequest,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Widget-scoped query endpoint. Accepts widget_token instead of user token."""
    from services.orchestrator import handle_query

    result = await handle_query(
        question=request.question,
        tenant_id=tenant_id,
        user_id=None,  # Widget queries are anonymous
        language=request.language,
    )
    return QueryResponse(
        answer=result["answer"],
        sources=[SourceChunk(**s) for s in result["sources"]],
        intent_label=result.get("intent_label"),
        intent_confidence=result.get("intent_confidence"),
        from_cache=result.get("from_cache", False),
        latency_ms=result.get("latency_ms", 0),
    )
