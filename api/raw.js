// /api/raw.js — Diagnóstico con paginación
// /api/raw?page=1        → página 1 (50 items)
// /api/raw?page=2        → página 2
// /api/raw?all=1         → TODAS las páginas, resumen completo de tipos (tarda ~30s)
// /api/raw?orden=precio  → ordenar por precio (default)
// /api/raw?orden=fecha   → ordenar por fecha

import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;
const GOOD_IP = '54.195.3.54';
const BAD_IP  = '54.217.142.99';
const PAGE_SIZE = 50;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const agency   = process.env.INMOVILLA_AGENCY || '5430_244_ext';
  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL;

  if (!pass || !fixieUrl) return res.status(500).json({ error: 'Variables de entorno no configuradas' });

  const page  = parseInt(req.query?.page) || 1;
  const all   = req.query?.all === '1';
  const orden = req.query?.orden || 'precioinmo'; // precioinmo | fechaact | ref

  const phpRaw = (s) => s.split('').map(c => {
    if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  }).join('');

  // Buscar IP buena
  let ip = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
      const candidate = JSON.parse(r).ip;
      if (candidate === GOOD_IP) { ip = candidate; break; }
    } catch(e) {}
  }

  if (!ip) {
    return res.status(200).json({
      status: '❌ IP buena no encontrada en 20 intentos',
      consejo: 'Inmovilla necesita autorizar también ' + BAD_IP,
    });
  }

  // Función para pedir una página concreta
  async function fetchPage(pageNum) {
    const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;${pageNum};${PAGE_SIZE};;${orden}`;
    const body  = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${ip}`;
    const raw   = await fetchViaTunnel(INMOVILLA_URL, body, fixieUrl, 'POST');
    if (raw.includes('NECESITAMOS')) throw new Error('IP rechazada: ' + raw.substring(0, 100));
    const parsed = JSON.parse(raw);
    if (!parsed?.paginacion) throw new Error('Estructura inesperada: ' + raw.substring(0, 200));
    const meta  = parsed.paginacion.find(i => i.posicion !== undefined) || parsed.paginacion[0];
    const items = parsed.paginacion.filter(i => i?.cod_ofer !== undefined);
    return { meta, items };
  }

  if (all) {
    // Pedir todas las páginas y hacer resumen completo
    const { meta, items: firstItems } = await fetchPage(1);
    const total     = meta?.total || 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    
    let allItems = [...firstItems];
    for (let p = 2; p <= Math.min(totalPages, 20); p++) {
      try {
        const { items } = await fetchPage(p);
        allItems.push(...items);
      } catch(e) {
        console.error(`[page ${p}] error: ${e.message}`);
        break;
      }
    }

    // Resumen completo de tipos
    const resumenTipos = {};
    allItems.forEach(item => {
      const k  = item.key_tipo || 'sin_key_tipo';
      const nb = item.nbtipo   || 'sin_nbtipo';
      const ka = item.keyacci  || '?';
      const key = `key_tipo:${k} | nbtipo:"${nb}" | keyacci:${ka}`;
      resumenTipos[key] = (resumenTipos[key] || 0) + 1;
    });
    const tiposOrdenados = Object.entries(resumenTipos)
      .sort((a, b) => b[1] - a[1])
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

    // Resumen por keyacci
    const porKeyacci = {};
    allItems.forEach(item => {
      const k = `keyacci:${item.keyacci}`;
      porKeyacci[k] = (porKeyacci[k] || 0) + 1;
    });

    return res.status(200).json({
      status: '✅ OK — resumen completo',
      ip_usada: ip,
      total_segun_api: total,
      total_paginas: totalPages,
      paginas_descargadas: Math.min(totalPages, 20),
      total_items_descargados: allItems.length,
      resumen_por_keyacci: porKeyacci,
      resumen_tipos_completo: tiposOrdenados,
    });
  }

  // Página individual
  const { meta, items } = await fetchPage(page);
  const total      = meta?.total || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const resumenTipos = {};
  items.forEach(item => {
    const k  = item.key_tipo || 'sin_key_tipo';
    const nb = item.nbtipo   || 'sin_nbtipo';
    const key = `${k} — ${nb}`;
    resumenTipos[key] = (resumenTipos[key] || 0) + 1;
  });

  return res.status(200).json({
    status: '✅ OK',
    ip_usada: ip,
    orden,
    pagina: page,
    total_paginas: totalPages,
    total_items_api: total,
    items_en_esta_pagina: items.length,
    resumen_tipos_esta_pagina: resumenTipos,
    muestra_primeros_3: items.slice(0, 3).map(i => ({
      cod_ofer: i.cod_ofer,
      key_tipo: i.key_tipo,
      nbtipo:   i.nbtipo,
      keyacci:  i.keyacci,
      precio:   i.precioinmo || i.precioalq,
      ciudad:   i.ciudad,
      zona:     i.zona,
    })),
  });
}

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
