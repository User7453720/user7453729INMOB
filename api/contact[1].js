// Vercel Serverless Function — Formulario de contacto
// Usa Web3Forms (gratuito, sin verificación de dominio)
//
// Variables de entorno en Vercel:
//   WEB3FORMS_KEY   → tu clave de Web3Forms (ver instrucciones abajo)
//   CONTACT_EMAIL_2 → i.inmobiliariapedrosa.5430.3@inmovilla.com
//
// Para obtener tu clave gratuita de Web3Forms:
//   1. Ve a https://web3forms.com
//   2. Escribe comercial@inmobiliariapedrosa.com
//   3. Pulsa "Create Access Key"
//   4. Copia la clave y añádela en Vercel como WEB3FORMS_KEY
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
 
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {
        body = Object.fromEntries(new URLSearchParams(body));
      }
    }
 
    const web3key   = process.env.WEB3FORMS_KEY;
    const emailCRM  = process.env.CONTACT_EMAIL_2 || 'i.inmobiliariapedrosa.5430.3@inmovilla.com';
 
    if (!web3key) {
      // Si no hay clave configurada, intentar Formspree como fallback
      return await sendViaFormspree(req, res, body, emailCRM);
    }
 
    const payload = {
      access_key: web3key,
      subject: `Nuevo contacto web: ${body.nombre || 'Sin nombre'} — ${body.interes || 'Consulta'}`,
      from_name: 'Web Inmobiliaria Pedrosa',
      replyto: body.email || '',
      nombre:   body.nombre   || '',
      telefono: body.telefono || '',
      email:    body.email    || '',
      interes:  body.interes  || '',
      mensaje:  body.mensaje  || body.message || '',
      cc:       emailCRM,
      fecha:    new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })
    };
 
    console.log('[Contact] Enviando via Web3Forms');
 
    const response = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
 
    const data = await response.json();
    console.log('[Contact] Web3Forms response:', response.status, JSON.stringify(data));
 
    if (response.ok && data.success) {
      return res.status(200).json({ ok: true, message: 'Mensaje enviado correctamente' });
    } else {
      console.error('[Contact] Web3Forms error:', data);
      return res.status(500).json({ ok: false, error: data.message || 'Error al enviar' });
    }
 
  } catch (err) {
    console.error('[Contact] Excepción:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
 
async function sendViaFormspree(req, res, body, emailCRM) {
  const formspreeId = process.env.FORMSPREE_ID || '6f4ea264-2063-40c0-b494-e14caf544e47';
 
  const payload = {
    nombre:   body.nombre   || '',
    telefono: body.telefono || '',
    email:    body.email    || '',
    interes:  body.interes  || '',
    mensaje:  body.mensaje  || '',
    _subject: `Nuevo contacto: ${body.nombre || 'Sin nombre'}`,
    _replyto: body.email || '',
    _cc:      emailCRM
  };
 
  try {
    const r = await fetch(`https://formspree.io/f/${formspreeId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Referer': 'https://user7453729-inmob.vercel.app'
      },
      body: JSON.stringify(payload)
    });
 
    const text = await r.text();
    console.log('[Contact] Formspree fallback:', r.status, text.substring(0, 200));
 
    if (r.ok) {
      return res.status(200).json({ ok: true });
    } else {
      return res.status(500).json({ ok: false, detail: text.substring(0, 200) });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
 
