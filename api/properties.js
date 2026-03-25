// Vercel Serverless Function — Proxy API Inmovilla
// Archivo: /api/properties.js
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   INMOVILLA_USER   → 5430_244_ext
//   INMOVILLA_PASS   → tu contraseña
//   INMOVILLA_AGENCY → 5430

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;

// Endpoint auxiliar para detectar la IP pública de Vercel
async function getVercelIP() {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const d = await r.json();
    return d.ip;
  } catch {
    try {
      const r2 = await fetch('https://ifconfig.me/ip');
      return (await r2.text()).trim();
    } catch {
      return 'No se pudo detectar';
    }
  }
} // 1 = español

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const agency = process.env.INMOVILLA_AGENCY || '5430';
  const pass   = process.env.INMOVILLA_PASS;
  const user   = process.env.INMOVILLA_USER || agency;

  if (!pass) {
    return res.status(500).json({ error: 'Variable INMOVILLA_PASS no configurada en Vercel' });
  }

  try {
    // Construir el parámetro exactamente como lo hace apiinmovilla.php:
    // "{numagencia};{password};{idioma};lostipos;paginacion;{posinicial};{numelementos};{where};{orden}"
    // Pedimos las primeras 200 propiedades disponibles
    const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
    const encoded = encodeURIComponent(texto);

    // El dominio que enviamos (simula el servidor cliente)
    const dominio = 'user7453729-inmob.vercel.app';

    const body = `param=${encoded}&elDominio=${dominio}&json=1`;

    console.log('[Inmovilla] Llamando a apiweb.php con agencia:', agency);

    const response = await fetch(INMOVILLA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: body
    });

    const raw = await response.text();
    console.log('[Inmovilla] Status:', response.status);
    console.log('[Inmovilla] Respuesta (primeros 300 chars):', raw.substring(0, 300));

    if (!response.ok) {
      return res.status(502).json({
        error: `Inmovilla respondió con estado ${response.status}`,
        detail: raw.substring(0, 400)
      });
    }

    if (!raw || raw.trim().length === 0) {
      const ip = await getVercelIP();
      return res.status(502).json({ error: 'Respuesta vacía — IP no autorizada en Inmovilla', vercel_ip: ip });
    }

    // Intentar parsear como JSON
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Si Inmovilla pide la IP, detectarla y devolverla
      const ip = await getVercelIP();
      return res.status(200).json({
        debug: true,
        raw_preview: raw.substring(0, 200),
        vercel_ip: ip,
        message: 'Inmovilla solicita autorización de IP. Facilita esta IP a soporte@inmovilla.com: ' + ip
      });
    }

    // Normalizar estructura — Inmovilla puede devolver el array directamente
    // o dentro de claves como 'paginacion', 'ofertas', 'inmuebles'
    let list = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (data.paginacion) {
      list = Array.isArray(data.paginacion) ? data.paginacion : Object.values(data.paginacion);
    } else if (data.ofertas) {
      list = Array.isArray(data.ofertas) ? data.ofertas : Object.values(data.ofertas);
    } else if (data.inmuebles) {
      list = Array.isArray(data.inmuebles) ? data.inmuebles : Object.values(data.inmuebles);
    } else {
      // Intentar extraer cualquier array del objeto
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key]) && data[key].length > 0) {
          list = data[key];
          break;
        }
      }
    }

    console.log('[Inmovilla] Propiedades encontradas:', list.length);

    const properties = list
      .filter(p => !p.nodisponible || p.nodisponible == 0)
      .map(p => mapProperty(p, agency));

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      properties,
      total: properties.length,
      updated: new Date().toISOString()
    });

  } catch (err) {
    console.error('[Inmovilla] Excepción:', err.message);
    return res.status(502).json({ error: 'Error conectando con Inmovilla', detail: err.message });
  }
}

function mapProperty(p, agency) {
  const typeMap = {
    1: 'sale', 2: 'rent', 3: 'vacation', 4: 'new_build',
    '1': 'sale', '2': 'rent', '3': 'vacation', '4': 'new_build'
  };
  const subtypeMap = {
    '1': 'piso', '2': 'piso', '3': 'chalet', '4': 'chalet',
    '5': 'local', '6': 'local', '7': 'chalet', '8': 'piso', '9': 'local'
  };

  const codOfer   = p.cod_ofer || p.codofer || p.id || '';
  const fotoletra = p.fotoletra || p.foto_letra || '';
  const numfotos  = parseInt(p.numfotos) || 0;

  // Construir URLs de fotos según formato oficial Inmovilla
  const images = [];
  if (numfotos > 0 && fotoletra && codOfer) {
    for (let i = 1; i <= Math.min(numfotos, 20); i++) {
      images.push(`https://fotos15.inmovilla.com/${agency}/${codOfer}/${fotoletra}-${i}.jpg`);
    }
  }
  if (images.length === 0 && p.fotos) {
    try {
      const fotosObj = typeof p.fotos === 'string' ? JSON.parse(p.fotos) : p.fotos;
      Object.values(fotosObj)
        .sort((a, b) => (a.posicion || 0) - (b.posicion || 0))
        .forEach(f => { if (f.url) images.push(f.url); });
    } catch { /* ignorar */ }
  }

  const keyacci = p.keyacci || p.key_acci || 1;
  const keyTipo = String(p.key_tipo || p.keytipo || '1');
  const price   = parseFloat(p.precioinmo || p.precio || 0);

  return {
    id:               codOfer,
    reference:        p.ref || p.referencia || String(codOfer),
    type:             typeMap[keyacci] || 'sale',
    subtype:          subtypeMap[keyTipo] || 'piso',
    title:            buildTitle(p),
    description:      p.observaciones || p.descripcion || p.desc_es || '',
    price:            price,
    price_night:      parseFloat(p.precio_noche || 0) || null,
    location:         buildLocation(p),
    address:          [p.calle, p.numero, p.municipio].filter(Boolean).join(', '),
    bedrooms:         parseInt(p.habitaciones) || 0,
    bathrooms:        parseInt(p.banyos || p.banios) || 0,
    surface:          parseInt(p.superficie || p.sup_cons) || 0,
    floor:            (p.planta != null && p.planta !== '') ? `${p.planta}º` : '',
    garage:           p.garaje == 1 || p.parking == 1,
    lift:             p.ascensor == 1,
    year:             p.antiquedad || p.anyo_construccion || '',
    exclusive:        p.exclusiva == 1,
    available:        true,
    features:         buildFeatures(p),
    images,
    video_url:        p.video || p.url_video || null,
    virtual_tour_url: p.url_tour || p.tour_virtual || null,
    floor_plan_url:   p.url_plano || p.plano || null,
  };
}

function buildTitle(p) {
  const tipos = {
    '1':'Piso','2':'Apartamento','3':'Casa','4':'Chalet',
    '5':'Local','6':'Oficina','7':'Adosado','8':'Estudio','9':'Nave'
  };
  const tipo = tipos[String(p.key_tipo || p.keytipo || '1')] || 'Inmueble';
  const zona = p.zona || p.municipio || 'Pontevedra';
  return `${tipo} en ${zona}`;
}

function buildLocation(p) {
  return [p.municipio, p.zona].filter(Boolean).join(' · ') || 'Pontevedra';
}

function buildFeatures(p) {
  const f = [];
  if (p.terraza   == 1) f.push('Terraza');
  if (p.jardin    == 1) f.push('Jardín');
  if (p.piscina   == 1) f.push('Piscina');
  if (p.garaje    == 1) f.push('Garaje incluido');
  if (p.parking   == 1) f.push('Parking');
  if (p.ascensor  == 1) f.push('Ascensor');
  if (p.trastero  == 1) f.push('Trastero');
  if (p.aire_con  == 1) f.push('Aire acondicionado');
  if (p.calefaccion)    f.push('Calefacción');
  if (p.amueblado == 1) f.push('Amueblado');
  if (p.armarios  == 1) f.push('Armarios empotrados');
  if (p.alarma    == 1) f.push('Alarma');
  if (p.portero   == 1) f.push('Portero automático');
  return f;
}
