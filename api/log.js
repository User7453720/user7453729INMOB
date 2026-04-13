// /api/log.js — Genera el log exacto que pide Inmovilla
// Abre: https://user7453729-inmob.vercel.app/api/log
 
import net from 'net';
import tls from 'tls';
import https from 'https';
import { URL } from 'url';
 
const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
 
  const agency   = process.env.INMOVILLA_AGENCY || '5430';
  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL || 'http://fixie:mJDyuli9kcV9Uuq@ventoux.usefixie.com:80';
 
  if (!pass) return res.status(500).json({ error: 'INMOVILLA_PASS no configurada' });
 
  // Obtener IP del proxy (la que ve Inmovilla)
  let ipProxy = 'desconocida';
  try {
    const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
    ipProxy = JSON.parse(r).ip;
  } catch(e) { ipProxy = 'error: ' + e.message; }
 
  // Construir parámetro EXACTAMENTE como lo hace apiinmovilla.php
  // PHP: $texto = "$numagencia;$password;$idioma;lostipos;paginacion;1;200;;precioinmo"
  // PHP: $texto = rawurlencode($texto)
  // PHP: $parametros = "param=$texto&elDominio=$_SERVER[SERVER_NAME]"
  // PHP: $campospost = $parametros . "&ia=" . getClientIP()
 
  // PHP rawurlencode NO codifica: letras, números, _, ., -, ~, !
  const phpRawurlencode = (s) => encodeURIComponent(s)
    .replace(/%21/g,'!')  // PHP rawurlencode NO codifica !
    .replace(/%27/g,"'")
    .replace(/%28/g,'(')
    .replace(/%29/g,')')
    .replace(/%2A/g,'*');
 
  const texto     = `${agency};${pass};1;lostipos;paginacion;1;200;;precioinmo`;
  const encoded   = phpRawurlencode(texto);
  const dominio   = 'inmobiliariapedrosa.com';
  const parametros = `param=${encoded}&elDominio=${dominio}&json=1`;
  const campospost = `${parametros}&ia=${ipProxy}`; // exactamente como PHP añade la IP
 
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const id_petition = Math.floor(Math.random() * 900000 + 100000) + '_' + Math.floor(Date.now()/1000);
 
  // Llamar a Inmovilla
  let respuesta = '';
  let error = null;
  try {
    respuesta = await fetchViaTunnel(INMOVILLA_URL, campospost, fixieUrl, 'POST');
  } catch(e) {
    error = e.message;
    respuesta = 'ERROR: ' + e.message;
  }
 
  // Generar log EXACTAMENTE en el formato de apiinmovilla.log de PHP
  const logLinea1 = `${timestamp} - id_petition: ${id_petition} - parametros: ${campospost}`;
  const logLinea2 = `${timestamp} - id_petition: ${id_petition} - respuesta: ${respuesta}`;
  const logCompleto = logLinea1 + '\n' + logLinea2;
 
  // Devolver tanto el log como info adicional para el email
  return res.status(200).json({
    '=== CONTENIDO DEL FICHERO apiinmovilla.log ===': logCompleto,
    log_linea_1_parametros: logLinea1,
    log_linea_2_respuesta: logLinea2,
    '=== INFO ADICIONAL PARA SOPORTE ===': {
      ip_proxy_fixie: ipProxy,
      proxy_es_ip_fixie: ['54.217.142.99','54.195.3.54'].includes(ipProxy),
      url_llamada: INMOVILLA_URL,
      metodo: 'POST',
      dominio_enviado: dominio,
      parametros_sin_password: campospost.replace(pass, '***'),
      respuesta_completa: respuesta,
      error: error
    }
  });
}
 
function fetchDirect(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}
 
function fetchViaTunnel(targetUrl, pathOrBody, proxyUrl, method) {
  return new Promise((resolve, reject) => {
    const target  = new URL(targetUrl);
    const proxy   = new URL(proxyUrl);
    const auth    = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
 
    const socket = net.createConnection(parseInt(proxy.port)||80, proxy.hostname, () => {
      socket.write([
        `CONNECT ${target.hostname}:443 HTTP/1.1`,
        `Host: ${target.hostname}:443`,
        `Proxy-Authorization: Basic ${auth}`,
        `User-Agent: Mozilla/5.0`,
        '', ''
      ].join('\r\n'));
    });
 
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error('Timeout socket')); });
    socket.on('error', reject);
 
    let buf = '', ready = false;
    socket.on('data', chunk => {
      if (ready) return;
      buf += chunk.toString();
      if (!buf.includes('\r\n\r\n')) return;
      ready = true;
 
      const status = parseInt(buf.split('\r\n')[0].split(' ')[1]);
      if (status !== 200) { socket.destroy(); reject(new Error(`CONNECT: ${status}`)); return; }
 
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
 
      const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
      tlsSocket.setTimeout(20000, () => { tlsSocket.destroy(); reject(new Error('Timeout TLS')); });
      tlsSocket.on('error', reject);
 
      tlsSocket.on('secureConnect', () => {
        let httpReq;
        if (method === 'POST') {
          const postData = pathOrBody;
          httpReq = [
            `POST ${target.pathname} HTTP/1.1`,
            `Host: ${target.hostname}`,
            `Content-Type: application/x-www-form-urlencoded`,
            `Content-Length: ${Buffer.byteLength(postData)}`,
            `Accept: text/xml,application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8,image/png,*/*;q=0.5`,
            `Cache-Control: max-age=0`,
            `Connection: keep-alive`,
            `Keep-Alive: 300`,
            `Accept-Charset: ISO-8859-1,utf-8;q=0.7,*;q=0.7`,
            `Accept-Language: en-us,en;q=0.5`,
            `Pragma: `,
            `User-Agent: Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.8.1.3) Gecko/20070309 Firefox/2.0.0.3`,
            '', postData
          ].join('\r\n');
        } else {
          const qs = pathOrBody || '';
          httpReq = [`GET ${target.pathname}${qs} HTTP/1.1`,`Host: ${target.hostname}`,`Accept: application/json`,`Connection: close`,'',''].join('\r\n');
        }
        tlsSocket.write(httpReq);
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
