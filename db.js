const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data', 'control-actas.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, usuario TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, rol TEXT NOT NULL CHECK(rol IN ('director','admin','lector')), cargo TEXT NOT NULL, hash TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS inspectores (id INTEGER PRIMARY KEY, codigo TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, legajo TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS usuario_inspector (usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, codigo TEXT NOT NULL, PRIMARY KEY(usuario_id, codigo));
CREATE TABLE IF NOT EXISTS causales (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, controla TEXT DEFAULT '', aparte INTEGER DEFAULT 0, tipos TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS supuestos (id INTEGER PRIMARY KEY, causal_id INTEGER NOT NULL REFERENCES causales(id), nombre TEXT NOT NULL, activo INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS actas (id INTEGER PRIMARY KEY, nro TEXT NOT NULL, parte TEXT DEFAULT '', link TEXT NOT NULL, tipo TEXT DEFAULT '', inspector TEXT NOT NULL, razon TEXT DEFAULT '', cuit TEXT DEFAULT '', firmantes TEXT DEFAULT '[]', puntos TEXT DEFAULT '[]', admin_id INTEGER REFERENCES usuarios(id), director_id INTEGER REFERENCES usuarios(id), fecha_asignacion TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'asignada', fecha_fin TEXT, UNIQUE(nro, parte));
CREATE TABLE IF NOT EXISTS errores (id INTEGER PRIMARY KEY, acta_id INTEGER NOT NULL REFERENCES actas(id) ON DELETE CASCADE, punto TEXT NOT NULL, supuesto_id INTEGER NOT NULL REFERENCES supuestos(id), detalle TEXT DEFAULT '', estado TEXT NOT NULL DEFAULT 'pendiente', comentario TEXT DEFAULT '', fecha_revision TEXT, comunicado INTEGER DEFAULT 0, fecha_comunicado TEXT);
CREATE TABLE IF NOT EXISTS efectividad (id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, fecha TEXT NOT NULL, marcados INTEGER NOT NULL, rechazados INTEGER NOT NULL);
`);

// Migraciones: columnas y tablas agregadas después de la primera versión
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
[['orden', "TEXT DEFAULT ''"], ['actividad', "TEXT DEFAULT ''"], ['trabajadores', 'INTEGER'], ['receptor', "TEXT DEFAULT ''"], ['fecha_acta', 'TEXT'], ['fecha_citacion', 'TEXT'], ['plazo', 'TEXT'], ['acta_origen', "TEXT DEFAULT ''"], ['alertas', "TEXT DEFAULT '[]'"], ['informe', "TEXT DEFAULT ''"], ['secciones', "TEXT DEFAULT '[]'"], ['pdf', 'BLOB'], ['borrador', "TEXT DEFAULT ''"]].forEach(([c, t]) => addCol('actas', c, t));
[['subsanado', 'INTEGER DEFAULT 0'], ['fecha_subsanado', 'TEXT'], ['reincidente', 'INTEGER DEFAULT 0']].forEach(([c, t]) => addCol('errores', c, t));
addCol('usuarios', 'debe_cambiar', 'INTEGER DEFAULT 0');
addCol('inspectores', 'delegacion', "TEXT DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS auditoria (id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, usuario_id INTEGER, usuario TEXT, accion TEXT NOT NULL, entidad TEXT, entidad_id TEXT, detalle TEXT);
CREATE TABLE IF NOT EXISTS devoluciones (id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, fecha TEXT NOT NULL, nro_acta TEXT DEFAULT '', punto TEXT NOT NULL, supuesto_id INTEGER NOT NULL, detalle TEXT DEFAULT '', comentario TEXT DEFAULT '', respuesta TEXT DEFAULT '', leida INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_errores_acta ON errores(acta_id);
CREATE INDEX IF NOT EXISTS idx_actas_estado ON actas(estado);
CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(fecha);
`);

// Semilla inicial (solo si la base está vacía)
if (db.prepare('SELECT COUNT(*) c FROM usuarios').get().c === 0) {
  const seed = require('./seed.json');
  const h = bcrypt.hashSync('1234', 10);
  const iu = db.prepare('INSERT INTO usuarios (usuario,nombre,rol,cargo,hash,debe_cambiar) VALUES (?,?,?,?,?,1)');
  const iui = db.prepare('INSERT INTO usuario_inspector VALUES (?,?)');
  seed.usuarios.forEach(u => { const r = iu.run(u.usuario, u.nombre, u.rol, u.cargo, h); (u.inspectores || []).forEach(c => iui.run(r.lastInsertRowid, c)); });
  const ii = db.prepare('INSERT INTO inspectores (codigo,nombre,legajo,delegacion) VALUES (?,?,?,?)');
  seed.inspectores.forEach(i => ii.run(i.codigo, i.nombre, i.legajo, i.delegacion || ''));
  const ic = db.prepare('INSERT INTO causales (id,nombre,controla,aparte,tipos) VALUES (?,?,?,?,?)');
  seed.causales.forEach(c => ic.run(c.id, c.nombre, c.controla, c.aparte ? 1 : 0, '[]'));
  const is = db.prepare('INSERT INTO supuestos (id,causal_id,nombre,activo) VALUES (?,?,?,1)');
  seed.supuestos.forEach(s => is.run(s.id, s.causalId, s.nombre));
  console.log('Base inicializada con la semilla (usuarios, inspectores y catálogo).');
}

// Backups diarios de la base (se conservan los últimos 30)
const fs = require('fs');
function backup() {
  try {
    const dir = path.join(path.dirname(db.name), 'backups'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `control-actas-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(f)) { db.backup(f).then(() => { const old = fs.readdirSync(dir).filter(x => x.endsWith('.db')).sort().slice(0, -30); old.forEach(x => fs.unlinkSync(path.join(dir, x))); }).catch(e => console.error('Backup falló:', e.message)); }
  } catch (e) { console.error('Backup falló:', e.message); }
}
backup(); setInterval(backup, 6 * 60 * 60 * 1000);
module.exports = db;
