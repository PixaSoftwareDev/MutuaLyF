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
    role            VARCHAR(20)  NOT NULL DEFAULT 'user',
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
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Query audit log: used for intent classification, HDBSCAN clustering, billing
CREATE TABLE IF NOT EXISTS consultas_log (
    id                   UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID,
    question_hash        VARCHAR(64)  NOT NULL,  -- SHA-256 of original question
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
    id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    label             VARCHAR(200) NOT NULL UNIQUE,
    description       TEXT,
    example_count     INTEGER      NOT NULL DEFAULT 0,
    auto_learned_count INTEGER     NOT NULL DEFAULT 0,
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    model_version     VARCHAR(50),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Intention examples (labeled queries used for classification training)
CREATE TABLE IF NOT EXISTS intencion_ejemplos (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    intencion_id    UUID    NOT NULL REFERENCES intenciones(id) ON DELETE CASCADE,
    question_hash   VARCHAR(64) NOT NULL,
    is_auto_learned BOOLEAN     NOT NULL DEFAULT FALSE,
    is_approved     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_intencion_ejemplos_intencion ON intencion_ejemplos (intencion_id);
