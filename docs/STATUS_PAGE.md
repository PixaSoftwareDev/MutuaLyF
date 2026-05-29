# Status page público — UptimeRobot

> 10 minutos de configuración. Te da una URL que podés mandarle al cliente cuando preguntan "¿está caído?". Y a vos un email/SMS si se cae.

## ¿Por qué UptimeRobot y no otro?

- Gratis hasta 50 monitores cada 5 min
- Sin tarjeta para arrancar
- Status page público con dominio propio si querés
- Alertas por email + Telegram + SMS (pagos)

Si después crece, mover a Better Stack / Pingdom es trivial.

## Pasos

### 1. Crear cuenta

https://uptimerobot.com → Sign up con tu email (`alemaros20@gmail.com`).

### 2. Crear monitores (5 mínimos, gratis cubre todos)

**My Settings → New Monitor**

| # | Type | Friendly name | URL | Monitoring interval |
|---|---|---|---|---|
| 1 | HTTPS | Intellix - Front | `https://intellix.com.ar/` | 5 min |
| 2 | HTTPS keyword | Intellix - Backend | `https://intellix.com.ar/health/ready` | 5 min |
| 3 | HTTPS keyword | Intellix - Chat publico | `https://intellix.com.ar/chat` | 5 min |
| 4 | HTTPS keyword | Intellix - Admin login | `https://intellix.com.ar/login` | 5 min |
| 5 | SSL Expiration | Intellix - SSL | `intellix.com.ar` | 1 / day |

Para los "HTTPS keyword" (monitor 2):
- **Keyword type:** exists
- **Keyword value:** `"status":"ok"`

(Eso valida que `/health/ready` no solo responda 200, sino que el JSON diga que todo está sano.)

### 3. Configurar alertas

**My Settings → Alert Contacts → Add Alert Contact**

Mínimo: email tuyo. Recomendado además: Telegram del mismo chat que usé para Alertmanager (así llega todo al mismo lado).

**Telegram en UptimeRobot:**
1. Add Alert Contact → Type: Telegram
2. Te da un link tipo `t.me/UptimeRobot?start=ABC123` — abrirlo en Telegram
3. Si querés que mande al **grupo** en vez de a vos, agregás `@UptimeRobotBot` al grupo y forwardás el `/start ABC123` al grupo

### 4. Asociar contactos a monitores

Para cada monitor: **Edit → Alert Contacts to Notify → seleccionar todos los contactos que querés**.

Tip: para los 5 monitores activar "When Down" y "When SSL Expires < 30 days".

### 5. Crear el Status Page

**Status Pages → Add Status Page**

- **Friendly name:** Intellix Status
- **Custom URL:** `intellix` (te da `stats.uptimerobot.com/intellix`)
- **Monitors:** marcar los 5 de arriba
- **Custom CSS / Branding:** opcional, podés poner el logo de Intellix
- **Show monitor labels:** sí

Resultado: una URL pública que muestra:
- Estado actual de cada componente (verde/rojo)
- Uptime últimos 30 / 60 / 90 días
- Historial de incidentes

### 6. (Opcional) Subdomain propio

Si querés que sea `status.intellix.com.ar`:

1. En UptimeRobot Status Page settings → Custom Domain → `status.intellix.com.ar`
2. En tu DNS (donde tenés intellix.com.ar):
   - Agregar CNAME: `status` → `stats.uptimerobot.com`
3. Esperar 5-30 min a que propague.

## Cómo usarlo en el día a día

- **URL pública para el cliente:** mandala en el email de bienvenida y dejala en el footer del panel admin.
- **Cuando un cliente reclama "está caído":** lo primero que mirás es la status page; si está todo verde, el problema está del lado del cliente.
- **Cuando recibís alerta de UptimeRobot:** revisar antes de tocar nada — a veces es un falso positivo (5 seg de timeout en el polling). Si dura >2 chequeos seguidos (≈10 min), entrá a investigar (ver `RUNBOOK.md`).

## Integración con Alertmanager

UptimeRobot (externo) y Alertmanager (interno) **NO son redundantes — se complementan**:

- **UptimeRobot:** detecta si el VPS entero está caído (red, DNS, certs). Las alertas internas no pueden detectar esto porque están corriendo en el mismo VPS.
- **Alertmanager:** detecta degradación interna (p95 alto, error rate, recursos) que un probe HTTP no ve.

Tener ambos = visibilidad completa.

## Plan pago — cuándo conviene

Cuando tengas >3 clientes que usen la status page como referencia:

- **Pro ($8/mes):** intervalo 1 min, más componentes, status page con dominio propio sin trucos DNS.

Para arrancar piloto con Nexo: **gratis es suficiente**.
