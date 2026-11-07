// Motor de recuperación sobre el corpus local.
// Tres métodos comparables sobre el MISMO texto indexado de cada sentencia:
//   - bm25:      búsqueda léxica clásica (línea base "sin IA")
//   - semantica: similitud coseno entre embeddings de Gemini (máximo por fragmento)
//   - hibrida:   fusión de ambos rankings con Reciprocal Rank Fusion (RRF)

import fs from 'node:fs';
import crypto from 'node:crypto';
import { tokenizar } from './texto.mjs';
import { embeber, modeloEmbed } from './gemini.mjs';

const K1 = 1.2, B = 0.75, RRF_K = 60;
const TAM_FRAGMENTO = 1500, SOLAPE = 200;
const MAX_FRAGMENTOS = Number(process.env.EMBED_MAX_FRAGMENTOS || 6);

export const METODOS = {
  bm25: 'Léxica (BM25)',
  semantica: 'Semántica (embeddings)',
  hibrida: 'Híbrida (RRF)'
};

function fragmentar(texto) {
  const partes = [];
  for (let i = 0; i < texto.length && partes.length < MAX_FRAGMENTOS; i += TAM_FRAGMENTO - SOLAPE) {
    const p = texto.slice(i, i + TAM_FRAGMENTO).trim();
    if (p.length > 100) partes.push(p);
  }
  return partes.length ? partes : [texto.slice(0, TAM_FRAGMENTO)];
}

export class Indice {
  constructor(docs, rutaCache) {
    this.docs = docs;
    this.porId = new Map(docs.map(d => [d.id, d]));
    this.rutaCache = rutaCache;
    this.fragmentos = null;         // [{id, v}]
    this.cacheConsultas = new Map();
    this.estadoEmb = { estado: 'pendiente', hechos: 0, total: 0, error: '', modelo: '' };
    this.#construirBM25();
  }

  // ─── BM25 ──────────────────────────────────────────────────────
  #construirBM25() {
    this.tf = [];
    this.df = new Map();
    this.largo = [];
    for (const d of this.docs) {
      const tokens = tokenizar(d.texto_indexado);
      const frec = new Map();
      for (const t of tokens) frec.set(t, (frec.get(t) || 0) + 1);
      for (const t of frec.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      this.tf.push(frec);
      this.largo.push(tokens.length);
    }
    this.promedio = this.largo.reduce((a, b) => a + b, 0) / Math.max(1, this.docs.length);
  }

  bm25(consulta, k = 10) {
    const N = this.docs.length;
    const terminos = [...new Set(tokenizar(consulta))];
    const puntajes = this.docs.map((d, i) => {
      let s = 0;
      for (const t of terminos) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const n = this.df.get(t);
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * this.largo[i] / this.promedio));
      }
      return { id: d.id, puntaje: s };
    });
    return puntajes.filter(p => p.puntaje > 0).sort((a, b) => b.puntaje - a.puntaje).slice(0, k);
  }

  // ─── Embeddings ────────────────────────────────────────────────
  get semanticaLista() { return this.estadoEmb.estado === 'listo'; }

  async prepararEmbeddings() {
    try {
      this.estadoEmb = { estado: 'preparando', hechos: 0, total: 0, error: '', modelo: '' };
      const modelo = await modeloEmbed();
      this.estadoEmb.modelo = modelo;

      const lista = [];
      for (const d of this.docs) for (const f of fragmentar(d.texto_indexado)) lista.push({ id: d.id, texto: f });

      const huella = crypto.createHash('sha1')
        .update(modelo + '|' + TAM_FRAGMENTO + '|' + MAX_FRAGMENTOS + '|' + lista.map(x => x.id + ':' + x.texto.length).join(','))
        .digest('hex');

      // La caché guarda el avance por partes: si algo se interrumpe, se reanuda donde quedó.
      let hechos = [];
      if (fs.existsSync(this.rutaCache)) {
        try {
          const c = JSON.parse(fs.readFileSync(this.rutaCache, 'utf8'));
          if (c.huella === huella && Array.isArray(c.fragmentos)) hechos = c.fragmentos;
        } catch { /* caché dañada: se regenera */ }
      }
      this.estadoEmb.total = lista.length;
      this.estadoEmb.hechos = hechos.length;

      if (hechos.length === lista.length) {
        console.log(`[índice] Embeddings cargados desde caché (${lista.length} fragmentos).`);
      } else {
        console.log(hechos.length
          ? `[índice] Reanudando embeddings: ${hechos.length}/${lista.length} ya calculados.`
          : `[índice] Calculando embeddings de ${lista.length} fragmentos con ${modelo}… (solo la primera vez, unos minutos)`);
        const BLOQUE = 45;
        for (let i = hechos.length; i < lista.length; i += BLOQUE) {
          const parte = lista.slice(i, i + BLOQUE);
          const vectores = await embeber(parte.map(x => x.texto), 'RETRIEVAL_DOCUMENT', () => {}, ms => {
            console.log(`[índice] Esperando ${Math.round(ms / 1000)} s para respetar el límite gratuito de Gemini (100 textos y 30.000 tokens por minuto)…`);
          });
          hechos.push(...parte.map((x, j) => ({ id: x.id, v: vectores[j].map(n => Math.round(n * 1e5) / 1e5) })));
          this.estadoEmb.hechos = hechos.length;
          fs.writeFileSync(this.rutaCache, JSON.stringify({ huella, modelo, completo: hechos.length === lista.length, fragmentos: hechos }));
          console.log(`[índice] ${hechos.length}/${lista.length}`);
        }
        console.log('[índice] Embeddings listos y guardados en caché.');
      }
      this.fragmentos = hechos;
      this.estadoEmb.estado = 'listo';
    } catch (e) {
      this.estadoEmb.estado = 'error';
      this.estadoEmb.error = e.message;
      console.error('[índice] No se pudieron calcular los embeddings:', e.message);
      console.error(e.diario
        ? '[índice] Se agotó la cuota DIARIA de embeddings. El avance quedó guardado: al reiniciar el servidor (mañana o con otra clave) continuará donde quedó.'
        : '[índice] El avance quedó guardado: al reiniciar el servidor continuará donde quedó.');
      console.error('[índice] Mientras tanto, la app funciona solo con búsqueda léxica (BM25).');
    }
  }

  async vectorConsulta(consulta) {
    const clave = consulta.slice(0, 8000);
    if (!this.cacheConsultas.has(clave)) {
      const [v] = await embeber([clave], 'RETRIEVAL_QUERY');
      this.cacheConsultas.set(clave, v);
    }
    return this.cacheConsultas.get(clave);
  }

  async semantica(consulta, k = 10) {
    if (!this.semanticaLista) throw new Error('Los embeddings aún no están listos.');
    const q = await this.vectorConsulta(consulta);
    const mejor = new Map();
    for (const f of this.fragmentos) {
      let s = 0;
      for (let i = 0; i < q.length; i++) s += q[i] * f.v[i];
      if (s > (mejor.get(f.id) ?? -Infinity)) mejor.set(f.id, s);
    }
    return [...mejor].map(([id, puntaje]) => ({ id, puntaje })).sort((a, b) => b.puntaje - a.puntaje).slice(0, k);
  }

  async hibrida(consulta, k = 10) {
    const profundidad = this.docs.length;
    const [lex, sem] = await Promise.all([this.bm25(consulta, profundidad), this.semantica(consulta, profundidad)]);
    const total = new Map();
    lex.forEach((r, i) => total.set(r.id, (total.get(r.id) || 0) + 1 / (RRF_K + i + 1)));
    sem.forEach((r, i) => total.set(r.id, (total.get(r.id) || 0) + 1 / (RRF_K + i + 1)));
    return [...total].map(([id, puntaje]) => ({ id, puntaje })).sort((a, b) => b.puntaje - a.puntaje).slice(0, k);
  }

  async buscar(consulta, metodo = 'hibrida', k = 10) {
    if (metodo === 'bm25') return this.bm25(consulta, k);
    if (metodo === 'semantica') return this.semantica(consulta, k);
    return this.hibrida(consulta, k);
  }

  // Método por defecto de la app: híbrido si hay embeddings; si no, léxico.
  get metodoPorDefecto() { return this.semanticaLista ? 'hibrida' : 'bm25'; }

  resumen() {
    const porDelito = {};
    const porAnio = {};
    for (const d of this.docs) {
      porDelito[d.delito] = (porDelito[d.delito] || 0) + 1;
      const a = (String(d.fecha).match(/(19|20)\d{2}/) || ['Sin año'])[0];
      porAnio[a] = (porAnio[a] || 0) + 1;
    }
    return { documentos: this.docs.length, porDelito, porAnio, embeddings: this.estadoEmb };
  }
}
