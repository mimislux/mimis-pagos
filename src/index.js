/**
 * mimis-pagos — el agente de Mercado Pago de Mimis Lux.
 *
 * Este Worker tiene UNA sola responsabilidad: hablar con Mercado Pago.
 * No atiende WhatsApp, no recibe webhooks de Meta, no sabe del catálogo.
 * Es un "agente" en el sentido A2A: expone una capacidad (cobrar) y la comparte
 * como servicio, sin entregar la cuenta ni la clave.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINTS (todos exigen el header `x-internal-token`):
 *   GET  /whoami       → a qué cuenta de MP apunta (para verificar el entorno)
 *   POST /preferencia  → crea un link de pago (Checkout Pro) y lo devuelve
 *   POST /pago         → lee un pago por su id (para la confirmación por webhook)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ EXISTE SEPARADO (el fundamento):
 *   El Worker que atiende a los clientes (mimis-webhooks) NO necesita el token de
 *   Mercado Pago. Este Worker sí lo tiene, y lo comparte como SERVICIO: el otro le
 *   pide "creá la preferencia" y recibe el link, sin tocar la clave. Es la regla
 *   "una pieza, una responsabilidad" + "la capacidad se comparte, nunca la cuenta".
 *
 * CÓMO SE LLAMA (la conexión):
 *   Desde mimis-webhooks, por SERVICE BINDING: `env.PAGOS.fetch(request)`.
 *   El service binding es una llamada DENTRO de la red de Cloudflare: no pasa por
 *   internet público, es rápida y el Worker destino no necesita una URL pública.
 *   (Es el equivalente local del "protocolo A2A": dos agentes que se hablan por
 *   mensajes HTTP autenticados, cada uno con su responsabilidad.)
 *
 * AUTENTICACIÓN (defensa en profundidad):
 *   Aunque el binding sea privado, los dos Workers comparten un token interno
 *   (`INTERNAL_TOKEN`). Sin esa llave, nadie le habla a este Worker. Si mañana
 *   este Worker se publica a internet, sigue cerrado.
 */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request, env) {
    // 1 · La puerta: sin el token interno, no se entra.
    if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
      return json({ error: "no autorizado" }, 401);
    }

    const url = new URL(request.url);

    // 2 · El entorno (producción / sandbox) lo elige el Worker que llama, con el
    //     header x-mp-modo. Así el MISMO código sirve para testear y para vender.
    const modo = request.headers.get("x-mp-modo") === "sandbox" ? "sandbox" : "produccion";
    const binding = modo === "sandbox" ? env.MELI_TOKEN_TEST : env.MELI_TOKEN;

    // 3 · /whoami: responde a qué cuenta apunta el token (la primera prueba de vida).
    if (url.pathname === "/whoami") {
      const token = await binding.get();
      const r = await fetch("https://api.mercadolibre.com/users/me", {
        headers: { Authorization: "Bearer " + token },
      });
      const d = await r.json();
      return json({ ok: r.ok, id: d.id, nickname: d.nickname, site: d.site_id, modo });
    }

    // 4 · /preferencia: crea el link de pago. El cuerpo trae { items, external_reference }.
    //     El "external_reference" es el lazo con el pedido (p. ej. "wa:<teléfono>:<wamid>"):
    //     cuando Mercado Pago avise "pagado", con esa referencia sabemos a quién escribirle.
    if (url.pathname === "/preferencia" && request.method === "POST") {
      const { items, external_reference } = await request.json();
      const token = await binding.get();
      const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          external_reference,
          back_urls: {
            success: "https://wa.me/5491165870271?text=pago%20ok",
            failure: "https://wa.me/5491165870271?text=pago%20fallo",
          },
          auto_return: "approved",
          notification_url: "https://wa.mimislux.com/ml/notificaciones",
        }),
      });
      const d = await r.json();
      // En sandbox el checkout se abre en sandbox.mercadopago.com.ar, no en el de producción.
      const link = modo === "sandbox" ? (d.sandbox_init_point || d.init_point) : d.init_point;
      return json({ ok: r.ok, id: d.id, link, error: d.message || null });
    }

    // 5 · /pago: lee un pago por su id. Prueba los DOS tokens (producción y prueba)
    //     hasta que uno lo lea — así funciona en cualquier entorno.
    if (url.pathname === "/pago" && request.method === "POST") {
      const { id } = await request.json();
      let d = null, ok = false;
      for (const b of [env.MELI_TOKEN, env.MELI_TOKEN_TEST]) {
        const t = await b.get();
        const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
          headers: { Authorization: "Bearer " + t },
        });
        if (r.ok) { ok = true; d = await r.json(); break; }
      }
      return json({
        ok,
        status: d?.status,
        amount: d?.transaction_amount,
        currency: d?.currency_id,
        external_reference: d?.external_reference,
      });
    }

    // 6 · Cualquier otra ruta: no existe.
    return json({ error: "no existe" }, 404);
  },
};
