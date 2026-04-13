// Vercel Serverless Function — API Inmovilla con diagnóstico exhaustivo
// GET /api/properties        → propiedades reales (producción)
// GET /api/properties?diag=1 → diagnóstico completo de todas las combinaciones

import net from 'net';
import tls from 'tls';
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
  const diagMode = req.query && req.query.diag === '1';

  if (!pass) return res.status(500).json({ error: 'INMOVILLA_PASS no configurada en Vercel' });

  // ── DIAGNÓSTICO COMPLETO ──────────────────────────────────────────────
  if (diagMode) {
    return await runFullDiagnostic(req, res, agency, pass, fixieUrl);
  }

  // ── PRODUCCIÓN ──────────────────────────────────────────────────────────
  const phpRaw = (s) => s.split('').map(c => {
    if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  }).join('');

  const texto = `${agency};${pass};${IDIOMA};lostipos;paginacion;1;200;;precioinmo`;

  // Reintentar hasta 5 veces — Fixie rota entre IPs y solo una está activa en Inmovilla
  for (let intento = 0; intento < 5; intento++) {
    let ipProxy = '54.217.142.99';
    try {
      const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
      ipProxy = JSON.parse(r).ip;
    } catch(e) { /* usar fallback */ }

    const postBody = `param=${phpRaw(texto)}&elDominio=inmobiliariapedrosa.com&json=1&ia=${ipProxy}`;

    try {
      const raw = await fetchViaTunnel(INMOVILLA_URL, postBody, fixieUrl, 'POST');
      if (!raw.includes('NECESITAMOS') && raw.trim().length > 20) {
        return await serveProperties(res, raw, agency);
      }
      console.log(`[Inmovilla] Intento ${intento+1} fallido con IP ${ipProxy}: ${raw.substring(0,50)}`);
    } catch(e) {
      console.error(`[Inmovilla] Intento ${intento+1} error: ${e.message}`);
    }
  }

  return res.status(502).json({
    error: 'No se pudo conectar con Inmovilla',
    hint: 'Abre /api/properties?diag=1 para diagnóstico completo'
  });
}

// ── DIAGNÓSTICO EXHAUSTIVO ────────────────────────────────────────────────
async function runFullDiagnostic(req, res, agency, pass, fixieUrl) {
  const report = {
    timestamp: new Date().toISOString(),
    seccion_1_red: {},
    seccion_2_proxy: {},
    seccion_3_inmovilla: {},
    seccion_4_combinaciones: [],
    conclusion: '',
    solucion: ''
  };

  // ── SECCIÓN 1: Red ────────────────────────────────────────────────────
  // 1a. IP sin proxy
  try {
    const r = await fetchDirect('https://api.ipify.org?format=json');
    report.seccion_1_red.ip_vercel = JSON.parse(r).ip;
  } catch(e) {
    report.seccion_1_red.ip_vercel = 'ERROR: ' + e.message;
  }

  // 1b. IP con proxy
  try {
    const r = await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
    report.seccion_1_red.ip_con_proxy = JSON.parse(r).ip;
  } catch(e) {
    report.seccion_1_red.ip_con_proxy = 'ERROR: ' + e.message;
  }

  const fixieIPs = ['54.217.142.99', '54.195.3.54'];
  report.seccion_1_red.proxy_funcionando = fixieIPs.includes(report.seccion_1_red.ip_con_proxy);
  report.seccion_1_red.ips_fixie_esperadas = fixieIPs;

  // 1c. Conectividad directa a Inmovilla sin proxy
  try {
    const r = await fetchDirect('https://apiweb.inmovilla.com/apiweb/apiweb.php');
    report.seccion_1_red.inmovilla_accesible_sin_proxy = true;
    report.seccion_1_red.inmovilla_respuesta_directa = r.substring(0, 100);
  } catch(e) {
    report.seccion_1_red.inmovilla_accesible_sin_proxy = false;
    report.seccion_1_red.inmovilla_error_directo = e.message;
  }

  // ── SECCIÓN 2: Proxy ──────────────────────────────────────────────────
  report.seccion_2_proxy.fixie_url_configurada = fixieUrl.replace(/:[^:@]+@/, ':***@');
  report.seccion_2_proxy.proxy_ok = report.seccion_1_red.proxy_funcionando;

  // 2b. Latencia del proxy
  const t0 = Date.now();
  try {
    await fetchViaTunnel('https://api.ipify.org', '?format=json', fixieUrl, 'GET');
    report.seccion_2_proxy.latencia_ms = Date.now() - t0;
  } catch(e) {
    report.seccion_2_proxy.latencia_ms = 'ERROR';
  }

  // ── SECCIÓN 3: Inmovilla via proxy ────────────────────────────────────
  // Petición básica GET a Inmovilla a través del proxy
  try {
    const r = await fetchViaTunnel('https://apiweb.inmovilla.com/apiweb/apiweb.php', '', fixieUrl, 'GET');
    report.seccion_3_inmovilla.respuesta_get_vacia = r.substring(0, 150);
  } catch(e) {
    report.seccion_3_inmovilla.respuesta_get_vacia = 'ERROR: ' + e.message;
  }

  // ── SECCIÓN 4: Todas las combinaciones ───────────────────────────────
  const combos = buildCombos(agency, pass, IDIOMA);
  const dominios = [
    'inmobiliariapedrosa.com',
    'www.inmobiliariapedrosa.com',
    'user7453729-inmob.vercel.app',
    'inmobiliariapedrosa.es',
    agency + '.inmovilla.com',
    ''
  ];

  for (const combo of combos) {
    for (const dominio of dominios) {
      const body = dominio
        ? `${combo.body}&elDominio=${dominio}&json=1`
        : `${combo.body}&json=1`;

      const resultado = { combo: combo.label, dominio: dominio || '(sin dominio)', ok: false };

      try {
        const t1 = Date.now();
        const raw = await fetchViaTunnel(INMOVILLA_URL, body, fixieUrl, 'POST');
        resultado.ms = Date.now() - t1;
        resultado.preview = raw.substring(0, 120);
        resultado.ok = !raw.includes('NECESITAMOS') && !raw.includes('error') && raw.trim().length > 20;
        resultado.es_json = raw.trim().startsWith('[') || raw.trim().startsWith('{');

        if (resultado.ok) {
          resultado.exito = true;
          report.seccion_4_combinaciones.push(resultado);
          // Devolver inmediatamente con la combinación ganadora
          report.conclusion = '✅ COMBINACIÓN EXITOSA ENCONTRADA';
          report.solucion = `Usar combo="${combo.label}" con dominio="${dominio || '(sin dominio)'}"`;
          report.combo_ganador = { label: combo.label, dominio, body_template: combo.label };
          return res.status(200).json(report);
        }
      } catch(e) {
        resultado.error = e.message.substring(0, 100);
        resultado.ms = Date.now() - (t1 || Date.now());
      }

      report.seccion_4_combinaciones.push(resultado);
    }
  }

  // ── CONCLUSIÓN ────────────────────────────────────────────────────────
  if (!report.seccion_1_red.proxy_funcionando) {
    report.conclusion = '❌ EL PROXY FIXIE NO ESTÁ FUNCIONANDO';
    report.solucion = 'Verificar credenciales de Fixie en variable FIXIE_URL de Vercel';
  } else {
    const todasIgual = report.seccion_4_combinaciones.every(r => r.preview && r.preview.includes('NECESITAMOS'));
    if (todasIgual) {
      report.conclusion = '❌ TODAS LAS COMBINACIONES RECIBEN "NECESITAMOS RECIBIR LA IP"';
      report.solucion = 'Las IPs de Fixie están en el panel de Inmovilla pero no activas. Contactar soporte de Inmovilla con este diagnóstico completo y pedir que verifiquen que las IPs 54.217.142.99 y 54.195.3.54 están ACTIVAS para el usuario 5430_244_ext.';
    } else {
      report.conclusion = '⚠️ RESPUESTAS VARIADAS — revisar seccion_4_combinaciones';
      report.solucion = 'Hay combinaciones con respuestas diferentes. Revisar el detalle.';
    }
  }

  return res.status(200).json(report);
}

// ── COMBINACIONES DE PARÁMETROS ───────────────────────────────────────────
function buildCombos(agency, pass, idioma) {
  const agencyNum = agency.split('_')[0];
  const base = `${agency};${pass};${idioma};lostipos;paginacion;1;200;;precioinmo`;

  // PHP rawurlencode EXACTO: solo deja sin codificar A-Z a-z 0-9 _ . - ~
  const phpRaw = (s) => s.split('').map(c => {
    if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  }).join('');

  return [
    { label: 'php_rawurlencode', body: `param=${phpRaw(base)}` },
  ];
}

// ── FETCH DIRECTO (sin proxy) ─────────────────────────────────────────────
function fetchDirect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET' };
    https.get(options, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

// ── FETCH VIA PROXY TUNNEL (CONNECT) ─────────────────────────────────────
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

    let connectBuf = '';
    let ready = false;

    socket.on('data', chunk => {
      if (ready) return;
      connectBuf += chunk.toString();
      if (!connectBuf.includes('\r\n\r\n')) return;
      ready = true;

      const status = parseInt(connectBuf.split('\r\n')[0].split(' ')[1]);
      if (status !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT rechazado: ${status} ${connectBuf.split('\r\n')[0]}`));
        return;
      }

      socket.removeAllListeners('data');
      socket.removeAllListeners('error');

      const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
      tlsSocket.setTimeout(20000, () => { tlsSocket.destroy(); reject(new Error('Timeout TLS')); });
      tlsSocket.on('error', reject);

      tlsSocket.on('secureConnect', () => {
        let req;
        if (method === 'POST') {
          const postData = pathOrBody;
          req = [
            `POST ${target.pathname} HTTP/1.1`,
            `Host: ${target.hostname}`,
            `Content-Type: application/x-www-form-urlencoded`,
            `Content-Length: ${Buffer.byteLength(postData)}`,
            `Accept: application/json, text/plain, */*`,
            `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)`,
            `Connection: close`,
            '', postData
          ].join('\r\n');
        } else {
          const qs = pathOrBody || '';
          req = [
            `GET ${target.pathname}${qs} HTTP/1.1`,
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

async function serveProperties(res, raw, agency) {
  const agencyNum = agency.split('_')[0]; // solo el número para URLs de fotos
  let data;
  try { data = JSON.parse(raw); }
  catch { return res.status(200).json({ debug: true, raw_preview: raw.substring(0, 500) }); }

  let list = [];
  if (Array.isArray(data)) { list = data; }
  else {
    for (const k of ['paginacion','ofertas','inmuebles','properties','data']) {
      if (data[k] && Array.isArray(data[k])) { list = data[k]; break; }
      if (data[k] && typeof data[k] === 'object') { list = Object.values(data[k]); break; }
    }
  }

  const properties = list.filter(p => !p.nodisponible||p.nodisponible==0).map(p => mapProperty(p, agencyNum));
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json({ properties, total: properties.length, updated: new Date().toISOString() });
}

function mapProperty(p, agency) {
  const typeMap = {1:'sale',2:'rent',3:'vacation',4:'new_build','1':'sale','2':'rent','3':'vacation','4':'new_build'};
  const cod = p.cod_ofer||p.codofer||p.id||'';
  const fl  = p.fotoletra||p.foto_letra||'';
  const nf  = parseInt(p.numfotos)||0;
  const imgs = [];
  if (nf>0&&fl&&cod) for(let i=1;i<=Math.min(nf,20);i++) imgs.push(`https://fotos15.inmovilla.com/${agency}/${cod}/${fl}-${i}.jpg`);

  const tipo = p.keyacci||p.key_acci||2;
  // Precio: precioinmo para venta, precioalq para alquiler
  const price = parseFloat(p.precioinmo)||parseFloat(p.precioalq)||parseFloat(p.precio)||0;

  return {
    id: cod,
    reference: p.ref||String(cod),
    type: typeMap[tipo]||'rent',
    subtype: (p.nbtipo||'Inmueble').toLowerCase().replace(/ /g,'-'),
    title: `${p.nbtipo||'Inmueble'} en ${p.zona||p.ciudad||'Pontevedra'}`,
    description: p.observaciones||p.descripcion||'',
    price,
    price_alquiler: parseFloat(p.precioalq)||null,
    price_night: parseFloat(p.precio_noche||0)||null,
    location: [p.ciudad, p.zona].filter(Boolean).join(' · ')||'Pontevedra',
    address: [p.calle, p.numero, p.ciudad].filter(Boolean).join(', '),
    bedrooms: parseInt(p.habitaciones)||0,
    bathrooms: parseInt(p.banyos||p.banios||p.sumaseos)||0,
    surface: parseInt(p.m_cons||p.superficie||p.sup_cons)||0,
    floor: (p.planta!=null&&p.planta!=='')?`${p.planta}º`:'',
    garage: p.garaje==1||p.parking==1||p.plaza_gara==1,
    lift: p.ascensor==1,
    exclusive: p.exclu==1||p.exclusiva==1,
    featured: p.destacado==1||p.destestrella==1,
    available: !p.nodisponible||p.nodisponible==0,
    lat: parseFloat(p.latitud)||null,
    lng: parseFloat(p.altitud)||null,
    agent: p.nombreagente ? `${p.nombreagente} ${p.apellidosagente||''}`.trim() : null,
    agent_phone: p.telefono1agente||null,
    agent_email: p.emailagente||null,
    features: (()=>{const f=[];
      if(p.terraza==1)f.push('Terraza');if(p.jardin==1)f.push('Jardín');if(p.piscina_com==1||p.piscina_prop==1)f.push('Piscina');
      if(p.garaje==1)f.push('Garaje');if(p.parking==1)f.push('Parking');if(p.ascensor==1)f.push('Ascensor');
      if(p.trastero==1)f.push('Trastero');if(p.aire_con==1)f.push('Aire acondicionado');
      if(p.muebles==1)f.push('Amueblado');if(p.alarma==1)f.push('Alarma');
      if(p.calefaccion==1)f.push('Calefacción');if(p.primera_line==1)f.push('Primera línea');
      return f;})(),
    images: imgs,
    video_url: p.video||p.url_video||null,
    virtual_tour_url: p.url_tour||null,
    floor_plan_url: p.url_plano||null,
  };
}
