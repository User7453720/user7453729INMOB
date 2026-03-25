// Vercel Serverless Function — Proxy API Inmovilla (apiweb)
// Archivo: /api/properties.js en tu repositorio GitHub
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   INMOVILLA_USER   → 5430_244_ext
//   INMOVILLA_PASS   → tu contraseña
//   INMOVILLA_AGENCY → 5430
 
const BASE = 'http://procesos.inmovilla.com/apiweb';
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const user   = process.env.INMOVILLA_USER;
  const pass   = process.env.INMOVILLA_PASS;
  const agency = process.env.INMOVILLA_AGENCY || '5430';
 
  if (!user || !pass) {
    return res.status(500).json({ error: 'Credenciales no configuradas en Vercel' });
  }
 
  try {
    // Intentar varios endpoints conocidos de la apiweb de Inmovilla
    // hasta encontrar el que funcione con esta cuenta
    const endpoints = [
      `${BASE}/propiedades.php?usuario=${user}&password=${pass}&agencia=${agency}`,
      `${BASE}/ofertas.php?usuario=${user}&password=${pass}&agencia=${agency}`,
      `${BASE}/inmuebles.php?usuario=${user}&password=${pass}&agencia=${agency}`,
      `${BASE}/get_offers.php?usuario=${user}&password=${pass}&agencia=${agency}`,
    ];
 
    let data = null;
    let usedUrl = '';
    let lastError = '';
 
    for (const url of endpoints) {
      try {
        console.log('[Inmovilla] Probando:', url.replace(pass, '***'));
        const r = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json, text/xml, */*' }
        });
        const text = await r.text();
        console.log('[Inmovilla] Status:', r.status, '| Preview:', text.substring(0, 120));
 
        if (r.ok && text && !text.includes('<html') && !text.includes('error') && text.length > 10) {
          // Intentar parsear como JSON
          try {
            data = JSON.parse(text);
            usedUrl = url;
            break;
          } catch {
            // Intentar como XML
            if (text.includes('<') && text.includes('>')) {
              data = parseXML(text);
              usedUrl = url;
              if (data && data.length > 0) break;
            }
          }
        }
        lastError = `${r.status}: ${text.substring(0, 200)}`;
      } catch (e) {
        lastError = e.message;
        console.log('[Inmovilla] Error en', url.replace(pass, '***'), ':', e.message);
      }
    }
 
    if (!data) {
      return res.status(502).json({
        error: 'No se pudo obtener propiedades de Inmovilla',
        detail: lastError,
        hint: 'Verifica que la IP de Vercel está autorizada en Inmovilla y que las credenciales son correctas'
      });
    }
 
    const list = Array.isArray(data) ? data : (data.properties || data.ofertas || data.inmuebles || data.data || []);
    const properties = list.filter(p => !p.nodisponible).map(p => mapProperty(p, agency));
 
    console.log('[Inmovilla] OK —', properties.length, 'propiedades desde', usedUrl.replace(pass,'***'));
 
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ properties, total: properties.length, updated: new Date().toISOString() });
 
  } catch (err) {
    console.error('[Inmovilla] Excepción:', err.message);
    return res.status(502).json({ error: 'Error conectando con Inmovilla', detail: err.message });
  }
}
 
// Parser XML básico para respuestas de Inmovilla en formato XML
function parseXML(xml) {
  try {
    const items = [];
    const itemRegex = /<(?:propiedad|oferta|inmueble)[^>]*>([\s\S]*?)<\/(?:propiedad|oferta|inmueble)>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const obj = {};
      const fieldRegex = /<(\w+)(?:[^>]*)>([^<]*)<\/\1>/g;
      let field;
      while ((field = fieldRegex.exec(block)) !== null) {
        obj[field[1]] = field[2].trim();
      }
      if (Object.keys(obj).length > 0) items.push(obj);
    }
    return items;
  } catch {
    return null;
  }
}
 
function mapProperty(p, agency) {
  const typeMap = {
    '1': 'sale', '2': 'rent', '3': 'vacation', '4': 'new_build',
    'venta': 'sale', 'alquiler': 'rent', 'vacacional': 'vacation', 'obra nueva': 'new_build'
  };
  const subtypeMap = {
    '1': 'piso', '2': 'piso', '3': 'chalet', '4': 'chalet',
    '5': 'local', '6': 'local', '7': 'chalet', '8': 'piso', '9': 'local'
  };
 
  // Construir URLs de fotos
  const images = [];
  const numfotos = parseInt(p.numfotos) || 0;
  const fotoletra = p.fotoletra || p.foto_letra || '';
  const codOfer = p.cod_ofer || p.codofer || p.id || '';
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
 
  const keyacci = String(p.keyacci || p.key_acci || p.operacion || '1');
  const keyTipo = String(p.key_tipo || p.keytipo || p.tipo || '1');
  const price   = parseFloat(p.precioinmo || p.precio || p.price || 0);
 
  return {
    id:               codOfer,
    reference:        p.ref || p.referencia || String(codOfer),
    type:             typeMap[keyacci] || typeMap[keyacci.toLowerCase()] || 'sale',
    subtype:          subtypeMap[keyTipo] || 'piso',
    title:            buildTitle(p),
    description:      p.observaciones || p.descripcion || p.desc_es || p.description || '',
    price:            price,
    price_night:      parseFloat(p.precio_noche || 0) || null,
    location:         buildLocation(p),
    address:          [p.calle, p.numero, p.municipio].filter(Boolean).join(', '),
    bedrooms:         parseInt(p.habitaciones || 0),
    bathrooms:        parseInt(p.banyos || p.banios || 0),
    surface:          parseInt(p.superficie || p.sup_cons || 0),
    floor:            p.planta != null && p.planta !== '' ? `${p.planta}º` : '',
    garage:           p.garaje == 1 || p.parking == 1,
    lift:             p.ascensor == 1,
    year:             p.antiquedad || p.anyo_construccion || '',
    exclusive:        p.exclusiva == 1,
    available:        true,
    features:         buildFeatures(p),
    images:           images,
    video_url:        p.video || p.url_video || null,
    virtual_tour_url: p.url_tour || p.tour_virtual || null,
    floor_plan_url:   p.url_plano || p.plano || null,
  };
}
 
function buildTitle(p) {
  const tipos = { '1':'Piso','2':'Apartamento','3':'Casa','4':'Chalet','5':'Local','6':'Oficina','7':'Adosado','8':'Estudio','9':'Nave' };
  const tipo  = tipos[String(p.key_tipo || p.keytipo || '1')] || 'Inmueble';
  const zona  = p.zona || p.municipio || 'Pontevedra';
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
