"""Async helpers to query the Prometheus HTTP API from the backend."""

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

PROMETHEUS_URL = "http://prometheus:9090"
_TIMEOUT = 5.0  # seconds


async def _query(promql: str) -> list[dict]:
    """Instant query. Returns list of {metric, value} dicts or [] on error."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"{PROMETHEUS_URL}/api/v1/query",
                params={"query": promql},
            )
            r.raise_for_status()
            data = r.json()
            if data.get("status") == "success":
                return data["data"]["result"]
    except Exception as exc:
        logger.debug("prometheus_query_failed query=%r err=%s", promql[:80], exc)
    return []


async def _query_range(promql: str, start: int, end: int, step: int = 60) -> list[dict]:
    """Range query over [start, end] with the given step (seconds)."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"{PROMETHEUS_URL}/api/v1/query_range",
                params={"query": promql, "start": start, "end": end, "step": step},
            )
            r.raise_for_status()
            data = r.json()
            if data.get("status") == "success":
                return data["data"]["result"]
    except Exception as exc:
        logger.debug("prometheus_range_failed query=%r err=%s", promql[:80], exc)
    return []


def _scalar(result: list[dict], default: float = 0.0) -> float:
    """Extract scalar value from a single-result instant query."""
    if result and result[0].get("value"):
        try:
            return float(result[0]["value"][1])
        except (IndexError, ValueError, TypeError):
            pass
    return default


def _series(result: list[dict]) -> list[dict]:
    """Convert range query result to [{t, v}] list (first series only)."""
    if not result or not result[0].get("values"):
        return []
    return [{"t": int(ts), "v": float(v)} for ts, v in result[0]["values"] if v != "NaN"]


async def get_system_metrics(now: int) -> dict[str, Any]:
    """
    Query Prometheus for all system health metrics.
    All queries run concurrently. Any failure returns a safe default.
    Returns a dict ready to serialize as JSON.
    """
    import asyncio

    window_1h_ago = now - 3600

    # Fire all queries in parallel
    (
        pg_up_r,
        pg_conns_r,
        pg_size_r,
        pg_hit_num_r,
        pg_hit_den_r,
        pg_deadlocks_r,
        redis_up_r,
        redis_mem_used_r,
        redis_mem_max_r,
        redis_clients_r,
        redis_hits_r,
        redis_misses_r,
        redis_evicted_r,
        redis_frag_r,
        redis_keys_r,
        redis_slowlog_r,
        http_total_r,
        http_5xx_r,
        http_p95_r,
        groq_total_r,
        ia_tenants_r,
        ia_queries_r,
        ia_cache_r,
        ia_ingest_r,
        ia_quality_r,
        # Range data for sparklines
        http_rate_range_r,
        ia_query_rate_range_r,
    ) = await asyncio.gather(
        _query("pg_up"),
        _query("pg_stat_activity_count{datname='platform'}"),
        _query("pg_database_size_bytes{datname='platform'}"),
        _query("rate(pg_stat_database_blks_hit{datname='platform'}[5m])"),
        _query("rate(pg_stat_database_blks_read{datname='platform'}[5m])"),
        _query("pg_stat_database_deadlocks{datname='platform'}"),
        _query("redis_up"),
        _query("redis_memory_used_bytes"),
        _query("redis_config_maxmemory"),
        _query("redis_connected_clients"),
        _query("redis_keyspace_hits_total"),
        _query("redis_keyspace_misses_total"),
        _query("redis_evicted_keys_total"),
        _query("redis_mem_fragmentation_ratio"),
        _query("redis_db_keys"),
        _query("redis_slowlog_length"),
        _query("sum(http_requests_total)"),
        _query("sum(rate(http_requests_total{status=~'5..'}[10m])) or vector(0)"),
        _query("histogram_quantile(0.95, sum(rate(http_request_duration_highr_seconds_bucket[10m])) by (le))"),
        _query("sum(ia_groq_requests_total) by (model, status)"),
        _query("ia_active_tenants"),
        _query("sum(ia_queries_total) or vector(0)"),
        _query("sum(ia_cache_hits_total) or vector(0)"),
        _query("sum(ia_ingest_total) or vector(0)"),
        _query("sum(ia_quality_gate_total) by (status)"),
        _query_range("sum(rate(http_requests_total[5m]))", window_1h_ago, now, step=120),
        _query_range("sum(rate(ia_queries_total[5m]))", window_1h_ago, now, step=120),
        return_exceptions=False,
    )

    # PostgreSQL
    pg_hit = _scalar(pg_hit_num_r)
    pg_read = _scalar(pg_hit_den_r)
    pg_hit_rate = pg_hit / (pg_hit + pg_read) if (pg_hit + pg_read) > 0 else None

    # Redis key counts by DB (only DB 0, 1, 2 are ours)
    redis_keys: dict[str, int] = {}
    for r in redis_keys_r:
        db = r["metric"].get("db", "?")
        if db in ("db0", "db1", "db2"):
            redis_keys[db] = int(_scalar([r]))
    redis_hits  = _scalar(redis_hits_r)
    redis_miss  = _scalar(redis_misses_r)
    redis_hit_rate = redis_hits / (redis_hits + redis_miss) if (redis_hits + redis_miss) > 0 else None

    # HTTP
    http_5xx_rate = _scalar(http_5xx_r)
    http_p95_ms   = _scalar(http_p95_r) * 1000 if http_p95_r else None  # convert s → ms

    # Groq by model + status
    groq_by_model: dict[str, dict[str, float]] = {}
    for r in groq_total_r:
        model  = r["metric"].get("model", "unknown")
        status = r["metric"].get("status", "unknown")
        groq_by_model.setdefault(model, {})[status] = float(r["value"][1])

    # Quality gate
    quality: dict[str, int] = {}
    for r in ia_quality_r:
        status = r["metric"].get("status", "unknown")
        quality[status] = int(float(r["value"][1]))

    return {
        "postgres": {
            "up":              _scalar(pg_up_r) == 1.0,
            "connections":     int(_scalar(pg_conns_r)),
            "db_size_bytes":   int(_scalar(pg_size_r)),
            "cache_hit_rate":  round(pg_hit_rate, 4) if pg_hit_rate is not None else None,
            "deadlocks_total": int(_scalar(pg_deadlocks_r)),
        },
        "redis": {
            "up":                _scalar(redis_up_r) == 1.0,
            "memory_used_bytes": int(_scalar(redis_mem_used_r)),
            "memory_max_bytes":  int(_scalar(redis_mem_max_r)),
            "connected_clients": int(_scalar(redis_clients_r)),
            "keyspace_hit_rate": round(redis_hit_rate, 4) if redis_hit_rate is not None else None,
            "evicted_keys":      int(_scalar(redis_evicted_r)),
            "fragmentation_ratio": round(_scalar(redis_frag_r, 1.0), 2),
            "slowlog_length":    int(_scalar(redis_slowlog_r)),
            "keys_by_db":        redis_keys,
        },
        "backend": {
            "up":              True,
            "total_requests":  int(_scalar(http_total_r)),
            "error_rate_5m":   round(http_5xx_rate, 4),
            "latency_p95_ms":  round(http_p95_ms, 1) if http_p95_ms is not None else None,
        },
        "groq": {
            "by_model": [
                {
                    "model":   model,
                    "calls":   {s: int(v) for s, v in statuses.items()},
                    "total":   int(sum(statuses.values())),
                    "errors":  int(statuses.get("error", 0) + statuses.get("timeout", 0) + statuses.get("rate_limit", 0)),
                }
                for model, statuses in groq_by_model.items()
            ],
            "total_calls": int(sum(
                int(float(r["value"][1])) for r in groq_total_r
            )),
        },
        "app": {
            "active_tenants":     int(_scalar(ia_tenants_r)),
            "total_queries":      int(_scalar(ia_queries_r)),
            "total_cache_hits":   int(_scalar(ia_cache_r)),
            "total_ingests":      int(_scalar(ia_ingest_r)),
            "quality": quality,
        },
        "sparklines": {
            "http_req_rate":   _series(http_rate_range_r),
            "query_rate":      _series(ia_query_rate_range_r),
        },
    }
