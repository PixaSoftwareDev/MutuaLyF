"""Regla 13 del template anti-alucinación: ESTADO DEL SISTEMA Y OPERADORES.

Incidente en producción (2026-07-27): ante "¿Seguro que no hay?" el bot
respondió "No, no hay operadores humanos disponibles por este medio" — leyó
un aviso de sistema previo del historial y lo AFIRMÓ como verdad vigente,
30 segundos antes de que la derivación real demostrara lo contrario (el
operador estaba conectado; su presencia había parpadeado).

El LLM no tiene forma de conocer el estado de runtime (quién está conectado,
la fila, si un aviso sigue vigente). Regla genérica multi-tenant: nunca
afirmarlo; invitar a la derivación, que es el mecanismo que SÍ sabe.

Idempotente (aplica solo si la regla no está). Mismo patrón que la 038.

Revision ID: 046
Revises: 045
"""

from alembic import op
from sqlalchemy import text

revision = "046"
down_revision = "045"
branch_labels = None
depends_on = None

NOMBRE = "Reglas anti-alucinación"
_MARK13 = "13. ESTADO DEL SISTEMA Y OPERADORES"
_R13 = (
    "\n\n13. ESTADO DEL SISTEMA Y OPERADORES\n"
    "Nunca afirmes por tu cuenta si hay o no operadores/personas disponibles, ni el estado "
    "de la fila de atención, ni si un aviso anterior del sistema sigue vigente: esa "
    "información cambia en tiempo real y vos no la conocés. Los avisos de sistema que veas "
    "en el historial describen un momento pasado, no el presente. Si preguntan por hablar "
    "con una persona o si hay alguien disponible, respondé que podés derivar la consulta a "
    "un operador y que el sistema la pondrá en la fila de atención — la disponibilidad la "
    "resuelve el sistema, no vos."
)


def upgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(text(
        "SELECT id, contenido FROM public.system_prompt_templates "
        "WHERE nombre = :n AND is_system = TRUE"
    ), {"n": NOMBRE}).fetchone()
    if not row:
        return
    if _MARK13 not in row[1]:
        conn.execute(text(
            "UPDATE public.system_prompt_templates SET contenido = contenido || :a, updated_at = NOW() "
            "WHERE id = :id"
        ), {"a": _R13, "id": row[0]})


def downgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(text(
        "SELECT id, contenido FROM public.system_prompt_templates WHERE nombre = :n AND is_system = TRUE"
    ), {"n": NOMBRE}).fetchone()
    if not row:
        return
    if _MARK13 in row[1]:
        conn.execute(text(
            "UPDATE public.system_prompt_templates SET contenido = :c, updated_at = NOW() WHERE id = :id"
        ), {"c": row[1].split("\n\n" + _MARK13)[0], "id": row[0]})
