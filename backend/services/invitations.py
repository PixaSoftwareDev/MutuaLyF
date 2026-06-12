"""Invitación por email al dar de alta un usuario (operador o admin).

En vez de que quien crea la cuenta tipee y comparta la contraseña, el sistema
envía un mail "te crearon una cuenta — definí tu contraseña" con un enlace
tokenizado. Reusa la infraestructura del reset de contraseña: misma tabla
`password_reset_tokens` (token de un solo uso, hasheado) y la misma página
`/reset-password` del frontend (con `welcome=1` muestra textos de bienvenida).

Beneficios: el email queda verificado implícitamente (si está mal escrito, la
invitación nunca llega y se detecta al instante) y nadie más que el usuario
conoce su contraseña.

El envío es no-fatal: si el SMTP falla, la cuenta queda creada igual y el
admin puede pedir un "olvidé mi contraseña" o definirla manualmente.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

logger = logging.getLogger(__name__)

# Las invitaciones duran más que un reset (1h): la persona puede no mirar el
# correo hasta el día siguiente.
INVITATION_TTL_HOURS = 72


def _invitation_email_body(name: str, org_name: str, link: str) -> tuple[str, str]:
    """(html, texto) del email de invitación."""
    greeting = f"Hola {name}," if name else "Hola,"
    org = org_name or "la plataforma"
    text_body = (
        f"{greeting}\n\n"
        f"Te crearon una cuenta en {org}.\n"
        f"Entrá a este enlace para definir tu contraseña (válido por {INVITATION_TTL_HOURS} horas):\n{link}\n\n"
        "Después vas a poder ingresar con tu email y la contraseña que elijas.\n"
    )
    html_body = f"""<!DOCTYPE html><html lang="es"><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 12px;font-size:16px;color:#0f172a;font-weight:600;">{greeting}</p>
          <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
            Te crearon una cuenta en <strong>{org}</strong>. Hacé clic en el botón para definir tu contraseña.
            El enlace vence en <strong>{INVITATION_TTL_HOURS} horas</strong>.
          </p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="{link}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:10px;">Definir mi contraseña</a>
          </p>
          <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;line-height:1.5;">
            Si el botón no funciona, copiá y pegá este enlace en tu navegador:
          </p>
          <p style="margin:0 0 20px;font-size:12px;word-break:break-all;"><a href="{link}" style="color:#475569;">{link}</a></p>
          <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;border-top:1px solid #e2e8f0;padding-top:16px;">
            Si no esperabas este correo, podés ignorarlo.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
    return html_body, text_body


async def send_account_invitation(tenant_id: str, user_id: str, email: str, name: str) -> bool:
    """Genera el token de invitación y envía el email. Devuelve True si se envió.

    No lanza: cualquier fallo se loguea y devuelve False — el alta del usuario
    nunca debe fallar por un problema de email.
    """
    from core.config import settings
    from core.database import get_pg_session
    from core.email import send_email

    try:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires = datetime.now(timezone.utc) + timedelta(hours=INVITATION_TTL_HOURS)

        async with get_pg_session(None) as session:
            await session.execute(text("""
                INSERT INTO password_reset_tokens (token_hash, tenant_id, user_id, email, expires_at)
                VALUES (:h, :tid, :uid, :email, :exp)
            """), {"h": token_hash, "tid": tenant_id, "uid": user_id, "email": email, "exp": expires})

            org_row = await session.execute(
                text("SELECT display_name FROM tenants WHERE id = :tid"), {"tid": tenant_id})
            org = org_row.scalar_one_or_none() or tenant_id

        base = (settings.app_base_url or "").rstrip("/")
        link = f"{base}/reset-password?token={token}&welcome=1"
        html, txt = _invitation_email_body(name, str(org), link)
        sent = await send_email(email, f"Te crearon una cuenta en {org}", html, txt)
        if not sent:
            logger.warning("invitation_email_not_sent tenant=%s user=%s", tenant_id, user_id)
        return bool(sent)
    except Exception as exc:
        logger.warning("invitation_failed tenant=%s user=%s error=%s", tenant_id, user_id, exc)
        return False
