"""Regla 12 del template anti-alucinación: URLS Y ENLACES.

Incidente en producción (2026-07-22): ante "cómo saco turno" el bot respondió con
https://www.mimutualyf.com.ar — dominio INVENTADO a partir del nombre del portal
("Mi MutuaLyF Web"). La URL real (https://www.luzyfuerza.org.ar/mi-mutualyf/) está
en la base de conocimiento, pero el chunk recuperado en esa conversación no la
incluía y el modelo la fabricó. Un enlace inventado es la peor alucinación posible
para este caso de uso: si alguien registra ese dominio, el bot deriva afiliados a
un sitio de terceros (phishing).

Regla genérica, multi-tenant, sin nada atado a un vertical. Idempotente: solo se
agrega si todavía no está (prod puede recibirla antes por hotfix).

Revision ID: 038
Revises: 037
"""

from alembic import op
from sqlalchemy import text

revision = "038"
down_revision = "037"
branch_labels = None
depends_on = None

NOMBRE = "Reglas anti-alucinación"
_MARK12 = "12. URLS Y ENLACES"
_R12 = (
    "\n\n12. URLS Y ENLACES\n"
    "Nunca escribas una URL, dirección web o enlace que no aparezca TEXTUALMENTE en el "
    "Contexto o en un mensaje anterior tuyo de esta conversación. No construyas ni deduzcas "
    "direcciones a partir del nombre de un sitio, portal o aplicación (que el portal se llame "
    '"Mi Ejemplo Web" NO significa que exista www.miejemplo.com.ar). Un enlace inventado '
    "puede llevar a la gente a un sitio falso: es un error tan grave como inventar un teléfono "
    "o una dirección. Si piden un enlace que no está en el Contexto, decí que no tenés el "
    "enlace exacto y ofrecé la vía que sí figure (sitio oficial, teléfono o área de contacto)."
)


def upgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(text(
        "SELECT id, contenido FROM public.system_prompt_templates "
        "WHERE nombre = :n AND is_system = TRUE"
    ), {"n": NOMBRE}).fetchone()
    if not row:
        return
    if _MARK12 not in row[1]:
        conn.execute(text(
            "UPDATE public.system_prompt_templates SET contenido = contenido || :a, updated_at = NOW() "
            "WHERE id = :id"
        ), {"a": _R12, "id": row[0]})


def downgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(text(
        "SELECT id, contenido FROM public.system_prompt_templates WHERE nombre = :n AND is_system = TRUE"
    ), {"n": NOMBRE}).fetchone()
    if not row:
        return
    if _MARK12 in row[1]:
        conn.execute(text(
            "UPDATE public.system_prompt_templates SET contenido = :c, updated_at = NOW() WHERE id = :id"
        ), {"c": row[1].split("\n\n" + _MARK12)[0], "id": row[0]})
