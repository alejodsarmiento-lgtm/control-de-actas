// Lectura del PDF del acta (RAI) → datos del acta, puntos, plazos y alertas automáticas.
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const SECS = ['Obstrucción', 'Infracción', 'Intimación', 'Verificación', 'Informe'];
const MESES = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };

async function textoDePDF(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    let cur = '', lastY = null;
    tc.items.forEach(it => { const y = Math.round(it.transform[5]); if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(cur.trim()); cur = ''; } cur += (cur && !cur.endsWith(' ') ? ' ' : '') + it.str; lastY = y; });
    lines.push(cur.trim());
  }
  return lines.filter(Boolean).join('\n');
}

const iso = (d, m, y, hh = 0, mm = 0) => new Date(Date.UTC(y, m, d, hh + 3, mm)).toISOString(); // hora Argentina (UTC-3)
function diasHabiles(a, b) { let n = 0; const d = new Date(a); d.setUTCHours(12); const fin = new Date(b); fin.setUTCHours(12); while (d < fin) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return n; }
function sumarHabiles(desde, n) { const d = new Date(desde); let k = 0; while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) k++; } return d.toISOString(); }
function cuitValido(c) { if (!/^\d{11}$/.test(c)) return false; const m = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]; const s = m.reduce((a, x, i) => a + x * +c[i], 0); const v = (11 - s % 11) % 11; return v === +c[10]; }

function parseActa(txt) {
  const r = { puntos: [], alertas: [] };
  const m = txt.match(/MT-(\d{4})-(\d{6})\s*PARTE\s*([AB])/i);
  if (m) { r.nro = `MT-${m[1]}-${m[2]}`; r.inspector = m[1]; r.parte = m[3].toUpperCase(); }
  const oi = txt.match(/Orden de Inspecci[oó]n\s*N[º°]?\s*(\d+)/i); if (oi) r.orden = oi[1];
  const rs = txt.match(/Raz[oó]n social:\s*\n?\s*([^\n]+)/i); if (rs && !/^CUIT/i.test(rs[1])) r.razon = rs[1].trim();
  const cu = txt.match(/CUIT:\s*(\d{11})/); if (cu) r.cuit = cu[1];
  const ac = txt.match(/Actividad:\s*([^\n]+)/i); if (ac) r.actividad = ac[1].trim();
  const tt = txt.match(/Trabajadores totales:\s*(\d+)/i); if (tt) r.trabajadores = +tt[1];
  const rep = txt.match(/Representado por:\s*([^\n]+)/i); if (rep) r.receptor = rep[1].replace(/\s*Documento:.*$/, '').trim();
  const fa = txt.match(/Fecha de inicio del acta:\s*(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2}):(\d{2})/); if (fa) r.fechaActa = iso(+fa[1], +fa[2] - 1, +fa[3], +fa[4], +fa[5]);
  const fc = txt.match(/d[ií]a\s+[a-záéíóú]+\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+del?\s+(\d{4})(?:,?\s*a\s+las\s+(\d{1,2}):(\d{2}))?/i);
  if (fc && MESES[fc[2].toLowerCase()] !== undefined) r.fechaCitacion = iso(+fc[1], MESES[fc[2].toLowerCase()], +fc[3], +(fc[4] || 9), +(fc[5] || 0));
  const ori = txt.match(/(?:intimad[oa]|intimado en el Acta|lo intimado en el Acta)[^\n]*?(MT-\d{4}-\d{6})/i) || txt.match(/acta de inspecci[oó]n\s+(MT-\d{4}-\d{6})/i); if (ori) r.actaOrigen = ori[1];
  r.firmantes = [...txt.matchAll(/^([A-ZÁÉÍÓÚÑÜ][^\n]*?)\s+Legajo:\s*(\d+)/gm)].map(x => ({ nombre: x[1].trim(), legajo: x[2] }));
  r.secciones = SECS.filter(s => new RegExp('^' + s + '\\s*$', 'm').test(txt));
  r.tipo = r.secciones[0] || '';
  let sec = '', informe = '';
  txt.split('\n').forEach(l => {
    if (/^(INFORME|NÓMINA DE PERSONAL|INSPECTORES|DETALLE|ESTABLECIMIENTO|TRABAJADORES)\s*$/.test(l.trim())) { sec = l.trim() === 'INFORME' ? 'INFORME' : ''; return; }
    const h = SECS.find(s => new RegExp('^' + s + '\\s*$').test(l.trim())); if (h) { sec = h; return; }
    if (sec === 'INFORME') { informe += ' ' + l; return; }
    const pm = l.match(/^(\d{1,2})\)\s*(.+)/);
    if (pm && sec) r.puntos.push({ n: pm[1], s: sec, t: pm[2].trim() });
    else if (r.puntos.length && sec && !/^[A-ZÁÉÍÓÚÑ ]{5,}$/.test(l.trim()) && !/Página \d|MT-\d{4}-\d{6}\s*PARTE|Expediente|Raz[oó]n social|^CUIT|Orden de Inspección|Domicilio:/.test(l) && r.puntos[r.puntos.length - 1].t.length < 260)
      r.puntos[r.puntos.length - 1].t += ' ' + l.trim();
  });
  r.informe = informe.trim();
  // plazo útil de revisión
  if (r.fechaCitacion) r.plazo = r.fechaCitacion; else if (r.fechaActa) r.plazo = sumarHabiles(r.fechaActa, 5);
  // ---------- alertas automáticas (se mapean a supuestos del catálogo) ----------
  const A = (punto, supuestoId, motivo) => r.alertas.push({ punto, supuestoId, motivo });
  if (!r.cuit) A('General', 1, 'No se encontró el CUIT en el encabezado.'); else if (!cuitValido(r.cuit)) A('General', 1, `El CUIT ${r.cuit} tiene dígito verificador inválido.`);
  if (!r.razon) A('General', 2, 'No se encontró la razón social.');
  if (!r.actividad) A('General', 43, 'No figura la actividad del establecimiento.');
  if (r.trabajadores === undefined) A('General', 44, 'No figura la cantidad de trabajadores totales.');
  if (!r.receptor) A('General', 45, 'No figuran los datos de quien recibe el acta.');
  if (r.tipo === 'Intimación' && r.fechaActa && r.fechaCitacion) { const dh = diasHabiles(r.fechaActa, r.fechaCitacion); if (dh < 5) A('General', 40, `Entre el acta y la citación hay ${dh} días hábiles (mínimo 5).`); }
  if (r.secciones.includes('Obstrucción') && r.trabajadores === 0) A('General', 27, 'Obstrucción con total de trabajadores en cero.');
  if (/gremial|sindic|delegad[oa]|UPSRA|UOM|UOCRA|CGT|CTA/i.test(r.informe) && !/gremial|sindic|delegad[oa]/i.test(r.puntos.map(p => p.t).join(' '))) A('General', 48, 'El informe menciona representación gremial; verificar que conste en el cuerpo del acta.');
  r.puntos.forEach(p => {
    if (p.n === '99') return;
    const pa = p.t.match(/Personal\s+Afectado:?\s*(\d+)/i);
    if (pa && r.trabajadores !== undefined && +pa[1] > r.trabajadores) A(p.n, 22, `Personal afectado ${pa[1]} supera los ${r.trabajadores} trabajadores totales.`);
    if (!pa && (p.s === 'Infracción' || p.s === 'Obstrucción')) A(p.n, 21, 'Punto imputado sin personal afectado.');
    if ((p.s === 'Infracción' || p.s === 'Intimación') && !/conforme|ley|art|res(ol)?\.?|dec(reto)?\.?|cct|convenio/i.test(p.t)) A(p.n, 17, 'No se encuentra cita normativa (ley, artículo, resolución).');
    if (/normativa vigente/i.test(p.t) && p.t.length < 120) A(p.n, 13, 'Fórmula genérica sin contenido fáctico.');
    if (/ver informe|informe adjunto|seg[uú]n informe/i.test(p.t)) A(p.n, 14, 'La descripción remite a otro documento.');
    if (/presenta defectuos[oa]/i.test(p.t) && !/(defect[oa]s?|por|ya que|dado que|en tanto|falta|sin)\s.{15,}/i.test(p.t.split(/defectuos[oa]/i)[1] || '')) A(p.n, 15, '"Presenta defectuoso" sin explicar en qué consiste el defecto.');
  });
  return r;
}

async function descargarActa(link) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(link, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ControlActas-MTPBA', 'Accept': 'application/pdf,*/*' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`RAI respondió ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('El link no devolvió un PDF');
    return buf;
  } finally { clearTimeout(t); }
}
module.exports = { textoDePDF, parseActa, descargarActa, diasHabiles };
