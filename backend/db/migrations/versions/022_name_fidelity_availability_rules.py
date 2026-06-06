"""Reglas 10 y 11 del template anti-alucinación (genéricas, multi-tenant):

  10. FIDELIDAD DE NOMBRES PROPIOS — copiar nombres (personas/lugares/productos)
      sin alterar letras ni acentos (evita deformar apellidos al reformatear).
  11. DISPONIBILIDAD EN UN DÍA U HORARIO — si el contexto tiene los horarios y el
      día consultado no figura, es un "no", no "falta de información" (evita el
      falso "no encontré" en preguntas de negación por categoría).

Ambas son reglas de comportamiento del bot, sin nada atado a un vertical o tenant.
Idempotentes: solo se agregan si todavía no están (prod pudo recibirlas por hotfix).

Revision ID: 022
Revises: 021
"""

from alembic import op
from sqlalchemy import text

revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None

NOMBRE = "Reglas anti-alucinación"
_MARK10 = "10. FIDELIDAD DE NOMBRES PROPIOS"
_MARK11 = "11. DISPONIBILIDAD EN UN DÍA U HORARIO"
_R10 = (
    "\n\n10. FIDELIDAD DE NOMBRES PROPIOS\n"
    "No alteres las LETRAS de los nombres propios (personas, lugares, productos): no cambies, "
    "agregues ni quites letras ni acentos respecto del Contexto. Sí podés escribirlos con "
    "capitalización normal (mayúscula inicial en cada palabra, el resto en minúscula) en vez de "
    "todo en mayúsculas. Cambiar aunque sea una letra de un apellido es un error grave."
)
_R11 = (
    "\n\n11. DISPONIBILIDAD EN UN DÍA U HORARIO\n"
    "Si preguntan si algo o alguien está disponible en un día u horario específico y el Contexto "
    "tiene los días/horarios de atención, respondé comparando: si el día consultado NO figura entre "
    'los horarios listados, significa que NO atiende ese día (respondé "No, atiende [días reales]"). '
    'Que un día no aparezca en los horarios NO es "falta de información", es un "no". Aplica también '
    "cuando hay varios elementos del mismo tipo: si ninguno cubre ese día, decilo."
)


def upgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(text(
        "SELECT id, contenido FROM public.system_prompt_templates "
        "WHERE nombre = :n AND is_system = TRUE"
    ), {"n": NOMBRE}).fetchone()
    if not row:
        return
    add = ""
    if _MARK10 not in row[1]:
        add += _R10
    if _MARK11 not in row[1]:
        add += _R11
    if add:
        conn.execute(text(
            "UPDATE public.system_prompt_templates SET contenido = contenido || :a, updated_at = NOW() "
            "WHERE id = :id"
        ), {"a": add, "id": row[0]})


def downgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(text(
        "SELECT id, contenido FROM public.system_prompt_templates WHERE nombre = :n AND is_system = TRUE"
    ), {"n": NOMBRE}).fetchone()
    if not row:
        return
    c = row[1]
    for mark in (_MARK10, _MARK11):
        c = c.split("\n\n" + mark)[0] if mark in c else c
    conn.execute(text(
        "UPDATE public.system_prompt_templates SET contenido = :c, updated_at = NOW() WHERE id = :id"
    ), {"c": c, "id": row[0]})
