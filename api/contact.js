// Vercel Serverless Function — Formulario de contacto via Web3Forms
// Coloca este archivo en /api/contact.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const key = process.env.WEB3FORMS_KEY;
  if (!key) return res.status(500).json({ error: 'WEB3FORMS_KEY no configurada en Vercel' });

  try {
    // Admite tanto JSON como FormData
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const payload = {
      access_key: key,
      subject: 'Nuevo contacto web — Inmobiliaria Pedrosa',
      from_name: 'Web Inmobiliaria Pedrosa',
      name:    body.nombre    || body.name    || 'Sin nombre',
      email:   body.email     || 'sin-email@inmobiliariapedrosa.com',
      phone:   body.telefono  || body.phone   || '',
      message: body.mensaje   || body.message || '',
      interest:body.interes   || body.tipo    || '',
    };

    const r = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (data.success) {
      return res.status(200).json({ ok: true, message: 'Enviado correctamente' });
    } else {
      console.error('[contact] Web3Forms error:', data);
      return res.status(500).json({ error: 'Error al enviar', detail: data.message });
    }
  } catch (e) {
    console.error('[contact] excepción:', e.message);
    return res.status(500).json({ error: 'Error interno', detail: e.message });
  }
}
