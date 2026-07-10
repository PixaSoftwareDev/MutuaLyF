"""Tripwire: prohíbe el patrón ':param::tipo' en SQL crudo de todo el backend.

Historia: el cast de PG '::' pegado a un placeholder nombrado rompe el parser
de SQLAlchemy+asyncpg en tiempo de PREPARE (':ids::uuid[]' se parsea como dos
parámetros). Ya causó dos incidentes reales:
- mayo 2026: BM25 roto por '::jsonb'
- julio 2026: retrain nocturno roto por '::uuid[]' en _commit_version
  (descubierto adelantando el ciclo — hubiera fallado esa misma noche)

La forma correcta: CAST(:param AS tipo). Este test escanea el código para
que el patrón no vuelva a entrar nunca.
"""

import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
SCAN_DIRS = ["services", "api", "workers", "core", "db"]
# :nombre seguido de :: (cast de PG) — la mina exacta
LANDMINE = re.compile(r":\w+::")


def test_no_named_param_double_colon_cast():
    hits = []
    for d in SCAN_DIRS:
        for f in (BACKEND / d).rglob("*.py"):
            for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
                m = LANDMINE.search(line)
                if not m or "noqa: landmine" in line:
                    continue
                # Ignorar comentarios (los avisos que documentan este mismo bug)
                hash_pos = line.find("#")
                if hash_pos != -1 and m.start() > hash_pos:
                    continue
                hits.append(f"{f.relative_to(BACKEND)}:{n}: {line.strip()[:90]}")
    assert not hits, (
        "Patrón ':param::tipo' detectado — rompe asyncpg en PREPARE. "
        "Usá CAST(:param AS tipo). Ocurrencias:\n" + "\n".join(hits)
    )
