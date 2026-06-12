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
            entry = json.dumps({
                "ts": int(record.created),
                "level": record.levelname,
                "logger": record.name,
                "message": self.format(record)[:1000],
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


def get_recent_errors(limit: int = 100, level: str | None = None) -> list[dict]:
    """Lee los errores recientes (más nuevos primero). Sync — llamar via to_thread."""
    client = _client()
    if client is None:
        return []
    try:
        raw = client.lrange(_KEY, 0, _MAX - 1)
        out = []
        for item in raw:
            try:
                e = json.loads(item)
            except Exception:
                continue
            if level and e.get("level") != level:
                continue
            out.append(e)
            if len(out) >= limit:
                break
        return out
    except Exception:
        return []
