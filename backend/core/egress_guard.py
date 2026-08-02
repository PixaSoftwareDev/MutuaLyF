"""Guard de egress anti-SSRF para llamadas salientes a APIs de terceros.

Contexto: al abrir Tool Calling, el backend hará requests HTTP a URLs que en
parte vienen de configuración por tenant (base_url de conectores). Sin control,
un conector mal configurado —o un atacante que logre escribir config— podría
apuntar a un recurso interno: la metadata de la nube (169.254.169.254), las
DBs (postgres:5432), localhost, o rangos privados. Eso es SSRF.

Decisión D6 (arquitectura de conectores): el egress es un control de primera
clase. Toda URL que el executor vaya a invocar pasa PRIMERO por assert_egress_allowed:
1. Solo https (o http explícito en dev)
2. Host en la allowlist del conector (dominios declarados por el tenant)
3. Ninguna IP resuelta cae en rango privado/loopback/link-local/metadata

Este módulo es puro y sin I/O de red salvo la resolución DNS — testeable en CI.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class EgressUnreachable(Exception):
    """El destino ESTÁ permitido pero no se pudo resolver (DNS caído, dominio
    vencido, host apagado). Se separa de EgressBlocked porque no es un rechazo
    de política sino una falla del proveedor: el circuit breaker tiene que
    contarla, si no cada consulta reintenta la resolución de un host muerto."""


class EgressBlocked(Exception):
    """La URL de destino viola la política de egress (posible SSRF)."""


# Rangos que NUNCA deben ser destino de una llamada a "API externa".
_BLOCKED_NETS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),   # CGNAT
    ipaddress.ip_network("127.0.0.0/8"),     # loopback
    ipaddress.ip_network("169.254.0.0/16"),  # link-local + metadata cloud
    ipaddress.ip_network("172.16.0.0/12"),   # docker/privadas
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),         # ULA
    ipaddress.ip_network("fe80::/10"),        # link-local v6
]


def _is_blocked_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # no parseable → bloquear por las dudas
    # IPv6 que envuelve una IPv4 (::ffff:169.254.169.254): comparar contra las
    # redes v4 da False siempre — versiones distintas no matchean, y sin error.
    # Un host de la allowlist con un AAAA así alcanzaba loopback y la metadata
    # del cloud esquivando toda la lista. Se desenvuelve ANTES de comparar.
    if ip.version == 6:
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
        elif getattr(ip, "sixtofour", None) is not None:
            ip = ip.sixtofour
    if any(ip in net for net in _BLOCKED_NETS):
        return True
    # Red de seguridad sobre la lista explícita: cualquier dirección que no sea
    # ruteable en internet (reservadas, benchmarking 198.18/15, 240/4, NAT64,
    # multicast, futuras) no puede ser el destino de una "API externa".
    return not ip.is_global or ip.is_multicast or ip.is_reserved


def assert_egress_allowed(
    url: str,
    allowlist: set[str] | list[str],
    *,
    allow_http: bool = False,
    trusted_internal_hosts: set[str] | list[str] | None = None,
) -> None:
    """Lanza EgressBlocked si `url` no es un destino externo permitido.

    allowlist: hosts (dominios) declarados por el conector del tenant. El host
    de la URL debe estar en la allowlist exactamente o ser subdominio de alguno.
    allow_http: solo True en entornos de test/dev; en prod exigimos https.
    trusted_internal_hosts: hosts internos permitidos EXPLÍCITAMENTE (p. ej. un
        servicio mock en la red Docker durante desarrollo). Se saltea SOLO para
        ellos la verificación de IP privada. Vacío en producción → SSRF intacto.
    """
    if not allowlist:
        raise EgressBlocked("egress denegado: allowlist vacía")

    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("https", "http"):
        raise EgressBlocked(f"esquema no permitido: {scheme!r}")
    if scheme == "http" and not allow_http:
        raise EgressBlocked("http no permitido fuera de dev; usar https")

    host = (parsed.hostname or "").lower()
    if not host:
        raise EgressBlocked("URL sin host")

    allow = {h.lower().lstrip(".") for h in allowlist}
    if not (host in allow or any(host.endswith("." + h) for h in allow)):
        raise EgressBlocked(f"host {host!r} no está en la allowlist del conector")

    # Excepción dev EXPLÍCITA: host interno de confianza (mock) → no verificamos IP.
    trusted = {h.lower() for h in (trusted_internal_hosts or ())}
    if host in trusted:
        return

    # Anti-DNS-rebinding / IP directa: resolver y verificar CADA dirección.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if scheme == "https" else 80),
                                   proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise EgressUnreachable(f"no se pudo resolver {host!r}: {exc}") from exc

    for info in infos:
        ip = info[4][0]
        if _is_blocked_ip(ip):
            raise EgressBlocked(
                f"host {host!r} resuelve a IP interna/no-ruteable {ip} — bloqueado (SSRF)")
