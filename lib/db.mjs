import { createClient } from '@libsql/client/web';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !line.trim().startsWith('#')) {
      const key = match[1];
      let value = match[2] || '';
      value = value.replace(/(^['"]|['"]$)/g, '').trim();
      if (!process.env[key]) process.env[key] = value;
    }
  });
}

// --- CONFIGURACIÓN SEGURA ---
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  console.error('❌ ERROR: Faltan las variables TURSO_DATABASE_URL o TURSO_AUTH_TOKEN en el archivo .env');
}

export const db = createClient({ 
  url: url, 
  authToken: authToken,
  intMode: 'number'
});

export async function inicializarDB() {  
  if (!url || !authToken) return;  
  try {    
    // Tabla de usuarios
    await db.execute(`      
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE,
        password TEXT,
        creado_en TEXT DEFAULT CURRENT_TIMESTAMP
      );    
    `);        
    
    // Tabla de documentos (Sentencias guardadas) CON LA NUEVA COLUMNA
    await db.execute(`      
      CREATE TABLE IF NOT EXISTS documentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        sentencia_id TEXT,
        nombre TEXT,
        radicado TEXT,
        ponente TEXT,
        fecha TEXT,
        url_oficial TEXT,
        etiqueta TEXT,
        analisis_json TEXT,
        guardado_en TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(usuario_id, sentencia_id)
      );    
    `);        

    // Tabla de notas (Bloques separados por sentencia)
    await db.execute(`      
      CREATE TABLE IF NOT EXISTS notas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        sentencia_id TEXT,
        texto TEXT,
        creado_en TEXT DEFAULT CURRENT_TIMESTAMP
      );    
    `);        

    // Tabla de historial
    await db.execute(`      
      CREATE TABLE IF NOT EXISTS historial (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        caso TEXT,
        fecha TEXT DEFAULT CURRENT_TIMESTAMP
      );    
    `);        

    console.log('  🗄️ Base de datos conectada y tablas listas.');  
  } catch (error) {    
    if (!error.message.includes('migration') && !error.message.includes('400')) {      
      console.error('❌ Error inicializando:', error.message);    
    }  
  }
}

// --- USUARIOS ---
export async function registrarUsuario(usuario, password) {
  try {
    const res = await db.execute({ sql: 'INSERT INTO usuarios (usuario, password) VALUES (?, ?)', args: [usuario, password] });
    return { ok: true, id: Number(res.lastInsertRowid) };
  } catch (e) {
    console.error("🚨 ERROR REAL EN REGISTRO:", e);
    return { ok: false, error: e.message.includes('UNIQUE') ? 'El usuario ya existe' : 'Error en el registro' };
  }
}

export async function loginUsuario(usuario, password) {
  try {
    const res = await db.execute({ sql: 'SELECT id, usuario FROM usuarios WHERE usuario = ? AND password = ?', args: [usuario, password] });
    return res.rows.length > 0 ? { ok: true, id: res.rows[0].id, usuario: res.rows[0].usuario } : { ok: false, error: 'Usuario o contraseña incorrectos' };
  } catch (e) {
    console.error("🚨 ERROR REAL EN LOGIN:", e);
    return { ok: false, error: 'Error de conexión' };
  }
}

// --- DOCUMENTOS (SENTENCIAS GUARDADAS) ---
export async function guardarDocumento(usuario_id, doc) {
  return await db.execute({
    // Ahora guardamos el analisis_json y actualizamos si ya existe
    sql: `INSERT INTO documentos (usuario_id, sentencia_id, nombre, radicado, ponente, fecha, url_oficial, analisis_json) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
          ON CONFLICT(usuario_id, sentencia_id) DO UPDATE SET analisis_json = excluded.analisis_json`,
    args: [usuario_id, doc.sentencia_id, doc.nombre, doc.radicado, doc.ponente, doc.fecha, doc.url_oficial, doc.analisis_json || null]
  });
}

export async function obtenerDocumentos(usuario_id) {
  const res = await db.execute({ sql: 'SELECT * FROM documentos WHERE usuario_id = ? ORDER BY guardado_en DESC', args: [usuario_id] });
  return res.rows;
}

export async function eliminarDocumento(usuario_id, id) {
  return await db.execute({ sql: 'DELETE FROM documentos WHERE id = ? AND usuario_id = ?', args: [id, usuario_id] });
}

// --- NOTAS (BLOQUES SEPARADOS) ---
export async function guardarNotaDB(usuario_id, sentencia_id, texto) {
  return await db.execute({
    sql: 'INSERT INTO notas (usuario_id, sentencia_id, texto) VALUES (?, ?, ?)',
    args: [usuario_id, sentencia_id, texto]
  });
}

export async function obtenerNotasDB(usuario_id, sentencia_id) {
  const res = await db.execute({
    sql: 'SELECT * FROM notas WHERE usuario_id = ? AND sentencia_id = ? ORDER BY creado_en DESC',
    args: [usuario_id, sentencia_id]
  });
  return res.rows;
}

export async function eliminarNotaDB(id) {
  return await db.execute({ sql: 'DELETE FROM notas WHERE id = ?', args: [id] });
}

// --- HISTORIAL Y ESTADÍSTICAS ---
export async function guardarHistorialDB(usuario_id, caso) {
  return await db.execute({
    sql: "INSERT INTO historial (usuario_id, caso, fecha) VALUES (?, ?, datetime('now'))",
    args: [usuario_id, caso]
  });
}

export async function obtenerHistorialDB(usuario_id) {
  const res = await db.execute({
    sql: 'SELECT * FROM historial WHERE usuario_id = ? ORDER BY fecha DESC LIMIT 50',
    args: [usuario_id]
  });
  return res.rows;
}

export async function obtenerEstadisticasDB(usuario_id) {
  const guardadas = await db.execute({ sql: 'SELECT COUNT(*) as total FROM documentos WHERE usuario_id = ?', args: [usuario_id] });
  const busquedas = await db.execute({ sql: 'SELECT COUNT(*) as total FROM historial WHERE usuario_id = ?', args: [usuario_id] });
  const notas = await db.execute({ sql: 'SELECT COUNT(*) as total FROM notas WHERE usuario_id = ?', args: [usuario_id] });
  
  return {
    guardadas: guardadas.rows[0]?.total || 0,
    busquedas: busquedas.rows[0]?.total || 0,
    notas: notas.rows[0]?.total || 0
  };
}