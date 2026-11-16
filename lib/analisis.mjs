// lib/analisis.mjs
import { generarJSON } from './gemini.mjs';
import { anonimizar } from './texto.mjs';

export async function analizarCaso(indice, textoCaso) {
  // 1. Anonimizamos el texto antes de enviarlo a la IA
  const textoAnonimizado = anonimizar(textoCaso);
  
  // 2. Buscamos las sentencias más similares usando el motor híbrido
  const resultadosBusqueda = await indice.buscar(textoAnonimizado, 10);

  // 3. Preparamos el prompt para que la IA analice el caso y lo compare con las sentencias
  const prompt = `
    Eres un asistente jurídico experto en derecho penal colombiano. 
    Analiza el siguiente caso y compáralo con las sentencias proporcionadas.

    CASO DEL USUARIO (Anonimizado):
    ${textoAnonimizado}

    SENTENCIAS ENCONTRADAS:
    ${resultadosBusqueda.map((r, i) => `
      [Sentencia ${i + 1}]
      Nombre: ${r.nombre}
      Texto: ${r.texto.substring(0, 3000)}...
    `).join('\n')}

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
    const sentenciaReal = resultadosBusqueda.find(s => s.id === rIA.id) || resultadosBusqueda[0];
    return {
      ...sentenciaReal, // Metadatos reales del corpus
      ...rIA,           // Análisis de la IA
      // Nos aseguramos de que los campos críticos sean los reales
      nombre: sentenciaReal.nombre,
      radicado: sentenciaReal.radicado,
      fecha: sentenciaReal.fecha,
      ponente: sentenciaReal.ponente,
      url: sentenciaReal.url,
      archivo: sentenciaReal.archivo
    };
  });

  return {
    ...analisisJSON,
    resultados: resultadosFinales,
    anonimizacion: {
      reemplazos: 1 // Puedes calcular esto con contarReemplazos()
    }
  };
}