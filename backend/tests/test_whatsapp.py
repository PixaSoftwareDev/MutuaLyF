"""Tests del canal WhatsApp: firma HMAC del webhook + normalización de número.

Superficie pública (el webhook no tiene auth de plataforma, Meta llama directo)
que maneja PII y gasta el token del tenant. La firma HMAC es la barrera
anti-spoofing; el normalizador decide a qué número real se entrega la respuesta.
"""

import hashlib
import hmac

from services.whatsapp import verify_signature, _normalize_recipient


class TestVerifySignature:
    SECRET = "app_secret_de_prueba"

    def _sign(self, secret: str, payload: bytes) -> str:
        return "sha256=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()

    def test_valid_signature_passes(self):
        payload = b'{"entry":[{"id":"123"}]}'
        assert verify_signature(self.SECRET, payload, self._sign(self.SECRET, payload)) is True

    def test_wrong_secret_fails(self):
        payload = b'{"entry":[]}'
        # Firmado con otro secret → no debe validar contra SECRET
        assert verify_signature(self.SECRET, payload, self._sign("otro_secret", payload)) is False

    def test_tampered_payload_fails(self):
        payload = b'{"entry":[{"id":"123"}]}'
        sig = self._sign(self.SECRET, payload)
        # Mismo header, body alterado → firma no coincide
        assert verify_signature(self.SECRET, b'{"entry":[{"id":"999"}]}', sig) is False

    def test_missing_header_fails(self):
        assert verify_signature(self.SECRET, b"x", None) is False

    def test_header_without_sha256_prefix_fails(self):
        payload = b"x"
        raw = hmac.new(self.SECRET.encode(), payload, hashlib.sha256).hexdigest()
        assert verify_signature(self.SECRET, payload, raw) is False  # falta "sha256="


class TestNormalizeRecipient:
    def test_argentina_mobile_strips_the_9(self):
        # 549 + 10 dígitos = 13 → Meta espera el número SIN el 9
        assert _normalize_recipient("5493425123456") == "543425123456"

    def test_argentina_without_9_untouched(self):
        assert _normalize_recipient("543425123456") == "543425123456"

    def test_plus_prefix_stripped(self):
        assert _normalize_recipient("+5493425123456") == "543425123456"

    def test_non_argentina_untouched(self):
        # Brasil (5511...) no se toca
        assert _normalize_recipient("5511987654321") == "5511987654321"

    def test_549_but_wrong_length_untouched(self):
        # Empieza con 549 pero no son 13 dígitos → no aplica la regla AR
        assert _normalize_recipient("549123") == "549123"
