// Vercel Serverless Function — Diagnóstico de IP de Fixie
// Archivo: /api/checkip.js
// Abre: https://user7453729-inmob.vercel.app/api/checkip

import http from 'http';
import { URL } from 'url';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const fixieUrl = process.env.FIXIE_URL || 'http://fixie:mJDyuli9kcV9Uuq@ventoux.usefixie.com:80';

  try {
    // Petición SIN proxy — IP dinámica de Vercel
    const ipSinProxy = await fetchUrl('https://api.ipify.org?format=json', null);

    // Petición CON proxy Fixie — IP fija
    const ipConProxy = await fetchUrlViaProxy('https://api.ipify.org?format=json', fixieUrl);

    const ipSin = JSON.parse(ipSinProxy).ip;
    const ipCon = JSON.parse(ipConProxy).ip;

    const fixieOk = ['54.217.142.99','54.195.3.54'].includes(ipCon);

    return res.status(200).json({
      ip_sin_proxy:  ipSin,
      ip_con_proxy:  ipCon,
      fixie_ok:      fixieOk,
      mensaje: fixieOk
        ? '✅ Fixie está funcionando correctamente. La IP que ve Inmovilla es: ' + ipCon
        : '⚠️ La IP del proxy (' + ipCon + ') no coincide con las IPs esperadas de Fixie (54.217.142.99 o 54.195.3.54)',
      ips_esperadas: ['54.217.142.99','54.195.3.54']
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function fetchUrl(url, proxyUrl) {
  return new Promise((resolve, reject) => {
    const { get } = url.startsWith('https') ? require('https') : require('http');
    get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function fetchUrlViaProxy(targetUrl, proxyUrl) {
  return new Promise((resolve, reject) => {
    const proxy  = new URL(proxyUrl);
    const auth   = `${proxy.username}:${proxy.password}`;
    const authB64 = Buffer.from(auth).toString('base64');

    const options = {
      host: proxy.hostname,
      port: parseInt(proxy.port) || 80,
      method: 'GET',
      path: targetUrl,
      headers: {
        'Host': 'api.ipify.org',
        'Proxy-Authorization': `Basic ${authB64}`,
        'User-Agent': 'Mozilla/5.0'
      }
    };

    const req = http.request(options, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}
