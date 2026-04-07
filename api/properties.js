// Vercel Serverless Function — Proxy API Inmovilla con IP fija via Fixie
// Archivo: /api/properties.js
//
// Variables de entorno en Vercel:
//   INMOVILLA_AGENCY → 5430
//   INMOVILLA_PASS   → tu contraseña
//   FIXIE_URL        → http://fixie:mJDyuli9kcV9Uuq@ventoux.usefixie.com:80
 
const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const agency   = process.env.INMOVILLA_AGENCY || '5430';
  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL || 'http://fixie:mJDyuli9kcV9Uuq@ventoux.usefixie.com:80';
 
  if (!pass) {
    return res.status(500).json({ error: 'Variable INMOVILLA_PASS no configurada en Vercel' });
  }
 
  // Construir parámetro exactamente como apiinmovilla.php
  const texto   = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
  const encoded = encodeURIComponent(texto);
  const dominio = 'user7453729-inmob.vercel.app';
  const body    = `param=${encoded}&elDominio=${dominio}&json=1`;
 
  console.log('[Inmovilla] Llamando via Fixie proxy...');
 
  try {
    // Usar undici con proxy SOCKS/HTTP de Fixie para IP fija
    const { ProxyAgent } = await import('undici');
 
    const proxyAgent = new ProxyAgent(fixieUrl);
 
    const response = await fetch(INMOVILLA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: body,
      dispatcher: proxyAgent
    });
 
    const raw = await response.text();
    console.log('[Inmovilla] Status:', response.status);
    console.log('[Inmovilla] Respuesta:', raw.substring(0, 200));
 
    if (raw.includes('NECESITAMOS RECIBIR LA IP')) {
      return res.status(502).json({
        error: 'IP del proxy no autorizada en Inmovilla',
        detail: 'Facilita las IPs de Fixie a soporte@inmovilla.com',
        raw: raw
      });
    }
 
    if (!raw || raw.trim().length === 0) {
      return res.status(502).json({ error: 'Respuesta vacía de Inmovilla' });
    }
 
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(200).json({
        debug: true,
        raw_preview: raw.substring(0, 300),
        message: 'Respuesta no es JSON'
      });
    }
 
    // Normalizar estructura
    let list = [];
    if (Array.isArray(data)) {
      list = data;
    } else {
      for (const key of ['paginacion','ofertas','inmuebles','properties','data']) {
        if (data[key] && Array.isArray(data[key])) { list = data[key]; break; }
        if (data[key] && typeof data[key] === 'object') { list = Object.values(data[key]); break; }
      }
    }
 
    console.log('[Inmovilla] Propiedades:', list.length);
 
    const properties = list
      .filter(p => !p.nodisponible || p.nodisponible == 0)
      .map(p => mapProperty(p, agency));
 
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ properties, total: properties.length, updated: new Date().toISOString() });
 
  } catch (err) {
    console.error('[Inmovilla] Error:', err.message);
    return res.status(502).json({ error: 'Error conectando con Inmovilla via proxy', detail: err.message });
  }
}
 
function mapProperty(p, agency) {
  const typeMap = { 1:'sale', 2:'rent', 3:'vacation', 4:'new_build', '1':'sale','2':'rent','3':'vacation','4':'new_build' };
  const subtypeMap = { '1':'piso','2':'piso','3':'chalet','4':'chalet','5':'local','6':'local','7':'chalet','8':'piso','9':'local' };
 
  const codOfer   = p.cod_ofer || p.codofer || p.id || '';
  const fotoletra = p.fotoletra || p.foto_letra || '';
  const numfotos  = parseInt(p.numfotos) || 0;
 
  const images = [];
  if (numfotos > 0 && fotoletra && codOfer) {
    for (let i = 1; i <= Math.min(numfotos, 20); i++) {
      images.push(`https://fotos15.inmovilla.com/${agency}/${codOfer}/${fotoletra}-${i}.jpg`);
    }
  }
  if (images.length === 0 && p.fotos) {
    try {
      const fotosObj = typeof p.fotos === 'string' ? JSON.parse(p.fotos) : p.fotos;
      Object.values(fotosObj).sort((a,b)=>(a.posicion||0)-(b.posicion||0)).forEach(f=>{ if(f.url) images.push(f.url); });
    } catch {}
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
    price,
    price_night:      parseFloat(p.precio_noche||0)||null,
    location:         buildLocation(p),
    address:          [p.calle, p.numero, p.municipio].filter(Boolean).join(', '),
    bedrooms:         parseInt(p.habitaciones)||0,
    bathrooms:        parseInt(p.banyos||p.banios)||0,
    surface:          parseInt(p.superficie||p.sup_cons)||0,
    floor:            (p.planta!=null&&p.planta!=='') ? `${p.planta}º` : '',
    garage:           p.garaje==1||p.parking==1,
    lift:             p.ascensor==1,
    year:             p.antiquedad||p.anyo_construccion||'',
    exclusive:        p.exclusiva==1,
    available:        true,
    features:         buildFeatures(p),
    images,
    video_url:        p.video||p.url_video||null,
    virtual_tour_url: p.url_tour||p.tour_virtual||null,
    floor_plan_url:   p.url_plano||p.plano||null,
  };
}
 
function buildTitle(p) {
  const tipos = {'1':'Piso','2':'Apartamento','3':'Casa','4':'Chalet','5':'Local','6':'Oficina','7':'Adosado','8':'Estudio','9':'Nave'};
  return `${tipos[String(p.key_tipo||p.keytipo||'1')]||'Inmueble'} en ${p.zona||p.municipio||'Pontevedra'}`;
}
 
function buildLocation(p) {
  return [p.municipio, p.zona].filter(Boolean).join(' · ') || 'Pontevedra';
}
 
function buildFeatures(p) {
  const f = [];
  if(p.terraza==1)   f.push('Terraza');
  if(p.jardin==1)    f.push('Jardín');
  if(p.piscina==1)   f.push('Piscina');
  if(p.garaje==1)    f.push('Garaje incluido');
  if(p.parking==1)   f.push('Parking');
  if(p.ascensor==1)  f.push('Ascensor');
  if(p.trastero==1)  f.push('Trastero');
  if(p.aire_con==1)  f.push('Aire acondicionado');
  if(p.calefaccion)  f.push('Calefacción');
  if(p.amueblado==1) f.push('Amueblado');
  if(p.armarios==1)  f.push('Armarios empotrados');
  if(p.alarma==1)    f.push('Alarma');
  if(p.portero==1)   f.push('Portero automático');
  return f;
}
