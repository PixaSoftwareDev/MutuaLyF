"""Buffer de errores recientes del backend, visible en el panel super-admin.

Un logging.Handler que guarda cada registro WARNING/ERROR en una lista acotada
de Redis (los últimos N, TTL 7 días). El super-admin los ve en Monitoreo sin
salir del panel — el 80% de los "abrí Grafana / docker logs" es para esto.

Diseño:
  - Cliente Redis SÍNCRONO propio (logging es sync; no puede usar el cliente
    asyncio del app). Lazy + best-effort: si Redis no está, el handler calla.
  - Anti-recursión: ignora registros de los loggers de redis/urllib3 y nunca
    propaga excepciones (un error al loguear no puede tumbar un request).
  - Compartido entre workers de uvicorn (todos escriben a la misma key).
"""

import ast
import json
import logging
import time

_KEY = "platform:recent_errors"
_MAX = 300
_TTL = 7 * 24 * 3600

_redis = None
_redis_failed_until = 0.0


def _client():
    """Cliente sync lazy. Si la conexión falla, no reintenta por 60s."""
    global _redis, _redis_failed_until
    if _redis is not None:
        return _redis
    if time.time() < _redis_failed_until:
        return None
    try:
        import redis as redis_sync
        from core.config import settings
        _redis = redis_sync.Redis.from_url(
            settings.redis_url_cache, socket_timeout=1, socket_connect_timeout=1)
        return _redis
    except Exception:
        _redis_failed_until = time.time() + 60
        return None


def _split_message(raw: str) -> tuple[str, str, str | None]:
    """Separa (título, detalle, tenant) de un mensaje de log.

    structlog (vía ProcessorFormatter) entrega el event-dict como repr de
    Python — ilegible en el panel. Acá extraemos 'event' como título, armamos
    un detalle compacto con los campos útiles y rescatamos el tenant si el
    evento lo trae (permite la vista de salud por organización).
    """
    raw = raw.strip()
    if raw.startswith("{'") or raw.startswith('{"'):
        try:
            data = ast.literal_eval(raw)
            if isinstance(data, dict):
                title = str(data.get("event") or "error")
                tenant = data.get("tenant") or data.get("tenant_id")
                parts = []
                for key in ("path", "tenant", "tenant_id", "error", "detail", "exception"):
                    val = data.get(key)
                    if val:
                        parts.append(f"{key}={val}")
                return title[:200], " · ".join(parts)[:600], (str(tenant) if tenant else None)
        except Exception:
            pass
    # Mensajes planos tipo "jwt_decode_failed error=...": primer token = título.
    tenant = None
    for tok in raw.split():
        if tok.startswith("tenant=") or tok.startswith("tenant_id="):
            tenant = tok.split("=", 1)[1].strip(",")
            break
    if " " in raw:
        head, rest = raw.split(" ", 1)
        if "=" in rest and " " not in head:
            return head[:200], rest[:600], tenant
    return raw[:200], "", tenant


class RedisErrorBufferHandler(logging.Handler):
    """Guarda WARNING+ en Redis para el panel. Nunca lanza."""

    _SKIP_LOGGERS = ("redis", "urllib3", "httpx", "httpcore", "asyncio")

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if record.name.startswith(self._SKIP_LOGGERS):
                return
            client = _client()
            if client is None:
                return
            title, detail, tenant = _split_message(self.format(record)[:2000])
            entry = json.dumps({
                "ts": int(record.created),
                "level": record.levelname,
                "logger": record.name,
                "message": title,
                "detail": detail,
                "tenant": tenant,
            }, ensure_ascii=False)
            pipe = client.pipeline()
            pipe.lpush(_KEY, entry)
            pipe.ltrim(_KEY, 0, _MAX - 1)
            pipe.expire(_KEY, _TTL)
            pipe.execute()
        except Exception:
            # Best-effort: jamás propagar — y marcar backoff si Redis cayó.
            global _redis, _redis_failed_until
            _redis = None
            _redis_failed_until = time.time() + 60


def attach_error_buffer() -> None:
    """Engancha el handler al root logger (idempotente)."""
    root = logging.getLogger()
    if any(isinstance(h, RedisErrorBufferHandler) for h in root.handlers):
        return
    h = RedisErrorBufferHandler(level=logging.WARNING)
    h.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(h)


def get_recent_errors(limit: int = 100, level: str | None = None, tenant: str | None = None) -> list[dict]:
    """Lee los errores recientes (más nuevos primero). Sync — llamar via to_thread.

    Agrupa repeticiones del mismo (level, message) en una sola entrada con
    `count` — un warning que se dispara 40 veces ocupa una línea, no 40.
    Con `tenant` devuelve solo los eventos de esa organización (los que no
    traen tenant en el log quedan afuera del filtro).
    """
    client = _client()
    if client is None:
        return []
    try:
        raw = client.lrange(_KEY, 0, _MAX - 1)
        grouped: dict[tuple[str, str], dict] = {}
        for item in raw:
            try:
                e = json.loads(item)
            except Exception:
                continue
            if level and e.get("level") != level:
                continue
            # Entradas viejas (pre-formato) traen el mensaje crudo: normalizar.
            if "detail" not in e:
                title, detail, ten = _split_message(str(e.get("message", "")))
                e["message"], e["detail"], e["tenant"] = title, detail, ten
            if tenant and e.get("tenant") != tenant:
                continue
            key = (e.get("level", ""), e.get("message", ""))
            if key in grouped:
                grouped[key]["count"] += 1
                # La lista viene de más nuevo a más viejo: el primero ya tiene
                # el ts/detalle más reciente — solo sumamos.
            else:
                e["count"] = 1
                grouped[key] = e
        out = sorted(grouped.values(), key=lambda e: e.get("ts", 0), reverse=True)
        return out[:limit]
    except Exception:
        return []
