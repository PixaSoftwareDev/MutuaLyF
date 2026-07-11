"""Tests del guard anti-SSRF de egress (Fase 0, decisión D6).

La resolución DNS se mockea para no depender de la red en CI y para poder
simular DNS-rebinding (host público que resuelve a IP interna).
"""

import socket

import pytest

from core.egress_guard import EgressBlocked, assert_egress_allowed


def _fake_getaddrinfo(ip: str):
    def _inner(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port or 443))]
    return _inner


ALLOW = {"api.nexa.com.ar"}


def test_permite_host_publico_en_allowlist(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("200.58.109.110"))
    # No debe lanzar.
    assert_egress_allowed("https://api.nexa.com.ar/afiliados", ALLOW)


def test_permite_subdominio_de_allowlist(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("200.58.109.110"))
    assert_egress_allowed("https://test.api.nexa.com.ar/v1", ALLOW)


def test_bloquea_host_fuera_de_allowlist(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("200.58.109.110"))
    with pytest.raises(EgressBlocked, match="allowlist"):
        assert_egress_allowed("https://evil.example.com/x", ALLOW)


def test_bloquea_esquema_no_http(monkeypatch):
    with pytest.raises(EgressBlocked, match="esquema"):
        assert_egress_allowed("file:///etc/passwd", ALLOW)


def test_bloquea_http_en_prod(monkeypatch):
    with pytest.raises(EgressBlocked, match="http"):
        assert_egress_allowed("http://api.nexa.com.ar/x", ALLOW, allow_http=False)


def test_permite_http_en_dev(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("200.58.109.110"))
    assert_egress_allowed("http://api.nexa.com.ar/x", ALLOW, allow_http=True)


def test_bloquea_allowlist_vacia():
    with pytest.raises(EgressBlocked, match="allowlist vacía"):
        assert_egress_allowed("https://api.nexa.com.ar/x", set())


@pytest.mark.parametrize("internal_ip", [
    "169.254.169.254",  # metadata cloud (SSRF clásico)
    "127.0.0.1",        # loopback
    "10.1.2.3",         # privada
    "172.17.0.2",       # docker bridge
    "192.168.0.10",     # LAN
    "0.0.0.0",
])
def test_bloquea_dns_rebinding_a_ip_interna(monkeypatch, internal_ip):
    # Host ESTÁ en la allowlist pero resuelve a una IP interna → SSRF, bloquear.
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo(internal_ip))
    with pytest.raises(EgressBlocked, match="SSRF"):
        assert_egress_allowed("https://api.nexa.com.ar/x", ALLOW)


def test_bloquea_si_dns_no_resuelve(monkeypatch):
    def _boom(*a, **k):
        raise socket.gaierror("no such host")
    monkeypatch.setattr(socket, "getaddrinfo", _boom)
    with pytest.raises(EgressBlocked, match="resolver"):
        assert_egress_allowed("https://api.nexa.com.ar/x", ALLOW)
