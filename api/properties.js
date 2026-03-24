// Vercel Serverless Function — Proxy API Inmovilla
// Ruta: /api/properties.js en tu repositorio GitHub
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   INMOVILLA_TOKEN  → tu token de API
//   INMOVILLA_AGENCY → 5430
 
const INMOVILLA_BASE = 'https://procesos.inmovilla.com/api/v1';
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const token  = process.env.INMOVILLA_TOKEN;
  const agency = process.env.INMOVILLA_AGENCY || '5430';
 
  if (!token) {
    return res.status(500).json({ error: 'Variable INMOVILLA_TOKEN no configurada en Vercel' });
  }
 
  try {
    // Llamada al endpoint de propiedades de Inmovilla
    const url = `${INMOVILLA_BASE}/properties?numagencia=${agency}`;
    
    console.log('[Inmovilla] Llamando a:', url);
 
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
 
    console.log('[Inmovilla] Respuesta HTTP:', response.status);
 
    // Si Inmovilla devuelve error, capturarlo con detalle
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Inmovilla] Error body:', errorText);
      return res.status(502).json({
        error: `Inmovilla respondió con estado ${response.status}`,
        detail: errorText.substring(0, 300)
      });
    }
 
    const data = await response.json();
 
    // Inmovilla puede devolver array directo o un objeto con propiedad
    const list = Array.isArray(data) ? data : (data.properties || data.data || data.inmuebles || []);
 
    console.log('[Inmovilla] Propiedades recibidas:', list.length);
 
    // Transformar y devolver
    const properties = list
      .filter(p => !p.nodisponible) // solo disponibles
      .map(p => mapProperty(p, agency));
 
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      properties,
      total: properties.length,
      updated: new Date().toISOString()
    });
 
  } catch (err) {
    console.error('[Inmovilla] Excepción:', err.message);
    return res.status(502).json({
      error: 'Error conectando con Inmovilla',
      detail: err.message
    });
  }
}
 
function mapProperty(p, agency) {
  // keyacci: 1=venta, 2=alquiler, 3=vacacional, 4=obra nueva
  const typeMap = { 1: 'sale', 2: 'rent', 3: 'vacation', 4: 'new_build' };
 
  // key_tipo (tipos más comunes de Inmovilla)
  const subtypeMap = {
    1: 'piso', 2: 'piso', 3: 'chalet', 4: 'chalet', 5: 'local',
    6: 'local', 7: 'chalet', 8: 'piso', 9: 'local', 10: 'piso'
  };
 
  // Construir URLs de fotos
  // Formato oficial: https://fotos15.inmovilla.com/{agency}/{cod_ofer}/{fotoletra}-{N}.jpg
  const images = [];
  if (p.numfotos && p.numfotos > 0 && p.fotoletra) {
    for (let i = 1; i <= Math.min(parseInt(p.numfotos), 20); i++) {
      images.push(`https://fotos15.inmovilla.com/${agency}/${p.cod_ofer}/${p.fotoletra}-${i}.jpg`);
    }
  }
  // Alternativa: fotos como objeto { "1": { url, posicion }, ... }
  if (images.length === 0 && p.fotos && typeof p.fotos === 'object') {
    Object.values(p.fotos)
      .sort((a, b) => (a.posicion || 0) - (b.posicion || 0))
      .forEach(f => { if (f.url) images.push(f.url); });
  }
 
  const price = p.precioinmo || p.precio || 0;
 
  return {
    id:               p.cod_ofer,
    reference:        p.ref || String(p.cod_ofer),
    type:             typeMap[p.keyacci] || 'sale',
    subtype:          subtypeMap[p.key_tipo] || 'piso',
    title:            buildTitle(p),
    description:      p.observaciones || p.descripcion || p.desc_es || '',
    price:            price,
    price_night:      p.precio_noche || null,
    location:         buildLocation(p),
    address:          [p.calle, p.numero, p.municipio].filter(Boolean).join(', '),
    bedrooms:         parseInt(p.habitaciones) || 0,
    bathrooms:        parseInt(p.banyos) || 0,
    surface:          parseInt(p.superficie || p.sup_cons) || 0,
    floor:            p.planta != null ? `${p.planta}º` : '',
    garage:           p.garaje == 1 || p.parking == 1,
    lift:             p.ascensor == 1,
    year:             p.antiquedad || p.anyo_construccion || '',
    exclusive:        p.exclusiva == 1,
    available:        true,
    features:         buildFeatures(p),
    images:           images,
    video_url:        p.video || p.url_video || null,
    virtual_tour_url: p.url_tour || p.tour_virtual || null,
    floor_plan_url:   p.url_plano || p.plano || null,
  };
}
 
function buildTitle(p) {
  const tipos = {
    1: 'Piso', 2: 'Apartamento', 3: 'Casa', 4: 'Chalet',
    5: 'Local', 6: 'Oficina', 7: 'Adosado', 8: 'Estudio', 9: 'Nave'
  };
  const tipo = tipos[p.key_tipo] || 'Inmueble';
  const zona = p.zona || p.municipio || 'Pontevedra';
  return `${tipo} en ${zona}`;
}
 
function buildLocation(p) {
  const parts = [];
  if (p.municipio) parts.push(p.municipio);
  if (p.zona)      parts.push(p.zona);
  return parts.join(' · ') || 'Pontevedra';
}
 
function buildFeatures(p) {
  const f = [];
  if (p.terraza   == 1) f.push('Terraza');
  if (p.jardin    == 1) f.push('Jardín');
  if (p.piscina   == 1) f.push('Piscina');
  if (p.garaje    == 1) f.push('Garaje incluido');
  if (p.parking   == 1) f.push('Parking');
  if (p.ascensor  == 1) f.push('Ascensor');
  if (p.trastero  == 1) f.push('Trastero');
  if (p.aire_con  == 1) f.push('Aire acondicionado');
  if (p.calefaccion)    f.push('Calefacción');
  if (p.amueblado == 1) f.push('Amueblado');
  if (p.armarios  == 1) f.push('Armarios empotrados');
  if (p.alarma    == 1) f.push('Alarma');
  if (p.portero   == 1) f.push('Portero automático');
  return f;
}
 
