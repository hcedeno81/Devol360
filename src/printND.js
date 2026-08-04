// ─────────────────────────────────────────────────────────────────────────────
// IMPRESIÓN DE NOTA DE DEVOLUCIÓN — Hoja de trabajo para recepción en bodega
// ─────────────────────────────────────────────────────────────────────────────
// Genera un documento A4 HORIZONTAL, optimizado para impresión en blanco y
// negro, y lo envía a la impresora usando un IFRAME AISLADO.
//
// ¿Por qué un iframe y no window.print() sobre la página?
//   · Todo el CSS (incluido @page { size: A4 landscape }) vive dentro del
//     iframe: NO puede afectar ni un pixel de la aplicación actual.
//   · Funciona igual en StackBlitz (app embebida en iframe), en Vercel y en
//     local, y no lo bloquean los bloqueadores de ventanas emergentes como sí
//     ocurre con window.open().
//   · No requiere react-dom, portales ni tocar el árbol de componentes.
//
// Uso:
//   import { printND } from "./printND";
//   printND({ nota, form: dispForm, user });
// ─────────────────────────────────────────────────────────────────────────────

const CIUDADES = { quito: "Quito", guayaquil: "Guayaquil" };

// Filas en blanco al final de la tabla, para anotar producto físico que llegó
// pero NO está registrado en la nota (caso real y frecuente en recepción).
const FILAS_EXTRA = 2;

// Escapa el contenido antes de inyectarlo en el HTML del iframe.
const esc = (v) =>
  String(v === null || v === undefined ? "" : v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// Mismo formato de fecha que la app (DD/MM/AAAA). Se duplica aquí a propósito
// para que este módulo sea autónomo y no dependa de App.jsx.
const fmtD = (iso) => {
  if (!iso) return "";
  const p = String(iso).split("-");
  if (p.length !== 3) return String(iso);
  return `${p[2]}/${p[1]}/${p[0]}`;
};

const siNo = (v) => (v === "si" ? "Sí" : v === "no" ? "No" : "—");

// Campo de cabecera: etiqueta pequeña en versalitas + valor sobre línea fina.
const campo = (label, valor, ancho) =>
  `<td class="fld" style="width:${ancho}">
     <span class="fld-l">${esc(label)}</span>
     <span class="fld-v">${esc(valor) || "&nbsp;"}</span>
   </td>`;

// ── CONSTRUCCIÓN DEL DOCUMENTO ───────────────────────────────────────────────
export function buildNDHtml({ nota, form, user }) {
  const f = form || nota.form;
  const lineas = (f.lineas || []).filter((l) => l.codigo || l.nombre);

  const vendedores = [
    ...new Set((f.lineas || []).map((l) => l.vendedor).filter(Boolean)),
  ].join(", ");

  const impresoPor = user ? user.name : "";
  const ahora = new Date().toLocaleString("es-EC");

  const filasTabla =
    lineas
      .map(
        (l, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td class="mono">${esc(l.codigo)}</td>
        <td>${esc(l.nombre)}</td>
        <td class="c">${siNo(l.porc15)}</td>
        <td class="c">${siNo(l.medVital)}</td>
        <td class="c num">${esc(l.cantidad)}</td>
        <td class="mono">${esc(l.lote)}</td>
        <td class="c">${esc(fmtD(l.fechaVenc))}</td>
        <td class="mono">${esc(l.facturaNo)}</td>
        <td class="tarja"></td>
        <td class="tarja"></td>
        <td class="tarja"></td>
      </tr>`
      )
      .join("") +
    Array.from({ length: FILAS_EXTRA })
      .map(
        (_, i) => `
      <tr class="extra">
        <td class="c">${lineas.length + i + 1}</td>
        <td colspan="8" class="extra-l">Producto recibido sin registrar en la ND (anotar código, descripción, lote, vencimiento y factura)</td>
        <td class="tarja"></td>
        <td class="tarja"></td>
        <td class="tarja"></td>
      </tr>`
      )
      .join("");

  const bloqueRechazo = nota.motivoRechazo
    ? `<div class="aviso"><strong>RRVV rechazó la corrección anterior:</strong> ${esc(
        nota.motivoRechazo
      )}</div>`
    : "";

  const bloqueObs = f.observacion
    ? `<div class="aviso"><strong>Observación registrada:</strong> ${esc(f.observacion)}</div>`
    : "";

  const historial = (nota.historial || [])
    .map(
      (h) =>
        `<li><span class="h-u">${esc(h.usuario)}</span> · ${esc(h.accion)} <span class="h-f">${esc(
          h.fecha
        )}</span></li>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>ND ${esc(nota.ndv)}</title>
<style>
  @page { size: A4 landscape; margin: 9mm 8mm 8mm 8mm; }

  *      { box-sizing: border-box; }
  html, body { margin:0; padding:0; }
  body   { font-family: Arial, Helvetica, sans-serif; font-size: 8.5pt; color:#000;
           -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .doc   { border: 1.4pt solid #000; padding: 0; }

  /* ── Encabezado ───────────────────────────────────────────────────────── */
  .hdr   { display:flex; align-items:stretch; border-bottom:1.4pt solid #000; }
  .hdr-l { flex:1; padding:5px 8px; }
  .hdr-r { width:56mm; border-left:1pt solid #000; padding:5px 8px; text-align:right; }
  .marca { font-size:13pt; font-weight:bold; letter-spacing:1.5px; line-height:1.1; }
  .tit   { font-size:9pt; font-weight:bold; text-transform:uppercase; letter-spacing:.4px; margin-top:2px; }
  .cod   { font-size:6.5pt; color:#333; margin-top:2px; }
  .ndv-l { font-size:6.5pt; text-transform:uppercase; letter-spacing:.8px; }
  .ndv   { font-size:16pt; font-weight:bold; line-height:1.05; font-variant-numeric: tabular-nums; }
  .tags  { margin-top:3px; }
  .tag   { display:inline-block; border:1pt solid #000; padding:1px 5px; font-size:6.5pt;
           font-weight:bold; text-transform:uppercase; letter-spacing:.4px; margin-left:3px; }
  .tag.k { background:#000; color:#fff; }

  /* ── Campos de cabecera ───────────────────────────────────────────────── */
  .meta  { width:100%; border-collapse:collapse; }
  .meta td.fld { border-right:.5pt solid #999; border-bottom:.5pt solid #999;
                 padding:3px 7px 4px; vertical-align:top; }
  .meta tr:last-child td { border-bottom:1.4pt solid #000; }
  .meta td.fld:last-child { border-right:none; }
  .fld-l { display:block; font-size:6pt; text-transform:uppercase; letter-spacing:.7px; color:#444; }
  .fld-v { display:block; font-size:8.5pt; font-weight:bold; margin-top:1px; }

  /* ── Avisos ───────────────────────────────────────────────────────────── */
  .aviso { border-bottom:.5pt solid #999; padding:4px 8px; font-size:7.5pt; }
  .aviso strong { text-transform:uppercase; font-size:6.5pt; letter-spacing:.5px; }

  /* ── Tabla de líneas ──────────────────────────────────────────────────── */
  table.items { width:100%; border-collapse:collapse; table-layout:fixed; }
  table.items th { background:#dcdcdc; border:.5pt solid #000; padding:3px 3px;
                   font-size:6.5pt; text-transform:uppercase; letter-spacing:.3px; line-height:1.15; }
  table.items td { border:.5pt solid #000; padding:3px 4px; height:22px;
                   font-size:7.5pt; vertical-align:middle; word-wrap:break-word; }
  table.items tr { page-break-inside: avoid; }
  .c     { text-align:center; }
  .num   { font-weight:bold; font-variant-numeric: tabular-nums; }
  .mono  { font-family:"Courier New", monospace; font-size:7.5pt; }

  /* Divisoria funcional: todo lo que está a la derecha se llena a mano. */
  th.sep, td.tarja:first-of-type { border-left:1.4pt solid #000; }
  th.tarja-h { background:#fff; }
  td.tarja   { background:#fff; }
  tr.extra td { color:#666; }
  .extra-l { font-size:6.5pt; font-style:italic; }

  /* ── Zona de tarja / cierre ───────────────────────────────────────────── */
  .tarja-zone { page-break-inside: avoid; border-top:1.4pt solid #000; }
  .box-t { font-size:6.5pt; text-transform:uppercase; letter-spacing:.7px;
           font-weight:bold; padding:3px 7px 2px; border-bottom:.5pt solid #999; }
  .lines { padding:4px 7px 6px; }
  .lines div { border-bottom:.5pt solid #999; height:15px; }
  .grid3 { display:flex; }
  .grid3 > div { flex:1; border-right:.5pt solid #999; }
  .grid3 > div:last-child { border-right:none; }
  .firma { height:34px; border-bottom:.5pt solid #000; margin:14px 10px 3px; }
  .firma-l { font-size:6pt; text-transform:uppercase; letter-spacing:.5px;
             text-align:center; color:#444; padding-bottom:5px; }

  /* ── Historial ────────────────────────────────────────────────────────── */
  .hist { border-top:.5pt solid #999; padding:4px 8px 6px; }
  .hist ul { margin:2px 0 0; padding:0; list-style:none; column-count:2; column-gap:14px; }
  .hist li { font-size:6.5pt; line-height:1.35; break-inside:avoid; border-bottom:.25pt dotted #bbb; }
  .h-u { font-weight:bold; }
  .h-f { color:#555; }

  .pie { display:flex; justify-content:space-between; font-size:6pt; color:#444;
         margin-top:3px; padding:0 1px; }
</style>
</head>
<body>
<div class="doc">

  <div class="hdr">
    <div class="hdr-l">
      <div class="marca">FRESENIUS KABI</div>
      <div class="tit">Nota de Devolución — Hoja de recepción física en bodega</div>
      <div class="cod">EC-MU-3207-FORM-LW-000087034 · Ver 1.0</div>
    </div>
    <div class="hdr-r">
      <div class="ndv-l">Nº Nota de Devolución</div>
      <div class="ndv">${esc(nota.ndv)}</div>
      <div class="tags">
        <span class="tag${nota.tipoProducto === "controlado" ? " k" : ""}">${
    nota.tipoProducto === "controlado" ? "Controlado" : "Normal"
  }</span>
        <span class="tag">Bodega ${esc(CIUDADES[nota.ciudad] || nota.ciudad || "")}</span>
      </div>
    </div>
  </div>

  <table class="meta">
    <tr>
      ${campo("Fecha de la ND", fmtD(f.fecha), "13%")}
      ${campo("Código cliente", f.codigoCliente, "13%")}
      ${campo("Cliente", f.nombreCliente, "44%")}
      ${campo("Tipo de devolución", f.tipoDevolucion, "15%")}
      ${campo("Nº de bultos", f.noBultos, "15%")}
    </tr>
    <tr>
      ${campo("Motivo", `${f.codigoMotivo || ""} ${f.descripcionMotivo ? "– " + f.descripcionMotivo : ""}`.trim(), "39%")}
      ${campo("Documento", f.nc ? "Nota de Crédito" : f.canje ? "Canje" : "", "13%")}
      ${campo("RRVV responsable", nota.rrvvNombre, "16%")}
      ${campo("Vendedor", vendedores, "16%")}
      ${campo("Creada por", nota.creadoPorNombre, "16%")}
    </tr>
  </table>

  ${bloqueRechazo}
  ${bloqueObs}

  <table class="items">
    <colgroup>
      <col style="width:3.0%"><col style="width:8.5%"><col style="width:20.5%">
      <col style="width:4.0%"><col style="width:4.5%"><col style="width:5.5%">
      <col style="width:8.0%"><col style="width:7.0%"><col style="width:8.5%">
      <col style="width:7.0%"><col style="width:6.0%"><col style="width:17.5%">
    </colgroup>
    <thead>
      <tr>
        <th>Nº</th>
        <th>Código</th>
        <th>Descripción del material</th>
        <th>15%</th>
        <th>Med.<br>vital</th>
        <th>Cant.<br>ND</th>
        <th>Lote</th>
        <th>F. venc.</th>
        <th>Factura Nº</th>
        <th class="sep tarja-h">Cant. física<br>recibida</th>
        <th class="tarja-h">Dife-<br>rencia</th>
        <th class="tarja-h">Observación / corrección a registrar</th>
      </tr>
    </thead>
    <tbody>
      ${filasTabla}
    </tbody>
  </table>

  <div class="tarja-zone">
    <div class="grid3">
      <div style="flex:1.6">
        <div class="box-t">Observaciones generales de la recepción</div>
        <div class="lines"><div></div><div></div><div></div></div>
      </div>
      <div style="flex:1.4">
        <div class="box-t">Correcciones a registrar en el sistema</div>
        <div class="lines"><div></div><div></div><div></div></div>
      </div>
      <div style="flex:1">
        <div class="box-t">Cierre de recepción física</div>
        <div class="grid3">
          <div>
            <div class="firma"></div>
            <div class="firma-l">Firma / iniciales bodeguero</div>
          </div>
          <div>
            <div class="firma"></div>
            <div class="firma-l">Fecha y hora de recepción</div>
          </div>
        </div>
      </div>
    </div>

    ${
      historial
        ? `<div class="hist">
             <div class="box-t" style="border:none;padding:0 0 2px">Trazabilidad del proceso</div>
             <ul>${historial}</ul>
           </div>`
        : ""
    }
  </div>

</div>

<div class="pie">
  <span>Impreso por: <strong>${esc(impresoPor)}</strong> · ${esc(ahora)}</span>
  <span>Este documento impreso es una hoja de trabajo. El registro válido es el del sistema.</span>
</div>
</body>
</html>`;
}

// ── ENVÍO A LA IMPRESORA ─────────────────────────────────────────────────────
export function printND({ nota, form, user }) {
  const html = buildNDHtml({ nota, form, user });

  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "Impresión de Nota de Devolución");
  // Fuera de pantalla PERO con dimensiones reales: si se usa display:none el
  // navegador no calcula el layout y algunos motores imprimen en blanco.
  Object.assign(iframe.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "1200px",
    height: "850px",
    border: "0",
  });
  document.body.appendChild(iframe);

  const limpiar = () => {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 1500);
  };

  try {
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    // Pequeña espera para que el motor termine de maquetar antes de imprimir.
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        abrirEnPestana(html);
      } finally {
        limpiar();
      }
    }, 250);
  } catch (e) {
    limpiar();
    abrirEnPestana(html);
  }
}

// Respaldo: si el navegador impide imprimir desde el iframe, se abre el
// documento en una pestaña nueva para que el usuario imprima con Ctrl+P.
function abrirEnPestana(html) {
  try {
    const w = window.open("", "_blank");
    if (!w) {
      alert(
        "El navegador bloqueó la impresión. Permite las ventanas emergentes para este sitio e intenta de nuevo."
      );
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
  } catch (e) {
    /* sin más alternativas */
  }
}
