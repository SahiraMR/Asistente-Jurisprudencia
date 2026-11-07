// Servidor local del MVP "Recuperación de Jurisprudencia Penal en Colombia".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 1. IMPORTAMOS TODAS LAS FUNCIONES DE LA BASE DE DATOS
import { 
  db, // Importante para la ruta PATCH
  inicializarDB, 
  registrarUsuario, 
  loginUsuario, 
  guardarDocumento, 
  obtenerDocumentos, 
  eliminarDocumento,
  guardarNotaDB,
  obtenerNotasDB,
  eliminarNotaDB,
  guardarHistorialDB, 
  obtenerHistorialDB, 
  obtenerEstadisticasDB
} from './lib/db.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(RAIZ, 'data');

// ─── Verificaciones iniciales ────────────────────────────────────
const [mayor] = process.versions.node.split('.').map(Number);
if (mayor < 18) {
  console.error(`Necesitas Node.js 18 o superior (tienes ${process.versions.node}). Descárgalo en https://nodejs.org`);
  process.exit(1);
}

// Carga simple del archivo .env (sin librerías).
function cargarEnv() {
  const ruta = path.join(RAIZ, '.env');
  if (!fs.existsSync(ruta)) return;
  for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || linea.trim().startsWith('#')) continue;
    const valor = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = valor;
  }
}
cargarEnv();

// Inicializamos la base de datos antes de que el servidor arranque
await inicializarDB();

const { Indice } = await import('./lib/buscador.mjs');
const { analizarCaso } = await import('./lib/analisis.mjs');
const { evaluar } = await import('./lib/evaluacion.mjs');
const { pruebasEticas } = await import('./lib/etica.mjs');
const { modelosTexto } = await import('./lib/gemini.mjs');

const PUERTO = Number(process.env.PORT || 3000);
const MAX_BODY = 15_000_000;
const LIMITE = { ventanaMs: 10 * 60 * 1000, max: Number(process.env.RATE_MAX || 20) };

const leerJSON = (archivo, defecto = null) => {
  const ruta = path.join(DATOS, archivo);
  try { return fs.existsSync(ruta) ? JSON.parse(fs.readFileSync(ruta, 'utf8')) : defecto; }
  catch (e) { console.error(`No se pudo leer data/${archivo}:`, e.message); return defecto; }
};
const guardarJSON = (archivo, datos) => fs.writeFileSync(path.join(DATOS, archivo), JSON.stringify(datos, null, 2));

// ─── Corpus e índice ─────────────────────────────────────────────
if (!fs.existsSync(DATOS)) fs.mkdirSync(DATOS);
const corpus = leerJSON('corpus.json', []);
const casosPrueba = leerJSON('casos_prueba.json', []);
const indice = corpus.length ? new Indice(corpus, path.join(DATOS, 'embeddings_cache.json')) : null;

if (!indice) console.warn('⚠ No se encontró data/corpus.json: la búsqueda no funcionará hasta agregar el corpus.');
if (!process.env.GEMINI_API_KEY) console.warn('⚠ Falta GEMINI_API_KEY en el archivo .env: la IA no funcionará.');
if (indice && process.env.GEMINI_API_KEY) indice.prepararEmbeddings();

// ─── Trabajos en segundo plano (evaluación y pruebas éticas) ────
const trabajos = {
  evaluacion: { estado: 'inactivo', progreso: '', error: '' },
  etica: { estado: 'inactivo', progreso: '', error: '' }
};

async function correrTrabajo(nombre) {
  const t = trabajos[nombre];
  if (t.estado === 'ejecutando') return;
  Object.assign(t, { estado: 'ejecutando', progreso: 'Iniciando…', error: '' });
  try {
    if (nombre === 'evaluacion') {
      if (!casosPrueba.length) throw new Error('No hay casos de prueba en data/casos_prueba.json.');
      t.progreso = `Evaluando ${casosPrueba.length} casos de prueba…`;
      guardarJSON('resultados_evaluacion.json', await evaluar(indice, casosPrueba));
    } else {
      guardarJSON('resultados_eticos.json', await pruebasEticas(indice, n => { t.progreso = `Prueba ${n} de 9 completada…`; }));
    }
    Object.assign(t, { estado: 'listo', progreso: '' });
  } catch (e) {
    console.error(`[${nombre}]`, e);
    Object.assign(t, { estado: 'error', progreso: '', error: e.message });
  }
}

// ─── HTTP ────────────────────────────────────────────────────────
class ErrorUsuario extends Error {
  constructor(m, status = 400) { super(m); this.status = status; }
}

const visitas = new Map();
function permitido(ip) {
  const ahora = Date.now();
  const recientes = (visitas.get(ip) || []).filter(t => ahora - t < LIMITE.ventanaMs);
  const ok = recientes.length < LIMITE.max;
  if (ok) recientes.push(ahora);
  visitas.set(ip, recientes);
  return ok;
}

function enviar(res, status, datos) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(datos));
}

async function leerCuerpo(req) {
  let body = '';
  for await (const c of req) {
    body += c;
    if (body.length > MAX_BODY) throw new ErrorUsuario('El documento es demasiado grande.', 413);
  }
  try { return JSON.parse(body || '{}'); } catch { throw new ErrorUsuario('La solicitud no es un JSON válido.'); }
}

function requiereIndice() {
  if (!indice) throw new ErrorUsuario('Aún no hay corpus cargado (falta data/corpus.json).', 503);
  if (!process.env.GEMINI_API_KEY) throw new ErrorUsuario('Falta configurar GEMINI_API_KEY en el archivo .env.', 503);
}

const rutas = {
  // --- LOGIN Y REGISTRO ---
  'POST /api/registro': async (req) => {
    const { usuario, password } = await leerCuerpo(req);
    if (!usuario || !password) throw new ErrorUsuario('Faltan datos');
    return await registrarUsuario(usuario, password);
  },

  'POST /api/login': async (req) => {
    const { usuario, password } = await leerCuerpo(req);
    if (!usuario || !password) throw new ErrorUsuario('Faltan datos');
    return await loginUsuario(usuario, password);
  },

  // --- DOCUMENTOS (SENTENCIAS GUARDADAS) ---
  'POST /api/documentos': async (req) => {
    const { usuario_id, sentencia } = await leerCuerpo(req);
    if (!usuario_id || !sentencia) throw new ErrorUsuario('Faltan datos.');
    await guardarDocumento(usuario_id, sentencia);
    return { ok: true, mensaje: 'Documento guardado' };
  },

  'GET /api/documentos': async (req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');
    if (!usuario_id) return { documentos: [] };
    const docs = await obtenerDocumentos(usuario_id);
    return { documentos: docs };
  },

  'DELETE /api/documentos': async (req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');
    const id = urlObj.searchParams.get('id');
    if (!usuario_id || !id) throw new ErrorUsuario('Faltan datos.');
    await eliminarDocumento(usuario_id, id);
    return { ok: true };
  },

  // --- NOTAS (BLOQUES SEPARADOS) ---
  'POST /api/notas': async (req) => {
    const { usuario_id, sentencia_id, texto } = await leerCuerpo(req);
    if (!usuario_id || !sentencia_id || !texto) throw new ErrorUsuario('Faltan datos.');
    await guardarNotaDB(usuario_id, sentencia_id, texto);
    return { ok: true, mensaje: 'Nota guardada' };
  },

  'GET /api/notas': async (req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');
    const sentencia_id = urlObj.searchParams.get('sentencia_id');
    if (!usuario_id || !sentencia_id) return { notas: [] };
    const notas = await obtenerNotasDB(usuario_id, sentencia_id);
    return { notas: notas };
  },

  'DELETE /api/notas': async (req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const id = urlObj.searchParams.get('id');
    if (!id) throw new ErrorUsuario('Falta el ID de la nota.');
    await eliminarNotaDB(id);
    return { ok: true };
  },

  // --- NUEVAS RUTAS (PERFIL, ETIQUETAS, HISTORIAL) ---
  'GET /api/perfil': async (req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');
    if (!usuario_id) return { estadisticas: {} };
    return { estadisticas: await obtenerEstadisticasDB(usuario_id) };
  },

  'PATCH /api/etiqueta': async (req) => {
    const { usuario_id, sentencia_id, etiqueta } = await leerCuerpo(req);
    if (!usuario_id || !sentencia_id) throw new ErrorUsuario('Faltan datos');
    await db.execute({
      sql: 'UPDATE documentos SET etiqueta = ? WHERE usuario_id = ? AND sentencia_id = ?',
      args: [etiqueta, usuario_id, sentencia_id]
    });
    return { ok: true };
  },

  'GET /api/historial': async (req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');
    if (!usuario_id) return { historial: [] };
    return { historial: await obtenerHistorialDB(usuario_id) };
  },

  // --- RUTAS ORIGINALES ---
  'GET /api/estado': async () => ({
    corpus: indice ? indice.resumen() : null,
    casos_prueba: casosPrueba.length,
    clave_configurada: Boolean(process.env.GEMINI_API_KEY),
    metodo: indice ? indice.metodoPorDefecto : null,
    evaluacion: leerJSON('resultados_evaluacion.json')
  }),

  'POST /api/analyze': async (req) => {
    requiereIndice();
    if (!permitido(req.socket.remoteAddress || 'local')) throw new ErrorUsuario('Demasiadas consultas seguidas. Espera unos minutos.', 429);
    const { caso } = await leerCuerpo(req);
    if (typeof caso !== 'string' || caso.trim().length < 30) throw new ErrorUsuario('Escribe un caso más detallado (mínimo 30 caracteres) o sube un documento.');
    
    // GUARDAMOS EN EL HISTORIAL CON TRY-CATCH PARA QUE LA BÚSQUEDA NO SE DETENGA SI FALLA
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const usuario_id = urlObj.searchParams.get('usuario_id') || 0;
      await guardarHistorialDB(usuario_id, caso);
    } catch (err) {
      console.error("Error guardando historial (pero la búsqueda continúa):", err.message);
    }

    return analizarCaso(indice, caso);
  },

  'GET /api/metricas': async () => ({
    evaluacion: leerJSON('resultados_evaluacion.json'),
    etica: leerJSON('resultados_eticos.json'),
    trabajos,
    corpus: indice ? indice.resumen() : null,
    casos_prueba: casosPrueba.length
  }),

  'POST /api/evaluar': async () => { requiereIndice(); correrTrabajo('evaluacion'); return { iniciado: true }; },
  'POST /api/etica': async () => { requiereIndice(); correrTrabajo('etica'); return { iniciado: true }; }
};

http.createServer(async (req, res) => {
  const ruta = (req.url || '/').split('?')[0];

  try {
    const manejador = rutas[`${req.method} ${ruta}`];
    if (manejador) return enviar(res, 200, await manejador(req));

    // Texto completo de una sentencia del corpus
    const doc = ruta.match(/^\/api\/documento\/([\w.-]+)$/);
    if (req.method === 'GET' && doc) {
      const d = indice?.porId.get(doc[1]);
      if (!d) throw new ErrorUsuario('Documento no encontrado.', 404);
      return enviar(res, 200, { id: d.id, nombre: d.nombre, radicado: d.radicado, fecha: d.fecha, ponente: d.ponente, url: d.url, archivo: d.archivo, texto: d.texto });
    }

    // Servir el login.html
    if (req.method === 'GET' && ruta === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(RAIZ, 'public', 'login.html')));
    }

    // Servir la librería para exportar a Word
    if (req.method === 'GET' && ruta === '/html-docx.min.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(fs.readFileSync(path.join(RAIZ, 'public', 'html-docx.min.js')));
    }

    // Servir la página principal (Solo si hay sesión)
    if (req.method === 'GET' && (ruta === '/' || ruta === '/index.html')) {
      const cookies = req.headers.cookie || '';
      if (!cookies.includes('usuario_id=')) {
        res.writeHead(302, { 'Location': '/login' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(RAIZ, 'public', 'index.html')));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  } catch (e) {
    if (e instanceof ErrorUsuario) return enviar(res, e.status, { error: e.message });
    console.error(e);
    enviar(res, 500, { error: e.message || 'Error interno.' });
  }
}).listen(PUERTO, '0.0.0.0', async () => {
  console.log('');
  console.log('  ⚖  Jurisprudencia Penal · MVP');
  console.log(`  Abre en tu navegador:  http://127.0.0.1:${PUERTO}`);
  console.log(`  Corpus: ${corpus.length} sentencias · Casos de prueba: ${casosPrueba.length}`);
  if (process.env.GEMINI_API_KEY) {
    try { const m = await modelosTexto(); console.log(`  Modelo de IA: ${m[0]}${m.length > 1 ? '  (respaldo automático: ' + m.slice(1).join(', ') + ')' : ''}`); }
    catch (e) { console.error('  ⚠ ' + e.message); }
  }
  console.log('  Para detener el servidor: Ctrl + C');
  console.log('');
});