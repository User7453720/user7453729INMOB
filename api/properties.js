// Vercel Serverless Function — API Inmovilla
import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;
const GOOD_IP = '54.195.3.54';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const agency   = process.env.INMOVILLA_AGENCY || '5430_244_ext';
  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL || 'http://fixie:mJDyuli9kcV9Uuq@ventoux.usefixie.com:80';

  if (!pass) return res.status(500).json({ error: 'INMOVILLA_PASS no configurada' });

  if (req.query && req.query.diag === '1') {
    return await runDiag(res, agency, pass, fixieUrl);
  }

  // phpRawurlencode exacto igual que PHP
  const phpRaw = (s) => s.split('').map(c => {
    if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  }).join('');

  // Buscar la IP buena (hasta 12 intentos)
  let ip = null;
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
      const candidate = JSON.parse(r).ip;
      console.log(`[ip intento ${i+1}] candidata: ${candidate}`);
      if (candidate === GOOD_IP) { ip = candidate; break; }
    } catch(e) {
      console.error(`[ip intento ${i+1}] error: ${e.message}`);
    }
  }

  if (!ip) {
    return res.status(502).json({
      error: 'IP de Fixie no válida tras 12 intentos',
      hint: 'Inmovilla solo acepta 54.195.3.54 — la otra IP aún no está autorizada'
    });
  }

  // Llamar a Inmovilla con la IP buena (3 intentos)
  const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
  const body  = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${ip}`;

  for (let i = 0; i < 3; i++) {
    try {
      const raw = await fetchViaTunnel(INMOVILLA_URL, body, fixieUrl, 'POST');
      console.log(`[inmovilla intento ${i+1}] inicio="${raw.substring(0, 80)}"`);
      if (!raw.includes('NECESITAMOS') && raw.trim().length > 100) {
        return await serveProperties(res, raw, agency);
      }
      console.log(`[inmovilla intento ${i+1}] rechazado: ${raw.substring(0, 80)}`);
    } catch(e) {
      console.error(`[inmovilla intento ${i+1}] error: ${e.message}`);
    }
  }

  return res.status(502).json({ error: 'No se pudo obtener propiedades', hint: '/api/properties?diag=1' });
}

async function serveProperties(res, raw, agency) {
  const agencyNum = agency.split('_')[0];
  let data;
  try { data = JSON.parse(raw); } catch {
    return res.status(200).json({ error: 'JSON invalido', raw: raw.substring(0, 200) });
  }

  let list = [];
  // Inmovilla devuelve {"paginacion":[{posicion,elementos,total},{cod_ofer,...},...]}
  if (data && data.paginacion && Array.isArray(data.paginacion)) {
    list = data.paginacion.filter(item => item && item.cod_ofer !== undefined);
  } else if (Array.isArray(data)) {
    list = data.filter(item => item && typeof item === 'object' && item.cod_ofer !== undefined);
  } else {
    for (const k of ['ofertas', 'inmuebles', 'data', 'properties']) {
      if (data[k] && Array.isArray(data[k])) { list = data[k]; break; }
    }
  }

  const properties = list
    .filter(p => p && (!p.nodisponible || p.nodisponible == 0))
    .map(p => mapProperty(p, agencyNum));

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json({ properties, total: properties.length, updated: new Date().toISOString() });
}

function mapProperty(p, agency) {
  const typeMap = { 1:'sale', 2:'rent', 3:'vacation', 4:'new_build', '1':'sale', '2':'rent', '3':'vacation', '4':'new_build' };
  const cod = p.cod_ofer || p.codofer || p.id || '';
  const fl  = p.fotoletra || p.foto_letra || '';
  const nf  = parseInt(p.numfotos) || 0;
  const imgs = [];
  if (nf > 0 && fl && cod) {
    for (let i = 1; i <= Math.min(nf, 20); i++) imgs.push(`https://fotos15.apinmo.com/${agency}/${cod}/${fl}-${i}.jpg`);
  }

  const tipo = p.keyacci || p.key_acci || 2;
  const type = typeMap[tipo] || 'rent';

  const nbtipo = (p.nbtipo || '').toLowerCase();
  let subtype = 'piso';
  if (nbtipo.includes('local')) subtype = 'local';
  else if (nbtipo.includes('oficina')) subtype = 'oficina';
  else if (nbtipo.includes('nave')) subtype = 'nave';
  else if (nbtipo.includes('chalet') || nbtipo.includes('casa')) subtype = 'chalet';
  else if (nbtipo.includes('atico') || nbtipo.includes('ático')) subtype = 'atico';
  else if (nbtipo.includes('apartamento')) subtype = 'apartamento';
  else if (nbtipo.includes('adosado')) subtype = 'adosado';
  else if (nbtipo.includes('terreno') || nbtipo.includes('solar')) subtype = 'terreno';

  const price = parseFloat(p.precioinmo || p.precioalq || p.precio || 0);

  return {
    id: cod, reference: p.ref || String(cod), type, subtype,
    title: p.nbtipo ? `${p.nbtipo} en ${p.zona || p.ciudad || 'Pontevedra'}` : `Inmueble en ${p.zona || p.ciudad || 'Pontevedra'}`,
    description: p.observaciones || p.descripcion || '',
    price, price_alquiler: parseFloat(p.precioalq) || null, price_night: parseFloat(p.precio_noche || 0) || null,
    location: [p.ciudad, p.zona].filter(Boolean).join(' · ') || 'Pontevedra',
    address: [p.calle, p.numero, p.ciudad].filter(Boolean).join(', '),
    bedrooms: parseInt(p.habitaciones) || 0,
    bathrooms: parseInt(p.banyos || p.banios || p.sumaseos) || 0,
    surface: parseInt(p.m_cons || p.superficie || p.sup_cons) || 0,
    floor: (p.planta != null && p.planta !== '') ? `${p.planta}º` : '',
    garage: p.garaje == 1 || p.parking == 1, lift: p.ascensor == 1,
    exclusive: p.exclu == 1 || p.exclusiva == 1, featured: p.destacado == 1,
    available: !p.nodisponible || p.nodisponible == 0,
    lat: parseFloat(p.latitud) || null, lng: parseFloat(p.altitud) || null,
    agent: p.nombreagente ? `${p.nombreagente} ${p.apellidosagente || ''}`.trim() : null,
    agent_phone: p.telefono1agente || null, agent_email: p.emailagente || null,
    features: (() => {
      const f = [];
      if (p.terraza == 1) f.push('Terraza'); if (p.jardin == 1) f.push('Jardín');
      if (p.piscina_com == 1 || p.piscina_prop == 1) f.push('Piscina');
      if (p.garaje == 1) f.push('Garaje'); if (p.parking == 1) f.push('Parking');
      if (p.ascensor == 1) f.push('Ascensor'); if (p.trastero == 1) f.push('Trastero');
      if (p.aire_con == 1) f.push('Aire acondicionado'); if (p.muebles == 1) f.push('Amueblado');
      if (p.calefaccion == 1) f.push('Calefacción');
      return f;
    })(),
    images: imgs, video_url: p.video || p.url_video || null,
    virtual_tour_url: p.url_tour || null, floor_plan_url: p.url_plano || null,
  };
}

async function runDiag(res, agency, pass, fixieUrl) {
  const phpRaw = (s) => s.split('').map(c => /[A-Za-z0-9_.\-~]/.test(c) ? c : '%' + c.charCodeAt(0).toString(16).toUpperCase()).join('');
  let ip = 'error';
  try {
    const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
    ip = JSON.parse(r).ip;
  } catch(e) { ip = e.message; }
  const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
  const body = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${ip}`;
  let raw = 'error';
  try { raw = await fetchViaTunnel(INMOVILLA_URL, body, fixieUrl, 'POST'); } catch(e) { raw = e.message; }
  const ipOk = ip === GOOD_IP;
  return res.status(200).json({
    ip,
    ip_valida: ipOk ? '✅ correcta' : `❌ no autorizada (la buena es ${GOOD_IP})`,
    param_enviado: body.substring(0, 200),
    respuesta_inicio: raw.substring(0, 300),
    ok: !raw.includes('NECESITAMOS') && raw.length > 100
  });
}

// fetchViaTunnel con headers HTTP idénticos a los que Inmovilla espera
function fetchViaTunnel(targetUrl, pathOrBody, proxyUrl, method) {
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
          // Headers exactos que espera Inmovilla (igual que su cliente PHP original)
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
