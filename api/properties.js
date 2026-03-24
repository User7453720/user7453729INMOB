
// Vercel Serverless Function — Proxy API Inmovilla
// Este archivo va en la carpeta /api de tu repositorio GitHub
// Vercel lo convierte automáticamente en un endpoint: /api/properties
//
// IMPORTANTE: No pongas el token directamente aquí.
// Añádelo en Vercel → Settings → Environment Variables:
//   Nombre: INMOVILLA_TOKEN   Valor: tu_token
//   Nombre: INMOVILLA_AGENCY  Valor: 5430

const INMOVILLA_BASE = 'https://procesos.apinmo.com/api/v1';

export default async function handler(req, res) {
  // CORS — permite que tu web llame a este endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token  = process.env.INMOVILLA_TOKEN;
  const agency = process.env.INMOVILLA_AGENCY || '5430';

  if (!token) {
    return res.status(500).json({ error: 'Token no configurado en Vercel' });
  }

  try {
    // 1. Obtener listado de propiedades disponibles
    const listRes = await fetch(`${INMOVILLA_BASE}/properties?numagencia=${agency}&nodisponible=0`, {
      headers: {
        'Token': token,
        'Content-Type': 'application/json'
      }
    });

    if (!listRes.ok) {
      throw new Error(`Inmovilla respondió con estado ${listRes.status}`);
    }

    const rawList = await listRes.json();
    const list = Array.isArray(rawList) ? rawList : (rawList.properties || rawList.data || []);

    // 2. Transformar cada propiedad al formato que usa la web
    const properties = list.map(p => mapProperty(p, agency));

    // 3. Devolver resultado
    res.setHeader('Cache-Control', 's-maxage=1800'); // caché 30 min en Vercel
    return res.status(200).json({ properties, total: properties.length, updated: new Date().toISOString() });

  } catch (err) {
    console.error('[Inmovilla API Error]', err.message);
    return res.status(502).json({ error: 'Error conectando con Inmovilla', detail: err.message });
  }
}

// Mapea los campos de Inmovilla al formato interno de la web
function mapProperty(p, agency) {
  // keyacci: 1=venta, 2=alquiler, 3=alquiler vacacional, 4=obra nueva/promoción
  const typeMap = { 1: 'sale', 2: 'rent', 3: 'vacation', 4: 'new_build' };

  // Generar URLs de fotos
  // Formato: https://fotos15.inmovilla.com/{agency}/{cod_ofer}/{fotoletra}-{N}.jpg
  const images = [];
  if (p.numfotos && p.numfotos > 0 && p.fotoletra) {
    for (let i = 1; i <= Math.min(p.numfotos, 20); i++) {
      images.push(`https://fotos15.inmovilla.com/${agency}/${p.cod_ofer}/${p.fotoletra}-${i}.jpg`);
    }
  }
  // Compatibilidad con formato objeto de fotos { "1": { url, posicion }, ... }
  if (p.fotos && typeof p.fotos === 'object' && images.length === 0) {
    Object.values(p.fotos)
      .sort((a, b) => (a.posicion || 0) - (b.posicion || 0))
      .forEach(f => { if (f.url) images.push(f.url); });
  }

  // Precio: usar precioinmo (precio agencia) o precio (precio portal)
  const price = p.precioinmo || p.precio || 0;
  const priceNight = p.precio_noche || null;

  // Subtipo del inmueble para filtros
  const subtypeMap = {
    // key_tipo comunes en Inmovilla (valores aproximados, verificar con ENUM)
    1: 'piso', 2: 'piso', 3: 'chalet', 4: 'chalet', 5: 'local',
    6: 'local', 7: 'chalet', 8: 'piso', 9: 'local'
  };

  return {
    id:          p.cod_ofer,
    reference:   p.ref || String(p.cod_ofer),
    type:        typeMap[p.keyacci] || 'sale',
    subtype:     subtypeMap[p.key_tipo] || 'piso',
    title:       buildTitle(p),
    description: p.observaciones || p.descripcion || p.desc_es || '',
    price:       price,
    price_night: priceNight,
    location:    buildLocation(p),
    address:     [p.calle, p.numero, p.municipio].filter(Boolean).join(', '),
    bedrooms:    p.habitaciones || 0,
    bathrooms:   p.banyos || 0,
    surface:     p.superficie || p.sup_cons || 0,
    floor:       p.planta != null ? String(p.planta) + 'º' : '',
    garage:      p.garaje == 1 || p.parking == 1,
    lift:        p.ascensor == 1,
    year:        p.antiquedad || p.anyo_construccion || '',
    exclusive:   p.exclusiva == 1,
    available:   !p.nodisponible,
    features:    buildFeatures(p),
    images:      images,
    video_url:   p.video || p.url_video || null,
    virtual_tour_url: p.url_tour || p.tour_virtual || null,
    floor_plan_url:   p.url_plano || p.plano || null,
    energy_cert: p.cert_energetica || null,
    raw:         p // objeto original por si necesitas más campos
  };
}

function buildTitle(p) {
  const tipos = {
    1: 'Piso', 2: 'Apartamento', 3: 'Casa', 4: 'Chalet', 5: 'Local',
    6: 'Oficina', 7: 'Adosado', 8: 'Estudio', 9: 'Nave'
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
  const features = [];
  if (p.terraza  == 1) features.push('Terraza');
  if (p.jardin   == 1) features.push('Jardín privado');
  if (p.piscina  == 1) features.push('Piscina');
  if (p.garaje   == 1) features.push('Garaje incluido');
  if (p.parking  == 1) features.push('Parking');
  if (p.ascensor == 1) features.push('Ascensor');
  if (p.trastero == 1) features.push('Trastero');
  if (p.aire_con == 1) features.push('Aire acondicionado');
  if (p.calefaccion)   features.push('Calefacción');
  if (p.amueblado== 1) features.push('Amueblado');
  if (p.armarios == 1) features.push('Armarios empotrados');
  if (p.alarma   == 1) features.push('Alarma');
  if (p.portero  == 1) features.push('Portero automático');
  return features;
}
