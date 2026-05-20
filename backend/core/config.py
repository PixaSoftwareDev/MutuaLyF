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

    # ── Embedding provider switch (local | openai) ───────────────────────────
    # local: multilingual-e5-large CPU-bound, ~1.5GB RAM, ~200ms/embed.
    # openai: text-embedding-3-small con dimensions=1024 (compat Qdrant).
    #   Beneficio: libera 1.5GB RAM del backend y el celery_worker, embeddings
    #   ~80ms via API. NOTA: cambiar provider requiere re-embeddear chunks
    #   existentes (ver scripts/re_embed_qdrant.py) — los vectores no son
    #   intercambiables entre modelos.
    embedding_provider: str = "local"
    openai_embedding_model: str = "text-embedding-3-small"

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
    reranker_timeout_ms: int = 800       # antes 300ms: bge-reranker local CPU-bound
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

    # ── Retrieval ─────────────────────────────────────────────────────────────
    retrieval_top_k: int = 100           # candidates fetched from Qdrant
    rerank_top_k: int = 15              # top-k after reranking
    bm25_limit: int = 20                # BM25 candidates from PostgreSQL
    rrf_k: int = 60                     # RRF constant (standard value, rarely changed)
    skipped_chunk_score_penalty: float = 0.85  # score multiplier for quality_gate_status=skipped
    low_confidence_fallback_chunks: int = 2    # chunks to include when all below min_score
    max_context_chunks: int = 15        # max chunks sent to LLM in a single query

    # ── Conversation history ───────────────────────────────────────────────────
    history_recent_turns: int = 6       # last N turns sent as full messages
    history_summary_chars: int = 120    # chars per turn in the compressed summary block
    history_message_max_chars: int = 500  # max chars per recent turn message

    # ── ML models ─────────────────────────────────────────────────────────────
    embedding_model: str = "intfloat/multilingual-e5-large"
    reranker_model: str = "BAAI/bge-reranker-large"
    reranker_enabled: bool = True
    # Minimo de candidatos de Qdrant para correr el reranker. Si Qdrant
    # devuelve menos, skipear (no aporta calidad rankear 1-4 elementos y
    # gasta ~2s en CPU). Tenants con base chica veran queries mas rapidas;
    # cuando carguen 5+ docs relevantes el reranker se activa solo.
    reranker_min_candidates: int = 5
    nlu_model: str = "urchade/gliner_large-v2.1"
    nlu_enabled: bool = True

    # ── Cache ─────────────────────────────────────────────────────────────────
    cache_ttl_seconds: int = 3600
    semantic_cache_threshold: float = 0.93   # cosine similarity to consider a semantic hit
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

    # ── Rate limiting ─────────────────────────────────────────────────────────
    rate_limit_requests_per_minute: int = 60

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
