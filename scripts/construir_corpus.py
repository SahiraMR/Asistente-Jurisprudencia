#!/usr/bin/env python3
"""
Construye data/corpus.json a partir de una carpeta de sentencias organizada por delito:

    sentencias/
      hurto/            SP1234-2023.pdf, ...
      homicidio/        ...
      estupefacientes/  ...
      enlaces.csv       (opcional) columnas: archivo,url

Uso:  python3 scripts/construir_corpus.py <carpeta_sentencias> data/corpus.json
Requiere: pdftotext (poppler) para PDF y LibreOffice (soffice) para .doc / .rtf.
"""
import csv, json, os, re, subprocess, sys, tempfile, unicodedata, zipfile, html

MESES = 'enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre'.split()


def leer_docx(ruta):
    with zipfile.ZipFile(ruta) as z:
        xml = z.read('word/document.xml').decode('utf8', 'ignore')
    xml = re.sub(r'</w:p>', '\n', xml)
    xml = re.sub(r'<w:tab/>', '\t', xml)
    return html.unescape(re.sub(r'<[^>]+>', '', xml))


def extraer_texto(ruta):
    ext = os.path.splitext(ruta)[1].lower()
    if ext == '.pdf':
        return subprocess.run(['pdftotext', '-enc', 'UTF-8', ruta, '-'], capture_output=True, text=True).stdout
    if ext == '.docx':
        return leer_docx(ruta)
    if ext in ('.txt',):
        return open(ruta, encoding='utf8', errors='ignore').read()
    if ext in ('.doc', '.rtf', '.odt'):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['soffice', '--headless', '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', tmp, ruta],
                           capture_output=True, timeout=180)
            for f in os.listdir(tmp):
                return open(os.path.join(tmp, f), encoding='utf8', errors='ignore').read()
    return ''


def limpiar(t):
    t = unicodedata.normalize('NFC', t).replace('\f', '\n').replace('\r', '')
    t = re.sub(r'[ \t ]+', ' ', t)
    t = re.sub(r'\n\s*\n+', '\n\n', t)
    # OCR con letras separadas ("J O S E F R A N C I S C O") -> palabras normales
    t = re.sub(r'(?<!\w)(?:\w ){3,}\w(?!\w)', lambda m: m.group(0).replace(' ', ''), t)
    # OCR con espacios dentro de palabras ("d e", "l a", "p o r") muy frecuentes
    t = re.sub(r'(?<!\w)(d|l|p|s|c|e) (e|a|o|or|el|on|n)(?!\w)', r'\1\2', t)
    return t.strip()


def buscar(patrones, t, flags=re.I):
    for p in patrones:
        m = re.search(p, t, flags)
        if m:
            return re.sub(r'\s+', ' ', m.group(1)).strip(' .:-')
    return ''


def nombre_delito(carpeta):
    c = re.sub(r'([a-z])([A-Z])', r'\1 \2', carpeta).lower().replace('_', ' ').replace('-', ' ').strip()
    return {'homicidios': 'homicidio', 'hurtos': 'hurto'}.get(c, c)


TIPOS = {'SP': 'Sentencia', 'AP': 'Auto', 'STP': 'Tutela', 'SEP': 'Sentencia (primera instancia)', 'CP': 'Concepto'}


def metadatos(t, archivo):
    cab = t[:6000]
    base = os.path.splitext(archivo)[0]
    # Convención de la relatoría: "SP281-2023(61694)" = providencia + (radicado)
    m_arch = re.match(r'^\s*((?:SP|AP|SEP|STP|CP)\d{1,5}-\d{4})', base)
    # Si el archivo no trae el código, se busca solo en el encabezado (antes de "VISTOS"/"ASUNTO"),
    # para no tomar una providencia citada dentro del texto.
    encabezado = re.split(r'\n\s*(?:I\.\s*)?(?:VISTOS|ASUNTO|ANTECEDENTES)\b', cab, maxsplit=1)[0][:800]
    nombre = m_arch.group(1) if m_arch else buscar([r'\b((?:SP|AP|SEP|STP)\s?\d{1,5}\s?-\s?\d{4})\b'], encabezado, 0)
    rad_arch = re.search(r'\((\d{4,6})\)', base) or re.match(r'^(\d{5,6})\(', base)
    radicado = buscar([r'Radicaci[oó]n\s*(?:n(?:[uú]mero)?\.?\s*[°º.]?|No\.?|N[°º])?\s*:?\s*(\d[\d.\-]{0,30}\d)',
                       r'Radicado\s*(?:n\.?\s*[°º]?|No\.?|N[°º])?\s*:?\s*(\d[\d.\-]{2,30}\d)',
                       r'Proceso\s*(?:n\.?\s*[°º]?|No\.?|N[°º])\s*:?\s*(\d[\d.\-]{2,30}\d)'], encabezado or cab)
    if rad_arch:
        radicado = rad_arch.group(1)
    # Ponente: en la Sala Penal el nombre va en la línea ANTERIOR a "Magistrado Ponente".
    ponente = buscar([r'([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .\-]{5,60}?)\s*\n\s*Magistrad[oa]\s+[Pp]onente',
                      r'Magistrad[oa]s?\s+[Pp]onentes?\s*:?\s*\n?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .\-]{5,60})',
                      r'M\.\s?P\.\s*:?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ .\-]{5,60})'], cab, 0)
    ponente = ponente.split('\n')[0].strip().title() if ponente else ''
    # Fecha de la providencia: la que sigue a "Bogotá, D.C.," (no las fechas de los hechos).
    fecha = ''
    meses = '|'.join(MESES)
    m = re.search(r'Bogot[áa][^\n(]{0,15}?,?\s*[A-Za-záéíóú]+\s*\((\d{1,2})\)\s*de\s*(' + meses + r')\s*(?:de\s*)?[^()]{0,60}?\((\d)\.?(\d{3})\)', cab, re.I)
    if m:
        fecha = f'{int(m.group(1))} de {m.group(2).lower()} de {m.group(3)}{m.group(4)}'
    else:
        m = re.search(r'\((\d{1,2})\)\s*de\s*(' + meses + r')\s*(?:de\s*)?[^()]{0,60}?\((\d)\.?(\d{3})\)', cab, re.I)
        if m:
            fecha = f'{int(m.group(1))} de {m.group(2).lower()} de {m.group(3)}{m.group(4)}'
    if not fecha:
        m = re.search(r'Bogot[áa][^\n(]{0,15}?,?\s*[A-Za-záéíóú]+\s*\((\d{1,2})\)\s*de\s*(' + meses + r')\s*de\s*(\d{4})', cab, re.I)
        if m:
            fecha = f'{int(m.group(1))} de {m.group(2).lower()} de {m.group(3)}'
    if not nombre:
        tipo_enc = 'AP' if re.search(r'\bAP\s*-?\s*\d{4}\b', encabezado) else ''
        nombre = f'{tipo_enc or "Providencia"} rad. {radicado or base}'
    nombre = re.sub(r'\s+', ' ', nombre).strip()
    tipo = TIPOS.get(re.match(r'[A-Z]*', nombre).group(0), 'Providencia')
    return nombre, radicado, ponente, fecha, tipo


def secciones(t):
    """Texto indexado = inicio + sección de hechos; texto final = parte resolutiva."""
    inicio = t[:2000]
    m = re.search(r'\n\s*(?:[IVX]+\.?\s*|\d+\.\s*|[A-Z]\)\s*)?(HECHOS|ANTECEDENTES(?:\s+F[ÁA]CTICOS)?|SITUACI[ÓO]N\s+F[ÁA]CTICA|'
                  r'HECHOS\s+Y\s+ACTUACI[ÓO]N\s+PROCESAL|ANTECEDENTES\s+RELEVANTES)\b', t[1500:])
    if m:
        ini = 1500 + m.start()
        hechos = t[ini:ini + 6000]
    else:
        hechos = t[2000:8000]
    pos = max(t.rfind('RESUELVE'), t.rfind('R E S U E L V E'), t.rfind('DECISIÓN'))
    final = t[pos:pos + 3000] if pos > len(t) * 0.5 else t[-3000:]
    return (inicio + '\n[…]\n' + hechos).strip(), final.strip()


def main(carpeta, salida):
    enlaces = {}
    for nombre in ('enlaces.csv', 'enlaces.CSV'):
        ruta = os.path.join(carpeta, nombre)
        if os.path.exists(ruta):
            with open(ruta, encoding='utf-8-sig', errors='ignore') as f:
                muestra = f.read(2048); f.seek(0)
                dialecto = csv.Sniffer().sniff(muestra, delimiters=',;\t') if muestra else csv.excel
                for fila in csv.reader(f, dialecto):
                    if len(fila) >= 2 and fila[1].strip().lower().startswith('http'):
                        enlaces[os.path.basename(fila[0].strip()).lower()] = fila[1].strip()

    docs, problemas, vistos = [], [], set()
    for raiz, dirs, archivos in os.walk(carpeta):
        # Las carpetas "excluidos" contienen decisiones descartadas por el equipo: no se indexan.
        excl = [d for d in dirs if d.lower().startswith('excluid')]
        for d in excl:
            n_ex = sum(len(f) for _, _, f in os.walk(os.path.join(raiz, d)))
            problemas.append(f'{os.path.relpath(os.path.join(raiz, d), carpeta)}: {n_ex} archivo(s) omitidos (carpeta de excluidos)')
        dirs[:] = sorted(d for d in dirs if d not in excl)
        rel = os.path.relpath(raiz, carpeta)
        delito = nombre_delito(rel.split(os.sep)[0]) if rel != '.' else 'sin clasificar'
        for a in sorted(archivos):
            if os.path.splitext(a)[1].lower() not in ('.pdf', '.docx', '.doc', '.rtf', '.txt', '.odt') or a.startswith('~$'):
                continue
            ruta = os.path.join(raiz, a)
            texto = limpiar(extraer_texto(ruta))
            if len(texto) < 3000:
                problemas.append(f'{delito}/{a}: texto insuficiente ({len(texto)} caracteres; ¿PDF escaneado?)')
                continue
            nombre, radicado, ponente, fecha, tipo = metadatos(texto, a)
            ident = re.sub(r'[^\w.-]', '_', nombre)
            base = ident; n = 2
            while ident in vistos:
                ident = f'{base}_{n}'; n += 1
            if base in vistos:
                problemas.append(f'{delito}/{a}: posible duplicado de {base}')
            vistos.add(ident)
            indexado, final = secciones(texto)
            url = enlaces.get(a.lower(), '')
            if url and not re.match(r'https?://([\w-]+\.)*(cortesuprema\.gov\.co|ramajudicial\.gov\.co|corteconstitucional\.gov\.co)(:\d+)?/', url):
                problemas.append(f'{delito}/{a}: URL no oficial descartada ({url})')
                url = ''
            docs.append(dict(id=ident, nombre=nombre, tipo=tipo, delito=delito, archivo=os.path.relpath(ruta, carpeta).replace(os.sep, '/'), radicado=radicado,
                             ponente=ponente, fecha=fecha, url=url, caracteres=len(texto),
                             texto_indexado=indexado, texto_final=final, texto=texto))

    # Correcciones manuales de metadatos (p. ej. PDFs escaneados con OCR defectuoso)
    ruta_corr = os.path.join(os.path.dirname(os.path.abspath(salida)), 'correcciones_metadatos.json')
    if os.path.exists(ruta_corr):
        corr = json.load(open(ruta_corr, encoding='utf8'))
        for d in docs:
            for k, v in corr.get(d['id'], {}).items():
                if k in ('nombre', 'radicado', 'ponente', 'fecha', 'url', 'tipo'):
                    d[k] = v
        print(f'Correcciones manuales aplicadas a {sum(1 for d in docs if d["id"] in corr)} documento(s).')

    os.makedirs(os.path.dirname(os.path.abspath(salida)), exist_ok=True)
    with open(salida, 'w', encoding='utf8') as f:
        json.dump(docs, f, ensure_ascii=False)

    print(f'Corpus: {len(docs)} sentencias -> {salida}')
    for d in sorted({d["delito"] for d in docs}):
        print(f'  {d}: {sum(1 for x in docs if x["delito"] == d)}')
    falt = lambda k: sum(1 for d in docs if not d[k])
    print(f'Sin radicado: {falt("radicado")} · sin ponente: {falt("ponente")} · sin fecha: {falt("fecha")} · sin URL: {falt("url")}')
    for p in problemas:
        print('  ⚠', p)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(1)
    main(sys.argv[1], sys.argv[2])
