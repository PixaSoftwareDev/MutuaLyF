"""Canal "Chat por link" (2026-09-24): validación del canal en la apertura de
conversación y del parámetro del endpoint público de tokens.

Sin DB: se prueban los contratos (pydantic / firma del endpoint). El circuito
completo (flag por canal → 403, channel persistido) se verifica en dev-local
con el script de la sesión y en staging antes de prod.
"""

import pytest
from pydantic import ValidationError

from api.v1.widget_conversation import StartConversationRequest
from api.v1.operator_panel import _CHAT_CHANNEL_FLAGS


class TestStartConversationChannel:
    def test_default_channel_is_widget(self):
        body = StartConversationRequest(widget_session_id="cs_1")
        assert body.channel == "widget"

    def test_link_channel_accepted(self):
        body = StartConversationRequest(widget_session_id="cs_1", channel="link")
        assert body.channel == "link"

    def test_unknown_channel_rejected(self):
        """La columna es texto libre: solo aceptamos valores conocidos para no
        ensuciar filtros/métricas ('whatsapp' no entra por acá)."""
        with pytest.raises(ValidationError):
            StartConversationRequest(widget_session_id="cs_1", channel="whatsapp")
        with pytest.raises(ValidationError):
            StartConversationRequest(widget_session_id="cs_1", channel="telegram")

    def test_body_is_test_is_ignored(self):
        """Compat: el campo sigue existiendo pero la marca real sale del token."""
        body = StartConversationRequest(widget_session_id="cs_1", is_test=True)
        assert body.is_test is True  # se parsea…
        # …pero el handler usa widget_user.is_test (ver test_security TestChatTesterToken)


class TestChannelFlags:
    def test_each_channel_has_its_own_switch(self):
        assert _CHAT_CHANNEL_FLAGS == {"widget": "widget_enabled", "link": "chat_link_enabled"}


class TestConversationIdValidation:
    def test_non_uuid_conversation_id_is_404_not_500(self):
        from fastapi import HTTPException
        from api.v1.widget_conversation import _assert_uuid
        for bad in ("abc", "", "123", "null"):
            with pytest.raises(HTTPException) as exc:
                _assert_uuid(bad)
            assert exc.value.status_code == 404

    def test_valid_uuid_passes(self):
        import uuid
        from api.v1.widget_conversation import _assert_uuid
        _assert_uuid(str(uuid.uuid4()))  # no lanza


class TestSetSectorRequest:
    def test_requires_session_and_sector(self):
        from api.v1.widget_conversation import SetSectorRequest
        with pytest.raises(ValidationError):
            SetSectorRequest(widget_session_id="cs_1")
        body = SetSectorRequest(widget_session_id="cs_1", sector_id="x")
        assert body.sector_id == "x"


class TestCancelHandoffRequest:
    def test_requires_session(self):
        from api.v1.widget_conversation import CancelHandoffRequest
        with pytest.raises(ValidationError):
            CancelHandoffRequest()
        assert CancelHandoffRequest(widget_session_id="cs_1").widget_session_id == "cs_1"
