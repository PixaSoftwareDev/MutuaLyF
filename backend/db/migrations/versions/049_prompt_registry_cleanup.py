"""Limpieza de system_prompt_templates: el código pasa a ser la fuente de verdad.

Decisión 2026-07-28 (services/prompt_registry.py): cada prompt del sistema vive
en el código, versionado por git, con UNA sola copia. La DB queda como capa de
overrides opcional — una fila activa cuyo nombre coincide con el db_name del
registro pisa al default; sin fila, rige el código. Esta migración elimina las
filas de sistema que ahora son copias redundantes del código o directamente
cadáveres:

  - "Etiquetador de intenciones": el subsistema de intenciones se eliminó
    (decisión 2026-07-21) — nadie la lee.
  - "Reglas anti-alucinación": reemplazada por los módulos del prompt_builder
    (migración 045) — nadie la lee.
  - "Validador de documentos": su texto curado se movió al registro
    (quality_gate) — el gate lee del código; override por tenant vía config.
  - "Grounding documental" + "Casos límite: nombres/horarios/URLs": seedeadas
    idénticas al código en la 045 — como override que no difiere del default
    son solo una copia más que mantener. Si el super-admin quiere pisar un
    módulo, crea una fila activa con ese mismo nombre.

Las PERSONALIDADES (is_system=FALSE) no se tocan: son contenido por tenant.

Sin downgrade automático: los textos siguen en el registro y en las migraciones
006/045 si hiciera falta restaurar a mano.

Revision ID: 049
Revises: 048
"""

from alembic import op
from sqlalchemy import text

revision = "049"
down_revision = "048"
branch_labels = None
depends_on = None

NOMBRES = [
    "Etiquetador de intenciones",
    "Reglas anti-alucinación",
    "Validador de documentos",
    "Grounding documental",
    "Casos límite: nombres",
    "Casos límite: horarios",
    "Casos límite: URLs",
]


def upgrade() -> None:
    conn = op.get_bind()
    # Las asignaciones por tenant (inactivas, herencia del auto-assign viejo)
    # referencian estas filas — van primero.
    conn.execute(text("""
        DELETE FROM public.tenant_prompt_assignments
        WHERE template_id IN (
            SELECT id FROM public.system_prompt_templates
            WHERE nombre = ANY(:nombres) AND is_system = TRUE
        )
    """), {"nombres": NOMBRES})
    conn.execute(text("""
        DELETE FROM public.system_prompt_templates
        WHERE nombre = ANY(:nombres) AND is_system = TRUE
    """), {"nombres": NOMBRES})


def downgrade() -> None:
    pass
