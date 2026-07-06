# Ambiente de desarrollo LOCAL

Corre backend + frontend + bases de datos en tu PC, **totalmente aislado de
producción y del VPS**. Podés hacer migraciones, romper la base y resetear todo
sin ningún riesgo para el cliente.

## Garantías de aislamiento

- Proyecto Docker propio: `mutualyf_local` (contenedores `local_*`, red y
  volúmenes namespaced). No colisiona con otros proyectos de tu máquina.
- Volúmenes propios (`local_postgres_data`, etc.) — datos separados, vacíos al
  arrancar. Nada compartido con prod.
- `.env.local` apunta **solo a contenedores locales**. No hay ni una URL del VPS.
- Puertos en rango propio para no chocar con otros postgres/redis de tu PC:

  | Servicio | Local | Interno |
  |---|---|---|
  | Frontend | http://localhost:3010 | 3000 |
  | Backend  | http://localhost:8010 | 8000 |
  | Postgres | localhost:5440 | 5432 |
  | Neo4j    | http://localhost:7475 (bolt 7688) | 7474/7687 |
  | Qdrant   | http://localhost:6340 | 6333 |
  | MinIO    | http://localhost:9011 (API 9010) | 9001/9000 |

- **Único dato traído de prod:** las API keys de Groq y OpenAI (para que el bot
  responda). Los passwords de las bases son nuevos y locales.

## Qué NO corre en local (a propósito, para no fundir la PC)

Observability (Prometheus/Grafana/Loki/Jaeger/exporters/cadvisor), TEI reranker,
pgbackrest y nginx. El reranker va desactivado (`RERANKER_ENABLED=false`);
embeddings y LLM salen por API externa (OpenAI/Groq), así que no pesan local.

## Uso

```bash
./scripts/dev-local.sh up          # levanta db + backend + frontend
./scripts/dev-local.sh up-workers  # + celery (para probar ingesta de docs)
./scripts/dev-local.sh logs backend
./scripts/dev-local.sh down        # detiene (conserva datos)
./scripts/dev-local.sh nuke        # detiene y BORRA los datos locales
```

## Migraciones (el objetivo principal)

El backend corre `alembic upgrade head` automáticamente al arrancar. Para
trabajar migraciones a mano:

```bash
./scripts/dev-local.sh migrate                  # aplica pendientes
./scripts/dev-local.sh makemigration "mi cambio"  # autogenera una nueva
./scripts/dev-local.sh psql                     # entrar a la DB local
```

Las migraciones corren **solo contra el Postgres local** (puerto 5440). Es
imposible que toquen la base de producción: `.env.local` no tiene la dirección
del VPS.

## Datos de prueba

El repo trae seeds en `scripts/` (`seed_dev.py`, `seed_demo_scenario.py`,
`seed_full_demo.py`). Arrancás con base vacía + migraciones; si querés un tenant
y datos de ejemplo, corré uno de esos seeds. **No** se copian datos reales de
clientes a local.
