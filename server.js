require('fs').mkdirSync(require('path').join(__dirname, 'data'), { recursive: true });
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('./db');
const { textoDePDF, parseActa, descargarActa } = require('./parser');
const { informeActa, informePeriodo } = require('./informes');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieSession({ name: 'ca', keys: [process.env.SESSION_SECRET || 'cambiar-esta-clave-en-produccion'], maxAge: 12 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: true }));
app.use(express.static(require('path').join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const now = () => new Date().toISOString();

/* ---------- helpers ---------- */
const me = req => req.session.uid ? db.prepare('SELECT id,usuario,nombre,rol,cargo,debe_cambiar FROM usuarios WHERE id=? AND activo=1').get(req.session.uid) : null;
const auth = (req, res, next) => { const u = me(req); if (!u) return res.status(401).json({ error: 'No autenticado' }); req.user = u; next(); };
const director = (req, res, next) => req.user.rol === 'director' ? next() : res.status(403).json({ error: 'Solo dirección' });
const lectura = (req, res, next) => ['director', 'lector'].includes(req.user.rol) ? next() : res.status(403).json({ error: 'Sin permiso' });
const inspDe = uid => db.prepare('SELECT codigo FROM usuario_inspector WHERE usuario_id=?').all(uid).map(r => r.codigo);
const adminsDe = codigo => db.prepare("SELECT u.id FROM usuario_inspector ui JOIN usuarios u ON u.id=ui.usuario_id WHERE ui.codigo=? AND u.rol='admin' AND u.activo=1").all(codigo).map(r => r.id);
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const rowActa = a => ({ id: a.id, nro: a.nro, parte: a.parte, link: a.link, tipo: a.tipo, secciones: J(a.secciones, []), inspector: a.inspector, razon: a.razon, cuit: a.cuit, orden: a.orden, actividad: a.actividad, trabajadores: a.trabajadores, receptor: a.receptor, firmantes: J(a.firmantes, []), puntos: J(a.puntos, []), alertas: J(a.alertas, []), informe: a.informe, fechaActa: a.fecha_acta, fechaCitacion: a.fecha_citacion, plazo: a.plazo, actaOrigen: a.acta_origen, tienePdf: !!a.tiene_pdf, borrador: J(a.borrador, null), adminId: a.admin_id, directorId: a.director_id, fechaAsignacion: a.fecha_asignacion, estado: a.estado, fechaFin: a.fecha_fin });
const rowErr = e => ({ id: e.id, actaId: e.acta_id, punto: e.punto, supuestoId: e.supuesto_id, detalle: e.detalle, estado: e.estado, comentario: e.comentario, fechaRevision: e.fecha_revision, comunicado: !!e.comunicado, fechaComunicado: e.fecha_comunicado, subsanado: !!e.subsanado, fechaSubsanado: e.fecha_subsanado, reincidente: !!e.reincidente });
const ok = (res, extra = {}) => res.json({ ok: true, ...extra });
const ACTA_COLS = 'id,nro,parte,link,tipo,secciones,inspector,razon,cuit,orden,actividad,trabajadores,receptor,firmantes,puntos,alertas,informe,fecha_acta,fecha_citacion,plazo,acta_origen,(pdf IS NOT NULL) tiene_pdf,borrador,admin_id,director_id,fecha_asignacion,estado,fecha_fin';
const log = (req, accion, entidad, id, detalle) => db.prepare('INSERT INTO auditoria (fecha,usuario_id,usuario,accion,entidad,entidad_id,detalle) VALUES (?,?,?,?,?,?,?)').run(now(), req.user ? req.user.id : null, req.user ? req.user.usuario : (req.body && req.body.usuario) || '', accion, entidad || '', id == null ? '' : String(id), (detalle || '').slice(0, 400));

/* ---------- sesión (con bloqueo tras 5 intentos fallidos) ---------- */
const intentos = new Map();
app.post('/api/login', (req, res) => {
  const usuario = String((req.body || {}).usuario || '').trim().toLowerCase(), clave = String((req.body || {}).clave || '');
  const it = intentos.get(usuario) || { n: 0, hasta: 0 };
  if (it.hasta > Date.now()) return res.status(429).json({ error: `Usuario bloqueado por intentos fallidos. Probá en ${Math.ceil((it.hasta - Date.now()) / 60000)} min.` });
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario=? AND activo=1').get(usuario);
  if (!u || !bcrypt.compareSync(clave, u.hash)) { it.n++; if (it.n >= 5) { it.hasta = Date.now() + 15 * 60000; it.n = 0; } intentos.set(usuario, it); log(req, 'login_fallido', 'usuario', usuario); return res.status(401).json({ error: 'Usuario o contraseña incorrectos' }); }
  intentos.delete(usuario); req.session.uid = u.id; req.user = u; log(req, 'login', 'usuario', u.id); ok(res, { debeCambiar: !!u.debe_cambiar });
});
app.post('/api/logout', auth, (req, res) => { log(req, 'logout', 'usuario', req.user.id); req.session = null; ok(res); });
app.post('/api/clave', auth, (req, res) => {
  const { actual, nueva } = req.body || {}; const u = db.prepare('SELECT hash FROM usuarios WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(actual || ''), u.hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  if (String(nueva || '').length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  db.prepare('UPDATE usuarios SET hash=?,debe_cambiar=0 WHERE id=?').run(bcrypt.hashSync(nueva, 10), req.user.id); log(req, 'cambio_clave', 'usuario', req.user.id); ok(res);
});

/* ---------- estado completo (filtrado por rol) ---------- */
app.get('/api/state', auth, (req, res) => {
  const u = req.user, dir = u.rol !== 'admin';
  const usuarios = (dir ? db.prepare('SELECT id,usuario,nombre,rol,cargo FROM usuarios WHERE activo=1').all() : [u]).map(x => ({ ...x, inspectores: inspDe(x.id) }));
  const actas = (dir ? db.prepare(`SELECT ${ACTA_COLS} FROM actas`).all() : db.prepare(`SELECT ${ACTA_COLS} FROM actas WHERE admin_id=?`).all(u.id)).map(rowActa);
  const ids = actas.map(a => a.id);
  const errores = ids.length ? db.prepare(`SELECT * FROM errores WHERE acta_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(rowErr) : [];
  const devoluciones = (dir ? db.prepare('SELECT * FROM devoluciones ORDER BY fecha DESC').all() : db.prepare('SELECT * FROM devoluciones WHERE admin_id=? ORDER BY fecha DESC').all(u.id)).map(d => ({ id: d.id, adminId: d.admin_id, fecha: d.fecha, nroActa: d.nro_acta, punto: d.punto, supuestoId: d.supuesto_id, detalle: d.detalle, comentario: d.comentario, respuesta: d.respuesta, leida: !!d.leida }));
  res.json({
    me: { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, cargo: u.cargo, debeCambiar: !!u.debe_cambiar, inspectores: inspDe(u.id) }, usuarios,
    inspectores: db.prepare('SELECT * FROM inspectores').all(),
    causales: db.prepare('SELECT * FROM causales').all().map(c => ({ ...c, aparte: !!c.aparte, tipos: J(c.tipos, []) })),
    supuestos: db.prepare('SELECT id,causal_id causalId,nombre,activo FROM supuestos').all().map(s => ({ ...s, activo: !!s.activo })),
    actas, errores, devoluciones,
    efectividad: dir ? db.prepare('SELECT admin_id adminId,fecha,marcados,rechazados FROM efectividad').all() : [],
    config: { smtp: !!process.env.SMTP_HOST }
  });
});
app.get('/api/auditoria', auth, lectura, (req, res) => res.json(db.prepare('SELECT * FROM auditoria ORDER BY id DESC LIMIT 300').all()));

/* ---------- actas: asignación (director) ---------- */
function altaActa(req, buffer, link, adminIdPedido) {
  return textoDePDF(buffer).then(txt => {
    const d = parseActa(txt);
    if (!d.nro) throw Object.assign(new Error('El PDF no tiene un número de acta MT-0000-000000 reconocible'), { status: 422 });
    const dup = db.prepare('SELECT id FROM actas WHERE nro=? AND parte=?').get(d.nro, d.parte || '');
    if (dup) throw Object.assign(new Error(`${d.nro} parte ${d.parte} ya fue asignada`), { status: 409, lectura: d });
    let adminId = +adminIdPedido || 0;
    if (!adminId) { const ad = adminsDe(d.inspector); if (ad.length !== 1) throw Object.assign(new Error(ad.length ? `Varios administrativos tienen al inspector ${d.inspector}; elegí uno` : `El inspector ${d.inspector} no tiene administrativo a cargo; elegí uno`), { status: 422, lectura: d }); adminId = ad[0]; }
    const r = db.prepare(`INSERT INTO actas (nro,parte,link,tipo,secciones,inspector,razon,cuit,orden,actividad,trabajadores,receptor,firmantes,puntos,alertas,informe,fecha_acta,fecha_citacion,plazo,acta_origen,pdf,admin_id,director_id,fecha_asignacion,estado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'asignada')`)
      .run(d.nro, d.parte || '', link, d.tipo || '', JSON.stringify(d.secciones || []), d.inspector, d.razon || '', d.cuit || '', d.orden || '', d.actividad || '', d.trabajadores ?? null, d.receptor || '', JSON.stringify(d.firmantes || []), JSON.stringify(d.puntos || []), JSON.stringify(d.alertas || []), d.informe || '', d.fechaActa || null, d.fechaCitacion || null, d.plazo || null, d.actaOrigen || '', buffer, adminId, req.user.id, now());
    log(req, 'asignar', 'acta', r.lastInsertRowid, `${d.nro} ${d.parte} → admin ${adminId}`);
    return { id: r.lastInsertRowid, lectura: d, adminId };
  });
}
const errRes = (res, e) => res.status(e.status || 422).json({ error: e.message, lectura: e.lectura });
app.post('/api/actas/link', auth, director, async (req, res) => {
  const link = String(req.body.link || '').trim(); if (!/^https?:\/\/.*IdActa=\d+/i.test(link)) return res.status(400).json({ error: 'Pegá el link completo del acta en RAI' });
  let buf; try { buf = await descargarActa(link); } catch (e) { return res.status(502).json({ error: 'No pude descargar el acta desde RAI (' + e.message + '). Subí el PDF.' }); }
  try { ok(res, await altaActa(req, buf, link, req.body.adminId)); } catch (e) { errRes(res, e); }
});
app.post('/api/actas/lote', auth, director, async (req, res) => {
  const links = [...new Set(String(req.body.links || '').split(/\s+/).map(s => s.trim()).filter(Boolean))].slice(0, 60);
  const out = [];
  for (const link of links) {
    if (!/^https?:\/\/.*IdActa=\d+/i.test(link)) { out.push({ link, error: 'Link inválido' }); continue; }
    try { const buf = await descargarActa(link); const r = await altaActa(req, buf, link, req.body.adminId); out.push({ link, ok: true, nro: r.lectura.nro, parte: r.lectura.parte, inspector: r.lectura.inspector, adminId: r.adminId, alertas: r.lectura.alertas.length }); }
    catch (e) { out.push({ link, error: e.message, nro: e.lectura && e.lectura.nro }); }
  }
  res.json({ resultados: out });
});
app.post('/api/actas/pdf', auth, director, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el PDF' });
  const link = String(req.body.link || '').trim(); if (!/^https?:\/\/.*IdActa=\d+/i.test(link)) return res.status(400).json({ error: 'Pegá el link completo del acta en RAI' });
  try { ok(res, await altaActa(req, req.file.buffer, link, req.body.adminId)); } catch (e) { errRes(res, e); }
});
app.delete('/api/actas/:id', auth, director, (req, res) => { const r = db.prepare("DELETE FROM actas WHERE id=? AND estado='asignada'").run(req.params.id); if (r.changes) log(req, 'quitar', 'acta', req.params.id); ok(res); });
app.post('/api/actas/:id/reasignar', auth, director, (req, res) => { const r = db.prepare("UPDATE actas SET admin_id=? WHERE id=? AND estado='asignada'").run(+req.body.adminId, req.params.id); if (r.changes) log(req, 'reasignar', 'acta', req.params.id, 'admin ' + req.body.adminId); ok(res); });
// PDF del acta (visor embebido): lo ve el administrativo a cargo o la dirección
app.get('/api/actas/:id/pdf', auth, (req, res) => {
  const a = db.prepare('SELECT nro,parte,admin_id,pdf FROM actas WHERE id=?').get(req.params.id);
  if (!a || !a.pdf || (req.user.rol === 'admin' && a.admin_id !== req.user.id)) return res.status(404).send('No disponible');
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${a.nro}-${a.parte}.pdf"`); res.send(a.pdf);
});

/* ---------- actas: revisión (administrativo) ---------- */
app.put('/api/actas/:id/borrador', auth, (req, res) => { db.prepare("UPDATE actas SET borrador=? WHERE id=? AND admin_id=? AND estado='asignada'").run(JSON.stringify(req.body || {}).slice(0, 20000), req.params.id, req.user.id); ok(res); });
app.post('/api/actas/:id/finalizar', auth, (req, res) => {
  const a = db.prepare("SELECT * FROM actas WHERE id=? AND admin_id=? AND estado='asignada'").get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Acta no disponible' });
  const { tipo, marcas } = req.body || {};
  if (!Array.isArray(marcas) || !marcas.length) return res.status(400).json({ error: 'No hay errores marcados' });
  const ins = db.prepare('INSERT INTO errores (acta_id,punto,supuesto_id,detalle) VALUES (?,?,?,?)');
  db.transaction(() => { marcas.forEach(m => ins.run(a.id, String(m.punto), +m.supuestoId, String(m.detalle || '').slice(0, 500))); db.prepare("UPDATE actas SET estado='finalizada',tipo=?,fecha_fin=?,borrador='' WHERE id=?").run(tipo || a.tipo, now(), a.id); })();
  log(req, 'finalizar', 'acta', a.id, `${marcas.length} errores`); ok(res);
});
app.post('/api/actas/:id/sin-errores', auth, (req, res) => {
  const r = db.prepare("UPDATE actas SET estado='sin_errores',tipo=COALESCE(NULLIF(?,''),tipo),fecha_fin=?,borrador='' WHERE id=? AND admin_id=? AND estado='asignada'").run(req.body.tipo || '', now(), req.params.id, req.user.id);
  if (r.changes) log(req, 'sin_errores', 'acta', req.params.id); r.changes ? ok(res) : res.status(404).json({ error: 'Acta no disponible' });
});
app.post('/api/devoluciones/:id/responder', auth, (req, res) => { db.prepare('UPDATE devoluciones SET respuesta=?,leida=1 WHERE id=? AND admin_id=?').run(String(req.body.respuesta || '').slice(0, 500), req.params.id, req.user.id); ok(res); });
app.post('/api/devoluciones/:id/leida', auth, (req, res) => { db.prepare('UPDATE devoluciones SET leida=1 WHERE id=? AND admin_id=?').run(req.params.id, req.user.id); ok(res); });

/* ---------- validación, comunicación, subsanación (director) ---------- */
// muestreo de control: el director revisa actas marcadas "sin errores"; si encuentra error, se registra como omisión
app.post('/api/actas/:id/control', auth, director, (req, res) => {
  const a = db.prepare("SELECT * FROM actas WHERE id=? AND estado='sin_errores'").get(req.params.id); if (!a) return res.status(404).json({ error: 'Acta no está en sin errores' });
  const { marcas } = req.body || {};
  if (!Array.isArray(marcas) || !marcas.length) { db.prepare("UPDATE actas SET estado='sin_errores', borrador='controlada' WHERE id=?").run(a.id); log(req, 'control_ok', 'acta', a.id); return ok(res); }
  const ins = db.prepare("INSERT INTO errores (acta_id,punto,supuesto_id,detalle,estado,fecha_revision) VALUES (?,?,?,?,'validado',?)");
  db.transaction(() => { marcas.forEach(m => ins.run(a.id, String(m.punto), +m.supuestoId, ('[Omisión detectada por la dirección] ' + (m.detalle || '')).slice(0, 500), now())); db.prepare("UPDATE actas SET estado='validada', borrador='omision' WHERE id=?").run(a.id); db.prepare('INSERT INTO efectividad (admin_id,fecha,marcados,rechazados) VALUES (?,?,?,?)').run(a.admin_id, now(), 0, marcas.length); })();
  log(req, 'control_omision', 'acta', a.id, `${marcas.length} errores omitidos`); ok(res);
});
app.post('/api/errores/:id/decidir', auth, director, (req, res) => {
  const { estado, comentario } = req.body || {}; if (!['validado', 'rechazado', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const e = db.prepare('SELECT e.*, a.inspector FROM errores e JOIN actas a ON a.id=e.acta_id WHERE e.id=?').get(req.params.id); if (!e) return res.status(404).json({ error: 'No existe' });
  const reinc = estado === 'validado' && !!db.prepare("SELECT 1 FROM errores x JOIN actas b ON b.id=x.acta_id WHERE b.inspector=? AND x.supuesto_id=? AND x.estado='validado' AND x.comunicado=1 AND x.id<>?").get(e.inspector, e.supuesto_id, e.id);
  db.prepare('UPDATE errores SET estado=?,comentario=?,fecha_revision=?,reincidente=? WHERE id=?').run(estado, String(comentario || '').slice(0, 500), now(), reinc ? 1 : 0, e.id);
  log(req, 'decidir', 'error', e.id, estado); ok(res, { reincidente: reinc });
});
app.post('/api/actas/:id/cerrar', auth, director, (req, res) => {
  const a = db.prepare("SELECT * FROM actas WHERE id=? AND estado='finalizada'").get(req.params.id); if (!a) return res.status(404).json({ error: 'Acta no está en validación' });
  const E = db.prepare('SELECT * FROM errores WHERE acta_id=?').all(a.id);
  if (E.some(e => e.estado === 'pendiente')) return res.status(400).json({ error: 'Faltan errores por decidir' });
  const v = E.filter(e => e.estado === 'validado').length, R = E.filter(e => e.estado === 'rechazado');
  const dev = db.prepare('INSERT INTO devoluciones (admin_id,fecha,nro_acta,punto,supuesto_id,detalle,comentario) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => {
    R.forEach(e => dev.run(a.admin_id, now(), v ? `${a.nro}${a.parte ? ' ' + a.parte : ''}` : '', e.punto, e.supuesto_id, e.detalle, e.comentario));
    if (!v) { db.prepare('INSERT INTO efectividad (admin_id,fecha,marcados,rechazados) VALUES (?,?,?,?)').run(a.admin_id, now(), E.length, E.length); db.prepare('DELETE FROM actas WHERE id=?').run(a.id); }
    else db.prepare("UPDATE actas SET estado='validada' WHERE id=?").run(a.id);
  })();
  log(req, v ? 'validar' : 'rechazar_todo', 'acta', a.id, `${a.nro}: ${v} validados, ${R.length} rechazados`); ok(res, { eliminada: !v, validados: v });
});
app.post('/api/inspectores/:codigo/comunicar', auth, director, (req, res) => {
  const r = db.prepare("UPDATE errores SET comunicado=1,fecha_comunicado=? WHERE comunicado=0 AND estado='validado' AND acta_id IN (SELECT id FROM actas WHERE inspector=?)").run(now(), req.params.codigo);
  log(req, 'comunicar', 'inspector', req.params.codigo, `${r.changes} errores`); ok(res);
});
app.post('/api/actas/:id/subsanar', auth, director, (req, res) => {
  const r = db.prepare("UPDATE errores SET subsanado=1,fecha_subsanado=? WHERE acta_id=? AND estado='validado' AND subsanado=0").run(now(), req.params.id);
  log(req, 'subsanar', 'acta', req.params.id, `${r.changes} errores`); ok(res);
});

/* ---------- catálogo (director) ---------- */
app.post('/api/causales', auth, director, (req, res) => { const r = db.prepare('INSERT INTO causales (nombre) VALUES (?)').run(String(req.body.nombre || '').trim()); log(req, 'alta', 'causal', r.lastInsertRowid); ok(res, { id: r.lastInsertRowid }); });
app.put('/api/causales/:id', auth, director, (req, res) => { const c = db.prepare('SELECT * FROM causales WHERE id=?').get(req.params.id); if (!c) return res.status(404).json({ error: 'No existe' }); const b = req.body || {};
  db.prepare('UPDATE causales SET nombre=?,controla=?,aparte=?,tipos=? WHERE id=?').run(b.nombre ?? c.nombre, b.controla ?? c.controla, b.aparte === undefined ? c.aparte : (b.aparte ? 1 : 0), b.tipos ? JSON.stringify(b.tipos) : c.tipos, c.id); log(req, 'editar', 'causal', c.id); ok(res); });
app.post('/api/supuestos', auth, director, (req, res) => { const r = db.prepare('INSERT INTO supuestos (causal_id,nombre) VALUES (?,?)').run(+req.body.causalId, String(req.body.nombre || '').trim()); log(req, 'alta', 'supuesto', r.lastInsertRowid); ok(res, { id: r.lastInsertRowid }); });
app.put('/api/supuestos/:id', auth, director, (req, res) => { const s = db.prepare('SELECT * FROM supuestos WHERE id=?').get(req.params.id); if (!s) return res.status(404).json({ error: 'No existe' }); const b = req.body || {};
  db.prepare('UPDATE supuestos SET nombre=?,activo=? WHERE id=?').run(b.nombre ?? s.nombre, b.activo === undefined ? s.activo : (b.activo ? 1 : 0), s.id); log(req, 'editar', 'supuesto', s.id); ok(res); });

/* ---------- inspectores y usuarios (director) ---------- */
app.post('/api/inspectores', auth, director, (req, res) => { const { codigo, nombre, legajo, delegacion } = req.body || {}; if (!/^\d{4}$/.test(codigo || '') || !nombre) return res.status(400).json({ error: 'Código de 4 dígitos y nombre son obligatorios' });
  try { db.prepare('INSERT INTO inspectores (codigo,nombre,legajo,delegacion) VALUES (?,?,?,?)').run(codigo, nombre.trim(), String(legajo || ''), String(delegacion || '')); log(req, 'alta', 'inspector', codigo); ok(res); } catch { res.status(409).json({ error: 'Ese código ya existe' }); } });
app.put('/api/inspectores/:id', auth, director, (req, res) => { const i = db.prepare('SELECT * FROM inspectores WHERE id=?').get(req.params.id); if (!i) return res.status(404).json({ error: 'No existe' }); const b = req.body || {};
  db.prepare('UPDATE inspectores SET nombre=?,legajo=?,delegacion=? WHERE id=?').run(b.nombre ?? i.nombre, b.legajo ?? i.legajo, b.delegacion ?? i.delegacion, i.id);
  if (b.adminId !== undefined) { db.prepare('DELETE FROM usuario_inspector WHERE codigo=?').run(i.codigo); if (b.adminId) db.prepare('INSERT INTO usuario_inspector VALUES (?,?)').run(+b.adminId, i.codigo); }
  log(req, 'editar', 'inspector', i.codigo, JSON.stringify(b).slice(0, 200)); ok(res); });
app.delete('/api/inspectores/:id', auth, director, (req, res) => { const i = db.prepare('SELECT * FROM inspectores WHERE id=?').get(req.params.id); if (!i) return res.status(404).json({ error: 'No existe' });
  if (db.prepare('SELECT 1 FROM actas WHERE inspector=?').get(i.codigo)) return res.status(409).json({ error: 'Tiene actas cargadas; no se puede quitar' });
  db.prepare('DELETE FROM usuario_inspector WHERE codigo=?').run(i.codigo); db.prepare('DELETE FROM inspectores WHERE id=?').run(i.id); log(req, 'baja', 'inspector', i.codigo); ok(res); });
app.post('/api/usuarios', auth, director, (req, res) => { const { usuario, nombre, clave, rol } = req.body || {}; const cargo = { admin: 'Administrativo', director: 'Director', subdirector: 'Subdirector', lector: 'Solo lectura' }[rol]; if (!usuario || !nombre || !clave || !cargo) return res.status(400).json({ error: 'Completá usuario, nombre, contraseña y rol' });
  try { const r = db.prepare('INSERT INTO usuarios (usuario,nombre,rol,cargo,hash,debe_cambiar) VALUES (?,?,?,?,?,1)').run(String(usuario).trim().toLowerCase(), nombre.trim(), rol === 'admin' ? 'admin' : rol === 'lector' ? 'lector' : 'director', cargo, bcrypt.hashSync(String(clave), 10)); log(req, 'alta', 'usuario', r.lastInsertRowid, usuario); ok(res); } catch { res.status(409).json({ error: 'Ese nombre de usuario ya existe' }); } });
app.put('/api/usuarios/:id/clave', auth, director, (req, res) => { db.prepare('UPDATE usuarios SET hash=?,debe_cambiar=1 WHERE id=?').run(bcrypt.hashSync(String(req.body.clave || '1234'), 10), req.params.id); log(req, 'reset_clave', 'usuario', req.params.id); ok(res); });
app.delete('/api/usuarios/:id', auth, director, (req, res) => { if (+req.params.id === req.user.id) return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
  if (db.prepare("SELECT 1 FROM actas WHERE admin_id=? AND estado='asignada'").get(req.params.id)) return res.status(409).json({ error: 'Tiene actas por revisar; reasignalas antes' });
  db.prepare('UPDATE usuarios SET activo=0 WHERE id=?').run(req.params.id); db.prepare('DELETE FROM usuario_inspector WHERE usuario_id=?').run(req.params.id); log(req, 'baja', 'usuario', req.params.id); ok(res); });

/* ---------- informes PDF y exportación ---------- */
app.get('/api/informes/acta/:id', auth, lectura, (req, res) => informeActa(+req.params.id, res));
app.get('/api/informes/inspector/:codigo', auth, lectura, (req, res) => informePeriodo(req.params.codigo, req.query.periodo || 'mes', req.query.hasta || '', res));
const csv = rows => '\uFEFF' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
app.get('/api/export/actas.csv', auth, lectura, (req, res) => {
  const A = db.prepare(`SELECT ${ACTA_COLS} FROM actas ORDER BY fecha_asignacion DESC`).all().map(rowActa);
  const E = db.prepare("SELECT e.*, s.nombre supuesto, c.nombre causal FROM errores e JOIN supuestos s ON s.id=e.supuesto_id JOIN causales c ON c.id=s.causal_id").all();
  const insp = Object.fromEntries(db.prepare('SELECT codigo,nombre,delegacion FROM inspectores').all().map(i => [i.codigo, i])), usr = Object.fromEntries(db.prepare('SELECT id,nombre FROM usuarios').all().map(u => [u.id, u.nombre]));
  const rows = [['Acta', 'Parte', 'Tipo', 'Inspector', 'Código', 'Delegación', 'Establecimiento', 'CUIT', 'Fecha acta', 'Plazo', 'Administrativo', 'Asignada', 'Finalizada', 'Estado', 'Punto', 'Causal', 'Supuesto', 'Detalle', 'Decisión', 'Comentario', 'Reincidente', 'Comunicado', 'Subsanado', 'Link']];
  A.forEach(a => { const es = E.filter(e => e.acta_id === a.id); const base = [a.nro, a.parte, a.tipo, (insp[a.inspector] || {}).nombre || '', a.inspector, (insp[a.inspector] || {}).delegacion || '', a.razon, a.cuit, a.fechaActa, a.plazo, usr[a.adminId] || '', a.fechaAsignacion, a.fechaFin, a.estado];
    if (!es.length) rows.push([...base, '', '', '', '', '', '', '', '', '', a.link]); es.forEach(e => rows.push([...base, e.punto, e.causal, e.supuesto, e.detalle, e.estado, e.comentario, e.reincidente ? 'sí' : '', e.fecha_comunicado || '', e.fecha_subsanado || '', a.link])); });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="control-actas.csv"'); res.send(csv(rows));
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error interno' }); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Control de actas en http://localhost:${PORT}`));
