"""Envío de emails vía SMTP — genérico, no atado a un proveedor.

Funciona con cualquier servidor SMTP (Resend, SendGrid, Gmail, SES…) configurando
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_FROM en el entorno.
Para Resend: SMTP_HOST=smtp.resend.com, SMTP_USER=resend, SMTP_PASSWORD=<API key>.

smtplib es bloqueante, así que el envío corre en un threadpool para no frenar el
event loop de FastAPI. No lanza excepciones hacia arriba: loguea y devuelve bool,
para que un fallo de correo no rompa el flujo que lo invoca.
"""

import asyncio
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import parseaddr

from core.config import settings

logger = logging.getLogger(__name__)


def _send_sync(to_email: str, subject: str, html_body: str, text_body: str) -> bool:
    if not settings.smtp_host:
        logger.warning("smtp_not_configured email_skipped to=%s subject=%r", to_email, subject)
        return False

    # El header From admite "Nombre <dir@dominio>", pero el envelope sender (MAIL FROM)
    # debe ser SOLO la dirección — varios SMTP (Resend incluido) rechazan el display name ahí.
    envelope_from = parseaddr(settings.email_from)[1] or settings.email_from

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = settings.email_from
    msg["To"] = to_email
    if text_body:
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
        server.starttls()
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password)
        server.sendmail(envelope_from, [to_email], msg.as_string())
    logger.info("email_sent to=%s subject=%r", to_email, subject)
    return True


async def send_email(to_email: str, subject: str, html_body: str, text_body: str = "") -> bool:
    """Envía un email sin bloquear el event loop. Devuelve True si se envió."""
    try:
        return await asyncio.to_thread(_send_sync, to_email, subject, html_body, text_body)
    except Exception as exc:
        logger.warning("send_email_failed to=%s subject=%r error=%s", to_email, subject, exc)
        return False
