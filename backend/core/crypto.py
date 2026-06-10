"""Cifrado simétrico para secretos de canales (tokens de WhatsApp, app secrets).

Los tokens de la Cloud API de Meta son credenciales de larga duración que NO
pueden guardarse en texto plano en la base. Se cifran con Fernet (AES-128-CBC
+ HMAC, de `cryptography`, que ya viene via python-jose[cryptography]).

Clave: env CHANNEL_ENCRYPTION_KEY (Fernet key urlsafe-base64 de 32 bytes) o,
si no está seteada, se deriva determinísticamente del JWT_SECRET_KEY. La
derivación permite arrancar sin config extra; para producción conviene fijar
CHANNEL_ENCRYPTION_KEY propia (rotar JWT_SECRET_KEY no invalida así los
secretos guardados).
"""

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

from core.config import settings

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        explicit = os.getenv("CHANNEL_ENCRYPTION_KEY", "").strip()
        if explicit:
            key = explicit.encode()
        else:
            digest = hashlib.sha256(f"channel-secrets:{settings.jwt_secret_key}".encode()).digest()
            key = base64.urlsafe_b64encode(digest)
        _fernet = Fernet(key)
    return _fernet


def encrypt_secret(plaintext: str) -> str:
    """Cifra un secreto. Devuelve string urlsafe apto para columna TEXT."""
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    """Descifra un secreto guardado. Lanza ValueError si la clave no coincide
    (p.ej. cambió JWT_SECRET_KEY sin fijar CHANNEL_ENCRYPTION_KEY)."""
    try:
        return _get_fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise ValueError(
            "No se pudo descifrar el secreto del canal — ¿cambió CHANNEL_ENCRYPTION_KEY/JWT_SECRET_KEY?"
        ) from exc
