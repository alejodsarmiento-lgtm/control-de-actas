# Control de Actas — Subsecretaría de Inspección del Trabajo (MTPBA)

Sistema interno para detectar errores en actas de inspección antes de que el acta se caiga:
el director pega el link del acta en RAI, el sistema la descarga, lee número / inspector / puntos
y la asigna al administrativo que tiene a ese inspector a cargo; el administrativo marca errores
por punto; la dirección valida o rechaza cada error y comunica al inspector.

## Requisitos
- Node.js 18 o superior.
- Acceso saliente a `https://www.trabajo.gba.gov.ar` desde el servidor (para descargar las actas).

## Instalación y arranque
```bash
npm install
npm start          # http://localhost:3000
```
Variables opcionales (`.env` o entorno):
- `PORT` — puerto (3000).
- `SESSION_SECRET` — clave para firmar la sesión. **Cambiarla en producción.**
- `DB_PATH` — ruta del archivo SQLite (por defecto `data/control-actas.db`).

La primera vez crea la base con la semilla (`seed.json`): usuarios, 20 inspectores de ejemplo y el
catálogo de causales/supuestos. Para cargar los inspectores reales, editá `seed.json` antes del primer
arranque o cargalos desde **Inspectores y usuarios** en la app.

## Usuarios iniciales (contraseña `1234`, cambiarla al ingresar)
| usuario   | nombre           | rol |
|-----------|------------------|-----|
| arzuaga   | Alejo Arzuaga    | Director de Inspección Laboral |
| mosconi   | Mariano Mosconi  | Subdirector de Inspección Laboral |
| cnunez    | Carla Núñez      | Administrativa |
| mibanez   | Marcos Ibáñez    | Administrativo |
| squiroga  | Sofía Quiroga    | Administrativa |
| therrera  | Tomás Herrera    | Administrativo |

## Despliegue
**VPS (Ubuntu):** `npm install && SESSION_SECRET=... PORT=3000 npm start`, detrás de Nginx con HTTPS.
Con pm2: `pm2 start server.js --name control-actas`. Backup = copiar `data/control-actas.db`.

**Render:** Web Service con Node, build `npm install`, start `npm start`. Agregar un *Persistent Disk*
montado en `/data` y setear `DB_PATH=/data/control-actas.db` (sin disco, la base se pierde en cada deploy).

## Si RAI no responde al servidor
El alta por link devuelve un error claro y la pantalla ofrece arrastrar el PDF del acta: se lee igual
y se asigna igual. Probar desde la red del Ministerio con:
```bash
curl -A "Mozilla/5.0" -o acta.pdf "https://www.trabajo.gba.gov.ar/delegaciones/rai/pdf/Actapdf.asp?IdActa=1829248"
```

## Informes en PDF
- **Informe único por acta**: desde *Inspectores* (botón Informe en cada acta) o desde *Informes*. Incluye datos del acta, cada error validado con el texto del punto, causal, supuesto, observación y qué se controla, y el requerimiento de subsanación.
- **Informe por período** (semanal, quincenal, mensual, trimestral, semestral, anual) por inspector o general: resumen, tendencia entre la primera y la segunda mitad del período, errores por causal, supuestos más frecuentes, ranking por inspector (en el general) y detalle de actas con errores.
- Se generan al momento desde la base (`informes.js`, pdfkit), no se almacenan.

## Estructura
- `server.js` — API (Express) y sesión.
- `db.js` — esquema SQLite y semilla inicial.
- `parser.js` — descarga y lectura del PDF del acta.
- `informes.js` — informes PDF por acta y por período.
- `public/index.html` — interfaz (un solo archivo).
- `seed.json` — usuarios, inspectores y catálogo iniciales.

## Qué hace el sistema (resumen funcional)
- **Asignación por link, en lote**: la dirección pega uno o varios links de RAI; el servidor descarga cada PDF, lo guarda, lee número/inspector/establecimiento/fechas/puntos y asigna al administrativo a cargo. Respaldo: arrastrar el PDF.
- **Plazo útil y semáforo**: en intimaciones, la fecha de citación; en el resto, fecha del acta + 5 días hábiles. Bandejas ordenadas por urgencia; atrasos visibles en Inicio y Equipo.
- **Alertas automáticas**: reglas mecánicas sobre el texto del acta (personal afectado > total, CUIT inválido o ausente, falta de cita normativa, fórmulas vacías, remisión a otro documento, plazo < 5 días hábiles, presencia gremial solo en informe, obstrucción con 0 trabajadores). El administrativo las confirma con un clic.
- **Revisión con visor integrado**: PDF embebido + puntos leídos; borrador guardado automáticamente.
- **Validación error por error**; rechazos vuelven al administrativo como **Devoluciones** con motivo (aunque el acta se elimine), con posibilidad de responder.
- **Reincidencia**: se marca cuando un inspector repite un supuesto ya comunicado. **Subsanación** con fecha.
- **Control de calidad**: muestra de actas "sin errores" para que la dirección detecte omisiones; impacta en la efectividad del administrativo.
- **Inicio** con urgencias, carga del equipo y reincidencias; **búsqueda global**; **actas vinculadas** (verificación → intimación de origen); **delegación** por inspector.
- **Informes PDF** por acta y por período; **exportación a Excel (CSV)**.
- **Seguridad**: contraseñas con bcrypt, cambio obligatorio en el primer ingreso, bloqueo 15 min tras 5 intentos fallidos, sesión de 12 h, **auditoría** completa (pestaña Actividad), **backups** automáticos en `data/backups` (últimos 30), rol **solo lectura**.

## Reglas de negocio implementadas
- Un administrativo solo ve las actas de los inspectores que tiene a cargo.
- Un acta con todos sus errores rechazados se elimina sin dejar registro; queda solo un contador anónimo
  para la efectividad del administrativo.
- Los errores validados aparecen en **Inspectores** hasta que la dirección los marca como comunicados.
- Director y Subdirector tienen exactamente los mismos permisos.
