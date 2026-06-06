"""Adjuntos en mensajes de conversación (handoff): afiliado y operador pueden
enviar archivos (imágenes/PDF) que se ven, descargan y persisten.

Agrega columnas de adjunto a la tabla `mensajes` de cada schema tenant. Un mensaje
puede tener texto, un adjunto, o ambos. El archivo vive en MinIO; acá guardamos
solo la referencia (key) y metadatos para mostrarlo/descargarlo.

Revision ID: 021
Revises: 020
"""

from alembic import op
from sqlalchemy import text

revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None

_COLS = [
    ("attachment_key", "TEXT"),       # key del objeto en MinIO (None = mensaje sin adjunto)
    ("attachment_name", "TEXT"),      # nombre original del archivo (para mostrar/descargar)
    ("attachment_mime", "TEXT"),      # content-type (image/png, application/pdf, ...)
    ("attachment_size", "INTEGER"),   # bytes
]


def _tenant_schemas(conn) -> list[str]:
    result = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE :pat ESCAPE '\\'"
    ), {"pat": r"tenant\_%"})
    return [r[0] for r in result.fetchall()]


def upgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        for col, typ in _COLS:
            conn.execute(text(
                f'ALTER TABLE "{schema}".mensajes ADD COLUMN IF NOT EXISTS {col} {typ}'
            ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        for col, _typ in _COLS:
            conn.execute(text(
                f'ALTER TABLE "{schema}".mensajes DROP COLUMN IF EXISTS {col}'
            ))
