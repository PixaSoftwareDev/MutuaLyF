"""El citado de fuentes es política de TONO, no de grounding.

Auditoría de prompts 2026-07-28: la regla 8 del grounding ("mencioná el origen
si puede haber confusión") chocaba con la personalidad profesional ("CITAS DE
FUENTE — OBLIGATORIO en cada dato"): dos políticas de citado activas a la vez,
el mismo patrón de pisada que causó el bug de alcance. Decisión: el grounding
pierde la regla (hecho en prompt_registry, código) y cada personalidad define
la suya. La profesional ya la tiene; esta migración se la devuelve a la
estándar (la 045 se la había quitado creyéndola duplicada del grounding).
La cordial no cita por diseño (tono llano).

Revision ID: 047
Revises: 046
"""

from alembic import op
from sqlalchemy import text

revision = "047"
down_revision = "046"
branch_labels = None
depends_on = None

ESTANDAR = (
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


def upgrade() -> None:
    op.get_bind().execute(text("""
        UPDATE public.system_prompt_templates
        SET contenido = :contenido, updated_at = NOW()
        WHERE nombre = 'Asistente estándar' AND is_system = FALSE
    """), {"contenido": ESTANDAR})


def downgrade() -> None:
    pass  # el texto previo está en la migración 045
