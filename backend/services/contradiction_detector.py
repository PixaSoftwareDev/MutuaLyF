"""Detector de contradicciones de campos en el corpus de un tenant.

Problema real (mutualyf) — y una trampa que aprendimos probando:
  - "Junín 2956" (129 chunks) = dirección del CENTRO MÉDICO.
  - "Junín 2961" (16 chunks)  = dirección de la SEDE administrativa de la mutual.
  Son DOS direcciones legítimas de DOS entidades distintas, NO un error de OCR.
  El único error real es 1 chunk que dice "El Centro Médico está en Junín 2961".

Por eso el detector es CONSCIENTE DE LA ENTIDAD: agrupa cada dirección por el
sujeto que describe (centro médico, sede, …) y solo marca contradicción cuando el
MISMO sujeto tiene valores en conflicto. Resuelve el valor autoritativo por
frecuencia dentro del sujeto. Un detector "mayoría global gana" habría forzado la
sede a 2956 y roto respuestas correctas — el error que evitamos.

Además filtra listas legítimas por co-ocurrencia (ej teléfono "0074 / 75" son dos
líneas válidas que aparecen juntas, no un conflicto).

Salida: `canonical_facts` (por sujeto, para inyectar en el contexto) + `report`
(para que el admin limpie el chunk erróneo). Determinista, no llama al LLM.
"""

import logging
import re
import unicodedata
from collections import Counter

logger = logging.getLogger(__name__)

_MIN_FIELD_FREQ = 8      # frecuencia mínima para tratar un valor como campo real
_DOMINANCE_MAX = 0.995   # si el dominante no llega a esto y hay variante similar → conflicto

# Sujetos posibles de una dirección, por keywords en la ventana de contexto previa.
# Genéricos de organización — sirven para cualquier tenant con múltiples ubicaciones.
_SUBJECT_KEYWORDS = {
    "centro_medico": ["centro medico"],
    "sede":          ["sede", "oficina", "administrativa", "auditoria",
                      "autorizacion", "contacto principal", "casa central",
                      "delegacion", "sucursal", "filial", "mesa de entrada"],
}
_CONTEXT_WINDOW = 120   # chars antes de la dirección para clasificar el sujeto


def _deaccent(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


# Dirección: palabra(s) capitalizada(s) + número de 3-4 dígitos. Excluye si viene
# tras dígito/punto (ej "3.13 Mendoza") para no tomar numeraciones de lista.
_ADDR_RE = re.compile(
    r"(?<![\d.])\b((?:[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,15})(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,15})?)\s+(\d{3,4})\b"
)
# Teléfono argentino: 0XXX + 7 dígitos, separadores opcionales.
_PHONE_RE = re.compile(r"\b(0\d{3})[\s\-]?(\d{3})[\s\-]?(\d{4})\b")


def _classify_subject(window: str) -> str:
    w = _deaccent(window.lower())
    for subject, kws in _SUBJECT_KEYWORDS.items():
        if any(k in w for k in kws):
            return subject
    return "general"


def extract_occurrences(text: str) -> list[tuple[str, str, str, str]]:
    """Devuelve [(field, subject, number, display), ...] para un texto.

    subject se infiere de la ventana de contexto previa a cada dirección.
    Para teléfonos, subject='telefono' (no se sub-clasifica).
    """
    out: list[tuple[str, str, str, str]] = []
    for m in _ADDR_RE.finditer(text):
        street, number = m.group(1).strip(), m.group(2)
        subject = _classify_subject(text[max(0, m.start() - _CONTEXT_WINDOW):m.start()])
        # entidad = calle + sujeto (una calle puede describir 2 sujetos distintos)
        out.append(("direccion", f"{_deaccent(street.lower())}|{subject}", number, f"{street} {number}"))
    for m in _PHONE_RE.finditer(text):
        digits = m.group(1) + m.group(2) + m.group(3)
        out.append(("telefono", m.group(1), digits, digits))
    return out


def _similar_number(a: str, b: str) -> bool:
    """True si dos números del mismo largo difieren en <=2 dígitos (error OCR)."""
    if len(a) != len(b):
        return False
    diff = sum(1 for x, y in zip(a, b) if x != y)
    return 0 < diff <= 2


async def detect_contradictions(tenant_id: str) -> dict:
    """Escanea los chunks del tenant y detecta campos contradictorios por sujeto."""
    from core.database import get_worker_qdrant_client

    coll = f"{tenant_id}_docs"
    counts: dict[tuple[str, str], Counter] = {}          # (field, entity) → Counter(num)
    cooccur: dict[tuple[str, str], Counter] = {}         # (field, entity) → Counter(pair)
    display: dict[str, str] = {}                          # num → forma legible

    scanned = 0
    async with get_worker_qdrant_client() as q:
        offset = None
        while True:
            pts, offset = await q.scroll(
                coll, limit=500, offset=offset, with_payload=True, with_vectors=False
            )
            if not pts:
                break
            for p in pts:
                scanned += 1
                text = (p.payload or {}).get("text") or ""
                occ = extract_occurrences(text)
                per_key_nums: dict[tuple[str, str], set] = {}
                for field, entity, num, disp in occ:
                    key = (field, entity)
                    counts.setdefault(key, Counter())[num] += 1
                    display[num] = disp
                    per_key_nums.setdefault(key, set()).add(num)
                for key, nums in per_key_nums.items():
                    if len(nums) < 2:
                        continue
                    nums_l = sorted(nums)
                    for i in range(len(nums_l)):
                        for j in range(i + 1, len(nums_l)):
                            cooccur.setdefault(key, Counter())[frozenset((nums_l[i], nums_l[j]))] += 1
            if offset is None:
                break

    canonical_facts: dict[str, dict] = {}
    contradictions: list[dict] = []

    for (field, entity), counter in counts.items():
        total = sum(counter.values())
        if total < _MIN_FIELD_FREQ:
            continue
        ranked = counter.most_common()
        top_num, top_n = ranked[0]
        canonical = display.get(top_num, top_num)
        subject = entity.split("|")[-1] if "|" in entity else field
        fact_key = f"{field}:{subject}" if field == "direccion" else field

        # Registrar el hecho canónico (dirección de cada sujeto, aunque no haya conflicto).
        if field == "direccion" and subject != "general":
            prev = canonical_facts.get(fact_key)
            if not prev or top_n > prev["count"]:
                canonical_facts[fact_key] = {"value": canonical, "count": top_n,
                                             "subject": subject, "entity": entity}

        if len(counter) < 2:
            continue
        pair_counts = cooccur.get((field, entity), Counter())
        dominance = top_n / total
        variants = []
        for num, n in ranked[1:]:
            if not _similar_number(_deaccent(num), _deaccent(top_num)):
                continue
            together = pair_counts.get(frozenset((num, top_num)), 0)
            if together >= max(1, n * 0.5):   # co-listado → lista legítima, no conflicto
                continue
            variants.append({"value": display.get(num, num), "count": n})

        if not variants or dominance > _DOMINANCE_MAX:
            continue
        contradictions.append({
            "field": field, "subject": subject, "canonical": canonical,
            "canonical_count": top_n, "total": total, "dominance": round(dominance, 3),
            "variants": variants,
        })
        logger.info(
            "contradiction_detected tenant=%s field=%s subject=%s canonical=%s (%d/%d) variants=%s",
            tenant_id, field, subject, canonical, top_n, total, [v["value"] for v in variants],
        )

    result = {
        "tenant_id": tenant_id,
        "scanned": scanned,
        "canonical_facts": canonical_facts,
        "contradictions": contradictions,
    }
    await _store(tenant_id, result)
    return result


async def _store(tenant_id: str, result: dict) -> None:
    import json
    from core.database import get_redis_cache
    redis = get_redis_cache()
    try:
        await redis.set(f"{tenant_id}:canonical_facts", json.dumps(result["canonical_facts"]))
        await redis.set(f"{tenant_id}:contradictions", json.dumps(result["contradictions"]))
    except Exception as exc:
        logger.warning("contradiction_store_failed tenant=%s err=%s", tenant_id, exc)


async def get_canonical_facts(tenant_id: str) -> dict:
    """Lee los hechos canónicos precomputados (query-time, barato)."""
    import json
    from core.database import get_redis_cache
    redis = get_redis_cache()
    try:
        raw = await redis.get(f"{tenant_id}:canonical_facts")
        return json.loads(raw) if raw else {}
    except Exception:
        return {}
