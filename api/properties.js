// Diagnóstico definitivo — qué IP ve realmente Inmovilla
// Compara IP sin proxy vs IP con proxy usando el mismo servicio externo

import http from 'http';
import https from 'https';
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

  if (!pass) return res.status(500).json({ error: 'INMOVILLA_PASS no configurada' });

  // 1. IP sin proxy (la que ve cualquier servidor sin proxy)
  let ipSinProxy = 'desconocida';
  try {
    const r = await fetchDirect('https://api.ipify.org?format=json');
    ipSinProxy = JSON.parse(r).ip;
  } catch(e) { ipSinProxy = 'error: '+e.message; }

  // 2. IP con proxy Fixie via tunnel CONNECT correcto
  let ipConProxy = 'desconocida';
  try {
    const r = await fetchViaTunnel('https://api.ipify.org?format=json', '', fixieUrl, 'GET');
    ipConProxy = JSON.parse(r).ip;
  } catch(e) { ipConProxy = 'error: '+e.message; }

  // 3. Probar Inmovilla con proxy
  const texto    = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
  const encoded  = encodeURIComponent(texto);
  const postBody = `param=${encoded}&elDominio=inmobiliariapedrosa.com&json=1`;

  let inmobillaResp = '';
  try {
    inmobillaResp = await fetchViaTunnel(INMOVILLA_URL, postBody, fixieUrl, 'POST');
  } catch(e) { inmobillaResp = 'error: '+e.message; }

  return res.status(200).json({
    ip_sin_proxy: ipSinProxy,
    ip_con_proxy: ipConProxy,
    fixie_ips_esperadas: ['54.217.142.99', '54.195.3.54'],
    proxy_correcto: ['54.217.142.99','54.195.3.54'].includes(ipConProxy),
    inmovilla_respuesta: inmobillaResp.substring(0, 200),
    inmovilla_ok: !inmobillaResp.includes('NECESITAMOS') && inmobillaResp.length > 10
  });
}

// Fetch directo sin proxy
function fetchDirect(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

// Fetch a través de proxy usando CONNECT tunnel (único método correcto para HTTPS)
function fetchViaTunnel(targetUrl, postData, proxyUrl, method) {
  return new Promise((resolve, reject) => {
    const target  = new URL(targetUrl);
    const proxy   = new URL(proxyUrl);
    const auth    = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    const port    = parseInt(proxy.port) || 80;

    // Construir petición CONNECT
    const connectStr = [
      `CONNECT ${target.hostname}:443 HTTP/1.1`,
      `Host: ${target.hostname}:443`,
      `Proxy-Authorization: Basic ${auth}`,
      `User-Agent: Mozilla/5.0`,
      '',
      ''
    ].join('\r\n');

    const socket = require('net').createConnection(port, proxy.hostname, () => {
      socket.write(connectStr);
    });

    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('Timeout socket')); });
    socket.on('error', reject);

    let connectBuf = '';
    socket.on('data', chunk => {
      connectBuf += chunk.toString();

      // Esperar respuesta del CONNECT
      if (connectBuf.includes('\r\n\r\n')) {
        const statusLine = connectBuf.split('\r\n')[0];
        const statusCode = parseInt(statusLine.split(' ')[1]);

        if (statusCode !== 200) {
          socket.destroy();
          reject(new Error(`CONNECT rechazado: ${statusLine}`));
          return;
        }

        // Tunnel establecido — hacer TLS sobre el socket
        socket.removeAllListeners('data');

        const tlsSocket = require('tls').connect({
          socket,
          servername: target.hostname,
          rejectUnauthorized: false
        });

        tlsSocket.on('secureConnect', () => {
          // Construir petición HTTP
          let httpReq;
          if (method === 'POST') {
            httpReq = [
              `POST ${target.pathname} HTTP/1.1`,
              `Host: ${target.hostname}`,
              `Content-Type: application/x-www-form-urlencoded`,
              `Content-Length: ${Buffer.byteLength(postData)}`,
              `Accept: application/json, text/plain, */*`,
              `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)`,
              `Connection: close`,
              '',
              postData
            ].join('\r\n');
          } else {
            httpReq = [
              `GET ${target.pathname}${target.search} HTTP/1.1`,
              `Host: ${target.hostname}`,
              `Accept: application/json`,
              `User-Agent: Mozilla/5.0`,
              `Connection: close`,
              '',
              ''
            ].join('\r\n');
          }

          tlsSocket.write(httpReq);
        });

        let response = '';
        tlsSocket.on('data', d => response += d.toString());
        tlsSocket.on('end', () => {
          // Extraer body HTTP
          const sep = response.indexOf('\r\n\r\n');
          if (sep === -1) { resolve(response); return; }

          const headers = response.substring(0, sep);
          let body = response.substring(sep + 4);

          // Dechunkear si es chunked
          if (headers.toLowerCase().includes('transfer-encoding: chunked')) {
            body = dechunk(body);
          }

          resolve(body.trim());
        });
        tlsSocket.on('error', reject);
        tlsSocket.setTimeout(15000, () => { tlsSocket.destroy(); reject(new Error('Timeout TLS')); });
      }
    });
  });
}

function dechunk(data) {
  let result = '';
  let pos = 0;
  while (pos < data.length) {
    const lineEnd = data.indexOf('\r\n', pos);
    if (lineEnd === -1) break;
    const size = parseInt(data.substring(pos, lineEnd), 16);
    if (isNaN(size) || size === 0) break;
    result += data.substring(lineEnd + 2, lineEnd + 2 + size);
    pos = lineEnd + 2 + size + 2;
  }
  return result || data;
}

function mapProperty(p, agency) { return p; }
function buildTitle(p) { return ''; }
function buildLocation(p) { return ''; }
function buildFeatures(p) { return []; }
