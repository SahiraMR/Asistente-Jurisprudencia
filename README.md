# IurisSearch · Recuperación de Jurisprudencia Penal en Colombia

IurisSearch es una aplicación web full-stack diseñada para asistir a profesionales del derecho en la investigación de jurisprudencia penal colombiana. A partir de la descripción de un caso, el sistema utiliza inteligencia artificial (Google Gemini) para buscar y comparar sentencias de la Sala de Casación Penal de la Corte Suprema de Justicia, ofreciendo un análisis estructurado, persistencia de datos por usuario y herramientas de exportación.

> **Investigar → verificar → comparar → explicar → dejar decidir.** La herramienta no determina culpabilidad ni inocencia, no recomienda penas y no predice resultados. La valoración final corresponde exclusivamente al funcionario judicial.

---

## 🚀 Características Principales

- **Búsqueda Híbrida:** Combina búsqueda léxica (BM25) y semántica (embeddings de Gemini) para encontrar sentencias por similitud de hechos, problema jurídico y normas.
- **Análisis con IA:** La IA compara el caso con cada sentencia del corpus y asigna un nivel de similitud (A, B, C) con justificación, similitudes y diferencias.
- **Autenticación Anónima:** Sistema de registro e inicio de sesión (solo usuario y contraseña) para proteger la privacidad.
- **Espacio de Trabajo Personal:**
  - Guardar sentencias relevantes.
  - Añadir etiquetas (Para estudio, Para audiencia, Para citar).
  - Escribir notas separadas por cada sentencia (sistema de bloques).
- **Exportación a Word:** Generación de fichas de jurisprudencia y listas completas de documentos en formato `.docx`.
- **Historial y Estadísticas:** Cada usuario puede ver su historial de búsquedas y un resumen de su actividad en la plataforma.

---

## 🛠️ Tecnologías Utilizadas

- **Backend:** Node.js (v20+)
- **Base de Datos:** Turso (SQLite en la nube) mediante `@libsql/client`
- **IA:** Google Gemini API (Modelos de texto y embeddings)
- **Frontend:** HTML5, CSS3, JavaScript (Vanilla) con diseño responsive.
- **Librerías Frontend:** PDF.js (lectura de PDFs), html-docx-js (exportación a Word).

---

## 💻 Cómo ejecutarlo localmente

**Requisitos:**
1. [Node.js 20 o superior](https://nodejs.org)
2. Una cuenta en [Turso](https://turso.tech/) (Base de datos).
3. Una clave de API gratuita de [Google AI Studio](https://aistudio.google.com/apikey).

**Configuración:**

1. Clona el repositorio e instala las dependencias:
   ```bash
   npm install