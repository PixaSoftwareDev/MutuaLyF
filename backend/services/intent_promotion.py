"""Auto-promoción de clusters candidatos → intenciones.

Rompe el cold-start del sistema de intenciones: sin esto, ninguna consulta llega
nunca a las bandas automáticas (≥95% / 70-94%) porque el clasificador arranca
vacío, así que el único camino era la aprobación manual — que puede no ocurrir
nunca (caso mutualyf: 59 clusters listos, 0 intenciones).

Flujo por cluster candidato con >= intent_auto_promote_min_size consultas:
  1. Validar coherencia con Groq (¿es UNA intención? + label sugerido).
  2. Si es coherente y confiable → crear intención, poblar intencion_ejemplos,
     indexar en Qdrant, marcar las consultas como 'classified'.
  3. Los incoherentes quedan como 'candidate' para revisión manual del admin.
  4. Cachea el label sugerido en Redis (calienta el panel — evita N llamadas Groq
     bloqueantes al abrirlo).

Corre en contexto worker (get_worker_pg_session / get_worker_qdrant_client).
Idempotente: solo toca clusters en estado 'candidate'.
"""

import logging
import uuid

from core.config import settings
from core.text_utils import repair_mojibake

logger = logging.getLogger(__name__)

# Umbral mínimo de confianza de Groq para auto-promover sin humano.
_MIN_COHERENCE_CONFIDENCE = 0.6
_SAMPLES_PER_CLUSTER = 20


async def promote_candidate_clusters(
    tenant_id: str, min_size: int | None = None, *, force: bool = False
) -> dict:
    """Promueve clusters candidatos coherentes a intenciones. Devuelve un summary.

    force=True: disparo manual explícito del admin (panel) — corre aunque la
    promoción automática esté deshabilitada (modo sugerencia).
    """
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    if not settings.intent_auto_promote_enabled and not force:
        logger.info("promotion_disabled tenant_id=%s (modo sugerencia)", tenant_id)
        return {"tenant_id": tenant_id, "enabled": False, "promoted": 0}

    min_size = min_size or settings.intent_auto_promote_min_size
    summary = {
        "tenant_id": tenant_id,
        "enabled": True,
        "clusters_evaluated": 0,
        "promoted": 0,
        "subdivided": 0,
        "incoherent": 0,
        "errors": 0,
        "labels": [],
    }

    # ── 1. Traer clusters candidatos grandes con sus muestras ──────────────────
    async with get_worker_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT cluster_candidate_id,
                   COUNT(*) AS n,
                   (array_agg(DISTINCT question_text))[1:20] AS samples
            FROM consultas_log
            WHERE cluster_status = 'candidate'
              AND cluster_candidate_id IS NOT NULL
              AND question_text IS NOT NULL
            GROUP BY cluster_candidate_id
            HAVING COUNT(*) >= :min_size
            ORDER BY COUNT(*) DESC
        """), {"min_size": min_size})
        clusters = [
            {"cluster_id": str(r[0]), "n": int(r[1]), "samples": list(r[2] or [])}
            for r in result.fetchall()
        ]

    summary["clusters_evaluated"] = len(clusters)
    if not clusters:
        logger.info("promotion_no_candidates tenant_id=%s min_size=%d", tenant_id, min_size)
        return summary

    # Intenciones existentes → para que el LLM absorba en vez de fragmentar.
    async with get_worker_pg_session(tenant_id) as session:
        existing = [r[0] for r in (await session.execute(text(
            "SELECT label FROM intenciones WHERE is_active = TRUE"
        ))).fetchall()]
    summary["absorbed"] = 0

    logger.info("promotion_start tenant_id=%s clusters=%d min_size=%d existing=%d",
                tenant_id, len(clusters), min_size, len(existing))

    any_promoted = False
    consecutive_groq_errors = 0
    for cluster in clusters:
        try:
            promoted_label, groq_error, absorbed = await _promote_one(tenant_id, cluster, existing)
            if groq_error:
                # Circuit-breaker: si Groq está caído/rate-limited, no tiene sentido
                # martillar los 43 clusters (cada uno reintenta con backoff). Cortamos
                # y dejamos el resto como candidatos para el próximo run.
                consecutive_groq_errors += 1
                summary["errors"] += 1
                if consecutive_groq_errors >= 3:
                    summary["aborted_reason"] = "groq_unavailable"
                    logger.warning(
                        "promotion_aborted tenant_id=%s reason=groq_unavailable after=%d clusters",
                        tenant_id, summary["errors"],
                    )
                    break
                continue
            consecutive_groq_errors = 0
            if promoted_label:
                if absorbed:
                    summary["absorbed"] += 1
                else:
                    summary["promoted"] += 1
                    existing.append(promoted_label)  # disponible para absorber los siguientes
                summary["labels"].append(promoted_label)
                any_promoted = True
            else:
                # A. Incoherente → intentar subdividir en sub-temas coherentes
                #    antes de descartarlo (recupera cobertura).
                sub_labels = await _subdivide_and_promote(tenant_id, cluster["cluster_id"], existing)
                if sub_labels:
                    summary["promoted"] += len(sub_labels)
                    summary["subdivided"] += 1
                    summary["labels"].extend(sub_labels)
                    any_promoted = True
                else:
                    summary["incoherent"] += 1
        except Exception as exc:
            summary["errors"] += 1
            logger.error("promotion_cluster_failed tenant_id=%s cluster=%s error=%s",
                         tenant_id, cluster["cluster_id"], exc)

    # ── Consolidar intenciones redundantes tras promover ───────────────────────
    if any_promoted:
        try:
            con = await consolidate_intentions(tenant_id)
            summary["merged"] = con.get("removed", 0)
        except Exception as exc:
            logger.warning("promotion_consolidate_failed tenant=%s err=%s", tenant_id, exc)

    # ── Reentrenar una sola vez si hubo promociones ────────────────────────────
    if any_promoted:
        try:
            from workers.training_tasks import retrain_intent_classifier
            retrain_intent_classifier.apply_async(args=[tenant_id], queue="training", countdown=5)
        except Exception as exc:
            logger.warning("promotion_retrain_trigger_failed tenant_id=%s error=%s", tenant_id, exc)

    logger.info("promotion_complete tenant_id=%s summary=%s", tenant_id, summary)
    return summary


async def _promote_one(
    tenant_id: str, cluster: dict, existing: list[str] | None = None,
) -> tuple[str | None, bool, bool]:
    """Valida y (si coherente) promueve o ABSORBE un cluster.

    Devuelve (label|None, groq_error, absorbed). groq_error=True → fallo de Groq
    (el llamador corta temprano). absorbed=True → el cluster se sumó a una intención
    existente (belongs_to) en vez de crear una nueva.
    """
    from core.database import get_redis_cache
    from services.groq_client import validate_cluster_coherence, match_existing_intention

    cluster_id = cluster["cluster_id"]
    samples = [repair_mojibake(s) or s for s in cluster["samples"] if s and s.strip()]
    if len(samples) < 2:
        return None, False, False
    if _is_junk_cluster(samples):
        logger.info("promotion_skip_junk tenant_id=%s cluster=%s", tenant_id, cluster_id)
        return None, False, False

    # ── Absorción: ¿pertenece a una intención existente? (evita fragmentar) ─────
    if existing:
        m = await match_existing_intention(samples[:10], existing)
        if m.get("belongs_to") and m.get("confidence", 0) >= _MIN_COHERENCE_CONFIDENCE:
            await _create_intention(tenant_id, m["belongs_to"], samples, cluster_id=cluster_id)
            logger.info("promotion_absorbed tenant_id=%s cluster=%s into=%s conf=%.2f",
                        tenant_id, cluster_id, m["belongs_to"], m["confidence"])
            return m["belongs_to"], False, True

    # ── Gate de coherencia (tema nuevo) ────────────────────────────────────────
    verdict = await validate_cluster_coherence(samples[:12])
    label = verdict.get("label") or ""
    groq_error = verdict.get("reason") == "groq_error"

    if label:
        try:
            redis = get_redis_cache()
            await redis.set(f"cluster_label_suggestion:{cluster_id}", label, ex=86400)
        except Exception:
            pass

    if not verdict.get("coherent") or verdict.get("confidence", 0) < _MIN_COHERENCE_CONFIDENCE or not label:
        if not groq_error:
            logger.info(
                "promotion_skip_incoherent tenant_id=%s cluster=%s coherent=%s conf=%.2f reason=%s",
                tenant_id, cluster_id, verdict.get("coherent"), verdict.get("confidence", 0),
                verdict.get("reason", ""),
            )
        return None, groq_error, False

    label = await _uniquify_label(tenant_id, label)
    await _create_intention(tenant_id, label, samples, cluster_id=cluster_id)
    logger.info("promotion_promoted tenant_id=%s cluster=%s label=%s examples=%d",
                tenant_id, cluster_id, label, len(samples))
    return label, False, False


async def _create_intention(
    tenant_id: str,
    label: str,
    samples: list[str],
    *,
    cluster_id: str | None = None,
    query_ids: list[str] | None = None,
) -> str:
    """Crea la intención, persiste ejemplos, marca las consultas y las indexa.

    Marca 'classified' por cluster_candidate_id (promoción directa) o por lista de
    ids específicos (subdivisión de un cluster incoherente en sub-grupos).
    """
    from core.database import get_worker_pg_session
    from services.intent_examples import insert_examples
    from sqlalchemy import text

    async with get_worker_pg_session(tenant_id) as session:
        row = await session.execute(text("""
            INSERT INTO intenciones (id, label, description, example_count, is_active)
            VALUES (:id, :label, :description, 0, TRUE)
            ON CONFLICT (label) DO UPDATE SET is_active = TRUE, updated_at = NOW()
            RETURNING id
        """), {
            "id": str(uuid.uuid4()),
            "label": label,
            "description": "Auto-generada desde cluster (revisar y ajustar si hace falta)",
        })
        intention_id = str(row.scalar())
        await insert_examples(session, intention_id, samples)

        if query_ids:
            await session.execute(text("""
                UPDATE consultas_log SET cluster_status='classified', intent_label=:label
                WHERE id = ANY(CAST(:ids AS uuid[])) AND cluster_status='candidate'
            """), {"label": label, "ids": query_ids})
        elif cluster_id:
            await session.execute(text("""
                UPDATE consultas_log SET cluster_status='classified', intent_label=:label
                WHERE cluster_candidate_id=:cid AND cluster_status='candidate'
            """), {"label": label, "cid": cluster_id})

    await _index_examples_worker(tenant_id, intention_id, label, samples)
    return intention_id


# ── A. Subdivisión de clusters incoherentes ─────────────────────────────────
# Un cluster que Groq marca incoherente suele estar SOBRE-fusionado (HDBSCAN unió
# sub-temas). En vez de descartarlo, lo re-clusterizamos con granularidad más fina
# y promovemos los sub-grupos que sí son coherentes. Recupera cobertura (ej: la
# intención "contacto" que se perdía en un cluster mezclado).

async def _subdivide_and_promote(
    tenant_id: str, cluster_id: str, existing: list[str] | None = None,
) -> list[str]:
    """Re-clusteriza un cluster incoherente y promueve/absorbe los sub-grupos coherentes.

    Devuelve la lista de labels resultantes (vacía si no se pudo subdividir).
    """
    from core.database import get_worker_pg_session
    from services.embeddings import embed_batch
    from services.groq_client import validate_cluster_coherence, match_existing_intention
    from sqlalchemy import text

    sub_min = settings.intent_subdivide_min_size

    # 1. Traer TODAS las consultas del cluster (id + texto).
    async with get_worker_pg_session(tenant_id) as s:
        rows = (await s.execute(text("""
            SELECT id::text, question_text FROM consultas_log
            WHERE cluster_candidate_id=:cid AND cluster_status='candidate'
              AND question_text IS NOT NULL
        """), {"cid": cluster_id})).fetchall()
    if len(rows) < sub_min * 2:
        return []   # muy chico para subdividir con sentido

    ids = [r[0] for r in rows]
    texts = [repair_mojibake(r[1]) or r[1] for r in rows]

    # 2. Embed + sub-clustering fino.
    import asyncio
    loop = asyncio.get_running_loop()
    vectors = await loop.run_in_executor(None, embed_batch, texts, True)
    labels_arr = _subcluster(vectors, sub_min)
    if labels_arr is None:
        return []

    # 3. Agrupar por sub-label (ignorando ruido -1).
    groups: dict[int, list[int]] = {}
    for idx, lab in enumerate(labels_arr):
        if lab != -1:
            groups.setdefault(lab, []).append(idx)

    promoted: list[str] = []
    for lab, idxs in groups.items():
        if len(idxs) < sub_min:
            continue
        sub_ids = [ids[i] for i in idxs]
        sub_texts = list(dict.fromkeys(texts[i] for i in idxs))  # distintos, orden estable
        # Exigir varios textos DISTINTOS: evita intenciones-ruido de una query
        # repetida (ej: "messi" x6 → 1 texto distinto). Coverage real, no eco.
        if len(sub_texts) < 4 or _is_junk_cluster(sub_texts):
            continue
        # Absorción también en subdivisión: si el sub-grupo pertenece a una intención
        # existente, sumar ahí en vez de crear una nueva granular.
        belongs_to = None
        if existing:
            m = await match_existing_intention(sub_texts[:10], existing)
            if m.get("belongs_to") and m.get("confidence", 0) >= _MIN_COHERENCE_CONFIDENCE:
                belongs_to = m["belongs_to"]
        if belongs_to:
            target = belongs_to
        else:
            verdict = await validate_cluster_coherence(sub_texts[:12])
            vlabel = verdict.get("label") or ""
            if not verdict.get("coherent") or verdict.get("confidence", 0) < _MIN_COHERENCE_CONFIDENCE or not vlabel:
                continue
            target = await _uniquify_label(tenant_id, vlabel)
        await _create_intention(tenant_id, target, sub_texts[:20], query_ids=sub_ids)
        promoted.append(target)
        logger.info("subdivide_%s tenant=%s parent=%s label=%s size=%d",
                    "absorbed" if belongs_to else "promoted", tenant_id, cluster_id, target, len(idxs))

    return promoted


def _subcluster(vectors, min_size: int):
    """HDBSCAN fino sobre las consultas de UN cluster. Devuelve labels o None."""
    import numpy as np
    valid = [v for v in vectors if v is not None]
    if len(valid) < min_size * 2:
        return None
    try:
        import hdbscan
        import umap
        X = np.array(valid, dtype=np.float32)
        n = len(X)
        # UMAP a pocas dims para exponer sub-estructura; params dependientes de n.
        reducer = umap.UMAP(
            n_neighbors=min(10, n - 1),
            n_components=min(8, n - 2),
            metric="cosine", min_dist=0.0, random_state=42,
        )
        reduced = reducer.fit_transform(X)
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=max(min_size, 4),
            min_samples=1,
            metric="euclidean",
            cluster_selection_method="leaf",  # 'leaf' = sub-grupos más finos que 'eom'
        )
        return clusterer.fit_predict(reduced)
    except Exception as exc:
        logger.warning("subcluster_failed error=%s", exc)
        return None


def _is_junk_cluster(texts: list[str]) -> bool:
    """True si el cluster es ruido/spam y no un intent real.

    Señal: los textos distintos son mayormente palabras sueltas (mediana de
    cantidad de palabras < 2). Las consultas reales son preguntas de varias
    palabras; clusters como 44×"messi" o tokens sueltos repetidos son basura
    off-domain que no debe volverse intención.
    """
    distinct = list(dict.fromkeys(t.strip() for t in texts if t and t.strip()))
    if not distinct:
        return True
    word_counts = sorted(len(t.split()) for t in distinct)
    median = word_counts[len(word_counts) // 2]
    return median < 2


_MERGE_SIM = 0.85         # coseno de centroide >= esto → misma intención (fusiona siempre)
_MERGE_SIM_NAMED = 0.78   # >= esto + raíz de label compartida → también fusiona

# Tokens genéricos que no cuentan como "raíz compartida" del label.
_STEM_STOP = {"de", "la", "el", "del", "los", "las", "consulta", "info",
              "general", "y", "por", "para", "gestion"}


def _labels_share_stem(a: str, b: str) -> bool:
    """True si dos labels comparten un token significativo (raíz común).

    Ej: horarios_atencion ~ horarios_atencion_medicos → comparten {horarios,
    atencion}. sacar_turno ~ horarios_atencion → nada en común → False.
    """
    ta = {t for t in a.lower().split("_") if t and t not in _STEM_STOP}
    tb = {t for t in b.lower().split("_") if t and t not in _STEM_STOP}
    return len(ta & tb) >= 1


async def consolidate_intentions(tenant_id: str, threshold: float = _MERGE_SIM) -> dict:
    """Fusiona intenciones redundantes (centroides muy similares).

    El clustering + promoción a veces genera intenciones casi idénticas
    (ej: sacar_turno ~ sacar_turno_medico = 0.89). Solapadas, el clasificador no
    las separa y la accuracy cae. Esta función detecta pares con coseno de
    centroide >= threshold y los fusiona en el de más ejemplos, reasignando
    consultas_log y ejemplos, y borrando el perdedor (PG + Qdrant).

    Idempotente. Devuelve summary con los merges hechos.
    """
    import numpy as np
    from core.database import get_worker_pg_session, get_worker_qdrant_client
    from sqlalchemy import text

    summary = {"tenant_id": tenant_id, "merges": [], "removed": 0}
    coll = f"{tenant_id}_intenciones"

    # 1. Vectores por label desde Qdrant → centroides.
    async with get_worker_qdrant_client() as q:
        try:
            pts, _ = await q.scroll(coll, limit=2000, with_payload=True, with_vectors=True)
        except Exception as exc:
            logger.warning("consolidate_scroll_failed tenant=%s err=%s", tenant_id, exc)
            return summary
    by_label: dict[str, list] = {}
    for p in pts:
        lbl = (p.payload or {}).get("label")
        if lbl and p.vector:
            by_label.setdefault(lbl, []).append(p.vector)
    if len(by_label) < 2:
        return summary
    cent = {l: np.mean(np.array(v), axis=0) for l, v in by_label.items()}

    # 2. Conteo de ejemplos por intención (para elegir a quién conservar).
    async with get_worker_pg_session(tenant_id) as s:
        rows = (await s.execute(text(
            "SELECT label, example_count FROM intenciones WHERE is_active = TRUE"
        ))).fetchall()
    ex_count = {r[0]: (r[1] or 0) for r in rows}

    def cos(a, b):
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

    # 3. Pares candidatos a fusión:
    #    - similitud >= threshold (0.85): claramente la misma intención, o
    #    - similitud >= _MERGE_SIM_NAMED (0.78) Y comparten raíz de label.
    #    Lo segundo captura near-dupes que el centroide no separa de intenciones
    #    vecinas (turno~horario viven a ~0.83), sin fusionarlas: turno y horario
    #    NO comparten token de label, así que quedan separadas.
    labels = list(cent)
    pairs = []
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            a, b = labels[i], labels[j]
            sim = cos(cent[a], cent[b])
            if sim >= threshold or (sim >= _MERGE_SIM_NAMED and _labels_share_stem(a, b)):
                pairs.append((sim, a, b))
    pairs.sort(reverse=True)

    merged: set[str] = set()
    for sim, a, b in pairs:
        if a in merged or b in merged:
            continue
        # keep = el de más ejemplos; ante empate, el nombre más corto (más general).
        keep, drop = (a, b) if (ex_count.get(a, 0), -len(a)) >= (ex_count.get(b, 0), -len(b)) else (b, a)
        await _merge_intention(tenant_id, keep, drop, coll)
        merged.add(drop)
        summary["merges"].append({"keep": keep, "drop": drop, "sim": round(sim, 3)})
        summary["removed"] += 1
        logger.info("intent_merged tenant=%s keep=%s drop=%s sim=%.3f", tenant_id, keep, drop, sim)

    return summary


async def _merge_intention(tenant_id: str, keep: str, drop: str, coll: str) -> None:
    """Mueve todo de la intención `drop` a `keep` y elimina `drop`."""
    from core.database import get_worker_pg_session, get_worker_qdrant_client
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    from sqlalchemy import text

    async with get_worker_pg_session(tenant_id) as s:
        keep_id = (await s.execute(text("SELECT id FROM intenciones WHERE label=:l"), {"l": keep})).scalar()
        drop_row = (await s.execute(text("SELECT id FROM intenciones WHERE label=:l"), {"l": drop})).mappings().fetchone()
        if not keep_id or not drop_row:
            return
        drop_id = drop_row["id"]
        # Reasignar ejemplos y consultas al que se conserva.
        await s.execute(text(
            "UPDATE intencion_ejemplos SET intencion_id=:k WHERE intencion_id=:d"
        ), {"k": keep_id, "d": drop_id})
        await s.execute(text(
            "UPDATE consultas_log SET intent_label=:k WHERE intent_label=:d"
        ), {"k": keep, "d": drop})
        # Recalcular example_count del que se conserva.
        await s.execute(text(
            "UPDATE intenciones SET example_count=(SELECT COUNT(*) FROM intencion_ejemplos "
            "WHERE intencion_id=:k AND is_auto_learned=FALSE), updated_at=NOW() WHERE id=:k"
        ), {"k": keep_id})
        # Borrar la intención perdedora.
        await s.execute(text("DELETE FROM intenciones WHERE id=:d"), {"d": drop_id})

    # Re-etiquetar los puntos Qdrant del perdedor al label que se conserva.
    async with get_worker_qdrant_client() as q:
        try:
            await q.set_payload(coll, payload={"label": keep, "intention_id": str(keep_id)},
                                points=Filter(must=[FieldCondition(key="label", match=MatchValue(value=drop))]))
        except Exception as exc:
            logger.warning("merge_qdrant_relabel_failed tenant=%s drop=%s err=%s", tenant_id, drop, exc)


async def absorb_fragmented_intentions(tenant_id: str, confidence_min: float = 0.7) -> dict:
    """Limpieza única: fusiona intenciones fragmentadas (por médico/especialidad,
    duplicados) en sus intenciones "padre" usando el clasificador LLM.

    Para cada intención (de menor a mayor cantidad de ejemplos) le pregunta al LLM
    si pertenece a una intención con MÁS ejemplos; si sí (conf ≥ min), la fusiona
    con `_merge_intention` (mueve ejemplos + relabel consultas + borra + Qdrant).
    Las genuinamente distintas devuelven 'NUEVA' y se conservan. Idempotente.
    """
    from core.database import get_worker_pg_session
    from services.groq_client import match_existing_intention
    from sqlalchemy import text

    coll = f"{tenant_id}_intenciones"
    async with get_worker_pg_session(tenant_id) as s:
        rows = (await s.execute(text(
            "SELECT label, example_count FROM intenciones WHERE is_active = TRUE "
            "ORDER BY example_count ASC"
        ))).fetchall()
    counts = {r[0]: (r[1] or 0) for r in rows}
    order = [r[0] for r in rows]           # menor → mayor
    absorbed: dict[str, str] = {}
    summary = {"tenant_id": tenant_id, "absorbed": [], "kept": 0}

    for label in order:
        if label in absorbed:
            continue
        # candidatos = intenciones con MÁS ejemplos (padres potenciales), no absorbidas
        targets = [l for l in order
                   if l not in absorbed and l != label and counts[l] > counts[label]]
        if not targets:
            summary["kept"] += 1
            continue
        # ejemplos de esta intención
        async with get_worker_pg_session(tenant_id) as s:
            ex = [r[0] for r in (await s.execute(text(
                "SELECT e.question_text FROM intencion_ejemplos e "
                "JOIN intenciones i ON i.id = e.intencion_id "
                "WHERE i.label = :l LIMIT 10"
            ), {"l": label})).fetchall()]
        if not ex:
            summary["kept"] += 1
            continue
        m = await match_existing_intention(ex, targets)
        if m.get("belongs_to") and m.get("confidence", 0) >= confidence_min:
            keep = m["belongs_to"]
            await _merge_intention(tenant_id, keep, label, coll)
            absorbed[label] = keep
            summary["absorbed"].append({"drop": label, "keep": keep, "conf": m["confidence"]})
            logger.info("absorb_fragmented tenant=%s %s → %s conf=%.2f",
                        tenant_id, label, keep, m["confidence"])
        else:
            summary["kept"] += 1

    # Reentrenar el clasificador con el set limpio.
    if summary["absorbed"]:
        try:
            from workers.training_tasks import retrain_intent_classifier
            retrain_intent_classifier.apply_async(args=[tenant_id], queue="training", countdown=5)
        except Exception as exc:
            logger.warning("absorb_retrain_trigger_failed tenant=%s error=%s", tenant_id, exc)
    return summary


async def _uniquify_label(tenant_id: str, label: str) -> str:
    """Evita fusionar temas DISTINTOS bajo el mismo label.

    Este camino corre solo para clusters que la absorción ya descartó ("no
    pertenece a ninguna intención existente"). Si aun así el label del LLM
    colisiona con una intención existente, fusionar sería contradictorio: el
    ON CONFLICT del insert mezclaría ejemplos de dos temas en silencio. En ese
    caso agregamos sufijo numérico y dejamos el merge (si corresponde) al admin
    o a consolidate_intentions, que compara centroides antes de fusionar.
    """
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    label = label[:90]
    try:
        async with get_worker_pg_session(tenant_id) as session:
            rows = (await session.execute(
                text("SELECT label FROM intenciones WHERE label LIKE :prefix"),
                {"prefix": f"{label}%"},
            )).fetchall()
    except Exception as exc:
        # Fail-open al comportamiento previo (merge por ON CONFLICT): peor caso
        # conocido, pero no bloquea la promoción por un fallo de lectura.
        logger.warning("uniquify_label_check_failed tenant=%s label=%s error=%s",
                       tenant_id, label, exc)
        return label

    existing = {r[0] for r in rows}
    if label not in existing:
        return label
    for i in range(2, 50):
        candidate = f"{label}_{i}"
        if candidate not in existing:
            logger.warning(
                "promotion_label_collision tenant=%s label=%s → %s "
                "(la absorción dijo 'tema nuevo' pero el label ya existe)",
                tenant_id, label, candidate,
            )
            return candidate
    return f"{label}_{uuid.uuid4().hex[:6]}"


async def _index_examples_worker(
    tenant_id: str, intention_id: str, label: str, examples: list[str]
) -> None:
    """Embebe e indexa los ejemplos en la colección de intenciones (contexto worker)."""
    import asyncio
    from core.database import get_worker_qdrant_client
    from qdrant_client.models import PointStruct, VectorParams, Distance
    from services.embeddings import embed_batch

    try:
        from services.intent_examples import qdrant_point_id

        loop = asyncio.get_running_loop()
        vectors = await loop.run_in_executor(None, embed_batch, examples, True)

        points = [
            PointStruct(
                id=qdrant_point_id(intention_id, txt),
                vector=vec,
                payload={"intention_id": intention_id, "label": label, "text": txt},
            )
            for txt, vec in zip(examples, vectors)
            if vec is not None
        ]
        if not points:
            logger.warning("promotion_index_no_vectors tenant_id=%s label=%s", tenant_id, label)
            return

        collection = f"{tenant_id}_intenciones"
        async with get_worker_qdrant_client() as qdrant:
            try:
                await qdrant.get_collection(collection)
            except Exception:
                await qdrant.create_collection(
                    collection_name=collection,
                    vectors_config=VectorParams(size=1024, distance=Distance.COSINE),
                )
            await qdrant.upsert(collection_name=collection, points=points)
        logger.info("promotion_indexed tenant_id=%s label=%s points=%d", tenant_id, label, len(points))
    except Exception as exc:
        logger.error("promotion_index_failed tenant_id=%s label=%s error=%s", tenant_id, label, exc)
