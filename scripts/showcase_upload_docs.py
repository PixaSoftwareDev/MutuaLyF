"""Sube los documentos de scripts/showcase_docs por la API de ingesta REAL del
ambiente (pipeline completo: verificación, chunking, quality gate, embeddings).

Crea un administrador temporal (showcase.admin@intellix.local) solo para
autenticarse, y lo desactiva al terminar. No toca a los usuarios existentes.

Uso (dentro del backend, con los .txt copiados al contenedor):
  docker cp scripts/showcase_docs ia_backend_staging:/tmp/showcase_docs
  docker exec -i -e SHOWCASE_TENANT=intellix ia_backend_staging python - < scripts/showcase_upload_docs.py
"""
import asyncio
import os
import sys
import time
import uuid
from pathlib import Path

import httpx
from sqlalchemy import text

TENANT = os.getenv("SHOWCASE_TENANT", "intellix")
DOCS = Path(os.getenv("SHOWCASE_DOCS", "/tmp/showcase_docs"))
BASE = os.getenv("SHOWCASE_BASE", "http://localhost:8000/api/v1")
ADMIN_EMAIL = "showcase.admin@intellix.local"
ADMIN_PASS = "showcase-" + uuid.uuid4().hex[:12]


async def ensure_admin(active: bool) -> None:
    from core.database import get_pg_session
    from core.security import hash_password
    async with get_pg_session(TENANT) as s:
        row = (await s.execute(text("SELECT id FROM usuarios WHERE email = :e"), {"e": ADMIN_EMAIL})).fetchone()
        if row:
            await s.execute(text("UPDATE usuarios SET is_active = :a, hashed_password = :p WHERE email = :e"),
                            {"a": active, "p": hash_password(ADMIN_PASS), "e": ADMIN_EMAIL})
        elif active:
            await s.execute(text("""
                INSERT INTO usuarios (id, email, name, hashed_password, role, is_active)
                VALUES (:id, :e, 'Showcase (temporal)', :p, 'admin', TRUE)
            """), {"id": str(uuid.uuid4()), "e": ADMIN_EMAIL, "p": hash_password(ADMIN_PASS)})


async def main() -> None:
    # Un solo loop para todo: el pool de la base queda atado al loop que lo
    # creó, y un segundo asyncio.run() falla con "attached to a different loop".
    await ensure_admin(True)
    try:
        h = {"X-Tenant-ID": TENANT}
        with httpx.Client(base_url=BASE, headers=h, timeout=120) as c:
            r = c.post("/auth/login", data={"username": ADMIN_EMAIL, "password": ADMIN_PASS})
            r.raise_for_status()
            tok = r.json()["access_token"]
            c.headers["Authorization"] = f"Bearer {tok}"
            ids = []
            for f in sorted(DOCS.glob("*.txt")):
                r = c.post("/ingest", files={"file": (f.name, f.read_bytes(), "text/plain")})
                if r.status_code >= 300:
                    print(f"  ✗ {f.name}: {r.status_code} {r.text[:120]}")
                    continue
                d = r.json()
                ids.append((d.get("document_id") or d.get("id"), f.name))
                print(f"  ↑ {f.name} → {ids[-1][0]}")
            # Esperar el procesamiento (celery del ambiente)
            for _ in range(60):
                time.sleep(5)
                estados = {}
                for did, name in ids:
                    st = c.get(f"/documents/{did}/status").json()
                    estados[name] = (st.get("status"), st.get("chunk_count"))
                pend = [n for n, (s, _) in estados.items() if s not in ("ready", "failed", "error", "rejected")]
                if not pend:
                    break
            for n, (s, ch) in estados.items():
                print(f"  {s:<10} {ch!s:>4} fragmentos  {n}")
    finally:
        await ensure_admin(False)
        print("admin temporal desactivado")


if __name__ == "__main__":
    sys.path.insert(0, "/app")
    asyncio.run(main())
