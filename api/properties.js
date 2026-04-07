// Vercel Serverless Function — Proxy API Inmovilla con IP fija via Fixie
// Usa módulos nativos de Node.js — sin dependencias externas
 
import https from 'https';
import http from 'http';
import { URL } from 'url';
 
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
 
  const texto   = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
  const encoded = encodeURIComponent(texto);
  const dominio = 'user7453729-inmob.vercel.app';
  const postBody = `param=${encoded}&elDominio=${dominio}&json=1`;
 
  console.log('[Inmovilla] Llamando via Fixie proxy...');
 
  try {
    const raw = await postViaProxy(INMOVILLA_URL, postBody, fixieUrl);
    console.log('[Inmovilla] Respuesta:', raw.substring(0, 200));
 
    if (raw.includes('NECESITAMOS RECIBIR LA IP')) {
      return res.status(502).json({
        error: 'IP del proxy aún no autorizada en Inmovilla',
        fixie_ips: '54.217.142.99 y 54.195.3.54',
        detail: 'Espera a que Inmovilla confirme que añadió las IPs de Fixie'
      });
    }
 
    if (!raw || raw.trim().length === 0) {
      return res.status(502).json({ error: 'Respuesta vacía de Inmovilla' });
    }
 
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(200).json({ debug: true, raw_preview: raw.substring(0, 300) });
    }
 
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
 
// POST a través del proxy HTTP de Fixie usando módulos nativos de Node.js
function postViaProxy(targetUrl, postData, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy  = new URL(proxyUrl);
 
    const auth = `${proxy.username}:${proxy.password}`;
    const authB64 = Buffer.from(auth).toString('base64');
 
    const options = {
      host: proxy.hostname,
      port: parseInt(proxy.port) || 80,
      method: 'POST',
      path: targetUrl, // Con proxy HTTP, path es la URL completa
      headers: {
        'Host': target.hostname,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Proxy-Authorization': `Basic ${authB64}`
      }
    };
 
    const req = http.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => resolve(data));
    });
 
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timeout conectando al proxy'));
    });
 
    req.write(postData);
    req.end();
  });
}
 
function mapProperty(p, agency) {
  const typeMap    = { 1:'sale',2:'rent',3:'vacation',4:'new_build','1':'sale','2':'rent','3':'vacation','4':'new_build' };
  const subtypeMap = { '1':'piso','2':'piso','3':'chalet','4':'chalet','5':'local','6':'local','7':'chalet','8':'piso','9':'local' };
 
  const codOfer  = p.cod_ofer || p.codofer || p.id || '';
  const fotoletra = p.fotoletra || p.foto_letra || '';
  const numfotos  = parseInt(p.numfotos) || 0;
 
  const images = [];
  if (numfotos > 0 && fotoletra && codOfer) {
    for (let i = 1; i <= Math.min(numfotos, 20); i++) {
      images.push(`https://fotos15.inmovilla.com/${agency}/${codOfer}/${fotoletra}-${i}.jpg`);
    }
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
 
