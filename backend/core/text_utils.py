"""Utilidades de normalización de texto.

repair_mojibake: repara dos casos de doble-encoding que aparecen en el corpus:
  1. UTF-8 decodificado como Latin-1/CP1252 ('Ã©' en vez de 'é').
  2. Mac Roman decodificado como Latin-1 (chars de control C1 \x80-\x9f, y 'À'
     en vez de '¿'). Típico de textos copiados desde apps viejas de Mac / iOS.
Puro Python, sin dependencias. Idempotente y seguro (no toca texto ya sano).
"""

import re

# Marcadores típicos de mojibake UTF-8→Latin-1.
_MOJIBAKE_MARKERS = ("Ã", "Â", "â\x80", "Ã\x81", "Ã©", "Ã³", "Ã±")
# Bytes de control C1 (0x80-0x9f): nunca aparecen en español legítimo. Su presencia
# delata Mac Roman mal decodificado (0x8e=é, 0x87=á, 0x97=ó, 0x9c=ú, 0xc0=¿).
_C1_CONTROL = re.compile(r"[\x80-\x9f]")


def repair_mojibake(s: str | None) -> str | None:
    """Repara mojibake UTF-8→Latin1 y Mac Roman→Latin1. Idempotente y seguro.

    Devuelve el string original si no detecta corrupción o si la reparación no
    mejora (señal de que el texto ya era válido).
    """
    if not s:
        return s

    # Caso 1: UTF-8 decodificado como Latin-1 ('Ã©' → 'é').
    if any(m in s for m in _MOJIBAKE_MARKERS):
        try:
            repaired = s.encode("latin-1").decode("utf-8")
            if sum(m in repaired for m in _MOJIBAKE_MARKERS) < sum(m in s for m in _MOJIBAKE_MARKERS):
                s = repaired
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass

    # Caso 2: Mac Roman decodificado como Latin-1 (chars de control C1).
    if _C1_CONTROL.search(s):
        try:
            fixed = s.encode("latin-1").decode("mac_roman")
            # Aceptar solo si eliminó los control chars (evita falsos positivos).
            if not _C1_CONTROL.search(fixed):
                s = fixed
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass

    return s
