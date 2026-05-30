-- Per-tenant schema template.
-- Executed by provision_tenant.py after CREATE SCHEMA tenant_{id}.
-- :schema placeholder is replaced by the provisioning script.

SET search_path TO :schema;

-- Users within this tenant
CREATE TABLE IF NOT EXISTS usuarios (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(320) NOT NULL UNIQUE,
    name            VARCHAR(200) NOT NULL,
    hashed_password VARCHAR(256) NOT NULL,
    role            VARCHAR(20)  NOT NULL DEFAULT 'operator',
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Documents ingested by this tenant
CREATE TABLE IF NOT EXISTS documentos (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title               VARCHAR(500) NOT NULL,
    filename            VARCHAR(500) NOT NULL,
    mime_type           VARCHAR(100) NOT NULL,
    size_bytes          INTEGER      NOT NULL,
    status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
    chunk_count         INTEGER      NOT NULL DEFAULT 0,
    quality_gate_status VARCHAR(20)  NOT NULL DEFAULT 'pending',
    uploaded_by         UUID         NOT NULL,
    content_hash_bytes  VARCHAR(64),
    content_hash_text   VARCHAR(64),
    storage_key         VARCHAR(1000),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique constraint on hash_bytes enables ON CONFLICT ON CONSTRAINT uq_doc_hash_bytes in ingest.py
-- NULLs are allowed (documents without hash are legacy/failed extractions)
ALTER TABLE documentos ADD CONSTRAINT uq_doc_hash_bytes UNIQUE (content_hash_bytes);
CREATE UNIQUE INDEX IF NOT EXISTS ix_documentos_hash_text ON documentos (content_hash_text) WHERE content_hash_text IS NOT NULL;

-- Query audit log: used for intent classification, HDBSCAN clustering, billing
CREATE TABLE IF NOT EXISTS consultas_log (
    id                   UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID,
    question_hash        VARCHAR(64)  NOT NULL,  -- SHA-256 of original question
    question_text        VARCHAR(500),            -- Truncated text for HDBSCAN clustering
    intent_label         VARCHAR(200),
    intent_confidence    FLOAT,
    cluster_candidate_id VARCHAR(100),
    cluster_status       VARCHAR(20)  NOT NULL DEFAULT 'unassigned',
    auto_learning_blocked BOOLEAN     NOT NULL DEFAULT FALSE,
    quality_gate_status  VARCHAR(20)  NOT NULL DEFAULT 'pending',
    latency_ms           INTEGER      NOT NULL,
    from_cache           BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_consultas_log_cluster_created ON consultas_log (cluster_status, created_at);
CREATE INDEX IF NOT EXISTS ix_consultas_log_created ON consultas_log (created_at);

-- Validated intentions discovered from user queries
CREATE TABLE IF NOT EXISTS intenciones (
    id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    label               VARCHAR(200) NOT NULL UNIQUE,
    description         TEXT,
    example_count       INTEGER      NOT NULL DEFAULT 0,
    auto_learned_count  INTEGER      NOT NULL DEFAULT 0,
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    model_version       VARCHAR(50),            -- current active Qdrant version_id
    prev_model_version  VARCHAR(50),            -- previous version for rollback
    last_accuracy       FLOAT,                  -- accuracy on last evaluation
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Intention examples (labeled queries used for classification training)
CREATE TABLE IF NOT EXISTS intencion_ejemplos (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    intencion_id    UUID    NOT NULL REFERENCES intenciones(id) ON DELETE CASCADE,
    question_hash   VARCHAR(64) NOT NULL,
    question_text   VARCHAR(500),           -- stored for retraining without consultas_log join
    version_id      VARCHAR(50),            -- training run that introduced this example
    is_auto_learned BOOLEAN     NOT NULL DEFAULT FALSE,
    is_approved     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_intencion_ejemplos_intencion ON intencion_ejemplos (intencion_id);

-- ── Operator panel ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sectores (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sectores (nombre, descripcion, is_default) VALUES
    ('Consultas Generales', 'Sector por defecto para consultas sin asignación específica', TRUE)
ON CONFLICT (nombre) DO NOTHING;

CREATE TABLE IF NOT EXISTS operador_sectores (
    operador_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    sector_id   UUID NOT NULL REFERENCES sectores(id) ON DELETE CASCADE,
    PRIMARY KEY (operador_id, sector_id)
);

CREATE TABLE IF NOT EXISTS conversaciones (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    widget_session_id       VARCHAR(100) NOT NULL,
    sector_id               UUID REFERENCES sectores(id),
    status                  VARCHAR(30) NOT NULL DEFAULT 'bot_active',
    assigned_operator_id    UUID REFERENCES usuarios(id),
    afiliado_nombre         VARCHAR(200),
    afiliado_email          VARCHAR(320),
    afiliado_dni            VARCHAR(20),
    afiliado_ip             VARCHAR(45),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_conversaciones_session ON conversaciones (widget_session_id);
CREATE INDEX IF NOT EXISTS ix_conversaciones_status  ON conversaciones (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_conversaciones_sector  ON conversaciones (sector_id, status);

CREATE TABLE IF NOT EXISTS mensajes (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID NOT NULL REFERENCES conversaciones(id) ON DELETE CASCADE,
    sender_type      VARCHAR(20) NOT NULL,
    content          TEXT NOT NULL,
    is_handoff_offer BOOLEAN NOT NULL DEFAULT FALSE,
    read_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mensajes_conversation ON mensajes (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS handoff_config (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inactivity_timeout_minutes      INTEGER NOT NULL DEFAULT 15,
    consecutive_insufficient_count  INTEGER NOT NULL DEFAULT 3,
    transition_messages             JSONB NOT NULL DEFAULT '{"handoff_offer":"Veo que tengo dificultades para resolver tu consulta. ¿Querés que te conecte con un operador?","handoff_confirmed":"Listo, tu solicitud fue recibida. Un operador te atenderá en breve.","operator_inactive_alert":"Todavía estás en cola. Un operador te atenderá a la brevedad."}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO handoff_config DEFAULT VALUES ON CONFLICT DO NOTHING;

-- ── Parent chunks (Small-to-Big RAG) ─────────────────────────────────────────
-- Children (150 tokens) live in Qdrant for precise semantic search.
-- Parents (up to 700 tokens, respecting structural boundaries) live here and
-- are fetched at query time to give the LLM full context.
-- ts_body enables BM25 keyword search (exact numbers, names, codes) at zero
-- extra LLM cost, complementing semantic search from Qdrant.
CREATE TABLE IF NOT EXISTS parent_chunks (
    id          TEXT        PRIMARY KEY,
    document_id UUID        NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
    text        TEXT        NOT NULL,
    chunk_index INTEGER     NOT NULL,
    token_count INTEGER     NOT NULL,
    metadata    JSONB       NOT NULL DEFAULT '{}',
    ts_body     tsvector    GENERATED ALWAYS AS (to_tsvector('spanish', text)) STORED,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_parent_chunks_doc ON parent_chunks (document_id);
CREATE INDEX IF NOT EXISTS ix_parent_chunks_fts ON parent_chunks USING GIN (ts_body);

-- ── Duplicate detection ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chunk_duplicate_pairs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id_a   VARCHAR(100) NOT NULL,
    chunk_id_b   VARCHAR(100) NOT NULL,
    doc_id_a     UUID NOT NULL,
    doc_id_b     UUID NOT NULL,
    text_a       TEXT NOT NULL,
    text_b       TEXT NOT NULL,
    jaccard_score FLOAT,
    cosine_score  FLOAT,
    status       VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, keep_a, keep_b, keep_both
    resolved_by  UUID,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_chunk_dup_pair ON chunk_duplicate_pairs (LEAST(chunk_id_a, chunk_id_b), GREATEST(chunk_id_a, chunk_id_b));
CREATE INDEX IF NOT EXISTS ix_chunk_dup_status ON chunk_duplicate_pairs (status, created_at);


-- ── Audit log ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    TEXT        NOT NULL,
    actor_email TEXT,
    actor_role  TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    resource    TEXT,
    detail      JSONB,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_action  ON audit_log (action);
