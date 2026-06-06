"""Agrega la Regla 9 (desambiguación por nombre) al template anti-alucinación.

Si el usuario menciona un nombre/apellido que coincide con VARIAS entidades
distintas en el contexto (p. ej. dos profesionales con el mismo apellido y
distinta especialidad, o dos productos con el mismo nombre), el bot debe
presentar TODAS las coincidencias distinguidas en vez de elegir una sola o
mezclar sus datos. Regla genérica — sirve para cualquier tenant/vertical.

Idempotente: solo agrega la regla si todavía no está presente (la DB de
producción pudo recibirla antes vía hotfix; esta migración no la duplica).

Revision ID: 020
Revises: 019
"""

from alembic import op
from sqlalchemy import text

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None

_MARKER = "9. AMBIGÜEDAD POR NOMBRE O REFERENCIA"
_REGLA9 = """

9. AMBIGÜEDAD POR NOMBRE O REFERENCIA
Si el usuario menciona un nombre, apellido o referencia y el Contexto contiene VARIAS entidades distintas que coinciden con esa mención (por ejemplo dos personas con el mismo apellido pero distinto rol o especialidad, o dos elementos con el mismo nombre), NO elijas una sola ni mezcles sus datos. Presentá TODAS las coincidencias por separado, distinguiéndolas claramente por su atributo diferenciador (especialidad, rol, categoría, etc.), para que el usuario identifique cuál necesita."""


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        text(
            "UPDATE public.system_prompt_templates "
            "SET contenido = contenido || :r, updated_at = NOW() "
            "WHERE nombre = 'Reglas anti-alucinación' AND is_system = TRUE "
            "AND contenido NOT LIKE :marker"
        ),
        {"r": _REGLA9, "marker": f"%{_MARKER}%"},
    )


def downgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(
        text(
            "SELECT id, contenido FROM public.system_prompt_templates "
            "WHERE nombre = 'Reglas anti-alucinación' AND is_system = TRUE"
        )
    ).fetchone()
    if row and _MARKER in row[1]:
        new_contenido = row[1].split("\n\n" + _MARKER)[0]
        conn.execute(
            text(
                "UPDATE public.system_prompt_templates "
                "SET contenido = :c, updated_at = NOW() WHERE id = :id"
            ),
            {"c": new_contenido, "id": row[0]},
        )
