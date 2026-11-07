#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instálalo desde https://nodejs.org (versión LTS)."; read -p "Enter para salir"; exit 1
fi
if [ ! -f .env ]; then
  cp .env.ejemplo .env
  echo "Se creó el archivo .env. Escribe tu clave de Gemini en GEMINI_API_KEY, guarda y cierra el editor."
  open -e .env 2>/dev/null || ${EDITOR:-nano} .env
  read -p "Cuando hayas guardado la clave, presiona Enter…"
fi
(sleep 2; open http://127.0.0.1:3000 2>/dev/null || xdg-open http://127.0.0.1:3000) &
node server.js
