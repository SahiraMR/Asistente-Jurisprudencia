// Evaluación de la recuperación con métricas estándar de Recuperación de Información.
//
// Juicios de relevancia (qrels) por caso de prueba:
//   3 = sentencia objetivo (el caso se escribió parafraseando sus hechos)
//   2 = otra sentencia juzgada relevante por el equipo (opcional)
//   1 = misma categoría de delito (relevancia parcial, asignada automáticamente)
//   0 = resto
// "Relevante" para Recall y MRR = grado >= 2.

import { METODOS } from './buscador.mjs';

const log2 = x => Math.log(x) / Math.LN2;

function juicios(caso, indice) {
  const g = { ...(caso.relevantes || {}) };
  for (const d of indice.docs) if (d.delito === caso.delito && !(d.id in g)) g[d.id] = 1;
  return g;
}

export function medir(ids, g) {
  const rel = Object.keys(g).filter(id => g[id] >= 2);
  const enTop = k => ids.slice(0, k).filter(id => (g[id] || 0) >= 2).length;
  const recall = k => rel.length ? enTop(k) / rel.length : 0;
  const primera = ids.findIndex(id => (g[id] || 0) >= 2);

  const dcg = ids.slice(0, 10).reduce((s, id, i) => s + (2 ** (g[id] || 0) - 1) / log2(i + 2), 0);
  const ideal = Object.values(g).sort((a, b) => b - a).slice(0, 10).reduce((s, x, i) => s + (2 ** x - 1) / log2(i + 2), 0);

  return {
    recall5: recall(5),
    recall10: recall(10),
    mrr: primera >= 0 ? 1 / (primera + 1) : 0,
    ndcg10: ideal ? dcg / ideal : 0,
    p5: ids.slice(0, 5).filter(id => (g[id] || 0) >= 1).length / 5,
    posicion: primera >= 0 ? primera + 1 : null
  };
}

const METRICAS = ['recall5', 'recall10', 'mrr', 'ndcg10', 'p5'];

function promediar(filas, metodos) {
  const n = filas.length || 1;
  return Object.fromEntries(metodos.map(m => [m, {
    nombre: METODOS[m],
    ...Object.fromEntries(METRICAS.map(c => [c, Math.round(filas.reduce((s, f) => s + f.medidas[m][c], 0) / n * 1000) / 1000]))
  }]));
}

export async function evaluar(indice, casos, { k = 10 } = {}) {
  const metodos = Object.keys(METODOS).filter(m => m === 'bm25' || indice.semanticaLista);
  const filas = [];

  for (const caso of casos) {
    const g = juicios(caso, indice);
    const fila = { id: caso.id, delito: caso.delito, grupo: caso.grupo || 'general', objetivo: Object.keys(caso.relevantes || {}).filter(x => caso.relevantes[x] >= 3), metodos: {}, medidas: {} };
    for (const m of metodos) {
      const ids = (await indice.buscar(caso.consulta, m, k)).map(r => r.id);
      const r = medir(ids, g);
      fila.metodos[m] = { posicion: r.posicion, top5: ids.slice(0, 5) };
      fila.medidas[m] = r;
    }
    filas.push(fila);
  }

  const grupos = {};
  for (const gr of [...new Set(filas.map(f => f.grupo))]) {
    const sub = filas.filter(f => f.grupo === gr);
    grupos[gr] = { casos: sub.length, metodos: promediar(sub, metodos) };
  }
  const detalle = filas.map(({ medidas, ...resto }) => resto);

  return {
    fecha: new Date().toISOString(),
    casos: casos.length,
    documentos: indice.docs.length,
    metodos: promediar(filas, metodos),
    grupos,
    sin_semantica: !indice.semanticaLista ? (indice.estadoEmb.error || 'Embeddings no disponibles') : '',
    detalle
  };
}
