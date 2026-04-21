// Vercel Serverless Function — API Inmovilla
// Usa un proxy HTTP con IP fija (Webshare u otro)
// Variables de entorno necesarias en Vercel:
//   INMOVILLA_AGENCY  = 5430_244_ext
//   INMOVILLA_PASS    = B57nyC!u5
//   PROXY_URL         = http://usuario:password@proxy.webshare.io:80
//   PROXY_IP          = 1.2.3.4  ← IP fija del proxy (la que autorizas en Inmovilla)

import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;

// key_tipo a EXCLUIR — comercial/industrial
const TIPOS_EXCLUIR = new Set([
  1199, 1299, 1399, 1499, 1599, 1799, 1899, 1999,
  2099, 2199, 2299, 2499, 4499, 5399, 6799, 7699,
  7799, 7899, 7999, 8299, 9599, 9899, 10099, 10199,
  10399, 11499, 11599, 11999, 20699,
]);

const TYPE_MAP = {
  1: 'sale', 13: 'sale', 14: 'sale',
  2: 'rent', 15: 'rent', 16: 'rent', 20: 'rent',
  3: 'transfer', 4: 'sale', 5: 'sale',
  9: 'vacation',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const agency   = process.env.INMOVILLA_AGENCY || '5430_244_ext';
  const pass     = process.env.INMOVILLA_PASS;
  const proxyUrl = process.env.PROXY_URL;
  const proxyIp  = process.env.PROXY_IP;

  if (!pass)     return res.status(500).json({ error: 'INMOVILLA_PASS no configurada' });
  if (!proxyUrl) return res.status(500).json({ error: 'PROXY_URL no configurada' });
  if (!proxyIp)  return res.status(500).json({ error: 'PROXY_IP no configurada' });

  // Modo diagnóstico
  if (req.query?.diag === '1') {
    return await runDiag(res, agency, pass, proxyUrl, proxyIp);
  }

  const phpRaw = (s) => s.split('').map(c => {
    if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  }).join('');

  // Verificar que la IP del proxy es la correcta
  let currentIp = null;
  try {
    const r = await fetchViaProxy('https://api.ipify.org', '?format=json', proxyUrl, 'GET');
    currentIp = JSON.parse(r).ip;
    console.log(`[proxy] IP actual: ${currentIp}, esperada: ${proxyIp}`);
  } catch(e) {
    console.error(`[proxy] No se pudo verificar IP: ${e.message}`);
  }

  if (currentIp && currentIp !== proxyIp) {
    console.warn(`[proxy] IP incorrecta: ${currentIp} (se esperaba ${proxyIp})`);
    // No abortamos — intentamos igualmente, puede que Inmovilla acepte
  }

  // Llamar a Inmovilla: keyacci=1 (venta) y keyacci=2 (alquiler)
  const rawList = [];
  for (const keyacci of [1, 2]) {
    const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;${keyacci};precioinmo`;
    const body  = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${proxyIp}`;
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try {
        const raw = await fetchViaProxy(INMOVILLA_URL, body, proxyUrl, 'POST');
        console.log(`[keyacci=${keyacci} intento ${i+1}] inicio="${raw.substring(0, 80)}"`);
        if (!raw.includes('NECESITAMOS') && raw.trim().length > 100) {
          const parsed = parseProperties(raw);
          console.log(`[keyacci=${keyacci}] parseadas: ${parsed.length}`);
          rawList.push(...parsed);
          ok = true;
        } else {
          console.warn(`[keyacci=${keyacci} intento ${i+1}] inválida: ${raw.substring(0, 120)}`);
        }
      } catch(e) {
        console.error(`[keyacci=${keyacci} intento ${i+1}] error: ${e.message}`);
      }
    }
  }

  if (rawList.length === 0) {
    return res.status(502).json({
      error: 'No se pudo obtener propiedades de Inmovilla',
      proxy_ip: currentIp,
      hint: 'Abre /api/properties?diag=1 para más info'
    });
  }

  const agencyNum = agency.split('_')[0]; // "5430"

  // Deduplicar por cod_ofer
  const seen = new Set();
  const unique = rawList.filter(p => {
    const id = p.cod_ofer || p.codofer || p.id;
    if (!id || seen.has(String(id))) return false;
    seen.add(String(id));
    return true;
  });

  console.log(`[total] rawList=${rawList.length}, unique=${unique.length}`);

  const properties = unique
    .filter(p => p && (!p.nodisponible || p.nodisponible == 0))
    .filter(p => !TIPOS_EXCLUIR.has(Number(p.key_tipo)))
    .map(p => mapProperty(p, agencyNum));

  console.log(`[total] tras filtros: ${properties.length}`);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    properties,
    total: properties.length,
    proxy_ip: currentIp,
    updated: new Date().toISOString()
  });
}

function parseProperties(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (data?.paginacion && Array.isArray(data.paginacion)) {
    return data.paginacion.filter(item => item && item.cod_ofer !== undefined);
  } else if (Array.isArray(data)) {
    return data.filter(item => item && typeof item === 'object' && item.cod_ofer !== undefined);
  } else {
    for (const k of ['ofertas', 'inmuebles', 'data', 'properties']) {
      if (data[k] && Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

function mapProperty(p, agency) {
  const cod = p.cod_ofer || p.codofer || p.id || '';
  const fl  = p.fotoletra || p.foto_letra || '';
  const nf  = parseInt(p.numfotos) || 0;
  const imgs = [];
  if (nf > 0 && fl && cod) {
    for (let i = 1; i <= Math.min(nf, 20); i++) {
      imgs.push(`https://fotos15.apinmo.com/${agency}/${cod}/${fl}-${i}.jpg`);
    }
  }

  const tipoAcci = Number(p.keyacci || p.key_acci || 2);
  const type = TYPE_MAP[tipoAcci] || 'rent';
  const keyTipo = Number(p.key_tipo || 0);
  const subtype = getSubtype(keyTipo, p.nbtipo || '');
  const price = parseFloat(p.precioinmo || p.precioalq || p.precio || 0);

  return {
    id: cod,
    reference: p.ref || String(cod),
    type,
    subtype,
    key_tipo: keyTipo,
    nbtipo: p.nbtipo || '',
    title: p.nbtipo
      ? `${p.nbtipo} en ${p.zona || p.ciudad || 'Pontevedra'}`
      : `Inmueble en ${p.zona || p.ciudad || 'Pontevedra'}`,
    description: p.observaciones || p.descripcion || '',
    price,
    price_alquiler: parseFloat(p.precioalq) || null,
    price_night: parseFloat(p.precio_noche || 0) || null,
    location: [p.ciudad, p.zona].filter(Boolean).join(' · ') || 'Pontevedra',
    address: [p.calle, p.numero, p.ciudad].filter(Boolean).join(', '),
    bedrooms: parseInt(p.habitaciones) || 0,
    bathrooms: parseInt(p.banyos || p.banios || p.sumaseos) || 0,
    surface: parseInt(p.m_cons || p.superficie || p.sup_cons) || 0,
    floor: (p.planta != null && p.planta !== '') ? `${p.planta}º` : '',
    garage: p.garaje == 1 || p.parking == 1,
    lift: p.ascensor == 1,
    exclusive: p.exclu == 1 || p.exclusiva == 1,
    featured: p.destacado == 1,
    available: !p.nodisponible || p.nodisponible == 0,
    lat: parseFloat(p.latitud) || null,
    lng: parseFloat(p.altitud) || null,
    agent: p.nombreagente ? `${p.nombreagente} ${p.apellidosagente || ''}`.trim() : null,
    agent_phone: p.telefono1agente || null,
    agent_email: p.emailagente || null,
    features: buildFeatures(p),
    images: imgs,
    video_url: p.video || p.url_video || null,
    virtual_tour_url: p.url_tour || null,
    floor_plan_url: p.url_plano || null,
  };
}

function getSubtype(keyTipo, nbtipo) {
  const map = {
    199:'adosado',    299:'bungalow',    399:'casa',
    499:'chalet',     999:'adosado',     1099:'chalet',
    2399:'garaje',    2599:'garaje',     2699:'trastero',
    2799:'apartamento', 2899:'atico',    2999:'duplex',
    3099:'estudio',   3199:'habitacion', 3299:'loft',
    3399:'piso',      3499:'planta_baja',3599:'triplex',
    3699:'finca',     3799:'terreno',    3899:'solar',
    3999:'terreno',   4099:'terreno',    4199:'terreno',
    4399:'atico',     4599:'casa',       4699:'atico',
    4799:'atico',     4999:'chalet',     5099:'terreno',
    5299:'sotano',    5499:'bungalow',   5699:'chalet',
    5799:'casa',      5999:'casa',       6099:'casa',
    6299:'casa',      6499:'chalet',     6699:'pazo',
    6899:'casa',      7099:'casa',       7599:'casa',
    8699:'finca',     8799:'terreno',    8899:'finca',
    8999:'finca',     9099:'terreno',    9699:'piso',
    10999:'terreno',  11099:'finca',     11199:'finca',
    11299:'finca',    11399:'finca',     11699:'casa',
    11899:'finca',    20099:'chalet',    20199:'finca',
    20299:'casa',     20399:'finca',     20899:'solar',
    20999:'atico',    21099:'duplex',    21199:'casa',
    21399:'chalet',
  };
  if (map[keyTipo]) return map[keyTipo];
  const nb = (nbtipo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (nb.includes('piso'))         return 'piso';
  if (nb.includes('apartamento'))  return 'apartamento';
  if (nb.includes('atico'))        return 'atico';
  if (nb.includes('chalet'))       return 'chalet';
  if (nb.includes('casa'))         return 'casa';
  if (nb.includes('duplex'))       return 'duplex';
  if (nb.includes('adosado'))      return 'adosado';
  if (nb.includes('terreno') || nb.includes('solar') || nb.includes('parcela')) return 'terreno';
  if (nb.includes('garaje'))       return 'garaje';
  return 'otro';
}

function buildFeatures(p) {
  const f = [];
  if (p.terraza == 1)                              f.push('Terraza');
  if (p.jardin == 1)                               f.push('Jardín');
  if (p.piscina_com == 1 || p.piscina_prop == 1)   f.push('Piscina');
  if (p.garaje == 1)                               f.push('Garaje');
  if (p.parking == 1)                              f.push('Parking');
  if (p.ascensor == 1)                             f.push('Ascensor');
  if (p.trastero == 1)                             f.push('Trastero');
  if (p.aire_con == 1)                             f.push('Aire acondicionado');
  if (p.muebles == 1)                              f.push('Amueblado');
  if (p.calefaccion == 1)                          f.push('Calefacción');
  if (p.electro == 1)                              f.push('Electrodomésticos');
  return f;
}

async function runDiag(res, agency, pass, proxyUrl, proxyIp) {
  const phpRaw = (s) => s.split('').map(c =>
    /[A-Za-z0-9_.\-~]/.test(c) ? c : '%' + c.charCodeAt(0).toString(16).toUpperCase()
  ).join('');

  let currentIp = 'error';
  try {
    const r = await fetchViaProxy('https://api.ipify.org', '?format=json', proxyUrl, 'GET');
    currentIp = JSON.parse(r).ip;
  } catch(e) { currentIp = e.message; }

  const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;5;1;precioinmo`;
  const body  = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${proxyIp}`;
  let raw = 'error';
  try { raw = await fetchViaProxy(INMOVILLA_URL, body, proxyUrl, 'POST'); } catch(e) { raw = e.message; }

  let items = [];
  try {
    const d = JSON.parse(raw);
    items = (d?.paginacion || []).filter(i => i?.cod_ofer);
  } catch {}

  const firstItem = items[0] || null;
  return res.status(200).json({
    proxy_ip_actual: currentIp,
    proxy_ip_configurada: proxyIp,
    ip_coincide: currentIp === proxyIp ? '✅ sí' : '❌ no coinciden',
    inmovilla_acepta: !raw.includes('NECESITAMOS') ? '✅ sí' : '❌ no — IP no autorizada en Inmovilla',
    param_enviado: body.substring(0, 200),
    respuesta_inicio: raw.substring(0, 400),
    total_items_raw: items.length,
    primer_inmueble_campos: firstItem ? Object.keys(firstItem) : null,
    primer_inmueble: firstItem,
  });
}

// ── fetchViaProxy — proxy HTTP CONNECT estándar ────────────────────────────
function fetchViaProxy(targetUrl, pathOrBody, proxyUrl, method) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy  = new URL(proxyUrl);
    const auth   = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');

    const socket = net.createConnection(parseInt(proxy.port) || 80, proxy.hostname, () => {
      socket.write([
        `CONNECT ${target.hostname}:443 HTTP/1.1`,
        `Host: ${target.hostname}:443`,
        `Proxy-Authorization: Basic ${auth}`,
        `User-Agent: Mozilla/5.0`,
        '', ''
      ].join('\r\n'));
    });

    socket.setTimeout(25000, () => { socket.destroy(); reject(new Error('Timeout socket')); });
    socket.on('error', reject);

    let buf = ''; let ready = false;
    socket.on('data', chunk => {
      if (ready) return;
      buf += chunk.toString();
      if (!buf.includes('\r\n\r\n')) return;
      ready = true;

      const status = parseInt(buf.split('\r\n')[0].split(' ')[1]);
      if (status !== 200) { socket.destroy(); reject(new Error(`CONNECT ${status}`)); return; }

      socket.removeAllListeners('data');
      socket.removeAllListeners('error');

      const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
      tlsSocket.setTimeout(25000, () => { tlsSocket.destroy(); reject(new Error('Timeout TLS')); });
      tlsSocket.on('error', reject);

      tlsSocket.on('secureConnect', () => {
        let req;
        if (method === 'POST') {
          req = [
            `POST ${target.pathname} HTTP/1.1`,
            `Host: ${target.hostname}`,
            `Content-Type: application/x-www-form-urlencoded`,
            `Content-Length: ${Buffer.byteLength(pathOrBody)}`,
            `Accept: text/xml,application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8,image/png,*/*;q=0.5`,
            `Cache-Control: max-age=0`,
            `Connection: keep-alive`,
            `Keep-Alive: 300`,
            `Accept-Charset: ISO-8859-1,utf-8;q=0.7,*;q=0.7`,
            `Accept-Language: en-us,en;q=0.5`,
            `Pragma: `,
            `User-Agent: Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.8.1.3) Gecko/20070309 Firefox/2.0.0.3`,
            '', pathOrBody
          ].join('\r\n');
        } else {
          req = [
            `GET ${target.pathname}${pathOrBody || ''} HTTP/1.1`,
            `Host: ${target.hostname}`,
            `Accept: application/json`,
            `User-Agent: Mozilla/5.0`,
            `Connection: close`,
            '', ''
          ].join('\r\n');
        }
        tlsSocket.write(req);
      });

      let resp = '';
      tlsSocket.on('data', d => resp += d.toString());
      tlsSocket.on('end', () => {
        const sep = resp.indexOf('\r\n\r\n');
        if (sep === -1) { resolve(resp.trim()); return; }
        const hdrs = resp.substring(0, sep);
        let body = resp.substring(sep + 4);
        if (hdrs.toLowerCase().includes('transfer-encoding: chunked')) body = dechunk(body);
        resolve(body.trim());
      });
    });
  });
}

function dechunk(data) {
  let result = '', pos = 0;
  while (pos < data.length) {
    const le = data.indexOf('\r\n', pos);
    if (le === -1) break;
    const size = parseInt(data.substring(pos, le), 16);
    if (isNaN(size) || size === 0) break;
    result += data.substring(le + 2, le + 2 + size);
    pos = le + 2 + size + 2;
  }
  return result || data;
}
