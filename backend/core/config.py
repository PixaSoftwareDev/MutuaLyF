"""Application settings loaded from environment variables via pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, field_validator


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

    # ── ML models ─────────────────────────────────────────────────────────────
    embedding_model: str = "intfloat/multilingual-e5-large"
    reranker_model: str = "BAAI/bge-reranker-large"
    nlu_model: str = "urchade/gliner_large-v2.1"

    # ── Cache ─────────────────────────────────────────────────────────────────
    cache_ttl_seconds: int = 3600

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

    # ── SSO / OAuth 2.0 ───────────────────────────────────────────────────────
    # Google Workspace
    google_client_id: str = ""
    google_client_secret: str = ""

    # Microsoft Azure AD
    azure_client_id: str = ""
    azure_client_secret: str = ""
    azure_tenant_id: str = "common"  # 'common' = any Azure AD tenant

    # Public base URL — used to build OAuth redirect_uri
    # In dev: http://localhost:8000 | In prod: https://api.tudominio.com
    public_api_url: str = "http://localhost:8000"

    # Frontend URL — where the backend redirects after successful SSO
    public_frontend_url: str = "http://localhost:3000"

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def azure_enabled(self) -> bool:
        return bool(self.azure_client_id and self.azure_client_secret)

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
