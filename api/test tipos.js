// /api/test_tipos.js — Prueba distintos valores de keyacci y lostipos
import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const GOOD_IP = '54.195.3.54';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const agency   = process.env.INMOVILLA_AGENCY || '5430_244_ext';
  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL || 'http://fixie:mJDyuli9kcV9Uuq@ventoux.usefixie.com:80';

  const phpRaw = (s) => s.split('').map(c => /[A-Za-z0-9_.\-~]/.test(c) ? c : '%' + c.charCodeAt(0).toString(16).toUpperCase()).join('');

  // Obtener IP buena
  let ip = null;
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
      const candidate = JSON.parse(r).ip;
      if (candidate === GOOD_IP) { ip = candidate; break; }
    } catch(e) {}
  }
  if (!ip) return res.status(502).json({ error: 'IP no válida' });

  // Probar keyacci=1 (venta)
  const resultados = {};
  for (const keyacci of [1, 2, 3, 4, '']) {
    const texto = `${agency};${pass};1;lostipos;paginacion;1;50;${keyacci};precioinmo`;
    const body = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${ip}`;
    try {
      const raw = await fetchViaTunnel(INMOVILLA_URL, body, fixieUrl, 'POST');
      if (!raw.includes('NECESITAMOS') && raw.length > 100) {
        const data = JSON.parse(raw);
        const list = data.paginacion ? data.paginacion.filter(i => i && i.cod_ofer) : [];
        const tipos = [...new Set(list.map(p => p.nbtipo))].slice(0, 5);
        const total = data.paginacion ? data.paginacion[0]?.total : 0;
        resultados[`keyacci_${keyacci || 'vacio'}`] = { total, tipos_muestra: tipos };
      } else {
        resultados[`keyacci_${keyacci || 'vacio'}`] = { error: raw.substring(0, 80) };
      }
    } catch(e) {
      resultados[`keyacci_${keyacci || 'vacio'}`] = { error: e.message };
    }
  }

  return res.status(200).json({ ip, resultados });
}

function fetchViaTunnel(targetUrl, pathOrBody, proxyUrl, method) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy  = new URL(proxyUrl);
    const auth   = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    const socket = net.createConnection(parseInt(proxy.port) || 80, proxy.hostname, () => {
      socket.write([`CONNECT ${target.hostname}:443 HTTP/1.1`,`Host: ${target.hostname}:443`,`Proxy-Authorization: Basic ${auth}`,`User-Agent: Mozilla/5.0`,'',''].join('\r\n'));
    });
    socket.setTimeout(25000, () => { socket.destroy(); reject(new Error('Timeout')); });
    socket.on('error', reject);
    let buf = ''; let ready = false;
    socket.on('data', chunk => {
      if (ready) return;
      buf += chunk.toString();
      if (!buf.includes('\r\n\r\n')) return;
      ready = true;
      const status = parseInt(buf.split('\r\n')[0].split(' ')[1]);
      if (status !== 200) { socket.destroy(); reject(new Error(`CONNECT ${status}`)); return; }
      socket.removeAllListeners('data'); socket.removeAllListeners('error');
      const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
      tlsSocket.setTimeout(25000, () => { tlsSocket.destroy(); reject(new Error('Timeout TLS')); });
      tlsSocket.on('error', reject);
      tlsSocket.on('secureConnect', () => {
        let req;
        if (method === 'POST') {
          req = [`POST ${target.pathname} HTTP/1.1`,`Host: ${target.hostname}`,`Content-Type: application/x-www-form-urlencoded`,`Content-Length: ${Buffer.byteLength(pathOrBody)}`,`Accept: application/json, text/plain, */*`,`User-Agent: Mozilla/5.0`,`Connection: close`,'',pathOrBody].join('\r\n');
        } else {
          req = [`GET ${target.pathname}${pathOrBody || ''} HTTP/1.1`,`Host: ${target.hostname}`,`Accept: application/json`,`User-Agent: Mozilla/5.0`,`Connection: close`,'',''].join('\r\n');
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
        if (hdrs.toLowerCase().includes('transfer-encoding: chunked')) {
          let result = '', pos = 0;
          while (pos < body.length) {
            const le = body.indexOf('\r\n', pos);
            if (le === -1) break;
            const size = parseInt(body.substring(pos, le), 16);
            if (isNaN(size) || size === 0) break;
            result += body.substring(le + 2, le + 2 + size);
            pos = le + 2 + size + 2;
          }
          body = result || body;
        }
        resolve(body.trim());
      });
    });
  });
}
