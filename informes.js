// Generación de informes en PDF (pdfkit): informe único por acta e informes por período por inspector.
const PDFDocument = require('pdfkit');
const db = require('./db');

const NAVY = '#0F2240', TEAL = '#0EA5B7', MUTED = '#6B7A90', LINE = '#E3E8EF', INK = '#172033', BAD = '#B4362E', OK = '#1B8A5A';
const fD = d => d ? new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const hoy = () => new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const insp = c => db.prepare('SELECT * FROM inspectores WHERE codigo=?').get(c) || { codigo: c, nombre: `Inspector ${c}`, legajo: '—' };
const sup = id => db.prepare('SELECT s.*, c.nombre causal, c.controla FROM supuestos s JOIN causales c ON c.id=s.causal_id WHERE s.id=?').get(id) || { nombre: '(eliminado)', causal: '', controla: '' };

function base(titulo, subtitulo, res, nombreArchivo) {
  const doc = new PDFDocument({ bufferPages: true, size: 'A4', margins: { top: 60, bottom: 60, left: 56, right: 56 }, info: { Title: titulo, Author: 'Subsecretaría de Inspección del Trabajo - MTPBA' } });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  doc.pipe(res);
  const W = doc.page.width - 112;
  // membrete
  doc.rect(0, 0, doc.page.width, 6).fill(TEAL);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('MINISTERIO DE TRABAJO · PROVINCIA DE BUENOS AIRES', 56, 26);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text('Subsecretaría de Inspección del Trabajo · Dirección de Inspección Laboral', 56, 38);
  doc.fillColor(MUTED).fontSize(8.5).text(`La Plata, ${hoy()}`, 56, 26, { width: W, align: 'right' });
  doc.moveDown(2.2);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(19).text(titulo, 56, 68, { width: W });
  if (subtitulo) doc.fillColor(MUTED).font('Helvetica').fontSize(10.5).text(subtitulo, { width: W });
  doc.moveDown(0.8);
  // pie de página
  const pie = () => { const r = doc.bufferedPageRange(); for (let p = r.start; p < r.start + r.count; p++) { doc.switchToPage(p); const mb = doc.page.margins.bottom; doc.page.margins.bottom = 0; const y = doc.page.height - 34; doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Control de Actas · documento interno de trabajo', 56, y, { width: W / 2, lineBreak: false }); doc.text(`Página ${p - r.start + 1} de ${r.count}`, 56, y, { width: W, align: 'right', lineBreak: false }); doc.page.margins.bottom = mb; } };
  doc.on('pageAdded', () => { doc.rect(0, 0, doc.page.width, 6).fill(TEAL); doc.fillColor(INK); });
  return { doc, W, pie };
}
function h2(doc, t) { doc.moveDown(0.6); doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12).text(t); doc.moveTo(56, doc.y + 3).lineTo(56 + (doc.page.width - 112), doc.y + 3).strokeColor(LINE).lineWidth(1).stroke(); doc.moveDown(0.7); doc.fillColor(INK).font('Helvetica').fontSize(10); }
function ficha(doc, W, pares) {
  const colW = W / 2; const x0 = 56; let y = doc.y;
  for (let i = 0; i < pares.length; i += 2) {
    const fila = pares.slice(i, i + 2); doc.font('Helvetica-Bold').fontSize(10.5);
    const h = Math.max(...fila.map(([, v]) => doc.heightOfString(String(v || '—'), { width: colW - 14 }))) + 20;
    fila.forEach(([k, v], j) => { const x = x0 + j * colW; doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(k.toUpperCase(), x, y, { lineBreak: false }); doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(String(v || '—'), x, y + 11, { width: colW - 14 }); });
    y += h;
  }
  doc.y = y + 4; doc.x = x0; doc.font('Helvetica').fontSize(10);
}
function tabla(doc, W, cols, filas) {
  // cols: [{t, w (fracción), align}], filas: array de arrays de strings
  const x0 = 56; let y = doc.y;
  const widths = cols.map(c => c.w * W);
  const head = () => { doc.rect(x0, y, W, 20).fill('#F4F6F9'); let x = x0; cols.forEach((c, i) => { doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.5).text(c.t.toUpperCase(), x + 6, y + 6, { width: widths[i] - 12, align: c.align || 'left' }); x += widths[i]; }); y += 22; };
  head();
  filas.forEach(f => {
    doc.font('Helvetica').fontSize(9.5);
    const hs = f.map((v, i) => doc.heightOfString(String(v ?? ''), { width: widths[i] - 12 })); const h = Math.max(...hs) + 10;
    if (y + h > doc.page.height - 70) { doc.addPage(); y = 60; head(); }
    let x = x0; f.forEach((v, i) => { doc.fillColor(cols[i].color || INK).font(cols[i].bold ? 'Helvetica-Bold' : 'Helvetica').text(String(v ?? ''), x + 6, y + 5, { width: widths[i] - 12, align: cols[i].align || 'left' }); x += widths[i]; });
    y += h; doc.moveTo(x0, y).lineTo(x0 + W, y).strokeColor(LINE).lineWidth(0.5).stroke();
  });
  doc.y = y + 8; doc.x = x0; doc.fillColor(INK);
}
function firma(doc, W) {
  if (doc.y > doc.page.height - 150) doc.addPage();
  doc.moveDown(3); const x = 56 + W - 220; doc.moveTo(x, doc.y).lineTo(x + 220, doc.y).strokeColor(INK).lineWidth(0.8).stroke();
  doc.moveDown(0.4); doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text('Dirección de Inspección Laboral', x, doc.y, { width: 220, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('Subsecretaría de Inspección del Trabajo', x, doc.y, { width: 220, align: 'center' });
}

/* ================= INFORME ÚNICO (por acta) ================= */
function informeActa(actaId, res) {
  const a = db.prepare('SELECT * FROM actas WHERE id=?').get(actaId); if (!a) return res.status(404).json({ error: 'Acta no encontrada' });
  const E = db.prepare('SELECT * FROM errores WHERE acta_id=? AND estado=\'validado\' ORDER BY CAST(punto AS INTEGER), id').all(a.id);
  const i = insp(a.inspector), puntos = J(a.puntos, []), firm = J(a.firmantes, []);
  const { doc, W, pie } = base('Informe de revisión de acta', `${a.nro}${a.parte ? ' · Parte ' + a.parte : ''}${a.tipo ? ' · ' + a.tipo : ''}`, res, `informe-${a.nro}${a.parte ? '-' + a.parte : ''}.pdf`);
  h2(doc, 'Datos del acta');
  ficha(doc, W, [['Acta', `${a.nro}${a.parte ? ' · Parte ' + a.parte : ''}`], ['Tipo', a.tipo], ['Inspector', `${i.nombre} (código ${i.codigo}, legajo ${i.legajo})`], ['Firmante según acta', firm.map(f => f.nombre).join(', ')], ['Establecimiento', a.razon], ['CUIT', a.cuit], ['Revisión finalizada', fD(a.fecha_fin)], ['Errores validados', String(E.length)]]);
  doc.fillColor(MUTED).fontSize(8.5).text(`Acta en RAI: ${a.link}`); doc.fillColor(INK).fontSize(10);
  h2(doc, 'Errores detectados y validados por la Dirección');
  if (!E.length) doc.text('No se registran errores validados en esta acta.');
  else E.forEach((e, k) => {
    const s = sup(e.supuesto_id), p = puntos.find(x => x.n === e.punto);
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.rect(56, doc.y, W, 22).fill('#F4F6F9'); doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5).text(`${k + 1}. ${e.punto === 'General' ? 'Encabezado / cuestión general' : 'Punto ' + e.punto}${p ? ' · ' + p.s : ''}`, 62, doc.y + 6, { width: W - 12 });
    doc.moveDown(0.9); doc.x = 56;
    if (p) { doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text(`Texto del acta: ${p.t}`, { width: W }); doc.moveDown(0.3); }
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(s.causal, { continued: true }).font('Helvetica').text(`  —  ${s.nombre}`);
    if (e.reincidente) { doc.fillColor(BAD).font('Helvetica-Bold').fontSize(9).text('Reincidencia: este supuesto ya fue comunicado al inspector en una revisión anterior.'); doc.fillColor(INK); }
    if (e.subsanado) { doc.fillColor(OK).font('Helvetica-Bold').fontSize(9).text(`Subsanado el ${fD(e.fecha_subsanado)}.`); doc.fillColor(INK); }
    if (e.detalle) { doc.moveDown(0.2); doc.font('Helvetica').fontSize(10).text(`Observación: ${e.detalle}`, { width: W }); }
    if (s.controla) { doc.moveDown(0.2); doc.fillColor(MUTED).fontSize(9).text(`Qué se controla: ${s.controla}`, { width: W }); }
    doc.fillColor(INK); doc.moveDown(0.8);
  });
  h2(doc, 'Requerimiento');
  doc.fontSize(10).text(E.length ? `Se solicita al inspector ${i.nombre} tomar conocimiento de las observaciones precedentes y, en los casos en que corresponda, proceder a su subsanación conforme el procedimiento vigente, a fin de evitar que el acta pierda eficacia en la instancia de sustanciación. Las observaciones se registran a efectos de seguimiento y mejora del procedimiento de inspección.` : 'Sin requerimientos.', { width: W, align: 'justify' });
  firma(doc, W); pie(); doc.end();
}

/* ================= INFORME POR PERÍODO ================= */
const PERIODOS = { semana: [7, 'Informe semanal'], quincena: [15, 'Informe quincenal'], mes: [30, 'Informe mensual'], trimestre: [91, 'Informe trimestral'], semestre: [182, 'Informe semestral'], anual: [365, 'Informe anual'] };
function rango(periodo, hasta) { const h = hasta ? new Date(hasta + 'T23:59:59') : new Date(); const d = new Date(h); d.setDate(d.getDate() - (PERIODOS[periodo] ? PERIODOS[periodo][0] : 30) + 1); d.setHours(0, 0, 0, 0); return [d.toISOString(), h.toISOString()]; }

function datosPeriodo(codigo, desde, hasta) {
  const cond = codigo ? 'AND a.inspector=?' : '', args = codigo ? [desde, hasta, codigo] : [desde, hasta];
  const actas = db.prepare(`SELECT a.* FROM actas a WHERE a.estado IN ('validada','sin_errores') AND a.fecha_fin BETWEEN ? AND ? ${cond} ORDER BY a.fecha_fin`).all(...args);
  const ids = actas.map(a => a.id);
  const E = ids.length ? db.prepare(`SELECT e.*, s.nombre supuesto, c.nombre causal, c.id causal_id, c.aparte FROM errores e JOIN supuestos s ON s.id=e.supuesto_id JOIN causales c ON c.id=s.causal_id WHERE e.estado='validado' AND e.acta_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const eliminadas = codigo ? 0 : db.prepare('SELECT COUNT(*) c FROM efectividad WHERE fecha BETWEEN ? AND ?').get(desde, hasta).c;
  return { actas, E, eliminadas };
}

function informePeriodo(codigo, periodo, hasta, res) {
  const [desde, hastaISO] = rango(periodo, hasta), tit = (PERIODOS[periodo] || PERIODOS.mes)[1];
  const todos = !codigo || codigo === 'todos'; const i = todos ? null : insp(codigo);
  const { actas, E } = datosPeriodo(todos ? null : codigo, desde, hastaISO);
  const { doc, W, pie } = base(todos ? `${tit} · todos los inspectores` : `${tit} · ${i.nombre}`, `Período ${fD(desde)} al ${fD(hastaISO)}`, res, `${periodo}-${todos ? 'general' : codigo}-${hastaISO.slice(0, 10)}.pdf`);
  const conErr = actas.filter(a => a.estado === 'validada').length, sinErr = actas.length - conErr;
  h2(doc, 'Resumen del período');
  ficha(doc, W, [...(todos ? [] : [['Inspector', `${i.nombre} (código ${i.codigo}, legajo ${i.legajo})`]]), ['Actas revisadas', String(actas.length)], ['Actas sin errores', String(sinErr)], ['Actas con errores validados', String(conErr)], ['Errores validados', String(E.length)], ['Errores por acta revisada', actas.length ? (E.length / actas.length).toFixed(2) : '—'], ['Errores comunicados', `${E.filter(e => e.comunicado).length} de ${E.length}`], ['Subsanados', `${E.filter(e => e.subsanado).length} de ${E.length}`], ['Reincidencias', String(E.filter(e => e.reincidente).length)]]);
  // tendencia: mitad inicial vs mitad final del período
  if (actas.length >= 2) {
    const mid = new Date((new Date(desde).getTime() + new Date(hastaISO).getTime()) / 2).toISOString();
    const a1 = actas.filter(a => a.fecha_fin < mid), a2 = actas.filter(a => a.fecha_fin >= mid);
    const r = as => { const ids = new Set(as.map(a => a.id)); const n = E.filter(e => ids.has(e.acta_id)).length; return as.length ? n / as.length : null; };
    const r1 = r(a1), r2 = r(a2);
    if (r1 !== null && r2 !== null) { const t = r2 < r1 ? 'mejora' : r2 > r1 ? 'empeora' : 'se mantiene'; doc.fillColor(r2 < r1 ? OK : r2 > r1 ? BAD : MUTED).font('Helvetica-Bold').fontSize(10).text(`Tendencia: ${t}`, { continued: true }).fillColor(INK).font('Helvetica').text(` — ${r1.toFixed(2)} errores por acta en la primera mitad del período, ${r2.toFixed(2)} en la segunda.`); }
  }
  // por causal
  h2(doc, 'Errores por causal');
  const pc = {}; E.forEach(e => { pc[e.causal] = (pc[e.causal] || 0) + 1; });
  const rc = Object.entries(pc).sort((a, b) => b[1] - a[1]);
  if (rc.length) tabla(doc, W, [{ t: 'Causal', w: .7 }, { t: 'Errores', w: .15, align: 'right', bold: true }, { t: '% del total', w: .15, align: 'right' }], rc.map(([c, n]) => [c, n, Math.round(n / E.length * 100) + '%'])); else doc.text('Sin errores validados en el período.');
  // supuestos más frecuentes
  const ps = {}; E.forEach(e => { const k = e.causal + '||' + e.supuesto; ps[k] = (ps[k] || 0) + 1; });
  const rs = Object.entries(ps).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (rs.length > 1) { h2(doc, 'Supuestos más frecuentes'); tabla(doc, W, [{ t: 'Causal', w: .35 }, { t: 'Supuesto de error', w: .5 }, { t: 'Veces', w: .15, align: 'right', bold: true }], rs.map(([k, n]) => [...k.split('||'), n])); }
  // ranking por inspector (informe general)
  if (todos) {
    h2(doc, 'Detalle por inspector');
    const pi = {}; actas.forEach(a => { pi[a.inspector] = pi[a.inspector] || { actas: 0, err: 0 }; pi[a.inspector].actas++; }); E.forEach(e => { const a = actas.find(x => x.id === e.acta_id); pi[a.inspector].err++; });
    const ri = Object.entries(pi).sort((a, b) => b[1].err - a[1].err);
    tabla(doc, W, [{ t: 'Inspector', w: .45 }, { t: 'Código', w: .13 }, { t: 'Actas', w: .14, align: 'right' }, { t: 'Errores', w: .14, align: 'right', bold: true }, { t: 'Err./acta', w: .14, align: 'right' }], ri.map(([c, v]) => { const x = insp(c); return [x.nombre, c, v.actas, v.err, (v.err / v.actas).toFixed(2)]; }));
  }
  // detalle por acta
  h2(doc, 'Detalle de actas con errores');
  const ce = actas.filter(a => a.estado === 'validada');
  if (ce.length) tabla(doc, W, [{ t: 'Acta', w: .2, bold: true }, { t: 'Fecha', w: .14 }, ...(todos ? [{ t: 'Inspector', w: .2 }] : []), { t: 'Tipo', w: .13 }, { t: 'Errores (punto · supuesto)', w: todos ? .33 : .53 }], ce.map(a => [`${a.nro}${a.parte ? ' ' + a.parte : ''}`, fD(a.fecha_fin), ...(todos ? [insp(a.inspector).nombre] : []), a.tipo || '—', E.filter(e => e.acta_id === a.id).map(e => `${e.punto === 'General' ? 'Gral.' : 'P.' + e.punto} · ${e.supuesto}`).join('\n')]));
  else doc.text('Ninguna acta con errores validados en el período.');
  h2(doc, 'Conclusión');
  doc.fontSize(10).text(todos
    ? `En el período se revisaron ${actas.length} actas de ${Object.keys(actas.reduce((o, a) => (o[a.inspector] = 1, o), {})).length} inspectores, con ${E.length} errores validados. ${rc.length ? `El causal más frecuente fue "${rc[0][0]}" (${rc[0][1]} casos).` : ''}`
    : `En el período el inspector ${i.nombre} tuvo ${actas.length} actas revisadas, de las cuales ${conErr} presentaron errores validados (${E.length} en total). ${rc.length ? `El causal más frecuente fue "${rc[0][0]}" (${rc[0][1]} casos), sobre el que se recomienda concentrar la corrección.` : 'No se registran errores validados: se destaca el cumplimiento.'}`, { width: W, align: 'justify' });
  firma(doc, W); pie(); doc.end();
}

module.exports = { informeActa, informePeriodo, PERIODOS };
