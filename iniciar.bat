@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Jurisprudencia Penal - MVP
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No se encontro Node.js. Instalalo desde https://nodejs.org ^(version LTS^) y vuelve a abrir este archivo.
  echo.
  pause
  exit /b
)
if not exist ".env" (
  copy ".env.ejemplo" ".env" >nul
  echo.
  echo  Se creo el archivo .env. Escribe tu clave de Gemini en la linea GEMINI_API_KEY, guarda y cierra el Bloc de notas.
  echo.
  notepad ".env"
)
start "" http://127.0.0.1:3000
node server.js
pause
