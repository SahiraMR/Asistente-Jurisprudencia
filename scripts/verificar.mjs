// Diagnóstico paso a paso de la instalación.   Uso:  node scripts/verificar.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = m => console.log('  ✔ ' + m);
const mal = m => { console.log('  ✘ ' + m); process.exitCode = 1; };

console.log('\nVerificando la instalación…\n');

// 1. Node
const [mayor] = process.versions.node.split('.').map(Number);
mayor >= 18 ? ok(`Node.js ${process.versions.node}`) : mal(`Node.js ${process.versions.node}: se necesita 18 o superior (https://nodejs.org)`);

// 2. .env y clave
const env = path.join(RAIZ, '.env');
if (!fs.existsSync(env)) mal('No existe el archivo .env. Copia .env.ejemplo como .env y escribe tu clave.');
else {
  for (const l of fs.readFileSync(env, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  process.env.GEMINI_API_KEY && !/tu[-_ ]?clave/i.test(process.env.GEMINI_API_KEY)
    ? ok('Archivo .env con GEMINI_API_KEY')
    : mal('GEMINI_API_KEY está vacía en .env (consíguela en https://aistudio.google.com/apikey)');
}

// 3. Corpus
const corpus = path.join(RAIZ, 'data', 'corpus.json');
if (!fs.existsSync(corpus)) mal('Falta data/corpus.json');
else ok(`Corpus con ${JSON.parse(fs.readFileSync(corpus, 'utf8')).length} sentencias`);
const casos = path.join(RAIZ, 'data', 'casos_prueba.json');
fs.existsSync(casos) ? ok(`Casos de prueba: ${JSON.parse(fs.readFileSync(casos, 'utf8')).length}`) : mal('Falta data/casos_prueba.json');

// 4. Gemini
if (process.env.GEMINI_API_KEY) {
  const g = await import('../lib/gemini.mjs');
  try {
    const lista = await g.modelosTexto();
    console.log('  … Modelos de texto en orden de preferencia: ' + lista.join(', '));
    const r = await g.generarJSON('Responde exactamente este JSON: {"ok": true}');
    r.ok ? ok(`Gemini responde (modelo de texto: ${g.ultimoModelo()})`) : mal('Gemini respondió algo inesperado');
  } catch (e) { mal('Gemini (texto): ' + e.message); }
  try {
    const m = await g.modeloEmbed();
    const [v] = await g.embeber(['hurto calificado con arma blanca'], 'RETRIEVAL_QUERY');
    ok(`Embeddings funcionan (modelo: ${m}, ${v.length} dimensiones)`);
  } catch (e) { mal('Gemini (embeddings): ' + e.message + ' → la app funcionará solo con búsqueda léxica.'); }
}

console.log(process.exitCode ? '\nHay problemas: revisa los puntos marcados con ✘.\n' : '\nTodo listo. Ejecuta:  node server.js\n');
