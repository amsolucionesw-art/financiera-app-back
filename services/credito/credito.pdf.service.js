// financiera-backend/services/credito/credito.pdf.service.js
// Generación de PDF para ficha del crédito (aislado para no inflar el service principal).

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

/* ===================== TOTAL ACTUAL (helper local para PDF) ===================== */
/**
 * Evita depender de un helper NO exportado del core.
 * Regla:
 * - LIBRE: capital (saldo_actual) + interés del ciclo estimado + mora en cuota (intereses_vencidos_acumulados).
 * - COMÚN/PROGRESIVO: suma por cuotas activas (pendiente/parcial/vencida):
 *    (importe - descuento - pagado) + mora (intereses_vencidos_acumulados)
 *
 * Nota importante:
 * - En tu arquitectura, el "total_actual" oficial viene seteadísimo por obtenerCreditoPorId().
 * - Este helper es SOLO fallback defensivo si por algún motivo c.total_actual viene null/undefined.
 * - Para LIBRE, el interés estimado NO lo recalculamos acá para no duplicar lógica:
 *   usamos "interes_pendiente_total" / "interes_pendiente_hoy" / "intereses_acumulados"
 *   que ya vienen aplanados por el core cuando existe resumen_libre.
 */
const calcularTotalActualCreditoPlainPDF = (creditoPlain) => {
  if (!creditoPlain) return 0;

  if (esLibre(creditoPlain)) {
    const cuota = Array.isArray(creditoPlain.cuotas) ? creditoPlain.cuotas[0] : null;
    const mora = fix2(toNumber(cuota?.intereses_vencidos_acumulados));

    // Preferimos valores ya normalizados por el core (si existen)
    const capital = fix2(toNumber(creditoPlain.saldo_capital ?? creditoPlain.saldo_actual));
    const interes =
      fix2(
        toNumber(
          creditoPlain.interes_pendiente_total ??
          creditoPlain.interes_pendiente_hoy ??
          // fallback ultra defensivo: si no hay resumen, tomamos 0
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

    const principalPend = Math.max(
      fix2(toNumber(c.importe_cuota) - toNumber(c.descuento_cuota) - toNumber(c.monto_pagado_acumulado)),
      0
    );
    const mora = fix2(toNumber(c.intereses_vencidos_acumulados));

    total = fix2(total + principalPend + mora);
  }
  return total;
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

    // ✅ Preferimos el total_actual ya calculado por el core
    const total_actual = fix2(toNumber(
      typeof c.total_actual !== 'undefined' && c.total_actual !== null
        ? c.total_actual
        : calcularTotalActualCreditoPlainPDF(c)
    ));

    const fechaEmision = todayYMD();

    const ciclosLibre = esLibre(c) ? obtenerFechasCiclosLibre(c) : null;

    const vtosValidos = cuotas
      .map((ct) => ct.fecha_vencimiento)
      .filter((f) => f && f !== LIBRE_VTO_FICTICIO)
      .map((f) => ymd(f))
      .filter(Boolean)
      .sort();

    let primerVto =
      vtosValidos[0] || (c.fecha_compromiso_pago ? ymd(c.fecha_compromiso_pago) : '-');

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

    const doc = new PDFDocument({ size: 'A4', margin: 36 });

    doc.on('error', (err) => {
      console.error('[PDFKit][imprimirFichaCredito] Error de stream:', err?.message || err);
      try { res.end(); } catch (_) {}
    });

    doc.pipe(res);

    doc.fontSize(16).text('Ficha de Crédito', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#555').text(`Emitido: ${fechaEmision}`, { align: 'center' });
    doc.moveDown(1);
    doc.fillColor('#000');

    doc.fontSize(12).text('Cliente', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10)
      .text(`Nombre: ${[cli.nombre, cli.apellido].filter(Boolean).join(' ') || '-'}`)
      .text(`DNI: ${cli.dni || '-'}`)
      .text(`Teléfono(s): ${[cli.telefono_1, cli.telefono_2, cli.telefono].filter(Boolean).join(' / ') || '-'}`)
      .text(`Dirección: ${[cli.direccion_1, cli.direccion_2, cli.direccion].filter(Boolean).join(' | ') || '-'}`);
    doc.moveDown(0.8);

    doc.fontSize(12).text('Crédito', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10)
      .text(`ID: ${c.id}`)
      .text(`Modalidad: ${labelModalidad(c.modalidad_credito)}`)
      .text(`Tipo: ${String(c.tipo_credito || '').toUpperCase()}`)
      .text(`Cuotas: ${c.cantidad_cuotas ?? '-'}`)
      .text(`Estado: ${String(c.estado || '').toUpperCase()}`)
      .text(`Fecha solicitud: ${c.fecha_solicitud || '-'}`)
      .text(`Fecha acreditación: ${c.fecha_acreditacion || '-'}`);

    if (ciclosLibre) {
      doc
        .text(`Vto 1er ciclo: ${ciclosLibre.vencimiento_ciclo_1 || '-'}`)
        .text(`Vto 2° ciclo: ${ciclosLibre.vencimiento_ciclo_2 || '-'}`)
        .text(`Vto 3er ciclo: ${ciclosLibre.vencimiento_ciclo_3 || '-'}`);
    } else {
      doc
        .text(`Fecha 1er vencimiento: ${primerVto}`)
        .text(`Fecha fin de crédito: ${ultimoVto}`);
    }

    doc.text(`Cobrador asignado: ${c.cobradorCredito?.nombre_completo || '-'}`);
    doc.moveDown(0.3);
    doc.fontSize(11).text(`Saldo actual declarado: ${fmtARS(c.saldo_actual)}`);
    doc.fontSize(12).text(`TOTAL ACTUAL: ${fmtARS(total_actual)}`);
    doc.moveDown(1);

    doc.fontSize(12).text('Detalle de cuotas', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(9);

    const headers = ['#', 'Vencimiento', 'Importe', 'Pagado', 'Desc.', 'Mora', 'Saldo', 'Estado'];
    const colWidths = [25, 85, 70, 70, 55, 55, 70, 70];

    let x = doc.x, y = doc.y;
    headers.forEach((h, i) => {
      doc.text(h, x, y, { width: colWidths[i], align: i <= 1 ? 'left' : 'right' });
      x += colWidths[i];
    });
    doc.moveDown(0.5);
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor('#ddd').stroke();
    doc.strokeColor('#000');

    let totalPrincipalPend = 0, totalMora = 0;
    cuotas.forEach((ct) => {
      const principalPend = Math.max(
        fix2(toNumber(ct.importe_cuota) - toNumber(ct.descuento_cuota) - toNumber(ct.monto_pagado_acumulado)),
        0
      );
      const mora = fix2(toNumber(ct.intereses_vencidos_acumulados));
      totalPrincipalPend = fix2(totalPrincipalPend + principalPend);
      totalMora = fix2(totalMora + mora);

      const vto =
        ct.fecha_vencimiento === LIBRE_VTO_FICTICIO
          ? '—'
          : (ct.fecha_vencimiento ? ymd(ct.fecha_vencimiento) : '-');

      const saldoCuota = fix2(principalPend + mora);

      const row = [
        ct.numero_cuota,
        vto,
        fmtARS(ct.importe_cuota),
        fmtARS(ct.monto_pagado_acumulado),
        fmtARS(ct.descuento_cuota),
        fmtARS(mora),
        fmtARS(saldoCuota),
        String(ct.estado || '').toUpperCase()
      ];

      let cx = 36;
      row.forEach((cell, i) => {
        doc.text(cell, cx, doc.y + 2, { width: colWidths[i], align: i <= 1 ? 'left' : 'right' });
        cx += colWidths[i];
      });
      doc.moveDown(0.6);
    });

    doc.moveDown(0.2);
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor('#ddd').stroke();
    doc.strokeColor('#000');
    doc.moveDown(0.4);

    const labelX = 36 + colWidths.slice(0, 5).reduce((a, b) => a + b, 0);
    const valueX = 36 + colWidths.slice(0, 6).reduce((a, b) => a + b, 0);

    doc.fontSize(10);
    doc.text('Tot. Mora:', labelX, doc.y, { width: colWidths[5], align: 'right' });
    doc.text(fmtARS(totalMora), valueX, doc.y, { width: colWidths[6], align: 'right' });
    doc.moveDown(0.2);
    doc.text('Tot. Principal pendiente:', labelX, doc.y, { width: colWidths[5], align: 'right' });
    doc.text(fmtARS(totalPrincipalPend), valueX, doc.y, { width: colWidths[6], align: 'right' });

    doc.moveDown(1);
    doc.fontSize(9).fillColor('#666')
      .text(
        'Nota: Esta ficha es informativa. Los importes pueden variar según pagos registrados y recálculos de mora.',
        { align: 'left' }
      );

    doc.end();
  } catch (error) {
    console.error('[imprimirFichaCredito]', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Error al generar la ficha del crédito' });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
};