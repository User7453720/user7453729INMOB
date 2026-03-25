// Vercel Serverless Function — Reenvío de formularios
// Archivo: /api/contact.js
//
// Envía el formulario a DOS destinos:
//   1. comercial@inmobiliariapedrosa.com  (email propio)
//   2. i.inmobiliariapedrosa.5430.3@inmovilla.com  (CRM Inmovilla)
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   CONTACT_EMAIL_1  → comercial@inmobiliariapedrosa.com
//   CONTACT_EMAIL_2  → i.inmobiliariapedrosa.5430.3@inmovilla.com
//   FORMSPREE_ID     → mwvrgvqd

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const body = req.body || {};

    // Enriquecer con metadata
    const enriched = {
      ...body,
      _fecha: new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
      _origen: 'Web Inmobiliaria Pedrosa',
      _url: 'https://user7453729-inmob.vercel.app'
    };

    const results = [];

    // ── Envío 1: Formspree (reenvía a comercial@inmobiliariapedrosa.com) ──
    const formspreeId = process.env.FORMSPREE_ID || 'mwvrgvqd';
    try {
      const r1 = await fetch(`https://formspree.io/f/${formspreeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(enriched)
      });
      results.push({ destino: 'comercial', ok: r1.ok, status: r1.status });
      console.log('[Contact] Formspree:', r1.status);
    } catch (e) {
      results.push({ destino: 'comercial', ok: false, error: e.message });
    }

    // ── Envío 2: Email interno Inmovilla via Formspree con email override ──
    // Inmovilla acepta leads por email — enviamos una copia al CRM
    const inmobillaEmail = process.env.CONTACT_EMAIL_2 || 'i.inmobiliariapedrosa.5430.3@inmovilla.com';
    try {
      // Usamos el mismo Formspree pero con _replyto al email de Inmovilla
      // para que llegue como lead al CRM
      const inmovilla_payload = {
        ...enriched,
        _replyto: enriched.email || '',
        _subject: `Nuevo lead web: ${enriched.nombre || 'Sin nombre'} — ${enriched.interes || 'Consulta general'}`,
        _cc: inmobillaEmail,
      };
      const r2 = await fetch(`https://formspree.io/f/${formspreeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(inmovilla_payload)
      });
      results.push({ destino: 'inmovilla_crm', ok: r2.ok, status: r2.status });
      console.log('[Contact] Inmovilla CRM:', r2.status);
    } catch (e) {
      results.push({ destino: 'inmovilla_crm', ok: false, error: e.message });
    }

    // Respuesta: éxito si al menos uno llegó correctamente
    const anyOk = results.some(r => r.ok);
    if (anyOk) {
      return res.status(200).json({ ok: true, results });
    } else {
      return res.status(500).json({ ok: false, results });
    }

  } catch (err) {
    console.error('[Contact] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
