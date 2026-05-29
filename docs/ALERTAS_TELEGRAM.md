# Alertas a Telegram — setup en 5 minutos

> Alertmanager está ya configurado y desplegado. Falta solo conectar tu Telegram. Una sola vez.

## 1. Crear el bot

1. En Telegram, buscar `@BotFather`
2. Mandar `/newbot`
3. Nombre del bot: `Intellix Alerts` (o como quieras)
4. Username: `intellix_alerts_bot` (tiene que terminar en `bot`)
5. BotFather te responde con un **token** tipo `1234567890:ABCdefGHI...` — copialo, lo usás en el paso 4.

## 2. Conseguir tu chat_id

1. En Telegram, mandale `/start` a tu nuevo bot (sin esto el bot no te puede mandar mensajes).
2. Después mandale cualquier mensaje al bot, ej. `hola`.
3. En el browser, abrir: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Buscar `"chat":{"id": 12345678` — ese número es tu `chat_id`.

(Si querés que las alertas vayan a un **grupo** en vez de a vos solo: creá el grupo, agregá el bot, mandá un mensaje en el grupo, y en `getUpdates` vas a ver el chat_id del grupo, que es negativo, ej. `-123456789`.)

## 3. Configurar en el VPS

```bash
ssh -i ~/.ssh/mutualyf_vps -p 2251 root@200.58.109.110

# Crear directorio de secrets si no existe
mkdir -p /opt/mutualyf/secrets
chmod 700 /opt/mutualyf/secrets

# Guardar el token (reemplazar TU_TOKEN)
echo "TU_TOKEN" > /opt/mutualyf/secrets/telegram_token
chmod 600 /opt/mutualyf/secrets/telegram_token
```

## 4. Poner el chat_id en alertmanager.yml

```bash
# Reemplazar el placeholder por tu chat_id real
sed -i 's/TELEGRAM_CHAT_ID_PLACEHOLDER/TU_CHAT_ID/' \
  /opt/mutualyf/observability/alertmanager/alertmanager.yml
```

## 5. Levantar Alertmanager + exporters

```bash
cd /opt/mutualyf
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d \
  alertmanager blackbox-exporter cadvisor node-exporter

# Reload prometheus para que recoja las rules nuevas
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart prometheus
```

## 6. Probar que llega

```bash
# Disparar una alerta sintética
curl -X POST http://localhost:9093/api/v2/alerts \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname":"TestAlert","severity":"warning"},
    "annotations": {"summary":"Prueba de Telegram","description":"Si ves esto, funciona."}
  }]'
```

Tenés que recibir en Telegram en <30s un mensaje:
```
🚨 ALERTA
TestAlert (warning)
Prueba de Telegram
Si ves esto, funciona.
```

Tras unos minutos también debería llegar otro con ✅ "RESUELTA" (cuando expire la alerta sintética).

## 7. Verificar que las rules cargaron

http://localhost:9090/alerts (tunel SSH) → tenés que ver los 10+ alerts en estado **OK** (verde). Si alguno está rojo desde el inicio (ej. `DiskAlmostFull`), reviválo según el runbook.

## ¿Qué pasa si Telegram se cae?

Las alertas se loguean en Alertmanager igual (tunel http://localhost:9093 → muestra histórico). Si Telegram está caído >X minutos, agregás un segundo receiver (email vía Mailgun, webhook a Discord, etc.) — copy/paste del bloque `telegram_configs` con otro tipo.

---

## Alertas que están configuradas

| Severidad | Alerta | Cuándo dispara |
|---|---|---|
| 🔴 critical | PlatformDown | `/health` no responde por 2 min |
| 🔴 critical | BackendDown | Backend interno caído |
| 🔴 critical | PostgresDown | PG no responde |
| 🔴 critical | RedisDown | Redis no responde |
| 🟡 warning | HighRagLatencyP95 | p95 RAG > 8s sostenido 5 min |
| 🟡 warning | HighErrorRate5xx | Tasa 5xx > 1% sostenido 5 min |
| 🟡 warning | DiskAlmostFull | Disco > 85% por 10 min |
| 🟡 warning | LowMemory | RAM libre < 5% por 5 min |
| 🟡 warning | HighCpuLoad | Load avg > 4 por core por 10 min |
| 🟡 warning | SslCertExpiringSoon | Cert vence en <14 días |

Para agregar/modificar: editar `observability/prometheus/rules/alerts.yml`, push, y `docker compose ... restart prometheus`.
