// /api/raw.js — Diagnóstico completo de la API Inmovilla
// Muestra el JSON raw completo cuando pilla la IP buena
// Uso: /api/raw?n=5  (muestra los primeros 5 inmuebles, por defecto 3)
// Uso: /api/raw?keyacci=2  (alquiler en vez de venta)
// Uso: /api/raw?full=1  (muestra TODO el raw sin parsear)

import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;
const GOOD_IP = '54.195.3.54';
const BAD_IP  = '54.217.142.99';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const agency   = process.env.INMOVILLA_AGENCY || '5430_244_ext';
  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL;

  if (!pass)     return res.status(500).json({ error: 'INMOVILLA_PASS no configurada' });
  if (!fixieUrl) return res.status(500).json({ error: 'FIXIE_URL no configurada' });

  const n       = parseInt(req.query?.n) || 3;
  const keyacci = parseInt(req.query?.keyacci) || 1;
  const full    = req.query?.full === '1';

  const phpRaw = (s) => s.split('').map(c => {
    if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  }).join('');

  // ── 1. Buscar IP buena (hasta 20 intentos) ──
  let ip = null;
  let ipAttempts = [];
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
      const candidate = JSON.parse(r).ip;
      ipAttempts.push(candidate);
      if (candidate === GOOD_IP) { ip = candidate; break; }
    } catch(e) {
      ipAttempts.push('error: ' + e.message);
    }
  }

  const ipStats = {
    intentos: ipAttempts.length,
    ip_encontrada: ip || 'ninguna — siempre salió la mala',
    ip_buena: GOOD_IP,
    ip_mala: BAD_IP,
    secuencia: ipAttempts,
    distribucion: {
      buenas: ipAttempts.filter(x => x === GOOD_IP).length,
      malas:  ipAttempts.filter(x => x === BAD_IP).length,
      errores: ipAttempts.filter(x => x.startsWith('error')).length,
    }
  };

  if (!ip) {
    return res.status(200).json({
      status: '❌ IP buena no encontrada en 20 intentos',
      ip_stats: ipStats,
      consejo: 'Inmovilla necesita autorizar también la IP ' + BAD_IP,
    });
  }

  // ── 2. Llamar a Inmovilla ──
  const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;${keyacci};precioinmo`;
  const body  = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${ip}`;

  let raw = '';
  let fetchError = null;
  try {
    raw = await fetchViaTunnel(INMOVILLA_URL, body, fixieUrl, 'POST');
  } catch(e) {
    fetchError = e.message;
  }

  if (fetchError) {
    return res.status(200).json({
      status: '❌ Error al conectar con Inmovilla',
      error: fetchError,
      ip_stats: ipStats,
    });
  }

  if (raw.includes('NECESITAMOS')) {
    return res.status(200).json({
      status: '❌ Inmovilla rechazó la IP',
      ip_usada: ip,
      respuesta_raw: raw.substring(0, 300),
      ip_stats: ipStats,
    });
  }

  // ── 3. Parsear ──
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(raw);
  } catch(e) {
    parseError = e.message;
  }

  if (full) {
    return res.status(200).json({
      status: '✅ OK — raw completo',
      ip_stats: ipStats,
      keyacci,
      raw_length: raw.length,
      raw_completo: parsed || raw,
    });
  }

  // ── 4. Analizar estructura ──
  let items = [];
  let metadata = null;
  let estructuraDetectada = 'desconocida';

  if (parsed?.paginacion && Array.isArray(parsed.paginacion)) {
    estructuraDetectada = 'paginacion[]';
    // El primer elemento suele ser metadata
    const first = parsed.paginacion[0];
    if (first && (first.posicion !== undefined || first.elementos !== undefined || first.total !== undefined)) {
      metadata = first;
      items = parsed.paginacion.slice(1).filter(i => i?.cod_ofer !== undefined);
    } else {
      items = parsed.paginacion.filter(i => i?.cod_ofer !== undefined);
    }
  } else if (Array.isArray(parsed)) {
    estructuraDetectada = 'array directo';
    items = parsed.filter(i => i?.cod_ofer !== undefined);
  } else if (parsed) {
    for (const k of ['ofertas', 'inmuebles', 'data', 'properties']) {
      if (parsed[k] && Array.isArray(parsed[k])) {
        estructuraDetectada = `objeto.${k}[]`;
        items = parsed[k];
        break;
      }
    }
  }

  const muestra = items.slice(0, n);

  // ── 5. Análisis de campos y tipos ──
  const camposPresentes = muestra.length > 0 ? Object.keys(muestra[0]) : [];
  const camposClave = [
    'cod_ofer','key_tipo','nbtipo','keyacci','key_acci',
    'precioinmo','precioalq','precio',
    'habitaciones','banyos','banios','sumaseos',
    'm_cons','superficie','sup_cons',
    'ciudad','zona','calle',
    'fotoletra','foto_letra','numfotos',
    'latitud','altitud',
    'nodisponible','destacado','exclu',
    'observaciones','descripcion',
    'nombreagente','telefono1agente','emailagente',
  ];
  const camposEncontrados = {};
  const camposFaltantes = [];
  camposClave.forEach(c => {
    if (camposPresentes.includes(c)) {
      camposEncontrados[c] = muestra[0]?.[c];
    } else {
      camposFaltantes.push(c);
    }
  });

  // Resumen de tipos en los 200 items
  const resumenTipos = {};
  items.forEach(item => {
    const k = item.key_tipo || 'sin_key_tipo';
    const nb = item.nbtipo || 'sin_nbtipo';
    const key = `${k} — ${nb}`;
    resumenTipos[key] = (resumenTipos[key] || 0) + 1;
  });
  // Ordenar por cantidad
  const tiposOrdenados = Object.entries(resumenTipos)
    .sort((a, b) => b[1] - a[1])
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

  return res.status(200).json({
    status: '✅ OK',
    ip_stats: ipStats,
    keyacci: keyacci === 1 ? '1 (venta)' : keyacci === 2 ? '2 (alquiler)' : keyacci,
    estructura_json: estructuraDetectada,
    metadata_paginacion: metadata,
    total_items_en_respuesta: items.length,
    // Campos encontrados vs esperados
    campos_presentes_en_item: camposPresentes,
    campos_clave_encontrados: camposEncontrados,
    campos_clave_faltantes: camposFaltantes,
    // Resumen de tipos
    resumen_tipos_key_tipo_nbtipo: tiposOrdenados,
    // Muestra de N inmuebles completos
    muestra_inmuebles: muestra,
  });
}

// ── fetchViaTunnel ─────────────────────────────────────────────────────────
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
