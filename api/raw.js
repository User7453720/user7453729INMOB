// /api/raw.js — Prueba automática de credenciales y parámetros
// /api/raw        → prueba todas las variantes automáticamente
// /api/raw?page=N → página N con credenciales actuales

import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;
const GOOD_IP = '54.195.3.54';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL;
  if (!pass || !fixieUrl) return res.status(500).json({ error: 'Variables de entorno no configuradas' });

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
  if (!ip) return res.status(200).json({ error: '❌ IP buena no encontrada en 20 intentos' });

  // Función base para hacer una petición
  async function probar(agency, pagina, cantidad, keyacci, orden) {
    const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;${pagina};${cantidad};${keyacci};${orden}`;
    const body  = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${ip}`;
    const raw   = await fetchViaTunnel(INMOVILLA_URL, body, fixieUrl, 'POST');

    if (raw.includes('NECESITAMOS')) return { error: 'IP rechazada', raw: raw.substring(0, 100) };
    if (raw.includes('CREDENCIALES') || raw.includes('ACCESO') || raw.includes('ERROR')) {
      return { error: 'Credenciales rechazadas', raw: raw.substring(0, 200) };
    }

    let parsed;
    try { parsed = JSON.parse(raw); } catch(e) { return { error: 'JSON inválido', raw: raw.substring(0, 200) }; }

    const paginacion = parsed?.paginacion || [];
    const meta  = paginacion.find(i => i.posicion !== undefined);
    const items = paginacion.filter(i => i?.cod_ofer !== undefined);

    // Resumen de tipos
    const tipos = {};
    items.forEach(i => {
      const k = `${i.key_tipo} — ${i.nbtipo} (keyacci:${i.keyacci})`;
      tipos[k] = (tipos[k] || 0) + 1;
    });

    return {
      total_api: meta?.total,
      elementos_pagina: meta?.elementos,
      items_recibidos: items.length,
      tipos_resumen: tipos,
      primer_item: items[0] ? {
        cod_ofer: items[0].cod_ofer,
        key_tipo: items[0].key_tipo,
        nbtipo:   items[0].nbtipo,
        keyacci:  items[0].keyacci,
        precio:   items[0].precioinmo || items[0].precioalq,
        ciudad:   items[0].ciudad,
      } : null,
    };
  }

  // ── PRUEBAS SISTEMÁTICAS ──
  const resultados = {};

  // 1. Credenciales originales con _244_ext, keyacci vacío (sin filtro)
  try {
    resultados['A — 5430_244_ext, sin keyacci, pag1, orden precioinmo'] =
      await probar('5430_244_ext', 1, 50, '', 'precioinmo');
  } catch(e) { resultados['A'] = { error: e.message }; }

  // 2. Solo agencia base 5430 sin sufijo
  try {
    resultados['B — 5430 (sin sufijo), sin keyacci, pag1, orden precioinmo'] =
      await probar('5430', 1, 50, '', 'precioinmo');
  } catch(e) { resultados['B'] = { error: e.message }; }

  // 3. Credenciales originales, keyacci=1 (venta)
  try {
    resultados['C — 5430_244_ext, keyacci=1 (venta), pag1'] =
      await probar('5430_244_ext', 1, 50, 1, 'precioinmo');
  } catch(e) { resultados['C'] = { error: e.message }; }

  // 4. Sin sufijo, keyacci=1 (venta)
  try {
    resultados['D — 5430, keyacci=1 (venta), pag1'] =
      await probar('5430', 1, 50, 1, 'precioinmo');
  } catch(e) { resultados['D'] = { error: e.message }; }

  // 5. Credenciales originales, keyacci=2, orden por fecha (diferente ordenación)
  try {
    resultados['E — 5430_244_ext, keyacci=2, orden fechaact'] =
      await probar('5430_244_ext', 1, 50, 2, 'fechaact');
  } catch(e) { resultados['E'] = { error: e.message }; }

  // 6. Sin sufijo, keyacci=2, orden fecha
  try {
    resultados['F — 5430, keyacci=2, orden fechaact'] =
      await probar('5430', 1, 50, 2, 'fechaact');
  } catch(e) { resultados['F'] = { error: e.message }; }

  // 7. Credenciales originales, página 10 (última), sin keyacci
  try {
    resultados['G — 5430_244_ext, sin keyacci, pag10 (ultima)'] =
      await probar('5430_244_ext', 10, 50, '', 'precioinmo');
  } catch(e) { resultados['G'] = { error: e.message }; }

  // 8. Sin sufijo, página 10
  try {
    resultados['H — 5430, sin keyacci, pag10 (ultima)'] =
      await probar('5430', 10, 50, '', 'precioinmo');
  } catch(e) { resultados['H'] = { error: e.message }; }

  // 9. Probar cantidad 200 (como hacíamos antes)
  try {
    resultados['I — 5430_244_ext, cantidad=200, sin keyacci'] =
      await probar('5430_244_ext', 1, 200, '', 'precioinmo');
  } catch(e) { resultados['I'] = { error: e.message }; }

  // 10. Sin sufijo, cantidad 200
  try {
    resultados['J — 5430, cantidad=200, sin keyacci'] =
      await probar('5430', 1, 200, '', 'precioinmo');
  } catch(e) { resultados['J'] = { error: e.message }; }

  return res.status(200).json({
    ip_usada: ip,
    nota: 'Cada letra es una combinación diferente de credenciales/parámetros. Busca cuál devuelve tipos distintos a locales/oficinas.',
    resultados,
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
