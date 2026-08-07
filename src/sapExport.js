// ─────────────────────────────────────────────────────────────────────────────
// EXPORTACIÓN A SAP — usa la plantilla corporativa .xlsx como base
// ─────────────────────────────────────────────────────────────────────────────
// La plantilla (public/plantillas/Formato_Exportacion_SAP_Normal.xlsx) NO se
// reconstruye: se abre como ZIP y se reemplaza ÚNICAMENTE el bloque de filas de
// datos y el tamaño de la tabla. Todo lo demás —estilos, anchos de columna,
// comentarios, formatos numéricos, encabezados— queda byte por byte idéntico.
//
// ¿Por qué así y no con SheetJS o ExcelJS?
//   · SheetJS (community) NO conserva estilos al escribir.
//   · ExcelJS pierde los comentarios y altera el objeto Tabla.
//   · Esta vía sólo toca <sheetData>, <dimension> y el ref de Tabla1.
//
// Columnas que llena el sistema (el resto se conserva de la plantilla):
//   E  Solicitante (AG) ............ Código de cliente de la ND
//   H  Destinatario mercancía (WE) . Código de cliente de la ND
//   K  No. Pedido Cliente .......... Número de la ND (NDV)
//   Q  Motivo de Pedido ............ Maestro de Motivos de Pedido (por material)
//   V  Material ..................... Código de material de la línea
//   X  Cantidad ..................... Cantidad devuelta de la línea (numérico)
//   AC Lote ......................... Lote de la línea
//   AG Documento Referencia Factura . Documento SAP (maestro de facturas)
// Valores fijos que se repiten en cada fila: A=ZREF · B=318A · C=EL · D=01
// ─────────────────────────────────────────────────────────────────────────────

export const RUTA_PLANTILLA_SAP = "/plantillas/Formato_Exportacion_SAP_Normal.xlsx";

// Carga JSZip desde CDN bajo demanda (mismo patrón que loadXLSX en App.jsx).
const loadJSZip = () => new Promise((resolve, reject) => {
  if (window.JSZip) { resolve(window.JSZip); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  s.onload = () => resolve(window.JSZip);
  s.onerror = () => reject(new Error("No se pudo cargar JSZip desde el CDN."));
  document.head.appendChild(s);
});

const txt = (v) => String(v === null || v === undefined ? "" : v).trim();

// Escapa para XML. Excel exige que & < > " estén escapados dentro de <t>.
const xmlEsc = (v) => txt(v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
  // Caracteres de control no son válidos en XML 1.0
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

// ── VALIDACIÓN ───────────────────────────────────────────────────────────────
// Comprueba TODO antes de generar nada. Si falta cualquier dato obligatorio el
// archivo no se genera y se informa exactamente qué falta y en qué línea.
// `resolver` permite recuperar motivo/documento desde los maestros cuando la
// línea no los trae guardados (notas creadas antes de esos campos).
export async function validarNotasSAP(notas, resolver = {}) {
  const errores = [];
  const filas = [];

  for (const n of notas) {
    const f = n.registroFinal || n.modActual || n.form;
    const codCliente = txt(f?.codigoCliente);
    const ndv = txt(n.ndv);

    if (!codCliente) errores.push({ ndv: ndv || `ID ${n.id}`, detalle: "Falta el código de cliente de la nota." });
    if (!ndv)        errores.push({ ndv: `ID ${n.id}`, detalle: "La nota no tiene número de ND asignado." });

    const lineas = (f?.lineas || []).filter(l => txt(l.codigo) || txt(l.nombre));
    if (lineas.length === 0) {
      errores.push({ ndv: ndv || `ID ${n.id}`, detalle: "La nota no tiene líneas de material." });
      continue;
    }

    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      const nl = i + 1;
      const material = txt(l.codigo);
      const faltantes = [];

      if (!material) faltantes.push("código de material");

      // Motivo de pedido: guardado en la línea o recuperado del maestro.
      let motivo = txt(l.motivoPedido);
      if (!motivo && material && resolver.motivoDe) {
        try { motivo = txt(await resolver.motivoDe(material)); } catch { /* se reporta abajo */ }
      }
      if (!motivo) faltantes.push("motivo de pedido");

      const lote = txt(l.lote);
      if (!lote) faltantes.push("lote de devolución");

      const cantidad = parseFloat(l.cantidad);
      if (isNaN(cantidad) || cantidad <= 0) faltantes.push("cantidad devuelta");

      // Documento SAP: guardado en la línea o recuperado del maestro de facturas.
      let docSap = txt(l.docSap);
      if (!docSap && txt(l.facturaNo) && resolver.docSapDe) {
        try { docSap = txt(await resolver.docSapDe(txt(l.facturaNo))); } catch { /* se reporta abajo */ }
      }
      if (!docSap) faltantes.push("factura SAP");

      if (faltantes.length > 0) {
        errores.push({
          ndv: ndv || `ID ${n.id}`,
          detalle: `Línea ${nl} (${material || l.nombre || "sin material"}): falta ${faltantes.join(", ")}.`,
        });
        continue;
      }

      // __notaId permite quedarse solo con las filas de las ND que sí se
      // marcaron como exportadas. generarXlsxSAP lo ignora (no es una columna).
      filas.push({ __notaId: n.id, E: codCliente, H: codCliente, K: ndv, Q: motivo, V: material, X: cantidad, AC: lote, AG: docSap });
    }
  }

  return { ok: errores.length === 0, errores, filas };
}

// ── GENERACIÓN DEL XLSX ──────────────────────────────────────────────────────
// Índice de columna (1..37) a partir de su letra.
const colNum = (L) => L.split("").reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0);
const LETRAS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z",
                "AA","AB","AC","AD","AE","AF","AG","AH","AI","AJ","AK"];

// Reconstruye una fila de datos clonando los estilos de la fila 2 de la plantilla.
// `plantillaCeldas` = { A: {s:"10", t:"s", v:"37"}, ... } leído de la fila 2.
function filaXml(nFila, datos, plantillaCeldas) {
  const celdas = LETRAS.map((L) => {
    const base = plantillaCeldas[L] || {};
    const s = base.s !== undefined ? ` s="${base.s}"` : "";
    const ref = `${L}${nFila}`;

    // Columna a llenar por el sistema
    if (Object.prototype.hasOwnProperty.call(datos, L)) {
      const val = datos[L];
      if (L === "X") {
        // Cantidad: valor numérico (la plantilla pide "sin ceros ni comas").
        return `<c r="${ref}"${s}><v>${Number(val)}</v></c>`;
      }
      return `<c r="${ref}"${s} t="inlineStr"><is><t>${xmlEsc(val)}</t></is></c>`;
    }

    // Valor fijo heredado de la plantilla (A=ZREF, B=318A, C=EL, D=01)
    if (base.t === "s" && base.v !== undefined) {
      return `<c r="${ref}"${s} t="s"><v>${base.v}</v></c>`;
    }
    if (base.v !== undefined) {
      const t = base.t ? ` t="${base.t}"` : "";
      return `<c r="${ref}"${s}${t}><v>${base.v}</v></c>`;
    }
    // Celda vacía, conservando su estilo
    return `<c r="${ref}"${s}/>`;
  }).join("");

  return `<row r="${nFila}" spans="1:37" ht="10.15" customHeight="1">${celdas}</row>`;
}

// Lee las celdas de una fila del XML de la hoja → { A: {s,t,v}, ... }
function leerCeldasDeFila(sheetXml, nFila) {
  const mRow = sheetXml.match(new RegExp(`<row[^>]*r="${nFila}"[^>]*>([\\s\\S]*?)</row>`));
  if (!mRow) return {};
  const celdas = {};
  const re = /<c\s+r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(mRow[1])) !== null) {
    const L = m[1];
    const attrs = m[2] || "";
    const cuerpo = m[3] || "";
    const s = (attrs.match(/\ss="([^"]+)"/) || [])[1];
    const t = (attrs.match(/\st="([^"]+)"/) || [])[1];
    const v = (cuerpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    celdas[L] = { s, t, v };
  }
  return celdas;
}

/**
 * Genera el .xlsx de carga a SAP a partir de la plantilla corporativa.
 * @param {Array} filas  Filas ya validadas (salida de validarNotasSAP).
 * @param {ArrayBuffer} plantillaBuffer  Bytes de la plantilla .xlsx.
 * @returns {Promise<Blob>}
 */
export async function generarXlsxSAP(filas, plantillaBuffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(plantillaBuffer);

  const rutaHoja = "xl/worksheets/sheet1.xml";
  let sheet = await zip.file(rutaHoja).async("string");

  // Estilos y valores fijos se toman de la primera fila de datos de la plantilla.
  const modelo = leerCeldasDeFila(sheet, 2);
  if (Object.keys(modelo).length === 0) {
    throw new Error("La plantilla no tiene una fila 2 de datos que sirva de modelo.");
  }

  const ultimaFila = filas.length + 1; // +1 por el encabezado
  const nuevasFilas = filas.map((d, i) => filaXml(i + 2, d, modelo)).join("");

  // 1) Reemplaza el bloque de filas conservando el encabezado (fila 1).
  const mHeader = sheet.match(/<row[^>]*r="1"[\s\S]*?<\/row>/);
  if (!mHeader) throw new Error("No se encontró la fila de encabezados en la plantilla.");
  sheet = sheet.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${mHeader[0]}${nuevasFilas}</sheetData>`);

  // 2) Ajusta la dimensión de la hoja.
  sheet = sheet.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:AK${ultimaFila}"/>`);

  // 3) Si la hoja declara un autofiltro propio, se redimensiona también.
  sheet = sheet.replace(/<autoFilter ref="[^"]*"/g, `<autoFilter ref="A1:AK${ultimaFila}"`);

  zip.file(rutaHoja, sheet);

  // 4) Redimensiona el objeto Tabla de Excel (si existe), o Excel marca el
  //    archivo como dañado al abrirlo.
  const rutaTabla = "xl/tables/table1.xml";
  if (zip.file(rutaTabla)) {
    let tabla = await zip.file(rutaTabla).async("string");
    tabla = tabla.replace(/(<table[^>]*\sref=")[^"]*(")/, `$1A1:AK${ultimaFila}$2`);
    tabla = tabla.replace(/(<autoFilter[^>]*\sref=")[^"]*(")/, `$1A1:AK${ultimaFila}$2`);
    zip.file(rutaTabla, tabla);
  }

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
}

// Descarga un Blob con el nombre indicado.
export function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Descarga la plantilla desde /public. Si falla, el error es explícito para que
// no se confunda con un problema de datos.
export async function cargarPlantillaSAP() {
  const r = await fetch(RUTA_PLANTILLA_SAP);
  if (!r.ok) {
    throw new Error(`No se encontró la plantilla SAP en ${RUTA_PLANTILLA_SAP} (HTTP ${r.status}). Verifica que el archivo esté en public/plantillas/.`);
  }
  return r.arrayBuffer();
}
