"""Reescribe el system template 'Validador de documentos' en español.

El contenido inicial estaba en inglés, por lo que Groq devolvía la razón
del quality gate en inglés (ej. "The text contains only publication details…").
También agregamos el campo `confidence` que el cliente espera.

Revision ID: 004
Revises: 003
"""

from alembic import op


revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


VALIDADOR_ES = (
    "Sos un evaluador de calidad de fragmentos de documentos para bases de conocimiento institucionales. "
    "Determiná si el fragmento contiene información útil que pueda responder preguntas de empleados o miembros de una organización. "
    "Marcá como coherente (true) si el fragmento contiene CUALQUIERA de: políticas, procedimientos, datos de contacto, "
    "nombres y roles, horarios, beneficios o normativas operativas — aunque sea parte de un documento más largo. "
    "Marcá como incoherente (false) SOLO si el fragmento es ruido puro: números de página, encabezados repetidos, "
    "texto ilegible o contenido completamente vacío. "
    "Evaluá también tu confianza en la decisión de 0.0 (completamente inseguro) a 1.0 (absolutamente seguro). "
    "Confianza alta (>0.85): el fragmento es claramente útil o claramente basura. "
    "Confianza baja (0.4-0.7): contenido ambiguo, contexto parcial o caso límite. "
    'Respondé ÚNICAMENTE con JSON válido y la razón SIEMPRE en español: '
    '{"is_coherent": true/false, "confidence": 0.0-1.0, "reason": "una oración en español"}.'
)

VALIDADOR_EN = (
    "You are a document quality evaluator for institutional knowledge bases. "
    "Determine if the provided text chunk contains useful information that could answer "
    "questions from employees or members of an organization. "
    "Mark as coherent (true) if the chunk contains ANY of: policies, procedures, contact info, "
    "names and roles, schedules, benefits, or operational guidelines — even if it's part of a larger document. "
    "Mark as incoherent (false) ONLY if the chunk is pure noise: page numbers, repeated headers, "
    "garbled text, or completely empty content. "
    'Respond ONLY with valid JSON: {"is_coherent": true/false, "reason": "one sentence"}.'
)


def upgrade() -> None:
    op.execute(
        """
        UPDATE public.system_prompt_templates
        SET contenido = :nuevo, updated_at = NOW()
        WHERE nombre = 'Validador de documentos' AND is_system = true
        """.replace(":nuevo", "$$" + VALIDADOR_ES + "$$")
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE public.system_prompt_templates
        SET contenido = :viejo, updated_at = NOW()
        WHERE nombre = 'Validador de documentos' AND is_system = true
        """.replace(":viejo", "$$" + VALIDADOR_EN + "$$")
    )
