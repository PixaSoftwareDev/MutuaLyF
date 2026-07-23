"""Trust gate — ¿el contexto recuperado RESPONDE la pregunta, o solo se le parece?

Ataca la alucinación por "chunks vecinos": la búsqueda semántica devuelve
material del mismo tema con score alto aunque ninguno conteste (caso real:
"¿cómo saco turno para una resonancia?" con una KB sin nada de resonancias →
el LLM inventaba el procedimiento). El gate corre DESPUÉS de armar el contexto
y ANTES de generar:

  1. Cobertura léxica (gratis, en proceso): si los términos distintivos de la
     pregunta aparecen en los chunks, pasa directo — cero latencia agregada.
     En la práctica resuelve ~3 de cada 4 consultas.
  2. Zona gris → juez LLM selectivo (el mismo `complete()` de la app, modelo
     rápido): "¿cuáles de estos fragmentos CONTIENEN la respuesta?".
     Ninguno → rechazo (rama determinística de no-info del orquestador).
     Algunos → el contexto se filtra a esos.
  3. Si el juez aprobó pero el objeto específico de la pregunta no aparece en
     ningún documento, la generación recibe la instrucción de admitir el límite
     ("no tengo información sobre X") antes de ofrecer lo relacionado.

Fail-open SIEMPRE: ante cualquier error el gate deja pasar (comportamiento
previo). Config en `Settings` (`trust_gate_*`); validado en staging 2026-07-23
con 33/33 sobre el corpus real (ver progress.json / memoria del proyecto).
"""

import json
import logging
import re
import unicodedata

from core.config import settings

logger = logging.getLogger(__name__)

# Stopwords + palabras de trámite que no distinguen el TEMA de la pregunta.
_STOPWORDS = {
    "de", "la", "el", "en", "un", "una", "unos", "unas", "los", "las", "del",
    "para", "por", "con", "sin", "que", "qué", "es", "se", "su", "sus", "al",
    "le", "les", "lo", "si", "sí", "te", "me", "mi", "mis", "no", "ni", "o",
    "u", "y", "a", "e", "ya", "hay", "son", "está", "esta", "este", "esto",
    "como", "cómo", "cuando", "cuándo", "donde", "dónde", "cual", "cuál",
    "quien", "quién", "cuanto", "cuánto", "cuanta", "cuánta", "cuantos",
    "cuantas", "ser", "estar", "tener", "tengo", "tenes", "tenés", "tiene",
    "tienen", "hacer", "hago", "hace", "hacen", "puedo", "puede", "pueden",
    "podes", "podés", "debo", "debe", "deben", "quiero", "quiere", "necesito",
    "necesita", "saber", "sabes", "sabés", "sabe", "decir", "dime", "decime",
    "existe", "existen", "algun", "algún", "alguna", "algunos", "algunas",
    "sobre", "entre", "hasta", "desde", "mas", "más", "menos", "muy", "bien",
    "info", "informacion", "información", "dato", "datos", "consulta",
    "pregunta", "ayuda", "favor", "hola", "gracias", "quisiera", "sacar",
    "saco", "realizar", "realizo", "obtener", "conseguir", "solicitar",
    "solicito", "pedir", "pido", "gestionar", "tramitar", "dan", "cubren",
    "prestan", "atienden", "atiende",
    # Verbos/sustantivos transaccionales de precio: "¿cuánto sale X?" pregunta
    # por X, no por "sale" — sin esto, la cobertura parcial dispara en falso
    # y el bot antepone "no tengo información" a respuestas completas.
    "sale", "salen", "cuesta", "cuestan", "vale", "valen", "cobra", "cobran",
    "precio", "costo", "costos", "pago", "pagan", "pagar", "abona", "abonan",
    "monto", "valor",
    # Meta-preguntas sobre el propio asistente ("¿con quién estoy hablando?",
    # "¿qué temas conocés?"): las responde la personalidad/bot_description,
    # no los documentos — el gate no debe rechazarlas por falta de chunks.
    "hablando", "hablas", "hablás", "conoces", "conocés", "temas", "sos",
    "soy", "eres", "haces", "hacés", "responder", "respondes", "respondés",
    "estoy", "estas", "estás", "duda", "dudas", "agarra", "pasa", "quede",
}


def _norm(text: str) -> str:
    """minúsculas + sin tildes (para comparar 'resonancia' con 'Resonancia')."""
    text = unicodedata.normalize("NFD", text.lower())
    return "".join(c for c in text if unicodedata.category(c) != "Mn")


def _distinctive_terms(question: str) -> set[str]:
    """Términos que definen el TEMA de la pregunta (sin stopwords ni verbos de
    trámite). Se conservan cortos tipo sigla ('rnm', 'cos', 'dni')."""
    tokens = re.findall(r"[a-záéíóúüñ0-9]+", question.lower())
    terms: set[str] = set()
    for tok in tokens:
        if tok in _STOPWORDS or _norm(tok) in _STOPWORDS:
            continue
        if len(tok) >= 3:
            terms.add(_norm(tok))
    return terms


def lexical_coverage(question: str, chunk_texts: list[str]) -> tuple[float, list[str]]:
    """Fracción de términos distintivos presentes en el contexto. Términos de
    4+ chars matchean por substring ('hora'→'horario'); los de 3 exigen palabra
    completa — sin esto 'mar' (de Mar del Plata) matcheaba 'informar' y la
    cobertura daba un falso positivo. Sin términos distintivos → 1.0."""
    terms = _distinctive_terms(question)
    if not terms:
        return 1.0, []
    blob = _norm(" ".join(chunk_texts))
    words = set(re.findall(r"[a-z0-9]+", blob))
    missing = [
        t for t in terms
        if (t not in blob if len(t) >= 4 else t not in words)
    ]
    return 1.0 - (len(missing) / len(terms)), missing


_JUDGE_SYSTEM = (
    "Sos un evaluador estricto de relevancia para un sistema de consultas "
    "documentales. Tu única tarea: decidir cuáles fragmentos CONTIENEN la "
    "respuesta a la pregunta. Reglas:\n"
    "1. 'Habla del mismo tema' NO alcanza — el fragmento debe contener la "
    "información concreta que la pregunta pide.\n"
    "2. Si la pregunta es sobre un OBJETO ESPECÍFICO (un estudio, servicio, "
    "trámite, producto o entidad con nombre), el fragmento debe mencionar ESE "
    "objeto. Un fragmento sobre el trámite genérico o sobre otro objeto "
    "parecido NO responde (ej: si preguntan por resonancia, un fragmento sobre "
    "ecografías o sobre turnos en general NO responde).\n"
    "3. Si la pregunta COMBINA varios temas o condiciones, un fragmento que "
    "responde PARTE de la pregunta SÍ cuenta como que responde (la respuesta "
    "final puede armarse juntando fragmentos).\n"
    "3b. Si la pregunta menciona un caso PARTICULAR (un lugar, una fecha, una "
    "situación concreta) y un fragmento da la REGLA GENERAL que claramente lo "
    "cubre (ej: preguntan por una emergencia en Bariloche y el fragmento "
    "explica la cobertura de emergencias fuera de la red), ese fragmento SÍ "
    "responde.\n"
    "4. Ante la duda sobre un fragmento puntual, NO responde. Si ninguno "
    "responde ni en parte, la lista va vacía — esa es una respuesta correcta "
    "y frecuente.\n"
    "Respondé ÚNICAMENTE un JSON con este formato exacto: "
    '{"responden": [números de fragmento], "motivo": "breve"}'
)


def coverage_note(missing: list[str]) -> str:
    """Instrucción para la generación cuando la cobertura es parcial: admitir el
    límite sin afirmar negativos ("no tengo información" ≠ "no se realiza").

    CONDICIONAL, no un opener forzado: si los fragmentos responden la pregunta
    completa, el asistente responde normal — sin esto, "¿cuánto sale el plan?"
    salía como "No tengo información sobre eso. Sin embargo, cuesta $28.500"."""
    return (
        "NOTA PARA EL ASISTENTE: los documentos no mencionan: "
        + ", ".join(missing[:4]) + ". "
        "Si la pregunta se responde completa con los fragmentos, respondé "
        "normalmente e ignorá esta nota. Solo si la pregunta pide "
        "específicamente algo de esa lista y no está en los fragmentos, "
        "aclaralo diciendo que NO TENÉS INFORMACIÓN sobre eso (nunca afirmes "
        "que el servicio no existe o no se realiza) y ofrecé lo relacionado "
        "que SÍ está. No des a entender que lo faltante está cubierto."
    )


async def _judge(question: str, chunk_texts: list[str], tenant_id: str) -> dict | None:
    """Juez LLM listwise. None = no pudo decidir (fail-open)."""
    from services.groq_client import complete

    max_chunks = settings.trust_gate_judge_max_chunks
    max_chars = settings.trust_gate_judge_chunk_chars
    numbered = "\n\n".join(
        f"[{i + 1}] {t[:max_chars]}" for i, t in enumerate(chunk_texts[:max_chunks])
    )
    user = (
        f"Pregunta del usuario: {question[:500]}\n\n"
        f"Fragmentos recuperados:\n{numbered}\n\n"
        '¿Cuáles fragmentos CONTIENEN la respuesta? JSON: {"responden": [...], "motivo": "..."}'
    )
    try:
        raw = await complete(
            messages=[
                {"role": "system", "content": _JUDGE_SYSTEM},
                {"role": "user", "content": user},
            ],
            temperature=0.0,
            max_tokens=120,
            tenant_id=tenant_id,
        )
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            return None
        data = json.loads(match.group(0))
        idx = [
            int(i) - 1
            for i in data.get("responden", [])
            if isinstance(i, (int, float, str)) and str(i).isdigit()
        ]
        return {
            "kept": [i for i in idx if 0 <= i < len(chunk_texts)],
            "motivo": str(data.get("motivo", ""))[:200],
        }
    except Exception as exc:  # noqa: BLE001 — fail-open por diseño
        logger.warning("trust_gate_judge_failed tenant_id=%s error=%s", tenant_id, exc)
        return None


async def evaluate_coverage(question: str, chunk_texts: list[str], tenant_id: str) -> dict:
    """Devuelve {"action": "answer"|"refuse", "kept": list[int]|None,
    "missing": list[str], "reason": str, "judge_used": bool, "lex_coverage": float}."""
    # Smalltalk / entradas mínimas ("chau", "ok perfecto", "gracias", "?"):
    # no hay consulta informacional que evaluar — el gate no opina y deja que
    # la personalidad conteste. Sin este guard, "chau" terminaba en "no encontré".
    if len(question.split()) < 3:
        return {
            "action": "answer", "kept": None, "judge_used": False, "missing": [],
            "lex_coverage": 1.0, "reason": "smalltalk_skip",
        }

    coverage, missing = lexical_coverage(question, chunk_texts)
    if coverage >= settings.trust_gate_lex_strong:
        return {
            "action": "answer", "kept": None, "judge_used": False, "missing": [],
            "lex_coverage": round(coverage, 2),
            "reason": f"lexical_pass cov={coverage:.2f}",
        }

    if not settings.trust_gate_judge:
        # Sin juez: solo rechaza el caso extremo (ningún término presente).
        if coverage == 0.0:
            return {
                "action": "refuse", "kept": None, "judge_used": False,
                "missing": missing, "lex_coverage": 0.0,
                "reason": f"lexical_zero missing={missing[:5]}",
            }
        return {
            "action": "answer", "kept": None, "judge_used": False,
            "missing": missing, "lex_coverage": round(coverage, 2),
            "reason": "lexical_gray_no_judge",
        }

    verdict = await _judge(question, chunk_texts, tenant_id)
    if verdict is None:  # el juez falló → fail-open
        return {
            "action": "answer", "kept": None, "judge_used": True, "missing": [],
            "lex_coverage": round(coverage, 2), "reason": "judge_failed_open",
        }
    if not verdict["kept"]:
        return {
            "action": "refuse", "kept": None, "judge_used": True,
            "missing": missing, "lex_coverage": round(coverage, 2),
            "reason": f"judge_refuse: {verdict['motivo']}",
        }
    return {
        "action": "answer", "kept": verdict["kept"], "judge_used": True,
        "missing": missing, "lex_coverage": round(coverage, 2),
        "reason": f"judge_keep={len(verdict['kept'])}: {verdict['motivo']}",
    }
