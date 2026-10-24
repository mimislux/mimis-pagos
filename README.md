# mimis-pagos — el agente de Mercado Pago

> **Agent Card** · un Worker, una responsabilidad: hablar con Mercado Pago.

## Qué hace

Crea y lee pagos de Mercado Pago. Nada más. No atiende WhatsApp, no recibe webhooks de
Meta, no sabe del catálogo. Es una **capacidad** (cobrar) que se comparte como servicio:
el que la necesita le pide *"creá el link de pago"* y recibe el link, sin tocar la clave.

## Los verbos (endpoints)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/whoami` | responde a qué cuenta apunta el token (prueba de vida) |
| `POST` | `/preferencia` | crea un link de pago (Checkout Pro) y lo devuelve |
| `POST` | `/pago` | lee un pago por su id (para la confirmación por webhook) |

Cuerpo de `/preferencia`: `{ items: [...], external_reference }`.
El `external_reference` es el lazo con el pedido (p. ej. `wa:<teléfono>:<wamid>`): cuando
Mercado Pago avise *"pagado"*, con esa referencia sabemos a quién escribirle.

## Autenticación

Todos los endpoints exigen el header **`x-internal-token`** (un secreto compartido entre
los Workers de la red). El header **`x-mp-modo`** elige el entorno: `sandbox` | `produccion`.

## Webhooks que le llegan a OTROS (no a él)

Este Worker **no recibe** webhooks de Mercado Pago: el aviso de pago va a `mimis-webhooks`
(`/ml/notificaciones`), que a su vez le pide a este Worker que lea el pago (`/pago`).

## Conexiones (service bindings)

- **Consumido por** `mimis-webhooks` vía `env.PAGOS.fetch(...)` — llamada directa dentro de
  la red de Cloudflare, sin pasar por internet público.

## Secretos

- `MELI_TOKEN` / `MELI_TOKEN_TEST` — del Secrets Store (write-only), tokens de MP.
- `INTERNAL_TOKEN` — la llave interna compartida entre los Workers.
