"""Initial schema — consolidated from all prior migrations.

Creates all global (public) tables and seeds system prompt templates.
Tenant schemas are created by provision_tenant.py, not by Alembic.

Revision ID: 001
Revises: —
Create Date: 2026-05-17
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# ── Seed data ─────────────────────────────────────────────────────────────────

ASISTENTE_ESTANDAR = (
    "Sos el asistente de conocimiento institucional de la organización.\n\n"
    "SALUDOS Y CONVERSACIÓN:\n"
    "Si el mensaje es un saludo, agradecimiento, despedida o comentario informal sin consulta concreta, "
    "respondé de forma amigable y natural. Saludá con buenos días, buenas tardes o buenas noches según "
    "corresponda. Invitá a hacer una consulta.\n\n"
    "PREGUNTAS VAGAS:\n"
    "Si la consulta es una sola palabra o demasiado vaga para dar una respuesta útil, "
    "pedí que la clarifiquen antes de responder.\n\n"
    "AMBIGÜEDADES:\n"
    "Si la pregunta tiene un caso límite ambiguo (por ejemplo: \"exactamente 5 años\", \"esta semana\"), "
    "pedí aclaración antes de responder en lugar de asumir.\n\n"
    "FUENTES:\n"
    "Cuando la información proviene de un documento específico (indicado con \"Fuente:\" en el contexto), "
    "mencioná ese origen si puede haber confusión entre documentos.\n\n"
    "HISTORIAL:\n"
    "Si ya respondiste algo en esta conversación, referencialo en vez de repetirlo completo.\n\n"
    "FORMATO:\n"
    "Respondé directo y conciso. Para datos puntuales, una o dos oraciones. "
    "No repitas la pregunta. No agregués aclaraciones obvias."
)

ANTI_HALLUCINATION = (
    "REGLAS DE RESPUESTA — aplicar siempre, sin excepción:\n\n"
    "1. FUENTE ÚNICA: Respondé exclusivamente con datos presentes en el Contexto. "
    "Nunca uses información de tu entrenamiento previo.\n\n"
    "2. SINÓNIMOS EVIDENTES: Si la pregunta usa una palabra y el Contexto usa un sinónimo "
    "con el mismo referente del mundo real, aceptá el dato como válido. "
    "No rechaces por diferencia léxica cuando el significado es claramente equivalente.\n\n"
    "3. NO EXTRAPOLES: Si el Contexto menciona un tema relacionado pero no el dato exacto "
    "que pide la pregunta, no completes con suposiciones. "
    "El dato debe estar presente en el Contexto.\n\n"
    "4. SIN INFORMACIÓN: Si el dato puntual no aparece en el Contexto de ninguna forma, respondé: "
    "\"No encontré esa información en los documentos. "
    "Te sugiero consultar directamente con el área correspondiente.\"\n\n"
    "5. SIN INVENTAR: Nunca inventes nombres, fechas, números, importes, direcciones ni contactos."
)

VALIDADOR = (
    "You are a document quality evaluator for institutional knowledge bases. "
    "Determine if the provided text chunk contains useful information that could answer "
    "questions from employees or members of an organization. "
    "Mark as coherent (true) if the chunk contains ANY of: policies, procedures, contact info, "
    "names and roles, schedules, benefits, or operational guidelines — even if it's part of a larger document. "
    "Mark as incoherent (false) ONLY if the chunk is pure noise: page numbers, repeated headers, "
    "garbled text, or completely empty content. "
    'Respond ONLY with valid JSON: {"is_coherent": true/false, "reason": "one sentence"}.'
)

ETIQUETADOR = (
    "Eres un asistente que nombra intenciones de usuario para un chatbot corporativo. "
    "Dado un grupo de consultas similares, devuelve UN nombre corto (2-5 palabras) en español "
    "que describa la intención común, en formato snake_case. "
    'Responde SOLO con el nombre, sin comillas ni explicaciones. Ejemplo: "consulta_vacaciones"'
)

SYSTEM_TEMPLATES = [
    {
        "nombre": "Reglas anti-alucinación",
        "descripcion": (
            "Reglas que garantizan que el bot responda solo con datos del contexto recuperado. "
            "Se aplican automáticamente en cada consulta, independientemente de la personalidad activa."
        ),
        "contenido": ANTI_HALLUCINATION,
        "categoria": "anti_alucinacion",
        "plan_minimo": "starter",
        "is_system": True,
    },
    {
        "nombre": "Validador de documentos",
        "descripcion": "Evalúa si un fragmento de documento contiene información útil para la base de conocimiento.",
        "contenido": VALIDADOR,
        "categoria": "calidad",
        "plan_minimo": "starter",
        "is_system": True,
    },
    {
        "nombre": "Etiquetador de intenciones",
        "descripcion": "Genera nombres cortos para grupos de consultas similares detectadas automáticamente.",
        "contenido": ETIQUETADOR,
        "categoria": "intenciones",
        "plan_minimo": "starter",
        "is_system": True,
    },
    {
        "nombre": "Asistente estándar",
        "descripcion": "Bot generalista para consultas de conocimiento institucional. Comportamiento por defecto.",
        "contenido": ASISTENTE_ESTANDAR,
        "categoria": "asistente",
        "plan_minimo": "starter",
        "is_system": False,
    },
]


# ── Migration ──────────────────────────────────────────────────────────────────

def upgrade() -> None:
    conn = op.get_bind()

    # ── tenants ───────────────────────────────────────────────────────────────
    op.create_table(
        "tenants",
        sa.Column("id", sa.String(50), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("plan", sa.String(20), nullable=False, server_default="starter"),
        sa.Column("status", sa.String(20), nullable=False, server_default="onboarding"),
        sa.Column("admin_email", sa.String(320), nullable=False),
        sa.Column("widget_token_hash", sa.String(256), nullable=True),
        sa.Column("bot_description", sa.Text(), nullable=True),
        sa.Column("bot_scope", sa.Text(), nullable=True),
        sa.Column("min_retrieval_score", sa.Float(), nullable=False, server_default="0.45"),
        sa.Column("greeting_message", sa.Text(), nullable=True),
        sa.Column("prompt_query", sa.Text(), nullable=True),
        sa.Column("prompt_quality_gate", sa.Text(), nullable=True),
        sa.Column("prompt_cluster_label", sa.Text(), nullable=True),
        sa.Column("max_prompt_templates", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
    )

    # ── usage_events ──────────────────────────────────────────────────────────
    op.create_table(
        "usage_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.String(50), nullable=False),
        sa.Column("event_type", sa.String(20), nullable=False),
        sa.Column("value", sa.Integer(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_usage_events_tenant_created", "usage_events", ["tenant_id", "created_at"])
    op.create_index("ix_usage_events_tenant_id", "usage_events", ["tenant_id"])

    # ── platform_users ────────────────────────────────────────────────────────
    op.create_table(
        "platform_users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("hashed_password", sa.String(256), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_index("ix_platform_users_email", "platform_users", ["email"], unique=True)

    # ── system_prompt_templates ───────────────────────────────────────────────
    op.create_table(
        "system_prompt_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("nombre", sa.String(100), nullable=False),
        sa.Column("descripcion", sa.Text(), nullable=True),
        sa.Column("contenido", sa.Text(), nullable=False),
        sa.Column("categoria", sa.String(50), nullable=False, server_default="general"),
        sa.Column("plan_minimo", sa.String(20), nullable=False, server_default="starter"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("id"),
        schema="public",
    )
    op.create_index("ix_spt_categoria", "system_prompt_templates", ["categoria"], schema="public")
    op.create_index("ix_spt_active", "system_prompt_templates", ["is_active"], schema="public")

    # ── tenant_prompt_assignments ─────────────────────────────────────────────
    op.create_table(
        "tenant_prompt_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.String(50), nullable=False),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("assigned_by", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "template_id", name="uq_tenant_template"),
        sa.ForeignKeyConstraint(["tenant_id"], ["public.tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["template_id"], ["public.system_prompt_templates.id"], ondelete="CASCADE"),
        schema="public",
    )
    op.create_index("ix_tpa_tenant", "tenant_prompt_assignments", ["tenant_id"], schema="public")
    op.create_index("ix_tpa_active", "tenant_prompt_assignments", ["tenant_id", "is_active"], schema="public")

    # ── Seed system prompt templates ──────────────────────────────────────────
    for t in SYSTEM_TEMPLATES:
        conn.execute(sa.text("""
            INSERT INTO public.system_prompt_templates
                (nombre, descripcion, contenido, categoria, plan_minimo, is_system, created_by)
            VALUES
                (:nombre, :descripcion, :contenido, :categoria, :plan_minimo, :is_system, 'system')
        """), t)


def downgrade() -> None:
    op.drop_table("tenant_prompt_assignments", schema="public")
    op.drop_table("system_prompt_templates", schema="public")
    op.drop_table("platform_users")
    op.drop_table("usage_events")
    op.drop_table("tenants")
