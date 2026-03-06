// financiera-backend/services/credito/credito.pdf.service.js
// Generación de PDF para ficha del crédito (aislado para no inflar el service principal).
//
// ✅ Mejoras incluidas:
// - Logo desde financiera-backend/assets/logo.png (en runtime: process.cwd()/assets/logo.png)
// - Header prolijo (logo + título + fecha)
// - Secciones con cajas/sombreado suave
// - Tabla con encabezado sombreado + repetición de encabezado al saltar de página
// - Corte de página automático para no “romper” filas
// - Ajuste de tabla de cuotas para importes largos:
//   * columnas rebalanceadas
//   * tamaño de fuente levemente menor
//   * altura de fila dinámica
//   * montos compactados para evitar cortes visuales

import { obtenerCreditoPorId } from './credito.core.service.js';

import {
  fmtARS,
  labelModalidad,
  todayYMD,
  fix2,
  toNumber,
  ymd,
  esLibre,
  LIBRE_VTO_FICTICIO
} from './credito.utils.js';

import { obtenerFechasCiclosLibre } from './credito.libre.service.js';

import fs from 'fs';
import path from 'path';

/* ===================== Helpers descuento / mora ===================== */

const getPagoDescuento = (pago) => {
  return fix2(
    toNumber(
      pago?.descuento_aplicado ??
      pago?.descuento ??
      pago?.recibo?.descuento_aplicado ??
      pago?.recibo?.descuento ??
      pago?.recibo_ui?.descuento_aplicado ??
      0
    )
  );
};

const getCuotaDescuentoMora = (cuota) => {
  const consolidado = fix2(
    toNumber(
      cuota?.descuento_aplicado ??
      cuota?.descuento_aplicado_total ??
      0
    )
  );
  if (consolidado > 0) return consolidado;

  const pagos = Array.isArray(cuota?.pagos) ? cuota.pagos : [];
  const descuentoDesdePagos = fix2(
    pagos.reduce((acc, p) => acc + getPagoDescuento(p), 0)
  );

  if (descuentoDesdePagos > 0) return descuentoDesdePagos;
  return fix2(toNumber(cuota?.descuento_cuota ?? 0));
};

const getCuotaMoraBruta = (cuota) =>
  fix2(toNumber(cuota?.intereses_vencidos_acumulados ?? 0));

const getCuotaSaldoMora = (cuota) => {
  const saldoMora = cuota?.saldo_mora;
  if (saldoMora !== undefined && saldoMora !== null) {
    return fix2(toNumber(saldoMora));
  }
  return null;
};

const getCuotaMoraNeta = (cuota) => {
  const moraNetaConsolidada = cuota?.mora_neta;
  if (moraNetaConsolidada !== undefined && moraNetaConsolidada !== null) {
    return fix2(toNumber(moraNetaConsolidada));
  }

  const saldoMora = getCuotaSaldoMora(cuota);
  if (saldoMora !== null) return saldoMora;

  const moraBruta = getCuotaMoraBruta(cuota);
  const descuentoMora = getCuotaDescuentoMora(cuota);
  return fix2(Math.max(moraBruta - descuentoMora, 0));
};

const getCuotaPrincipalPendiente = (cuota) => {
  return fix2(
    Math.max(
      toNumber(cuota?.importe_cuota) -
      toNumber(cuota?.descuento_cuota) -
      toNumber(cuota?.monto_pagado_acumulado),
      0
    )
  );
};

const getCuotaSaldoTotal = (cuota) => {
  return fix2(getCuotaPrincipalPendiente(cuota) + getCuotaMoraNeta(cuota));
};

/* ===================== TOTAL ACTUAL (helper local para PDF) ===================== */
const calcularTotalActualCreditoPlainPDF = (creditoPlain) => {
  if (!creditoPlain) return 0;

  if (esLibre(creditoPlain)) {
    const cuota = Array.isArray(creditoPlain.cuotas) ? creditoPlain.cuotas[0] : null;
    const mora = fix2(
      toNumber(
        cuota?.saldo_mora ??
        cuota?.mora_neta ??
        cuota?.intereses_vencidos_acumulados ??
        0
      )
    );

    const capital = fix2(toNumber(creditoPlain.saldo_capital ?? creditoPlain.saldo_actual));
    const interes = fix2(
      toNumber(
        creditoPlain.interes_pendiente_total ??
        creditoPlain.interes_pendiente_hoy ??
        0
      )
    );

    return fix2(capital + interes + mora);
  }

  let total = 0;
  const cuotas = Array.isArray(creditoPlain.cuotas) ? creditoPlain.cuotas : [];
  for (const c of cuotas) {
    const estado = String(c.estado || '').toLowerCase();
    if (!['pendiente', 'parcial', 'vencida'].includes(estado)) continue;

    total = fix2(total + getCuotaSaldoTotal(c));
  }
  return total;
};

/* ===================== Helpers de layout PDF ===================== */
const COLORS = {
  text: '#111111',
  muted: '#6B7280',
  line: '#E5E7EB',
  headerFill: '#F3F4F6',
  tableHeaderFill: '#F3F4F6',
  boxFill: '#FAFAFA'
};

const safeSetColor = (doc, hex) => {
  try { doc.fillColor(hex); } catch (_) { }
};

const safeStrokeColor = (doc, hex) => {
  try { doc.strokeColor(hex); } catch (_) { }
};

const drawHR = (doc, x1, x2, y) => {
  safeStrokeColor(doc, COLORS.line);
  doc.moveTo(x1, y).lineTo(x2, y).stroke();
  safeStrokeColor(doc, COLORS.text);
};

const drawSectionTitle = (doc, title) => {
  doc.moveDown(0.4);
  safeSetColor(doc, COLORS.text);
  doc.fontSize(12).font('Helvetica-Bold').text(title);
  doc.moveDown(0.2);
  drawHR(doc, doc.page.margins.left, doc.page.width - doc.page.margins.right, doc.y);
  doc.moveDown(0.4);
  doc.font('Helvetica');
};

const drawKV = (doc, x, y, label, value, opts = {}) => {
  const labelW = opts.labelWidth ?? 140;
  const valueW = opts.valueWidth ?? 360;
  const fontSize = opts.fontSize ?? 10;

  doc.fontSize(fontSize);
  safeSetColor(doc, COLORS.muted);
  doc.font('Helvetica').text(label, x, y, { width: labelW });

  safeSetColor(doc, COLORS.text);
  doc.font('Helvetica').text(String(value ?? '-'), x + labelW, y, { width: valueW });

  return y + (opts.rowHeight ?? 14);
};

const ensureSpace = (doc, neededHeight, onNewPage) => {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight <= bottom) return;
  doc.addPage();
  if (typeof onNewPage === 'function') onNewPage();
};

const resolveLogoPath = () => {
  // En producción y docker, process.cwd() suele ser /app
  // Logo: /app/assets/logo.png
  const p = path.resolve(process.cwd(), 'assets', 'logo.png');
  return p;
};

/* ===================== Helpers tabla cuotas ===================== */

const fmtARSTable = (value) => {
  // Compacta un poco para que entre mejor en columnas del PDF
  return String(fmtARS(value ?? 0)).replace(/\$\s+/g, '$');
};

const getCellAlign = (index) => {
  if (index === 0) return 'center';
  if (index === 1) return 'left';
  if (index === 7) return 'center';
  return 'right';
};

const getCellFont = (index) => {
  if (index === 7) return 'Helvetica-Bold';
  return 'Helvetica';
};

const getRowHeight = (doc, cells, colWidths, opts = {}) => {
  const fontSize = opts.fontSize ?? 8;
  const paddingX = opts.paddingX ?? 4;
  const paddingY = opts.paddingY ?? 4;
  const minRowH = opts.minRowH ?? 18;

  let maxH = 0;
  cells.forEach((cell, i) => {
    const width = Math.max((colWidths[i] || 0) - (paddingX * 2), 8);
    const font = getCellFont(i);
    doc.font(font).fontSize(fontSize);

    const h = doc.heightOfString(String(cell ?? ''), {
      width,
      align: getCellAlign(i)
    });

    if (h > maxH) maxH = h;
  });

  return Math.max(minRowH, Math.ceil(maxH + (paddingY * 2)));
};

const drawTableGrid = (doc, x, y, colWidths, rowH) => {
  const totalW = colWidths.reduce((a, b) => a + b, 0);

  safeStrokeColor(doc, COLORS.line);
  doc.rect(x, y, totalW, rowH).stroke();

  let cx = x;
  for (let i = 0; i < colWidths.length - 1; i += 1) {
    cx += colWidths[i];
    doc.moveTo(cx, y).lineTo(cx, y + rowH).stroke();
  }

  safeStrokeColor(doc, COLORS.text);
};

/* ===================== PDF: Ficha del Crédito ===================== */
export const imprimirFichaCredito = async (req, res) => {
  try {
    const { id } = req.params || {};
    const credito = await obtenerCreditoPorId(id);
    if (!credito) {
      return res.status(404).json({ success: false, message: 'Crédito no encontrado' });
    }

    let PDFDocument;
    try {
      ({ default: PDFDocument } = await import('pdfkit'));
    } catch {
      return res.status(500).json({
        success: false,
        message: 'Falta la dependencia pdfkit. Ejecutá: npm i pdfkit'
      });
    }

    const c = credito.get ? credito.get({ plain: true }) : credito;
    const cli = c.cliente || {};
    const cuotas = Array.isArray(c.cuotas) ? c.cuotas : [];

    const total_actual = fix2(
      toNumber(
        typeof c.total_actual !== 'undefined' && c.total_actual !== null
          ? c.total_actual
          : calcularTotalActualCreditoPlainPDF(c)
      )
    );

    const fechaEmision = todayYMD();
    const ciclosLibre = esLibre(c) ? obtenerFechasCiclosLibre(c) : null;

    const vtosValidos = cuotas
      .map((ct) => ct.fecha_vencimiento)
      .filter((f) => f && f !== LIBRE_VTO_FICTICIO)
      .map((f) => ymd(f))
      .filter(Boolean)
      .sort();

    let primerVto = vtosValidos[0] || (c.fecha_compromiso_pago ? ymd(c.fecha_compromiso_pago) : '-');
    let ultimoVto = vtosValidos.length
      ? vtosValidos[vtosValidos.length - 1]
      : (c.fecha_compromiso_pago ? ymd(c.fecha_compromiso_pago) : '-');

    if (ciclosLibre) {
      primerVto = ciclosLibre.vencimiento_ciclo_1 || primerVto;
      ultimoVto = ciclosLibre.vencimiento_ciclo_3 || ultimoVto;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ficha-credito-${c.id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');

    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      info: {
        Title: `Ficha de Crédito #${c.id}`,
        Author: 'SyE - Financiera',
        Producer: 'PDFKit'
      }
    });

    doc.on('error', (err) => {
      console.error('[PDFKit][imprimirFichaCredito] Error de stream:', err?.message || err);
      try { res.end(); } catch (_) { }
    });

    doc.pipe(res);

    /* ===================== Header (logo + título) ===================== */
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const top = doc.page.margins.top;

    const headerH = 64;
    safeStrokeColor(doc, COLORS.line);
    doc.rect(left, top - 10, right - left, headerH).stroke();
    safeStrokeColor(doc, COLORS.text);

    const logoPath = resolveLogoPath();
    let logoDrawn = false;
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, left + 10, top - 2, { height: 44 });
        logoDrawn = true;
      } catch (e) {
        console.error('[PDFKit][logo] No se pudo cargar logo:', e?.message || e);
      }
    } else {
      console.warn('[PDFKit][logo] No existe:', logoPath);
    }

    const titleX = logoDrawn ? left + 10 + 160 : left + 10;
    const titleW = right - titleX - 10;

    safeSetColor(doc, COLORS.text);
    doc.font('Helvetica-Bold').fontSize(18).text('Ficha de Crédito', titleX, top + 2, { width: titleW, align: 'right' });

    safeSetColor(doc, COLORS.muted);
    doc.font('Helvetica').fontSize(9).text(`Emitido: ${fechaEmision}`, titleX, top + 28, { width: titleW, align: 'right' });

    safeSetColor(doc, COLORS.muted);
    doc.fontSize(9).text(`Crédito #${c.id} · ${String(c.estado || '').toUpperCase()} · ${labelModalidad(c.modalidad_credito)}`, titleX, top + 42, {
      width: titleW,
      align: 'right'
    });

    doc.y = top + headerH + 8;
    safeSetColor(doc, COLORS.text);

    /* ===================== Cliente ===================== */
    drawSectionTitle(doc, 'Cliente');

    const nombreCompleto = [cli.nombre, cli.apellido].filter(Boolean).join(' ') || '-';
    const telefonos = [cli.telefono_1, cli.telefono_2, cli.telefono].filter(Boolean).join(' / ') || '-';
    const direcciones = [cli.direccion_1, cli.direccion_2, cli.direccion].filter(Boolean).join(' | ') || '-';

    let y0 = doc.y;
    y0 = drawKV(doc, left, y0, 'Nombre', nombreCompleto);
    y0 = drawKV(doc, left, y0, 'DNI', cli.dni || '-');
    y0 = drawKV(doc, left, y0, 'Teléfono(s)', telefonos);
    y0 = drawKV(doc, left, y0, 'Dirección', direcciones, { rowHeight: 16 });
    doc.y = y0 + 6;

    /* ===================== Crédito ===================== */
    drawSectionTitle(doc, 'Crédito');

    let y1 = doc.y;
    y1 = drawKV(doc, left, y1, 'Modalidad', labelModalidad(c.modalidad_credito));
    y1 = drawKV(doc, left, y1, 'Tipo', String(c.tipo_credito || '').toUpperCase());
    y1 = drawKV(doc, left, y1, 'Cuotas', c.cantidad_cuotas ?? '-');
    y1 = drawKV(doc, left, y1, 'Fecha solicitud', c.fecha_solicitud || '-');
    y1 = drawKV(doc, left, y1, 'Fecha acreditación', c.fecha_acreditacion || '-');

    if (ciclosLibre) {
      y1 = drawKV(doc, left, y1, 'Vto 1er ciclo', ciclosLibre.vencimiento_ciclo_1 || '-');
      y1 = drawKV(doc, left, y1, 'Vto 2° ciclo', ciclosLibre.vencimiento_ciclo_2 || '-');
      y1 = drawKV(doc, left, y1, 'Vto 3er ciclo', ciclosLibre.vencimiento_ciclo_3 || '-');
    } else {
      y1 = drawKV(doc, left, y1, '1er vencimiento', primerVto);
      y1 = drawKV(doc, left, y1, 'Fin de crédito', ultimoVto);
    }

    y1 = drawKV(doc, left, y1, 'Cobrador asignado', c.cobradorCredito?.nombre_completo || '-');

    const totalsBoxH = 54;
    ensureSpace(doc, totalsBoxH + 18);

    const boxY = y1 + 10;
    safeStrokeColor(doc, COLORS.line);
    doc.rect(left, boxY, right - left, totalsBoxH).stroke();
    safeStrokeColor(doc, COLORS.text);

    safeSetColor(doc, COLORS.muted);
    doc.font('Helvetica').fontSize(10).text('Saldo actual declarado', left + 12, boxY + 10);
    safeSetColor(doc, COLORS.text);
    doc.font('Helvetica-Bold').fontSize(12).text(fmtARS(c.saldo_actual), left + 12, boxY + 26);

    safeSetColor(doc, COLORS.muted);
    doc.font('Helvetica').fontSize(10).text('TOTAL ACTUAL', right - 210, boxY + 10, { width: 198, align: 'right' });
    safeSetColor(doc, COLORS.text);
    doc.font('Helvetica-Bold').fontSize(16).text(fmtARS(total_actual), right - 210, boxY + 24, { width: 198, align: 'right' });

    doc.font('Helvetica');
    doc.y = boxY + totalsBoxH + 12;

    /* ===================== Detalle de cuotas (tabla) ===================== */
    drawSectionTitle(doc, 'Detalle de cuotas');

    const headers = ['#', 'Vencimiento', 'Importe', 'Pagado', 'Desc.', 'Mora', 'Saldo', 'Estado'];

    // Rebalanceadas para evitar corte de montos grandes
    const colWidths = [22, 78, 64, 64, 50, 72, 86, 64];

    const tableX = left;
    const tableW = colWidths.reduce((a, b) => a + b, 0);

    const tableFontSize = 7.6;
    const headerFontSize = 8;
    const cellPadX = 4;
    const cellPadY = 4;
    const minRowH = 18;

    const drawTableHeader = () => {
      const headerCells = headers;
      const headerH = getRowHeight(doc, headerCells, colWidths, {
        fontSize: headerFontSize,
        paddingX: cellPadX,
        paddingY: cellPadY,
        minRowH
      });

      ensureSpace(doc, headerH + 6);

      const y = doc.y;

      doc.save();
      safeSetColor(doc, COLORS.tableHeaderFill);
      doc.rect(tableX, y, tableW, headerH).fill();
      doc.restore();

      drawTableGrid(doc, tableX, y, colWidths, headerH);

      let cx = tableX;
      headers.forEach((h, i) => {
        const width = colWidths[i];
        const align = getCellAlign(i);
        doc.font('Helvetica-Bold').fontSize(headerFontSize);
        safeSetColor(doc, COLORS.text);
        doc.text(h, cx + cellPadX, y + cellPadY, {
          width: width - (cellPadX * 2),
          align
        });
        cx += width;
      });

      doc.font('Helvetica');
      doc.y = y + headerH;
      return y + headerH;
    };

    const drawRow = (cells) => {
      const rowH = getRowHeight(doc, cells, colWidths, {
        fontSize: tableFontSize,
        paddingX: cellPadX,
        paddingY: cellPadY,
        minRowH
      });

      ensureSpace(doc, rowH + 2, () => {
        drawTableHeader();
      });

      const y = doc.y;

      drawTableGrid(doc, tableX, y, colWidths, rowH);

      let cx = tableX;
      cells.forEach((cell, i) => {
        const width = colWidths[i];
        const align = getCellAlign(i);

        doc.font(getCellFont(i)).fontSize(tableFontSize);
        safeSetColor(doc, COLORS.text);

        doc.text(String(cell ?? ''), cx + cellPadX, y + cellPadY, {
          width: width - (cellPadX * 2),
          align
        });

        cx += width;
      });

      doc.y = y + rowH;
    };

    drawTableHeader();

    let totalPrincipalPend = 0;
    let totalMora = 0;
    let totalDescuento = 0;

    for (const ct of cuotas) {
      const descuentoMora = getCuotaDescuentoMora(ct);
      const mora = getCuotaMoraNeta(ct);
      const principalPend = getCuotaPrincipalPendiente(ct);

      totalPrincipalPend = fix2(totalPrincipalPend + principalPend);
      totalMora = fix2(totalMora + mora);
      totalDescuento = fix2(totalDescuento + descuentoMora);

      const vto = ct.fecha_vencimiento === LIBRE_VTO_FICTICIO
        ? '—'
        : (ct.fecha_vencimiento ? ymd(ct.fecha_vencimiento) : '-');

      const saldoCuota = fix2(principalPend + mora);

      drawRow([
        ct.numero_cuota,
        vto,
        fmtARSTable(ct.importe_cuota),
        fmtARSTable(ct.monto_pagado_acumulado),
        fmtARSTable(descuentoMora),
        fmtARSTable(mora),
        fmtARSTable(saldoCuota),
        String(ct.estado || '').toUpperCase()
      ]);
    }

    doc.moveDown(0.6);
    ensureSpace(doc, 76);

    const totalsY = doc.y;
    const boxH = 66;

    safeStrokeColor(doc, COLORS.line);
    doc.rect(left, totalsY, right - left, boxH).stroke();
    safeStrokeColor(doc, COLORS.text);

    doc.font('Helvetica-Bold').fontSize(10);
    safeSetColor(doc, COLORS.text);
    doc.text('Totales', left + 10, totalsY + 10);

    doc.font('Helvetica').fontSize(10);

    const labelW = 90;
    const valueW = 160;
    const rightPad = 12;

    const labelX = right - rightPad - (valueW + labelW);
    const valueX = right - rightPad - valueW;

    safeSetColor(doc, COLORS.muted);
    doc.text('Descuento:', labelX, totalsY + 10, { width: labelW, align: 'right' });
    safeSetColor(doc, COLORS.text);
    doc.text(fmtARS(totalDescuento), valueX, totalsY + 10, { width: valueW, align: 'right' });

    safeSetColor(doc, COLORS.muted);
    doc.text('Mora:', labelX, totalsY + 26, { width: labelW, align: 'right' });
    safeSetColor(doc, COLORS.text);
    doc.text(fmtARS(totalMora), valueX, totalsY + 26, { width: valueW, align: 'right' });

    safeSetColor(doc, COLORS.muted);
    doc.text('Principal pendiente:', labelX, totalsY + 42, { width: labelW, align: 'right' });
    safeSetColor(doc, COLORS.text);
    doc.text(fmtARS(totalPrincipalPend), valueX, totalsY + 42, { width: valueW, align: 'right' });

    const noteX = left + 10;
    const noteW = (labelX - 12) - noteX;

    safeSetColor(doc, COLORS.muted);
    doc.font('Helvetica').fontSize(8);
    doc.text(
      'Nota: Esta ficha es informativa. Los importes pueden variar según pagos registrados, descuentos aplicados y recálculos de mora.',
      noteX,
      totalsY + 38,
      { width: Math.max(noteW, 120), align: 'left' }
    );

    doc.y = totalsY + boxH + 10;

    doc.end();
  } catch (error) {
    console.error('[imprimirFichaCredito]', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Error al generar la ficha del crédito' });
    } else {
      try { res.end(); } catch (_) { }
    }
  }
};