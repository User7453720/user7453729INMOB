// Vercel Serverless Function — Proxy API Inmovilla con Fixie (HTTPS tunnel correcto)
import http from 'http';
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

  const results = [];

  for (const dominio of DOMINIOS) {
    const texto    = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;
    const encoded  = encodeURIComponent(texto);
    const postBody = `param=${encoded}&elDominio=${dominio}&json=1`;

    try {
      const raw = await postViaProxyTunnel(INMOVILLA_URL, postBody, fixieUrl);
      const preview = raw.substring(0, 150);
      const isOk = !raw.includes('NECESITAMOS') && raw.length > 20;

      results.push({ dominio, ok: isOk, preview });
      console.log(`[Inmovilla] dominio=${dominio} ok=${isOk} resp=${preview}`);

      if (isOk) {
        return await serveProperties(res, raw, agency, dominio);
      }
    } catch (err) {
      results.push({ dominio, ok: false, error: err.message });
      console.log(`[Inmovilla] dominio=${dominio} ERROR: ${err.message}`);
    }
  }

  return res.status(200).json({
    status: 'ninguna_combinacion_funciono',
    fixie_ips: '54.217.142.99 y 54.195.3.54',
    resultados: results
  });
}

// HTTPS a través de proxy usando CONNECT tunnel (método correcto para SSL)
function postViaProxyTunnel(targetUrl, postData, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy  = new URL(proxyUrl);
    const auth   = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');

    // Paso 1: establecer tunnel CONNECT con el proxy
    const connectReq = http.request({
      host: proxy.hostname,
      port: parseInt(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: {
        'Host': `${target.hostname}:443`,
        'Proxy-Authorization': `Basic ${auth}`
      }
    });

    connectReq.setTimeout(10000, () => {
      connectReq.destroy();
      reject(new Error('Timeout en CONNECT'));
    });

    connectReq.on('connect', (connectRes, socket) => {
      if (connectRes.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT falló: ${connectRes.statusCode}`));
        return;
      }

      // Paso 2: hacer la petición HTTPS real a través del tunnel
      const tlsSocket = require('tls').connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: false
      }, () => {
        const postReq = [
          `POST ${target.pathname} HTTP/1.1`,
          `Host: ${target.hostname}`,
          'Content-Type: application/x-www-form-urlencoded',
          `Content-Length: ${Buffer.byteLength(postData)}`,
          'Accept: application/json, text/plain, */*',
          'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Connection: close',
          '',
          postData
        ].join('\r\n');

        tlsSocket.write(postReq);
      });

      let rawResponse = '';
      tlsSocket.on('data', chunk => rawResponse += chunk.toString());
      tlsSocket.on('end', () => {
        // Extraer body de la respuesta HTTP
        const bodyStart = rawResponse.indexOf('\r\n\r\n');
        const body = bodyStart !== -1 ? rawResponse.substring(bodyStart + 4) : rawResponse;
        // Manejar chunked encoding si es necesario
        const cleanBody = body.replace(/^[0-9a-f]+\r\n/gim, '').replace(/\r\n0\r\n\r\n$/,'').trim();
        resolve(cleanBody || body.trim());
      });
      tlsSocket.on('error', reject);
      tlsSocket.setTimeout(10000, () => { tlsSocket.destroy(); reject(new Error('Timeout TLS')); });
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

async function serveProperties(res, raw, agency, dominioUsado) {
  let data;
  try { data = JSON.parse(raw); } catch {
    return res.status(200).json({ debug: true, raw_preview: raw.substring(0, 300), dominio_ok: dominioUsado });
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
