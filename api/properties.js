// Vercel Serverless Function — Proxy API Inmovilla con Fixie
// Solo ES modules, sin require()

import net from 'net';
import tls from 'tls';
import https from 'https';
import { URL } from 'url';

const INMOVILLA_URL = 'https://apiweb.inmovilla.com/apiweb/apiweb.php';
const IDIOMA = 1;
const DOMINIOS = [
  'inmobiliariapedrosa.com',
  'www.inmobiliariapedrosa.com',
  'user7453729-inmob.vercel.app',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const agency   = process.env.INMOVILLA_AGENCY || '5430';
  const pass     = process.env.INMOVILLA_PASS;
  const fixieUrl = process.env.FIXIE_URL || 'http://fixie:mJDyuli9kcV9Uuq@ventoux.usefixie.com:80';

  if (!pass) return res.status(500).json({ error: 'INMOVILLA_PASS no configurada' });

  // 1. IP sin proxy
  let ipSinProxy = 'desconocida';
  try {
    const r = await fetchDirect('https://api.ipify.org?format=json');
    ipSinProxy = JSON.parse(r).ip;
  } catch(e) { ipSinProxy = 'error: ' + e.message; }

  // 2. IP con proxy Fixie
  let ipConProxy = 'desconocida';
  try {
    const r = await fetchViaTunnel('https://api.ipify.org', '', fixieUrl, 'GET');
    ipConProxy = JSON.parse(r).ip;
  } catch(e) { ipConProxy = 'error: ' + e.message; }

  const proxyOk = ['54.217.142.99','54.195.3.54'].includes(ipConProxy);

  // 3. Si el proxy funciona, probar Inmovilla
  if (!proxyOk) {
    return res.status(200).json({
      ip_sin_proxy: ipSinProxy,
      ip_con_proxy: ipConProxy,
      proxy_ok: false,
      mensaje: 'El proxy no está enrutando correctamente. La IP con proxy no coincide con las IPs de Fixie.'
    });
  }

  // 4. Probar todos los dominios con Inmovilla
  const results = [];
  for (const dominio of DOMINIOS) {
    // Construir parámetro exactamente como PHP rawurlencode
    // PHP rawurlencode NO codifica: letras, números, _, ., -, ~
    // JavaScript encodeURIComponent NO codifica: letras, números, _, ., !, ~, *, ', (, )
    // La diferencia clave: PHP sí codifica ! pero JS no... pero rawurlencode de PHP
    // es equivalente a encodeURIComponent en JS excepto que PHP codifica ! y JS no.
    // Inmovilla usa PHP rawurlencode, así que debemos replicarlo exactamente:
    const rawurlencode = (str) => encodeURIComponent(str)
      .replace(/!/g, '%21')   // PHP sí codifica !
      .replace(/'/g, '%27')   // PHP sí codifica '
      .replace(/\(/g, '%28')  // PHP sí codifica (
      .replace(/\)/g, '%29')  // PHP sí codifica )
      .replace(/\*/g, '%2A'); // PHP sí codifica *

    const texto    = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
    const encoded  = rawurlencode(texto);
    const postBody = `param=${encoded}&elDominio=${dominio}&json=1`;

    try {
      const raw  = await fetchViaTunnel(INMOVILLA_URL, postBody, fixieUrl, 'POST');
      const isOk = !raw.includes('NECESITAMOS') && raw.length > 20;
      results.push({ dominio, ok: isOk, preview: raw.substring(0, 150) });
      if (isOk) return await serveProperties(res, raw, agency, dominio);
    } catch(e) {
      results.push({ dominio, ok: false, error: e.message });
    }
  }

  return res.status(200).json({
    ip_sin_proxy: ipSinProxy,
    ip_con_proxy: ipConProxy,
    proxy_ok: proxyOk,
    status: 'ninguna_combinacion_funciono',
    resultados: results
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

// Fetch a través de proxy CONNECT tunnel — solo ES modules
function fetchViaTunnel(targetUrl, postData, proxyUrl, method) {
  return new Promise((resolve, reject) => {
    const target  = new URL(targetUrl);
    const proxy   = new URL(proxyUrl);
    const auth    = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    const proxyPort = parseInt(proxy.port) || 80;

    const socket = net.createConnection(proxyPort, proxy.hostname, () => {
      const connectStr = [
        `CONNECT ${target.hostname}:443 HTTP/1.1`,
        `Host: ${target.hostname}:443`,
        `Proxy-Authorization: Basic ${auth}`,
        `User-Agent: Mozilla/5.0`,
        '', ''
      ].join('\r\n');
      socket.write(connectStr);
    });

    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('Timeout socket')); });
    socket.on('error', reject);

    let connectBuf = '';
    let tunnelEstablished = false;

    socket.on('data', chunk => {
      if (tunnelEstablished) return;
      connectBuf += chunk.toString();

      if (!connectBuf.includes('\r\n\r\n')) return;
      tunnelEstablished = true;

      const statusLine = connectBuf.split('\r\n')[0];
      const statusCode = parseInt(statusLine.split(' ')[1]);

      if (statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT rechazado: ${statusLine}`));
        return;
      }

      socket.removeAllListeners('data');
      socket.removeAllListeners('error');

      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: false
      });

      tlsSocket.on('error', reject);
      tlsSocket.setTimeout(15000, () => { tlsSocket.destroy(); reject(new Error('Timeout TLS')); });

      tlsSocket.on('secureConnect', () => {
        let httpReq;
        if (method === 'POST') {
          httpReq = [
            `POST ${target.pathname}${target.search} HTTP/1.1`,
            `Host: ${target.hostname}`,
            `Content-Type: application/x-www-form-urlencoded`,
            `Content-Length: ${Buffer.byteLength(postData)}`,
            `Accept: application/json, text/plain, */*`,
            `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)`,
            `Connection: close`,
            '', postData
          ].join('\r\n');
        } else {
          httpReq = [
            `GET ${target.pathname}${target.search||'?format=json'} HTTP/1.1`,
            `Host: ${target.hostname}`,
            `Accept: application/json`,
            `User-Agent: Mozilla/5.0`,
            `Connection: close`,
            '', ''
          ].join('\r\n');
        }
        tlsSocket.write(httpReq);
      });

      let response = '';
      tlsSocket.on('data', d => response += d.toString());
      tlsSocket.on('end', () => {
        const sep = response.indexOf('\r\n\r\n');
        if (sep === -1) { resolve(response.trim()); return; }
        const headers = response.substring(0, sep);
        let body = response.substring(sep + 4);
        if (headers.toLowerCase().includes('transfer-encoding: chunked')) {
          body = dechunk(body);
        }
        resolve(body.trim());
      });
    });
  });
}

function dechunk(data) {
  let result = '', pos = 0;
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

async function serveProperties(res, raw, agency, dominioUsado) {
  let data;
  try { data = JSON.parse(raw); }
  catch { return res.status(200).json({ debug: true, raw_preview: raw.substring(0, 300) }); }

  let list = [];
  if (Array.isArray(data)) { list = data; }
  else {
    for (const key of ['paginacion','ofertas','inmuebles','properties','data']) {
      if (data[key] && Array.isArray(data[key])) { list = data[key]; break; }
      if (data[key] && typeof data[key] === 'object') { list = Object.values(data[key]); break; }
    }
  }

  const properties = list
    .filter(p => !p.nodisponible || p.nodisponible == 0)
    .map(p => mapProperty(p, agency));

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json({ properties, total: properties.length, updated: new Date().toISOString(), dominio_usado: dominioUsado });
}

function mapProperty(p, agency) {
  const typeMap    = { 1:'sale',2:'rent',3:'vacation',4:'new_build','1':'sale','2':'rent','3':'vacation','4':'new_build' };
  const subtypeMap = { '1':'piso','2':'piso','3':'chalet','4':'chalet','5':'local','6':'local','7':'chalet','8':'piso','9':'local' };
  const codOfer   = p.cod_ofer||p.codofer||p.id||'';
  const fotoletra = p.fotoletra||p.foto_letra||'';
  const numfotos  = parseInt(p.numfotos)||0;
  const images    = [];
  if (numfotos>0&&fotoletra&&codOfer) {
    for (let i=1;i<=Math.min(numfotos,20);i++) images.push(`https://fotos15.inmovilla.com/${agency}/${codOfer}/${fotoletra}-${i}.jpg`);
  }
  const keyacci = p.keyacci||p.key_acci||1;
  const keyTipo = String(p.key_tipo||p.keytipo||'1');
  const price   = parseFloat(p.precioinmo||p.precio||0);
  return {
    id:codOfer, reference:p.ref||String(codOfer), type:typeMap[keyacci]||'sale',
    subtype:subtypeMap[keyTipo]||'piso', title:buildTitle(p), description:p.observaciones||p.descripcion||'',
    price, price_night:parseFloat(p.precio_noche||0)||null, location:buildLocation(p),
    address:[p.calle,p.numero,p.municipio].filter(Boolean).join(', '),
    bedrooms:parseInt(p.habitaciones)||0, bathrooms:parseInt(p.banyos||p.banios)||0,
    surface:parseInt(p.superficie||p.sup_cons)||0, floor:(p.planta!=null&&p.planta!=='')?`${p.planta}º`:'',
    garage:p.garaje==1||p.parking==1, lift:p.ascensor==1, year:p.antiquedad||'',
    exclusive:p.exclusiva==1, available:true, features:buildFeatures(p), images,
    video_url:p.video||p.url_video||null, virtual_tour_url:p.url_tour||null, floor_plan_url:p.url_plano||null,
  };
}
function buildTitle(p){const t={'1':'Piso','2':'Apartamento','3':'Casa','4':'Chalet','5':'Local','6':'Oficina','7':'Adosado','8':'Estudio','9':'Nave'};return `${t[String(p.key_tipo||'1')]||'Inmueble'} en ${p.zona||p.municipio||'Pontevedra'}`;}
function buildLocation(p){return [p.municipio,p.zona].filter(Boolean).join(' · ')||'Pontevedra';}
function buildFeatures(p){
  const f=[];
  if(p.terraza==1)f.push('Terraza');if(p.jardin==1)f.push('Jardín');if(p.piscina==1)f.push('Piscina');
  if(p.garaje==1)f.push('Garaje');if(p.parking==1)f.push('Parking');if(p.ascensor==1)f.push('Ascensor');
  if(p.trastero==1)f.push('Trastero');if(p.aire_con==1)f.push('Aire acondicionado');
  if(p.amueblado==1)f.push('Amueblado');if(p.armarios==1)f.push('Armarios');if(p.alarma==1)f.push('Alarma');
  return f;
}
