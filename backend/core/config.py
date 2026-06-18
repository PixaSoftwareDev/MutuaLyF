"""Application settings loaded from environment variables via pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Groq ──────────────────────────────────────────────────────────────────
    groq_api_key: str
    groq_model_fast: str = "llama-3.3-70b-versatile"
    groq_model_reasoning: str = "meta-llama/llama-4-scout-17b-16e-instruct"

    # ── LLM provider switch (groq | openai) ──────────────────────────────────
    # OpenAI is supported as test-only alternative for benchmarking. Production
    # default is groq for latency. See load test scripts.
    llm_provider: str = "groq"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    # Admin API key (sk-admin-…) para LEER el gasto/usage de la organización en
    # OpenAI (endpoint /v1/organization/costs). Distinta de openai_api_key (que es
    # para inferencia): esta es solo lectura de billing. Si está vacía, el panel
    # muestra el costo como "no configurado".
    openai_admin_api_key: str = ""

    # ── Embedding provider switch (local | openai | tei) ─────────────────────
    # local: multilingual-e5-large CPU-bound EN el proceso uvicorn, ~1.5GB RAM,
    #        ~200ms/embed pero consume GIL → bloquea event loop con concurrencia.
    # openai: text-embedding-3-small con dimensions=1024 (compat Qdrant). Via API.
    # tei:   text-embeddings-inference (HuggingFace, Rust). Mismo modelo
    #        multilingual-e5-large pero corriendo en su propio container. Hace
    #        dynamic batching: 20 requests simultaneas se procesan en 1 forward
    #        pass del modelo → throughput ~10x vs local.
    # NOTA: cambiar provider entre local/tei NO requiere re-embeddear (mismo
    # modelo y dim). Entre openai y local/tei SI requiere reembedding completo.
    embedding_provider: str = "local"
    openai_embedding_model: str = "text-embedding-3-small"

    # ── TEI URLs (Text Embeddings Inference) ──────────────────────────────────
    tei_embedding_url: str = "http://tei-embeddings:80"
    tei_reranker_url:  str = "http://tei-reranker:80"
    tei_timeout_ms:    int = 5000   # margen para batching server-side

    # ── Reranker provider switch (local | tei) ────────────────────────────────
    # local: bge-reranker-large via sentence-transformers CrossEncoder en el
    #        proceso uvicorn (CPU, GIL bound, ~2GB RAM, OOM leak conocido).
    # tei:   mismo modelo en TEI container con batching.
    reranker_provider: str = "local"

    # ── Concurrency tuning (production) ───────────────────────────────────────
    # Semaforos asyncio POR WORKER uvicorn para controlar hits concurrentes
    # a OpenAI. Critico bajo carga: OpenAI throttla agresivamente per-key cuando
    # ve >25 calls simultaneos del mismo key, INDEPENDIENTE del RPM tier.
    #
    # Calibrado empirica con bench 20-50 simultaneos (2026-05-23):
    #   Cada query hace ~2 calls a OpenAI (embed + LLM).
    #   4 workers x 6 LLM x 6 embed = 24+24 = 48 max OpenAI concurrent.
    #   Eso es safe zone para Tier 1 paid (probado: <2s/call sostenido).
    #
    # Tier 2+ podria subir a 10/10 o 15/15. Groq free: bajar a 2/2.
    llm_max_concurrent_per_worker: int = 6
    embedding_max_concurrent_per_worker: int = 6

    # Connection pool sizes para clientes HTTP externos (OpenAI, TEI).
    # Default httpx es 100/20 — chico para multi-worker bajo concurrencia.
    http_pool_max_connections: int = 200
    http_pool_max_keepalive: int = 50

    # ── PostgreSQL ─────────────────────────────────────────────────────────────
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "platform"
    postgres_user: str
    postgres_password: str

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
            f"?ssl=disable"
        )

    @property
    def postgres_dsn_sync(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
            f"?sslmode=disable"
        )

    # ── Neo4j ─────────────────────────────────────────────────────────────────
    neo4j_uri: str = "bolt://neo4j:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str
    # Multi-database isolation requires Neo4j Enterprise.
    # Community Edition only has the "neo4j" database; tenant isolation is
    # enforced via the tenant_id property on every node and relationship.
    neo4j_multidatabase: bool = False

    # ── Qdrant ────────────────────────────────────────────────────────────────
    qdrant_host: str = "qdrant"
    qdrant_port: int = 6333

    # ── MinIO ─────────────────────────────────────────────────────────────────
    minio_endpoint: str = "minio:9000"
    minio_root_user: str = "minioadmin"
    minio_root_password: str = "minioadmin123"
    minio_bucket: str = "documents"
    minio_secure: bool = False
    # Retención de adjuntos de conversaciones (imágenes/PDF en MinIO). Pasados
    # estos días, una task nocturna borra el archivo y deja la referencia en
    # NULL — el mensaje sobrevive en el historial pero el archivo expira.
    attachment_retention_days: int = 60

    # ── Redis ─────────────────────────────────────────────────────────────────
    redis_url_broker: str = "redis://redis:6379/0"
    redis_url_cache: str = "redis://redis:6379/1"
    redis_url_ratelimit: str = "redis://redis:6379/2"

    # ── JWT ───────────────────────────────────────────────────────────────────
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60
    jwt_refresh_expire_days: int = 30
    jwt_widget_expire_days: int = 90

    # ── Login brute-force protection ──────────────────────────────────────────
    # Despues de N fallos en la ventana, todos los intentos para ese email
    # reciben 429 sin pasar por bcrypt (que es caro). La ventana se renueva
    # con cada fallo nuevo (cada intento extiende el lockout otros TTL segundos).
    login_max_fails: int = 10            # intentos antes de bloquear
    login_lockout_window_s: int = 600    # ventana de 10 min

    # ── App ───────────────────────────────────────────────────────────────────
    environment: str = "development"
    log_level: str = "INFO"
    allowed_origins: str = "http://localhost:3000"
    base_domain: str = "localhost"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",")]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    # ── Timeouts (ms) ─────────────────────────────────────────────────────────
    # Valores calibrados con load test 10 concurrentes (2026-05-13).
    # Bajo contención CPU en backend (~200%), modelos locales y conexiones
    # de red necesitan headroom mayor que el ideal de "happy path".
    redis_timeout_ms: int = 200          # antes 20ms: causaba timeouts en cada request bajo carga
    classifier_timeout_ms: int = 200     # antes 80ms
    nlu_timeout_ms: int = 1000           # antes 200ms: GLiNER local CPU-bound bajo carga
    orchestrator_timeout_ms: int = 100   # antes 50ms
    db_timeout_ms: int = 1500            # antes 500ms
    reranker_timeout_ms: int = 2500      # bge-reranker local CPU-bound: 800ms timeouteaba
                                         # con 15-20 candidatos → caía a scores de embedding
                                         # (escala baja, diluye atributos). El reranker es la
                                         # autoridad de relevancia (entiende "cardiólogo"≈
                                         # "Cardiologia"); vale la latencia para que SIEMPRE corra.
    llm_fast_timeout_ms: int = 3000      # antes 1500ms: bajo carga + retries
    llm_reasoning_timeout_ms: int = 10000  # antes 7000ms
    neo4j_timeout_ms: int = 1500         # antes 500ms

    # ── Chunking ──────────────────────────────────────────────────────────────
    chunk_size_tokens: int = 512
    chunk_overlap_tokens: int = 64
    semantic_min_tokens: int = 20
    # Hierarchical chunking (Small-to-Big)
    child_chunk_size_words: int = 150    # child size sent to Qdrant for embedding
    child_chunk_overlap_words: int = 15
    max_parent_words: int = 700          # hard cap per parent section sent to LLM
    min_parent_words: int = 60           # sections shorter than this merge into previous

    # ── Query rewriting (multi-query retrieval) ───────────────────────────────
    # Antes del RAG, un LLM rápido reescribe la query con sinónimos + contexto
    # del historial. Resuelve "vocabulary mismatch" (query usa palabras que no
    # están en el texto) y reformulaciones (mismo intent, palabras distintas).
    # Cache en Redis 24h. Sin LLM disponible → fallback a query original.
    query_rewriting_enabled: bool = True
    query_rewriting_timeout_ms: int = 2500     # tope para el LLM call
    query_rewriting_num_variants: int = 1      # main + 1 variant = 2 queries total (calibrado 2026-05-25)
    query_rewriting_cache_ttl: int = 86400     # 24h en Redis
    query_rewriting_max_query_words: int = 30  # skip rewriting si query ya es muy específica
    # Mejora 2 — Conditional rewriting: solo correr el rewriter cuando aporta valor.
    # Queries cortas o que empiezan con pronombre interrogativo son las que tienen
    # vocabulary mismatch (ej: '¿dirección?' vs chunk 'Av. López 567'). Las queries
    # largas y específicas ya tienen suficiente contexto para el RAG actual.
    query_rewriting_short_threshold: int = 6   # ≤ N palabras → siempre rewriter

    # ── Retrieval ─────────────────────────────────────────────────────────────
    retrieval_top_k: int = 100           # candidates fetched from Qdrant
    rerank_top_k: int = 15              # top-k after reranking
    rerank_max_chars: int = 1200        # chars per chunk sent to the cross-encoder.
                                        # 900 cortaba parents largos; 2000 hacía el reranker
                                        # CPU demasiado lento → timeout → caía a embedding.
                                        # 1200 es el balance: cubre el chunk de entidad (~400)
                                        # y la mayoría de parents sin reventar el timeout.
    bm25_limit: int = 20                # BM25 candidates from PostgreSQL
    rrf_k: int = 60                     # RRF constant (standard value, rarely changed)
    skipped_chunk_score_penalty: float = 0.85  # score multiplier for quality_gate_status=skipped
    low_confidence_fallback_chunks: int = 2    # chunks to include when all below min_score
    # Piso de confianza para el corte duro anti-alucinación. DESACTIVADO (0.0) por
    # ahora: el score final tiene escala INCONSISTENTE — RRF (fusión con BM25) lo
    # comprime a ~0.03, y el reranker (que lo devolvería a ~0.4) no siempre corre.
    # Un umbral absoluto cortaba chunks relevantes que quedaban en escala RRF →
    # "no encontré" en casos válidos. Reactivar solo cuando el score esté calibrado
    # (reranker siempre activo o normalización de escala). El anti-alucinación
    # mientras tanto vive en el prompt (regla 6) + la advertencia de baja confianza.
    hard_fallback_min_score: float = 0.0
    max_context_chunks: int = 15        # max chunks sent to LLM in a single query

    # ── Conversation history ───────────────────────────────────────────────────
    history_recent_turns: int = 6       # last N turns sent as full messages
    history_summary_chars: int = 120    # chars per turn in the compressed summary block
    history_message_max_chars: int = 500  # max chars per recent turn message

    # ── ML models ─────────────────────────────────────────────────────────────
    embedding_model: str = "intfloat/multilingual-e5-large"
    reranker_model: str = "BAAI/bge-reranker-large"
    reranker_enabled: bool = True
    # Umbral de documentos listos para activar el reranker automaticamente.
    # Con < N docs la KB es chica: Qdrant similarity ya es precisa y el reranker
    # no aporta calidad pero si latencia. Con >= N docs hay overlap tematico entre
    # fuentes distintas y el reranker empieza a discriminar mejor que coseno puro.
    # 5 docs ≈ 180 chunks — punto de inflexion validado empiricamente.
    reranker_auto_min_docs: int = 1
    # Minimo de candidatos de Qdrant para correr el reranker en esa query.
    # Si Qdrant devuelve menos de este numero, skipear (sin calidad real a ganar).
    reranker_min_candidates: int = 5
    nlu_model: str = "urchade/gliner_large-v2.1"
    nlu_enabled: bool = True

    # ── Cache ─────────────────────────────────────────────────────────────────
    cache_ttl_seconds: int = 3600
    semantic_cache_threshold: float = 0.97   # cosine similarity to consider a semantic hit
    semantic_cache_enabled: bool = True

    # ── Intent classifier ─────────────────────────────────────────────────────
    intent_confidence_high: float = 0.95
    intent_confidence_mid: float = 0.70
    intent_auto_learn_cap: float = 0.30
    intent_cluster_min_size: int = 15
    intent_cluster_dismiss_days: int = 60

    # ── Email ─────────────────────────────────────────────────────────────────
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    email_from: str = "noreply@example.com"
    # URL pública base del frontend, para armar links en emails (reset de
    # contraseña). Ej. https://intellix.com.ar — sin barra final.
    app_base_url: str = ""

    # ── Rate limiting ─────────────────────────────────────────────────────────
    # Aplicado en core/rate_limit.py como FastAPI dependency. Sliding window
    # 60s en Redis DB 2 por tenant. Default subido de 60 → 600 r/m (10/s) para
    # matchear nginx (que tambien tiene rate=600r/m). Si alguien necesita mas:
    # subir en .env via RATE_LIMIT_REQUESTS_PER_MINUTE.
    rate_limit_requests_per_minute: int = 600
    # Rate limit del widget POR IP (mensajes/min). 0 = DESACTIVADO (útil para pruebas
    # de carga/concurrencia desde una sola IP). Configurable vía WIDGET_RATE_LIMIT_PER_MINUTE.
    widget_rate_limit_per_minute: int = 30

    # SSO / OAuth 2.0 (Google Workspace + Azure AD) eliminado en limpieza
    # de dead code (Sprint 1, 2026-05-20). El router auth_sso.py nunca estuvo
    # montado en main.py. Para re-habilitar: ver historial git en commit
    # anterior a la limpieza.

    @field_validator("groq_model_fast", "groq_model_reasoning")
    @classmethod
    def validate_groq_model_id(cls, value: str) -> str:
        """Guard against forbidden model IDs that don't exist in Groq's API."""
        # llama-3.1-405b never existed on Groq. llama-3.1-70b-versatile retired Jan 2025.
        # llama-4-maverick not available on free/dev tier — use llama-4-scout instead.
        forbidden = {
            "llama-3.1-405b",
            "llama-3.1-70b-versatile",
            "bge-large-en-v1.5",
            "meta-llama/llama-4-maverick-17b-128e-instruct",
        }
        if value in forbidden:
            raise ValueError(
                f"Model ID '{value}' is forbidden or unavailable. "
                "Use GROQ_MODEL_FAST / GROQ_MODEL_REASONING env vars."
            )
        return value


settings = Settings()  # type: ignore[call-arg]


def _assert_production_secrets_safe() -> None:
    """Validar al startup que en produccion no se usan defaults inseguros.
    Si environment=production y algun secret es un valor obvio de dev
    ('changeme', 'admin', 'minioadmin', el secret de dev), aborta el boot.

    Sin esto: un deploy a prod que se olvido de configurar las env vars
    arranca con passwords default y la BD queda accesible con credenciales
    publicamente conocidas.
    """
    if not settings.is_production:
        return

    DEV_DEFAULTS = {
        "changeme", "admin", "minioadmin", "minioadmin123",
        "dev_secret_key_min_32_chars_aqui_ok", "secret", "password",
    }
    checks = [
        ("POSTGRES_PASSWORD",       settings.postgres_password),
        ("NEO4J_PASSWORD",          settings.neo4j_password),
        ("JWT_SECRET_KEY",          settings.jwt_secret_key),
        ("MINIO_ROOT_PASSWORD",     settings.minio_root_password),
    ]
    failures = [name for name, value in checks if (value or "").strip().lower() in DEV_DEFAULTS]
    if failures:
        raise RuntimeError(
            f"ENVIRONMENT=production pero los siguientes secrets usan valores default de dev: "
            f"{', '.join(failures)}. Rotalos antes de arrancar."
        )
    if len(settings.jwt_secret_key) < 32:
        raise RuntimeError(
            "JWT_SECRET_KEY es muy corto (<32 chars). Generar con `openssl rand -hex 32`."
        )
    if "*" in settings.allowed_origins:
        raise RuntimeError(
            "ALLOWED_ORIGINS contiene '*' en produccion. Listar dominios especificos."
        )


_assert_production_secrets_safe()
