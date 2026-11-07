// Cliente mínimo de la API de Gemini (REST), sin dependencias. Requiere Node 18+ (fetch incluido).
//
// Manejo de cuotas y disponibilidad (plan gratuito):
//   - Texto: si un modelo responde 503 (saturado), 429 (sin cuota), 404 (no disponible) o no responde,
//     se pasa automáticamente al siguiente modelo de la lista de respaldo.
//   - Embeddings: se envían a un ritmo seguro (por defecto 90 por minuto) para no superar el límite
//     gratuito de 100 por minuto; si aun así hay un 429 por minuto, se espera lo que indique Google.
//   - Si la cuota agotada es DIARIA, no se reintenta (cada reintento también gastaría cuota).

const BASE = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const DIMENSIONES = 768;
const esperar = ms => new Promise(r => setTimeout(r, ms));

const RESPALDO_POR_DEFECTO = 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash,gemini-3.7-flash,gemini-flash-latest';

// ─── Errores de Google ───────────────────────────────────────────
function leerError(status, texto) {
  let d = {};
  try { d = JSON.parse(texto).error || {}; } catch { /* no es JSON */ }
  const detalles = Array.isArray(d.details) ? d.details : [];
  const cuotas = detalles.flatMap(x => (x.violations || []).map(v => v.quotaId || '')).join(' ');
  const retraso = detalles.find(x => x.retryDelay)?.retryDelay;
  return {
    mensaje: d.message || texto.slice(0, 300),
    diario: /PerDay/i.test(cuotas),
    esperaMs: retraso ? Math.ceil(parseFloat(retraso) * 1000) : null
  };
}

class ErrorGemini extends Error {
  constructor(status, info) {
    const tipo = status === 429 ? (info.diario ? 'cuota diaria agotada' : 'límite por minuto') : status === 503 ? 'modelo saturado' : status === 404 ? 'modelo no disponible' : status === 0 ? 'sin respuesta' : '';
    super(`Gemini respondió ${status}${tipo ? ' (' + tipo + ')' : ''}: ${info.mensaje}`);
    this.status = status;
    this.diario = info.diario;
    this.esperaMs = info.esperaMs;
  }
}

// opciones.esperarCuota: si es true, ante un 429 por minuto espera lo indicado y reintenta (embeddings).
// opciones.reintentos5xx: reintentos ante errores temporales del servidor.
async function llamar(ruta, cuerpo, { metodo = 'POST', esperarCuota = false, reintentos5xx = 1, timeoutMs = 120_000 } = {}) {
  const clave = process.env.GEMINI_API_KEY;
  if (!clave) throw new Error('Falta GEMINI_API_KEY en el archivo .env');

  let fallos5xx = 0, esperasCuota = 0, fallosRed = 0;
  for (;;) {
    let r;
    try {
      r = await fetch(`${BASE()}/${ruta}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      if (++fallosRed <= 1) { await esperar(2000); continue; }
      throw new ErrorGemini(0, { mensaje: e.name === 'TimeoutError' ? `no respondió en ${timeoutMs / 1000} s` : 'sin conexión (' + e.message + ')' });
    }
    if (r.ok) return r.json();

    const info = leerError(r.status, await r.text());
    if (r.status === 429 && esperarCuota && !info.diario && ++esperasCuota <= 4) {
      await esperar(Math.min(Math.max(info.esperaMs ?? 30_000, 5_000), 70_000) + 1_000);
      continue;
    }
    if (r.status >= 500 && ++fallos5xx <= reintentos5xx) { await esperar(3000 * fallos5xx); continue; }
    throw new ErrorGemini(r.status, info);
  }
}

export function extraerJSON(texto) {
  if (!texto) throw new SyntaxError('La IA no devolvió contenido.');
  const limpio = texto.replace(/```json/gi, '').replace(/```/g, '').trim();
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio === -1 || fin === -1) throw new SyntaxError('La IA no devolvió un JSON válido.');
  return JSON.parse(limpio.slice(inicio, fin + 1));
}

// ─── Modelos disponibles ─────────────────────────────────────────
let listado = null;
async function listarModelos() {
  if (listado) return listado;
  const todos = [];
  let token = '';
  do {
    const d = await llamar(`models?pageSize=1000${token ? '&pageToken=' + token : ''}`, null, { metodo: 'GET', timeoutMs: 30_000 });
    todos.push(...(d.models || []));
    token = d.nextPageToken || '';
  } while (token);
  listado = todos.map(m => ({ nombre: m.name.replace(/^models\//, ''), metodos: m.supportedGenerationMethods || [] }));
  return listado;
}

const esErrorDeClave = e => e.status === 400 || e.status === 401 || e.status === 403;
const ERROR_CLAVE = 'La clave de Gemini no es válida o no tiene permisos. Revisa GEMINI_API_KEY en el archivo .env.';

// Lista ordenada de modelos de texto: el de GEMINI_MODEL primero y luego los de respaldo,
// conservando solo los que existen para esta clave.
let candidatos = null;
export async function modelosTexto() {
  if (candidatos) return candidatos;
  const pedido = (process.env.GEMINI_MODEL || '').trim();
  const respaldo = (process.env.GEMINI_MODELOS_RESPALDO || RESPALDO_POR_DEFECTO).split(',').map(s => s.trim()).filter(Boolean);
  let lista = [...new Set([pedido, ...respaldo].filter(Boolean))];
  try {
    const disponibles = new Set((await listarModelos()).filter(m => m.metodos.includes('generateContent')).map(m => m.nombre));
    const filtrada = lista.filter(m => disponibles.has(m));
    if (filtrada.length) lista = filtrada;
    if (pedido && !disponibles.has(pedido)) console.warn(`[gemini] El modelo "${pedido}" no aparece para esta clave; se usarán: ${lista.join(', ')}`);
  } catch (e) {
    if (esErrorDeClave(e)) throw new Error(ERROR_CLAVE);
  }
  return (candidatos = lista);
}

// Modelos que fallaron recientemente: se dejan "en pausa" un tiempo antes de volver a probarlos.
const pausa = new Map();
const PAUSA_MS = { 404: Infinity, 429: 2 * 60_000, diario: 6 * 3600_000, otro: 2 * 60_000 };
const enPausa = m => (pausa.get(m) || 0) > Date.now();

let activo = null;
export const ultimoModelo = () => activo;
export async function modeloTexto() { return activo || (await modelosTexto())[0]; }

// ─── Generación con respaldo automático ──────────────────────────
export async function generarJSON(prompt, { temperatura = 0.2 } = {}) {
  const lista = await modelosTexto();
  // Primero los modelos que no están en pausa; los pausados (salvo 404) quedan como último recurso.
  const orden = [...lista.filter(m => !enPausa(m)), ...lista.filter(m => enPausa(m) && pausa.get(m) !== Infinity)];
  const fallos = [];

  for (const m of orden) {
    try {
      const d = await llamar(`models/${m}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: temperatura, responseMimeType: 'application/json' }
      }, { reintentos5xx: 1, timeoutMs: 90_000 });
      const texto = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      if (!texto && d.promptFeedback?.blockReason) throw new Error('La IA bloqueó la solicitud (' + d.promptFeedback.blockReason + ').');
      const json = extraerJSON(texto);
      if (activo !== m) console.log(`[gemini] Usando el modelo de texto: ${m}`);
      activo = m;
      pausa.delete(m);
      return json;
    } catch (e) {
      if (esErrorDeClave(e)) throw new Error(ERROR_CLAVE);
      const recuperable = e instanceof SyntaxError || [0, 404, 429, 500, 502, 503, 504].includes(e.status);
      if (!recuperable) throw e;
      pausa.set(m, Date.now() + (e.status === 404 ? PAUSA_MS[404] : e.diario ? PAUSA_MS.diario : e.status === 429 ? PAUSA_MS[429] : PAUSA_MS.otro));
      fallos.push(`${m}: ${e.status ?? 'respuesta inválida'}${e.diario ? ' (cuota diaria)' : ''}`);
      console.warn(`[gemini] ${m} falló (${e.message.slice(0, 120)}); probando el siguiente modelo…`);
    }
  }
  throw new Error('Ningún modelo de texto de Gemini está disponible en este momento (' + fallos.join(' · ') + '). Intenta de nuevo en unos minutos.');
}

// ─── Embeddings a ritmo seguro ───────────────────────────────────
let modeloEmbedElegido = null;
export async function modeloEmbed() {
  if (modeloEmbedElegido) return modeloEmbedElegido;
  const pedido = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
  try {
    const disponibles = (await listarModelos()).filter(m => m.metodos.some(x => /embed/i.test(x))).map(m => m.nombre);
    modeloEmbedElegido = disponibles.includes(pedido) ? pedido : (disponibles.find(n => /embedding/.test(n)) || pedido);
  } catch (e) {
    if (esErrorDeClave(e)) throw new Error(ERROR_CLAVE);
    modeloEmbedElegido = pedido;
  }
  return modeloEmbedElegido;
}

// El plan gratuito limita los embeddings por minuto de DOS formas: 100 textos y 30.000 tokens.
// Se respetan ambas con margen. Los tokens se estiman de forma conservadora (1 token ≈ 3 caracteres).
const POR_MINUTO = Math.max(1, Number(process.env.EMBED_POR_MINUTO || 90));
const TOKENS_POR_MINUTO = Math.max(1000, Number(process.env.EMBED_TOKENS_POR_MINUTO || 25_000));
const TOKENS_POR_LOTE = Math.min(12_000, TOKENS_POR_MINUTO);
const estimarTokens = t => Math.ceil(t.length / 3) + 8;
const enviados = []; // [{t: marca de tiempo, n: textos, tokens}] del último minuto

async function reservar(n, tokens, alEsperar) {
  for (;;) {
    const ahora = Date.now();
    while (enviados.length && ahora - enviados[0].t >= 60_000) enviados.shift();
    const usadosN = enviados.reduce((s, x) => s + x.n, 0);
    const usadosT = enviados.reduce((s, x) => s + x.tokens, 0);
    if (!enviados.length || (usadosN + n <= POR_MINUTO && usadosT + tokens <= TOKENS_POR_MINUTO)) {
      enviados.push({ t: ahora, n, tokens });
      return;
    }
    const ms = 60_000 - (ahora - enviados[0].t) + 500;
    alEsperar(ms);
    await esperar(ms);
  }
}

// Agrupa los textos en lotes que respeten el máximo de textos y de tokens por solicitud.
function lotes(textos) {
  const salida = [];
  let actual = [], tokens = 0;
  for (const t of textos) {
    const k = estimarTokens(t);
    if (actual.length && (actual.length >= Math.min(50, POR_MINUTO) || tokens + k > TOKENS_POR_LOTE)) {
      salida.push({ textos: actual, tokens });
      actual = []; tokens = 0;
    }
    actual.push(t); tokens += k;
  }
  if (actual.length) salida.push({ textos: actual, tokens });
  return salida;
}

function normalizarVector(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

// tipo: 'RETRIEVAL_DOCUMENT' o 'RETRIEVAL_QUERY'
export async function embeber(textos, tipo, alProgresar = () => {}, alEsperar = () => {}) {
  const modelo = await modeloEmbed();
  const salida = [];
  for (const lote of lotes(textos)) {
    await reservar(lote.textos.length, lote.tokens, alEsperar);
    const d = await llamar(`models/${modelo}:batchEmbedContents`, {
      requests: lote.textos.map(t => ({ model: `models/${modelo}`, content: { parts: [{ text: t }] }, taskType: tipo, outputDimensionality: DIMENSIONES }))
    }, { esperarCuota: true, reintentos5xx: 3 });
    for (const e of d.embeddings || []) salida.push(normalizarVector(e.values));
    alProgresar(salida.length, textos.length);
  }
  if (salida.length !== textos.length) throw new Error('Gemini devolvió un número inesperado de embeddings.');
  return salida;
}
