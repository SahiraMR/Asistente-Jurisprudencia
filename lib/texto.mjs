// Utilidades de texto: normalización, tokenización y anonimización.

const STOP = new Set(`a al algo algun alguna algunas alguno algunos ante antes aquel aquella aquellas aquellos aqui asi aun
aunque cada como con conforme contra cual cuales cualquier cuando cuanto de del desde donde dos durante e el ella ellas
ello ellos en entre era eran es esa esas ese eso esos esta estaba estaban estado estan estar estas este esto estos fue
fueron ha habia habian han hasta hay la las le les lo los mas me mediante mi mientras mismo misma mismos mismas muy ni no
nos o otra otras otro otros para pero poco por porque pues que quien quienes se sea sean segun ser si sido siempre sin
sobre son su sus tal tambien tan tanto te tiene tienen todo toda todos todas tras tu un una uno unos unas y ya dicho
dicha dichos dichas cuyo cuya cuyos cuyas hecho hechos sala corte decision providencia articulo ley`.split(/\s+/));

export const normalizar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Tokenizador para la búsqueda léxica (BM25):
// minúsculas, sin tildes, sin palabras vacías y con un "stemming" simple por prefijo (6 letras),
// para que "hurto" y "hurtos" o "homicidio" y "homicida" coincidan.
export function tokenizar(s) {
  const salida = [];
  for (const t of normalizar(s).match(/[a-z0-9]+/g) || []) {
    if (/^\d+$/.test(t)) { if (t.length === 3) salida.push(t); continue; } // números de artículo (p. ej. 240)
    if (t.length < 3 || STOP.has(t)) continue;
    salida.push(t.length > 6 ? t.slice(0, 6) : t);
  }
  return salida;
}

// Anonimización básica antes de enviar el texto a la IA (Ley 1581 de 2012).
// No es perfecta: solo detecta patrones frecuentes. Por eso la interfaz también pide no escribir datos personales.
const PATRONES = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[CORREO]'],
  [/\b(?:c\.?\s?c\.?|c[eé]dula(?:\s+de\s+ciudadan[ií]a)?|t\.?\s?i\.?|documento\s+de\s+identidad)\s*(?:n[o°º.]*\s*)?:?\s*[\d.\s]{6,15}\d/gi, '[DOCUMENTO DE IDENTIDAD]'],
  [/\b\d{1,3}(?:\.\d{3}){2,3}\b/g, '[NÚMERO DE IDENTIFICACIÓN]'],
  [/(?:\+?57\s?)?\b3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, '[TELÉFONO]'],
  [/\b(señor|señora|sr\.|sra\.|don|doña|joven|ciudadano|ciudadana|cliente|procesado|procesada|acusado|acusada|imputado|imputada|víctima)\s+((?:[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)(?:\s+(?:de\s+)?[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3})/g, '$1 [NOMBRE]']
];

export function anonimizar(texto) {
  let t = String(texto || '');
  let reemplazos = 0;
  for (const [re, rep] of PATRONES) {
    t = t.replace(re, (...m) => { reemplazos++; return rep.replace('$1', m[1] ?? ''); });
  }
  return { texto: t, reemplazos };
}
