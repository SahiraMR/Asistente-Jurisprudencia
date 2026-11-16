// lib/analisis.mjs
import { generarJSON } from './gemini.mjs';
import { anonimizar } from './texto.mjs';

export async function analizarCaso(indice, textoCaso) {
  // 1. Anonimizamos el texto del usuario
  const { texto: casoAnonimizado, reemplazos } = anonimizar(textoCaso);
  
  // 2. Buscamos las sentencias más similares
  const resultadosBusqueda = await indice.buscar(casoAnonimizado, 10);

  // 3. Preparamos el texto de las sentencias ANONIMIZADO
  const sentenciasParaIA = resultadosBusqueda.map((r, i) => {
    const sentenciaReal = indice.porId.get(r.id);
    // Anonimizamos el texto de la sentencia antes de enviarlo a la IA
    const textoAnonimizado = anonimizar(sentenciaReal.texto.substring(0, 3000)).texto;
    return `
      [Sentencia ${i + 1}] ID: ${r.id}
      Nombre: ${r.nombre}
      Texto: ${textoAnonimizado}...
    `;
  }).join('\n');

  // 4. Prompt completo con TODAS las instrucciones y REGLA REFORZADA
  const prompt = `
    Eres un asistente jurídico experto en derecho penal colombiano. 
    Analiza el siguiente caso y compáralo con las sentencias proporcionadas.

    CASO DEL USUARIO (Anonimizado):
    ${casoAnonimizado}

    SENTENCIAS ENCONTRADAS (Anonimizadas):
    ${sentenciasParaIA}

    INSTRUCCIONES ESTRICTAS DE RESPUESTA (Debes devolver un JSON válido):
    
    1. Extrae los hechos proporcionados, hechos no confirmados y problemas jurídicos del caso del usuario.
    2. Para cada sentencia, asigna un nivel de similitud (A, B, C) y justifica por qué.
    3. Enumera las similitudes y diferencias entre el caso y cada sentencia.
    4. Extrae el resumen de la decisión de cada sentencia: hechos probados, problema jurídico, argumentos, decisión y pena.

    REGLA ESTRICTA DE ANONIMIZACIÓN (OBLIGATORIO E INQUEBRANTABLE):
    - En TODOS los campos de tu respuesta, NO uses nombres propios de personas.
    - Si el texto original menciona un nombre (incluso si está en mayúsculas o es un nombre compuesto como "JUAN CAMILO RAMÍREZ OSORIO"), DEBES reemplazarlo por "el procesado", "la víctima", "el ciudadano", "el sujeto activo" o "el sujeto pasivo".
    - NO uses etiquetas como [NOMBRE], [CEDULA] o [TELEFONO]. Simplemente escribe el término genérico.
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
          "delitos": ["..."],
          "hechos": "hechos que el tribunal consideró probados",
          "problema_juridico": "cuestión que resolvió el tribunal",
          "normas": ["..."],
          "argumentos": "razones principales del tribunal",
          "decision": "qué resolvió exactamente el tribunal",
          "pena": "pena definitiva si hubo condena",
          "similitudes": ["..."],
          "diferencias": ["..."]
        }
      ]
    }
  `;

  // 5. Llamamos a Gemini
  const analisisJSON = await generarJSON(prompt, { temperatura: 0.1 });

  // 6. Cruzamos los metadatos reales con el análisis de la IA
  const resultadosFinales = analisisJSON.resultados.map(rIA => {
    const sentenciaReal = indice.porId.get(rIA.id) || indice.porId.get(resultadosBusqueda[0].id);
    return {
      id: sentenciaReal.id,
      posicion: resultadosBusqueda.findIndex(r => r.id === sentenciaReal.id) + 1,
      puntaje: resultadosBusqueda.find(r => r.id === sentenciaReal.id)?.puntaje || 0,
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
      nivel: rIA.nivel,
      justificacion_nivel: rIA.justificacion_nivel,
      similitudes: rIA.similitudes || [],
      diferencias: rIA.diferencias || [],
      hechos: rIA.hechos || 'No consta',
      problema_juridico: rIA.problema_juridico || 'No consta',
      argumentos: rIA.argumentos || 'No consta',
      decision: rIA.decision || 'No consta',
      pena: rIA.pena || 'No consta',
      normas: rIA.normas || [],
      delitos: rIA.delitos || []
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