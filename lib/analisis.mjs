// lib/analisis.mjs
import { generarJSON } from './gemini.mjs';
import { anonimizar } from './texto.mjs';

export async function analizarCaso(indice, textoCaso) {
  // 1. Anonimizamos el texto y extraemos el string y el número de reemplazos
  const { texto: textoAnonimizado, reemplazos } = anonimizar(textoCaso);
  
  // 2. Buscamos las sentencias más similares usando el motor híbrido
  const resultadosBusqueda = await indice.buscar(textoAnonimizado, 10);

  // 3. Preparamos el prompt para que la IA analice el caso y lo compare con las sentencias
  // CORRECCIÓN: Buscamos el texto real de la sentencia en el índice, no en el resultado de la búsqueda.
  const sentenciasParaIA = resultadosBusqueda.map((r, i) => {
    const sentenciaReal = indice.porId.get(r.id);
    return `
      [Sentencia ${i + 1}]
      Nombre: ${r.nombre}
      Texto: ${sentenciaReal.texto.substring(0, 3000)}...
    `;
  }).join('\n');

  const prompt = `
    Eres un asistente jurídico experto en derecho penal colombiano. 
    Analiza el siguiente caso y compáralo con las sentencias proporcionadas.

    CASO DEL USUARIO (Anonimizado):
    ${textoAnonimizado}

    SENTENCIAS ENCONTRADAS:
    ${sentenciasParaIA}

    INSTRUCCIONES ESTRICTAS DE RESPUESTA (Debes devolver un JSON válido):
    1. Extrae los hechos proporcionados, hechos no confirmados y problemas jurídicos del caso.
    2. Para cada sentencia, asigna un nivel de similitud (A, B, C) y justifica por qué.
    3. Enumera las similitudes y diferencias entre el caso y cada sentencia.

    REGLA ESTRICTA DE ANONIMIZACIÓN (OBLIGATORIO):
    - En TODOS los campos de tu respuesta (hechos, justificación, similitudes, diferencias), NO uses nombres propios de personas.
    - Si el texto original menciona un nombre, debes usar términos genéricos como "el procesado", "la víctima", "el ciudadano", "el sujeto activo" o "el sujeto pasivo".
    - NO uses etiquetas como [NOMBRE], [CEDULA] o [TELEFONO] en tu respuesta. Simplemente omítelas y usa los términos genéricos.
    - Esta regla es inquebrantable para cumplir con la Ley 1581 de Protección de Datos.

    Devuelve estrictamente el JSON con la siguiente estructura:
    {
      "hechos_proporcionados": ["..."],
      "hechos_no_confirmados": ["..."],
      "problemas": ["..."],
      "delitos_posibles": ["..."],
      "resultados": [
        {
          "id": "id de la sentencia",
          "nivel": "A|B|C",
          "justificacion_nivel": "...",
          "similitudes": ["..."],
          "diferencias": ["..."]
        }
      ]
    }
  `;

  // 4. Llamamos a Gemini
  const analisisJSON = await generarJSON(prompt, { temperatura: 0.1 });

  // 5. Cruzamos los metadatos reales con el análisis de la IA (Para evitar alucinaciones de links)
  const resultadosFinales = analisisJSON.resultados.map(rIA => {
    const sentenciaReal = indice.porId.get(rIA.id) || indice.porId.get(resultadosBusqueda[0].id);
    return {
      id: sentenciaReal.id,
      posicion: resultadosBusqueda.findIndex(r => r.id === sentenciaReal.id) + 1,
      puntaje: resultadosBusqueda.find(r => r.id === sentenciaReal.id)?.puntaje || 0,
      // Metadatos reales del corpus
      nombre: sentenciaReal.nombre,
      tipo: sentenciaReal.tipo || 'Providencia',
      corte: 'Corte Suprema de Justicia',
      sala: 'Sala de Casación Penal',
      fecha: sentenciaReal.fecha || 'No consta',
      radicado: sentenciaReal.radicado || 'No consta',
      ponente: sentenciaReal.ponente || 'No consta',
      delito_corpus: sentenciaReal.delito,
      url: sentenciaReal.url || '',
      archivo: sentenciaReal.archivo,
      // Análisis de la IA
      nivel: rIA.nivel,
      justificacion_nivel: rIA.justificacion_nivel,
      similitudes: rIA.similitudes || [],
      diferencias: rIA.diferencias || [],
      // Campos adicionales (pueden venir vacíos si la IA no los llenó)
      hechos: rIA.hechos || 'No consta',
      problema_juridico: rIA.problema_juridico || 'No consta',
      argumentos: rIA.argumentos || 'No consta',
      decision: rIA.decision || 'No consta',
      pena: rIA.pena || 'No consta',
      normas: rIA.normas || []
    };
  });

  return {
    ...analisisJSON,
    resultados: resultadosFinales,
    anonimizacion: {
      reemplazos: reemplazos
    }
  };
}