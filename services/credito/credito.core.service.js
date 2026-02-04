// financiera-backend/services/credito/credito.core.service.js
// Service principal de créditos (común/progresivo + orquestación). La lógica LIBRE y el PDF fueron extraídos.

import Cuota from '../../models/Cuota.js';
import Usuario from '../../models/Usuario.js';
import Zona from '../../models/Zona.js';
import TareaPendiente from '../../models/Tarea_pendiente.js';

import {
  addDays,
  format,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  addMonths
} from 'date-fns';

import { buildFilters } from '../../utils/buildFilters.js';
import { Credito, Cliente } from '../../models/associations.js';
import { Op } from 'sequelize';

import Pago from '../../models/Pago.js';
import Recibo from '../../models/Recibo.js';
import FormaPago from '../../models/FormaPago.js';

import CajaMovimiento from '../../models/CajaMovimiento.js';
import {
  MORA_DIARIA,
  LIBRE_MAX_CICLOS,
  LIBRE_VTO_FICTICIO,
  todayYMD,
  nowTime,
  toNumber,
  fix2,
  ymd,
  ymdDate,
  fmtARS,
  labelModalidad,
  normalizePercent,
  percentToDecimal,
  periodLengthFromTipo,
  calcularInteresProporcionalMin60,
  esLibre,
  anexarFlagsRefinanciacionPlain,
  createReciboSafe,
  registrarEgresoDesembolsoCredito,
  registrarIngresoDesdeReciboEnTx
} from './credito.utils.js';

import {
  obtenerFechasCiclosLibre,
  verificarTopeCiclosLibre,
  calcularMoraLibre,
  calcularInteresCicloLibre,
  calcularImporteCuotaLibre,
  refrescarCuotaLibre,
  obtenerTotalHoyLibreExacto,
  cancelarCreditoLibre,
  cicloLibreActual,
  // ✅ Usar resumen normalizado desde credito.libre.service.js (que a su vez usa cuota.libre.service.js como fuente de verdad)
  obtenerResumenLibre
} from './credito.libre.service.js';

import { refinanciarCredito as refinanciarCreditoImpl } from './credito.refinanciacion.service.js';

/* =============================================================================
   ✅ Helpers internos (normalización de estado)
   ============================================================================= */

const normalizeStr = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // quita diacríticos

const esEstadoAnulado = (estado) => {
  const e = normalizeStr(estado);
  return e === 'anulado' || e === 'anulada' || e.startsWith('anul');
};

/* =============================================================================
   ✅ Caja: helpers de limpieza (desembolso) al ANULAR/ELIMINAR
   ============================================================================= */

/**
 * Elimina SOLO el movimiento de caja del desembolso (egreso) asociado al crédito.
 * No toca ingresos por recibos ni otros movimientos no-egreso.
 */
const eliminarEgresoDesembolsoCajaEnTx = async ({ creditoId, t }) => {
  if (!creditoId) return;

  await CajaMovimiento.destroy({
    where: {
      referencia_tipo: 'credito',
      referencia_id: creditoId,
      tipo: 'egreso'
    },
    ...(t && { transaction: t })
  });
};

/* ===================== TOTAL ACTUAL (campo calculado) ===================== */
/**
 * Calcula el total actual del crédito (sin tocar DB):
 * - LIBRE: fallback (capital + interés estimado + mora en cuota)
 * - COMÚN/PROGRESIVO: suma por cuotas pendientes/parcial/vencidas:
 *    (importe - descuento - pagado) + intereses_vencidos_acumulados (mora).
 */
const calcularTotalActualCreditoPlain = (creditoPlain) => {
  if (!creditoPlain) return 0;

  if (String(creditoPlain.modalidad_credito) === 'libre') {
    const cuota = Array.isArray(creditoPlain.cuotas) ? creditoPlain.cuotas[0] : null;
    const mora = fix2(toNumber(cuota?.intereses_vencidos_acumulados));
    const interesCiclo = fix2(calcularInteresCicloLibre(creditoPlain));
    const capital = fix2(toNumber(creditoPlain.saldo_actual));
    return fix2(capital + interesCiclo + mora);
  }

  // común/progresivo
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

/* ===================== Normalización de fechas (soporta "créditos anteriores") ===================== */
const isValidYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(s));

/**
 * Reglas:
 * - fecha_acreditacion = fecha del DESEMBOLSO (Caja)
 * - fecha_compromiso_pago = ancla de vencimientos/ciclos
 *
 * Soporte "créditos anteriores":
 * - Si es_credito_anterior === true:
 *    - exige fecha_compromiso_pago (YMD)
 *    - si no viene fecha_acreditacion, la iguala a fecha_compromiso_pago (desembolso histórico)
 *    - fecha_solicitud default = fecha_acreditacion
 *
 * Compat (sin flag):
 * - Si NO viene fecha_acreditacion y viene fecha_compromiso_pago < hoy => asumimos crédito anterior
 *   y seteamos fecha_acreditacion = fecha_compromiso_pago (así caja queda histórica y no rompe ciclos).
 *
 * Validación:
 * - fecha_compromiso_pago NO puede ser anterior a fecha_acreditacion (inconsistente).
 */
const normalizarFechasCredito = ({
  fecha_acreditacion,
  fecha_compromiso_pago,
  fecha_solicitud,
  es_credito_anterior = false
} = {}) => {
  const hoy = todayYMD();

  const compromisoRaw = isValidYMD(fecha_compromiso_pago) ? String(fecha_compromiso_pago) : null;
  const acreditRaw = isValidYMD(fecha_acreditacion) ? String(fecha_acreditacion) : null;
  const solicitudRaw = isValidYMD(fecha_solicitud) ? String(fecha_solicitud) : null;

  let fechaAcreditacionFinal = acreditRaw;
  let fechaCompromisoFinal = compromisoRaw;

  if (es_credito_anterior === true) {
    if (!fechaCompromisoFinal) {
      const err = new Error('Para un crédito anterior es obligatorio indicar fecha_compromiso_pago (YYYY-MM-DD).');
      err.status = 400;
      err.code = 'FECHA_COMPROMISO_REQUERIDA';
      throw err;
    }
    if (!fechaAcreditacionFinal) {
      fechaAcreditacionFinal = fechaCompromisoFinal;
    }
  } else {
    if (!fechaAcreditacionFinal) {
      // Heurística compat: si compromiso es pasado y no viene acreditación, lo tratamos como crédito anterior
      if (fechaCompromisoFinal && String(fechaCompromisoFinal) < String(hoy)) {
        fechaAcreditacionFinal = fechaCompromisoFinal;
      } else {
        fechaAcreditacionFinal = hoy;
      }
    }
  }

  if (!fechaCompromisoFinal) {
    fechaCompromisoFinal = fechaAcreditacionFinal;
  }

  // Validación de consistencia
  if (String(fechaCompromisoFinal) < String(fechaAcreditacionFinal)) {
    const err = new Error(
      `Fechas inconsistentes: fecha_compromiso_pago (${fechaCompromisoFinal}) no puede ser anterior a fecha_acreditacion (${fechaAcreditacionFinal}).`
    );
    err.status = 400;
    err.code = 'FECHAS_INCONSISTENTES';
    throw err;
  }

  const fechaSolicitudFinal = solicitudRaw || fechaAcreditacionFinal;

  return {
    fecha_solicitud: fechaSolicitudFinal,
    fecha_acreditacion: fechaAcreditacionFinal,
    fecha_compromiso_pago: fechaCompromisoFinal
  };
};

/* ===================== Generación de cuotas ===================== */
const generarCuotasServicio = async (credito, t = null) => {
  const {
    id: credito_id,
    cantidad_cuotas: n,
    tipo_credito,
    monto_total_devolver: M,
    modalidad_credito,
    fecha_compromiso_pago
  } = credito.get ? credito.get({ plain: true }) : credito;

  // Caso LIBRE → 1 cuota abierta
  if (modalidad_credito === 'libre') {
    await Cuota.destroy({ where: { credito_id }, ...(t && { transaction: t }) }); // limpieza defensiva

    const hoyYMD = todayYMD();

    // ✅ Importante para "créditos anteriores":
    // No bloqueamos la CREACIÓN por tope superado; el sistema debe poder registrar el crédito.
    // El tope se aplicará en operaciones (pago parcial en ciclo 3, etc.).
    try {
      verificarTopeCiclosLibre(credito, hoyYMD);
    } catch (e) {
      if (e?.code !== 'LIBRE_TOPE_3_CICLOS_SUPERADO') throw e;
    }

    const importe = calcularImporteCuotaLibre(credito);

    // ✅ Resumen normalizado (fuente de verdad: cuota.libre.service.js vía credito.libre.service.js)
    let resumen = null;
    try {
      resumen = await obtenerResumenLibre(credito_id, ymdDate(hoyYMD));
    } catch (_e) {
      resumen = null;
    }

    // ✅ En la cuota guardamos "mora HOY" (solo ciclo actual), no el acumulado de todos los ciclos.
    const moraLibre = fix2(
      resumen?.mora_pendiente_hoy ??
        resumen?.mora_ciclo_hoy ??
        calcularMoraLibre(credito, ymdDate(hoyYMD))
    );

    const ciclos = obtenerFechasCiclosLibre(credito);
    const cicloActual = Math.min(Math.max(toNumber(resumen?.ciclo_actual || 1), 1), LIBRE_MAX_CICLOS);
    const vtoCicloYMD =
      cicloActual === 1
        ? ciclos?.vencimiento_ciclo_1
        : cicloActual === 2
          ? ciclos?.vencimiento_ciclo_2
          : ciclos?.vencimiento_ciclo_3;

    const diasAtraso =
      vtoCicloYMD && String(hoyYMD) > String(vtoCicloYMD)
        ? Math.max(differenceInCalendarDays(ymdDate(hoyYMD), ymdDate(vtoCicloYMD)), 0)
        : 0;

    const estado = diasAtraso > 0 ? 'vencida' : 'pendiente';

    await Cuota.create(
      {
        credito_id,
        numero_cuota: 1,
        importe_cuota: fix2(importe),
        fecha_vencimiento: LIBRE_VTO_FICTICIO,
        estado,
        forma_pago_id: null,
        descuento_cuota: 0.0,
        intereses_vencidos_acumulados: fix2(moraLibre),
        monto_pagado_acumulado: 0.0
      },
      t ? { transaction: t } : undefined
    );
    return;
  }

  // —— comun / progresivo ——
  let cuotasArr = [];
  if (modalidad_credito === 'progresivo') {
    const sum = (n * (n + 1)) / 2;
    let acumulado = 0;
    for (let i = 1; i <= n; i++) {
      const importe = parseFloat((M * (i / sum)).toFixed(2));
      cuotasArr.push({ numero_cuota: i, importe_cuota: importe });
      acumulado += importe;
    }
    const diff = parseFloat((M - acumulado).toFixed(2));
    cuotasArr[n - 1].importe_cuota = parseFloat((cuotasArr[n - 1].importe_cuota + diff).toFixed(2));
  } else {
    const fija = parseFloat((M / n).toFixed(2));
    for (let i = 1; i <= n; i++) {
      cuotasArr.push({ numero_cuota: i, importe_cuota: fija });
    }
    const totalCalc = fija * n;
    const diff = parseFloat((M - totalCalc).toFixed(2));
    cuotasArr[n - 1].importe_cuota = parseFloat((cuotasArr[n - 1].importe_cuota + diff).toFixed(2));
  }

  // Fecha base = fecha_compromiso_pago (debe ser el 1er vencimiento)
  const [year, month, day] = fecha_compromiso_pago.split('-').map((x) => parseInt(x, 10));
  const fechaBase = new Date(year, month - 1, day);

  // Crear registros
  const bulk = cuotasArr.map(({ numero_cuota, importe_cuota }) => {
    // ✅ Regla: la fecha elegida ES el primer vencimiento
    // cuota 1 => fechaBase
    // cuota i => fechaBase + (i-1) períodos
    let venc;

    if (tipo_credito === 'mensual') {
      venc = addMonths(fechaBase, Math.max(numero_cuota - 1, 0));
    } else {
      const dias = tipo_credito === 'semanal' ? 7 : tipo_credito === 'quincenal' ? 15 : 30;
      venc = addDays(fechaBase, dias * Math.max(numero_cuota - 1, 0));
    }

    return {
      credito_id,
      numero_cuota,
      importe_cuota,
      fecha_vencimiento: format(venc, 'yyyy-MM-dd'),
      estado: 'pendiente',
      forma_pago_id: null,
      descuento_cuota: 0.0,
      intereses_vencidos_acumulados: 0.0,
      monto_pagado_acumulado: 0.0
    };
  });

  await Cuota.bulkCreate(bulk, t ? { transaction: t } : undefined);
};

/* ===================== Descuento SOLO sobre interés (helper único) ===================== */
/**
 * Regla: descuento (si aplica) SOLO sobre el interés, nunca sobre el capital.
 * - descuento solo permitido para rol_id === 0 (superadmin)
 * - clamp 0..100
 */
const aplicarDescuentoSoloInteres = ({ capital, interestPct, descuento, rol_id }) => {
  const cap = fix2(toNumber(capital));
  const pctInteres = normalizePercent(interestPct, 0);

  const interesMontoBase = Number((cap * (pctInteres / 100)).toFixed(2));
  let interesMontoFinal = interesMontoBase;

  let descuentoPct = 0;
  if (rol_id === 0 && toNumber(descuento) > 0) {
    // normalizePercent ya clampa 0..100
    descuentoPct = normalizePercent(descuento, 0);
    const discInteresMonto = Number(((interesMontoBase * descuentoPct) / 100).toFixed(2));
    interesMontoFinal = Number((interesMontoBase - discInteresMonto).toFixed(2));
    if (interesMontoFinal < 0) interesMontoFinal = 0;
  }

  const total = Number((cap + interesMontoFinal).toFixed(2));

  return {
    capital: cap,
    interestPct: pctInteres,
    interesMontoBase,
    interesMontoFinal,
    descuentoPct,
    total
  };
};

/* ===================== Simulación de plan (Cotizador) ===================== */
export const simularPlanCredito = (data = {}) => {
  const {
    monto_acreditar,
    tipo_credito,
    cantidad_cuotas,
    modalidad_credito = 'comun',
    descuento = 0,
    rol_id = null,
    interes: interesInput,
    fecha_compromiso_pago,
    origen_venta_manual_financiada = false
  } = data;

  const capital = toNumber(monto_acreditar);
  const n = Math.max(toNumber(cantidad_cuotas), 1);

  if (!capital || capital <= 0) {
    throw new Error('Monto a acreditar inválido para simulación.');
  }
  if (!tipo_credito) {
    throw new Error('Tipo de crédito requerido para simulación.');
  }

  const modalidadStr = String(modalidad_credito || 'comun').toLowerCase();
  if (modalidadStr === 'libre') {
    throw new Error('La simulación de modalidad LIBRE no está soportada desde este servicio.');
  }

  // === Interés ===
  let interestPct;
  if (origen_venta_manual_financiada && typeof interesInput !== 'undefined') {
    interestPct = normalizePercent(interesInput);
  } else {
    interestPct = calcularInteresProporcionalMin60(tipo_credito, n);
  }

  // ✅ Total = capital + interés (descuento SOLO sobre interés)
  const calc = aplicarDescuentoSoloInteres({
    capital,
    interestPct,
    descuento,
    rol_id
  });

  const M = calc.total;

  // === Cuotas ===
  let cuotasArr = [];
  if (modalidadStr === 'progresivo') {
    const sum = (n * (n + 1)) / 2;
    let acumulado = 0;
    for (let i = 1; i <= n; i++) {
      const importe = parseFloat((M * (i / sum)).toFixed(2));
      cuotasArr.push({ numero_cuota: i, importe_cuota: importe });
      acumulado += importe;
    }
    const diff = parseFloat((M - acumulado).toFixed(2));
    cuotasArr[n - 1].importe_cuota = parseFloat((cuotasArr[n - 1].importe_cuota + diff).toFixed(2));
  } else {
    const fija = parseFloat((M / n).toFixed(2));
    for (let i = 1; i <= n; i++) {
      cuotasArr.push({ numero_cuota: i, importe_cuota: fija });
    }
    const totalCalc = fija * n;
    const diff = parseFloat((M - totalCalc).toFixed(2));
    cuotasArr[n - 1].importe_cuota = parseFloat((cuotasArr[n - 1].importe_cuota + diff).toFixed(2));
  }

  // === Fechas de vencimiento ===
  const baseStr = fecha_compromiso_pago || todayYMD();
  let fechaBase;
  try {
    const [year, month, day] = String(baseStr).split('-').map((x) => parseInt(x, 10));
    fechaBase = new Date(year, month - 1, day);
  } catch {
    fechaBase = new Date();
  }

  const cuotasSimuladas = cuotasArr.map(({ numero_cuota, importe_cuota }) => {
    // ✅ Regla: la fecha elegida ES el primer vencimiento
    let venc;

    if (tipo_credito === 'mensual') {
      venc = addMonths(fechaBase, Math.max(numero_cuota - 1, 0));
    } else {
      const dias = tipo_credito === 'semanal' ? 7 : tipo_credito === 'quincenal' ? 15 : 30;
      venc = addDays(fechaBase, dias * Math.max(numero_cuota - 1, 0));
    }

    return {
      numero_cuota,
      importe_cuota: fix2(importe_cuota),
      fecha_vencimiento: format(venc, 'yyyy-MM-dd')
    };
  });

  return {
    modalidad_credito: modalidadStr,
    tipo_credito,
    cantidad_cuotas: n,
    monto_acreditar: fix2(capital),
    interes_pct: calc.interestPct,
    descuento_pct: calc.descuentoPct,
    monto_total_devolver: fix2(M),
    cuotas: cuotasSimuladas
  };
};

/* ===================== Precálculo para CRÉDITOS ANTIGUOS ===================== */
const marcarVencidasYCalcularMora = async (
  creditoId,
  { sumarSoloVencidas = true, fechaCorte } = {}
) => {
  const credito = await Credito.findByPk(creditoId);
  if (!credito || esLibre(credito)) return;

  const hoy = fechaCorte ? ymdDate(fechaCorte) : ymdDate(todayYMD());
  const hoyY = ymd(hoy);

  const cuotas = await Cuota.findAll({ where: { credito_id: creditoId } });
  for (const c of cuotas) {
    const fv = c.fecha_vencimiento;
    if (!fv) continue;

    const estado = String(c.estado || '').toLowerCase();
    const fvY = ymd(fv);

    // 🛡️ No tocamos cuotas cerradas / derivadas
    if (['pagada', 'refinanciada', 'anulada'].includes(estado)) {
      continue;
    }

    if (fvY < hoyY) {
      const dias = Math.max(differenceInCalendarDays(ymdDate(hoy), ymdDate(fv)), 0);
      const mora = fix2(toNumber(c.importe_cuota) * MORA_DIARIA * dias);
      await c.update({
        estado: 'vencida',
        intereses_vencidos_acumulados: mora
      });
    } else if (fvY === hoyY) {
      if (!sumarSoloVencidas && toNumber(c.intereses_vencidos_acumulados) !== 0) {
        await c.update({ intereses_vencidos_acumulados: 0 });
      }
      if (estado === 'vencida') {
        await c.update({ estado: 'pendiente' });
      }
    } else if (!sumarSoloVencidas) {
      if (toNumber(c.intereses_vencidos_acumulados) !== 0) {
        await c.update({ intereses_vencidos_acumulados: 0 });
      }
    }
  }
};

/* ===================== Listado / detalle ===================== */
export const obtenerCreditos = async (query, { rol_id = null } = {}) => {
  if (rol_id !== null && rol_id !== 0 && rol_id !== 1) {
    const err = new Error('No tenés permisos para ver créditos.');
    err.status = 403;
    throw err;
  }

  const where = buildFilters(query, ['cliente_id', 'estado', 'interes', 'monto']);
  return Credito.findAll({
    where,
    include: [
      { model: Cliente, as: 'cliente', attributes: ['id', 'nombre', 'apellido'] },
      { model: Cuota, as: 'cuotas', separate: true, order: [['numero_cuota', 'ASC']] }
    ],
    order: [['id', 'DESC']]
  });
};

export const obtenerCreditoPorId = async (id, { rol_id = null } = {}) => {
  const pk = Number(id);
  if (!Number.isFinite(pk)) return null;

  if (rol_id !== null && rol_id !== 0 && rol_id !== 1) {
    const err = new Error('No tenés permisos para ver créditos.');
    err.status = 403;
    throw err;
  }

  const includeOpts = [
    { model: Cliente, as: 'cliente' },
    { model: Cuota, as: 'cuotas', separate: true, order: [['numero_cuota', 'ASC']] },
    { model: Usuario, as: 'cobradorCredito', attributes: ['id', 'nombre_completo'] }
  ];

  // 1) Leemos el crédito con todas las relaciones
  let cred = await Credito.findByPk(pk, { include: includeOpts });
  if (!cred) return null;

  // 2) Recalcular en función de modalidad (protegido con try/catch)
  try {
    if (esLibre(cred)) {
      await refrescarCuotaLibre(pk);
    } else {
      await marcarVencidasYCalcularMora(pk, {
        sumarSoloVencidas: true,
        fechaCorte: todayYMD()
      });

      try {
        const { recalcularMoraPorCredito } = await import('../cuota.service.js');
        await recalcularMoraPorCredito(pk);
      } catch (e2) {
        console.error('[obtenerCreditoPorId] Error al recalcular mora por crédito:', e2?.message || e2);
      }

      await actualizarEstadoCredito(pk);
    }

    const refetched = await Credito.findByPk(pk, { include: includeOpts });
    if (refetched) {
      cred = refetched;
    }
  } catch (e) {
    console.error('[obtenerCreditoPorId] Error al recalcular crédito:', e?.message || e);
  }

  // 3) total_actual calculado + fechas de ciclos + resumen para LIBRE
  const plain = cred.get({ plain: true });

  let totalActual = 0;

  if (esLibre(plain)) {
    const hoyYMD = todayYMD();

    // ✅ Resumen normalizado (con separación *_total vs *_hoy y total_ciclo_hoy)
    let resumen = null;
    try {
      resumen = await obtenerResumenLibre(pk, ymdDate(hoyYMD));
    } catch (_e) {
      resumen = null;
    }

    if (resumen) {
      cred.setDataValue('resumen_libre', resumen);

      // ✅ aplanado (evita adivinanzas en front)
      cred.setDataValue('saldo_capital', resumen.saldo_capital);
      cred.setDataValue('interes_pendiente_total', resumen.interes_pendiente_total);
      cred.setDataValue('mora_pendiente_total', resumen.mora_pendiente_total);
      cred.setDataValue('interes_pendiente_hoy', resumen.interes_pendiente_hoy);
      cred.setDataValue('mora_pendiente_hoy', resumen.mora_pendiente_hoy);
      cred.setDataValue('ciclo_actual', resumen.ciclo_actual);

      // ✅ totales (contrato consistente)
      cred.setDataValue('total_liquidacion_hoy', resumen.total_liquidacion_hoy); // acumulado 1..ciclo_actual
      cred.setDataValue('total_ciclo_hoy', resumen.total_ciclo_hoy); // solo ciclo actual

      // ✅ acumulados auditables
      if (typeof resumen.interes_cobrado_historico !== 'undefined') {
        cred.setDataValue('interes_cobrado_historico', resumen.interes_cobrado_historico);
      }
      if (typeof resumen.intereses_acumulados !== 'undefined') {
        cred.setDataValue('intereses_acumulados', resumen.intereses_acumulados);
      }

      // ✅ FIX CLAVE: interes_acumulado expuesto al front = devengado (cobrado + pendiente total)
      if (typeof resumen.intereses_acumulados !== 'undefined') {
        cred.setDataValue('interes_acumulado', fix2(toNumber(resumen.intereses_acumulados)));
      } else if (typeof resumen.interes_cobrado_historico !== 'undefined') {
        cred.setDataValue('interes_acumulado', fix2(toNumber(resumen.interes_cobrado_historico)));
      }

      // ✅ total_actual: total “al día” (capital + interés_total + mora_total)
      totalActual = fix2(toNumber(resumen.total_liquidacion_hoy));
      cred.setDataValue('total_actual', totalActual);

      // ✅ saldo_total_actual (compat/UI): para LIBRE debe ser TOTAL DEL CICLO (HOY)
      cred.setDataValue('saldo_total_actual', fix2(toNumber(resumen.total_ciclo_hoy)));
    } else {
      // fallback: intenta helper existente y luego plain
      try {
        totalActual = await obtenerTotalHoyLibreExacto(pk, ymdDate(hoyYMD));
      } catch (e) {
        totalActual = calcularTotalActualCreditoPlain(plain);
        console.error('[obtenerCreditoPorId] Fallback total_actual LIBRE:', e?.message || e);
      }

      cred.setDataValue('total_actual', fix2(toNumber(totalActual)));
      cred.setDataValue('saldo_total_actual', fix2(toNumber(totalActual)));
    }
  } else {
    totalActual = calcularTotalActualCreditoPlain(plain);

    // ✅ compat/UI: para no-LIBRE, “saldo_total_actual” = total_actual calculado
    cred.setDataValue('saldo_total_actual', fix2(toNumber(totalActual)));
    cred.setDataValue('total_actual', fix2(toNumber(totalActual)));
  }

  if (esLibre(plain)) {
    const ciclos = obtenerFechasCiclosLibre(plain);
    if (ciclos) {
      cred.setDataValue('fechas_ciclos_libre', ciclos);
    }
  }

  // ✅ Flags refinanciación para UI (R roja / R verde)
  try {
    let hijoId = null;
    if (String(plain.estado || '').toLowerCase() === 'refinanciado') {
      const hijo = await Credito.findOne({
        where: { id_credito_origen: plain.id },
        attributes: ['id', 'id_credito_origen'],
        order: [['id', 'DESC']],
        raw: true
      });
      hijoId = hijo?.id ?? null;
    }

    const plainTagged = anexarFlagsRefinanciacionPlain({ ...plain }, hijoId);

    cred.setDataValue('credito_origen_id', plainTagged.credito_origen_id);
    cred.setDataValue('es_credito_de_refinanciacion', plainTagged.es_credito_de_refinanciacion);
    cred.setDataValue('es_refinanciado', plainTagged.es_refinanciado);
    cred.setDataValue('credito_refinanciado_hacia_id', plainTagged.credito_refinanciado_hacia_id);
  } catch (e) {
    console.error('[obtenerCreditoPorId] No se pudieron anexar flags de refinanciación:', e?.message || e);
    cred.setDataValue('credito_origen_id', plain.id_credito_origen ?? null);
    cred.setDataValue('es_credito_de_refinanciacion', Boolean(plain.id_credito_origen));
    cred.setDataValue('es_refinanciado', String(plain.estado || '').toLowerCase() === 'refinanciado');
    cred.setDataValue('credito_refinanciado_hacia_id', null);
  }

  return cred;
};

/* ===================== Crear / Actualizar ===================== */
export const crearCredito = async (data, options = {}) => {
  const t = options?.transaction || null;

  const {
    cliente_id,
    cobrador_id,
    monto_acreditar,
    fecha_acreditacion,
    fecha_compromiso_pago,
    fecha_solicitud,
    tipo_credito,
    cantidad_cuotas,
    modalidad_credito = 'comun',
    descuento = 0,
    rol_id = null,
    interes: interesInput,
    origen_venta_manual_financiada = false,
    detalle_producto = null,
    recalcular_hasta_hoy = true,
    sumar_interes_solo_vencidas = true,
    fecha_corte = null,
    usuario_id = null,

    // ✅ Nuevo (opcional): permite marcar explícitamente "carga de crédito anterior"
    es_credito_anterior = false
  } = data;

  // Normalización + validación de fechas (incluye soporte de "créditos anteriores")
  const {
    fecha_solicitud: fechaSolicitudFinal,
    fecha_acreditacion: fechaAcreditacionFinal,
    fecha_compromiso_pago: fechaCompromisoFinal
  } = normalizarFechasCredito({
    fecha_acreditacion,
    fecha_compromiso_pago,
    fecha_solicitud,
    es_credito_anterior
  });

  // —— Modalidad LIBRE ——
  if (modalidad_credito === 'libre') {
    // ✅ Regla negocio: en LIBRE, si no se especifica tasa, por defecto es 60% por ciclo.
    const tasaPorCicloPct = normalizePercent(interesInput, 60);

    const nuevo = await Credito.create(
      {
        cliente_id,
        cobrador_id,
        monto_acreditar,
        fecha_solicitud: fechaSolicitudFinal,
        fecha_acreditacion: fechaAcreditacionFinal, // ✅ caja (desembolso) — ahora soporta histórico
        fecha_compromiso_pago: fechaCompromisoFinal, // ✅ ancla ciclo/vencimientos
        interes: tasaPorCicloPct,
        tipo_credito: 'mensual',
        cantidad_cuotas: 1,
        modalidad_credito,
        descuento: 0,
        monto_total_devolver: fix2(monto_acreditar),
        saldo_actual: fix2(monto_acreditar),
        interes_acumulado: 0.0,
        origen_venta_manual_financiada,
        detalle_producto
      },
      t ? { transaction: t } : undefined
    );

    // ✅ Importante para "créditos anteriores": no bloqueamos creación si supera el tope.
    try {
      verificarTopeCiclosLibre(nuevo, todayYMD());
    } catch (e) {
      if (e?.code !== 'LIBRE_TOPE_3_CICLOS_SUPERADO') throw e;
    }

    await generarCuotasServicio(nuevo, t || null);

    if (!origen_venta_manual_financiada) {
      try {
        const cli = await Cliente.findByPk(cliente_id, t ? { transaction: t } : undefined);
        const clienteNombre = cli ? `${cli.nombre} ${cli.apellido}` : null;
        await registrarEgresoDesembolsoCredito(
          {
            creditoId: nuevo.id,
            clienteNombre,
            fecha_acreditacion: fechaAcreditacionFinal, // ✅ caja histórica si corresponde
            monto: monto_acreditar,
            usuario_id
          },
          { t }
        );
      } catch (e) {
        console.error('[Caja][Desembolso libre] No se pudo registrar movimiento:', e?.message || e);
      }
    }

    return nuevo.id;
  }

  // —— común / progresivo ——
  let interestPct;
  if (origen_venta_manual_financiada && typeof interesInput !== 'undefined') {
    interestPct = normalizePercent(interesInput);
  } else {
    interestPct = calcularInteresProporcionalMin60(tipo_credito, cantidad_cuotas);
  }

  const capital = toNumber(monto_acreditar);

  // ✅ Total = capital + interés (descuento SOLO sobre interés)
  const calc = aplicarDescuentoSoloInteres({
    capital,
    interestPct,
    descuento,
    rol_id
  });

  const nuevo = await Credito.create(
    {
      cliente_id,
      cobrador_id,
      monto_acreditar: calc.capital,
      fecha_solicitud: fechaSolicitudFinal,
      fecha_acreditacion: fechaAcreditacionFinal, // ✅ caja (desembolso) — ahora soporta histórico
      fecha_compromiso_pago: fechaCompromisoFinal, // ✅ ancla vencimientos
      interes: calc.interestPct,
      tipo_credito,
      cantidad_cuotas,
      modalidad_credito,
      descuento: calc.descuentoPct,
      monto_total_devolver: calc.total,
      saldo_actual: calc.total,
      interes_acumulado: 0.0,
      origen_venta_manual_financiada,
      detalle_producto
    },
    t ? { transaction: t } : undefined
  );

  await generarCuotasServicio(nuevo, t || null);

  if (recalcular_hasta_hoy !== false) {
    await marcarVencidasYCalcularMora(nuevo.id, {
      sumarSoloVencidas: sumar_interes_solo_vencidas !== false,
      fechaCorte: fecha_corte || todayYMD()
    });
  }

  try {
    await actualizarEstadoCredito(nuevo.id);
  } catch (e) {
    console.error('[crearCredito] No se pudo actualizar estado del crédito:', e?.message || e);
  }

  if (!origen_venta_manual_financiada) {
    try {
      const cli = await Cliente.findByPk(cliente_id, t ? { transaction: t } : undefined);
      const clienteNombre = cli ? `${cli.nombre} ${cli.apellido}` : null;
      await registrarEgresoDesembolsoCredito(
        {
          creditoId: nuevo.id,
          clienteNombre,
          fecha_acreditacion: fechaAcreditacionFinal, // ✅ caja histórica si corresponde
          monto: calc.capital,
          usuario_id
        },
        { t }
      );
    } catch (e) {
      console.error('[Caja][Desembolso común/progresivo] No se pudo registrar movimiento:', e?.message || e);
    }
  }

  return nuevo.id;
};

export const actualizarCredito = async (id, data) => {
  const existente = await Credito.findByPk(id);
  if (!existente) throw new Error('Crédito no encontrado');

  const {
    monto_acreditar,
    fecha_acreditacion,
    fecha_compromiso_pago,
    fecha_solicitud,
    tipo_credito,
    cantidad_cuotas,
    modalidad_credito = existente.modalidad_credito,
    descuento = existente.descuento,
    rol_id = null,
    interes: interesInput,
    origen_venta_manual_financiada = existente.origen_venta_manual_financiada,
    detalle_producto = existente.detalle_producto,
    recalcular_hasta_hoy = true,
    sumar_interes_solo_vencidas = true,
    fecha_corte = null
  } = data;

  // —— LIBRE ——
  if (modalidad_credito === 'libre') {
    const tasaPorCicloPct = normalizePercent(
      typeof interesInput !== 'undefined' ? interesInput : existente.interes,
      0
    );
    const capital = toNumber(typeof monto_acreditar !== 'undefined' ? monto_acreditar : existente.monto_acreditar);

    // Normalización defensiva (sin flag aquí; en update exigimos coherencia si el usuario cambia fechas)
    const fechaAcreditacionFinal = fecha_acreditacion || existente.fecha_acreditacion || todayYMD();
    const fechaCompromisoFinal = fecha_compromiso_pago || existente.fecha_compromiso_pago || fechaAcreditacionFinal;
    const fechaSolicitudFinal = fecha_solicitud || existente.fecha_solicitud || fechaAcreditacionFinal;

    if (String(fechaCompromisoFinal) < String(fechaAcreditacionFinal)) {
      const err = new Error(
        `Fechas inconsistentes: fecha_compromiso_pago (${fechaCompromisoFinal}) no puede ser anterior a fecha_acreditacion (${fechaAcreditacionFinal}).`
      );
      err.status = 400;
      err.code = 'FECHAS_INCONSISTENTES';
      throw err;
    }

    await Credito.update(
      {
        monto_acreditar: capital,
        fecha_solicitud: fechaSolicitudFinal,
        fecha_acreditacion: fechaAcreditacionFinal, // ✅ caja
        fecha_compromiso_pago: fechaCompromisoFinal, // ✅ ancla
        interes: tasaPorCicloPct,
        tipo_credito: 'mensual',
        cantidad_cuotas: 1,
        modalidad_credito,
        descuento: 0,
        monto_total_devolver: fix2(capital),
        origen_venta_manual_financiada,
        detalle_producto
      },
      { where: { id } }
    );

    await refrescarCuotaLibre(id);
    return;
  }

  // —— común / progresivo ——
  const nuevoTipo = tipo_credito || existente.tipo_credito;
  const nuevasCuotas = cantidad_cuotas || existente.cantidad_cuotas;

  let interestPct;
  if (origen_venta_manual_financiada && typeof interesInput !== 'undefined') {
    interestPct = normalizePercent(interesInput);
  } else {
    interestPct = calcularInteresProporcionalMin60(nuevoTipo, nuevasCuotas);
  }

  const capitalBase = toNumber(monto_acreditar ?? existente.monto_acreditar);

  // ✅ Total = capital + interés (descuento SOLO sobre interés)
  const calc = aplicarDescuentoSoloInteres({
    capital: capitalBase,
    interestPct,
    descuento,
    rol_id
  });

  const fechaAcreditacionFinal = fecha_acreditacion || existente.fecha_acreditacion || todayYMD();
  const fechaCompromisoFinal = fecha_compromiso_pago || existente.fecha_compromiso_pago || fechaAcreditacionFinal;
  const fechaSolicitudFinal = fecha_solicitud || existente.fecha_solicitud || fechaAcreditacionFinal;

  if (String(fechaCompromisoFinal) < String(fechaAcreditacionFinal)) {
    const err = new Error(
      `Fechas inconsistentes: fecha_compromiso_pago (${fechaCompromisoFinal}) no puede ser anterior a fecha_acreditacion (${fechaAcreditacionFinal}).`
    );
    err.status = 400;
    err.code = 'FECHAS_INCONSISTENTES';
    throw err;
  }

  await Credito.update(
    {
      monto_acreditar: calc.capital,
      fecha_solicitud: fechaSolicitudFinal,
      fecha_acreditacion: fechaAcreditacionFinal, // ✅ caja
      fecha_compromiso_pago: fechaCompromisoFinal, // ✅ ancla vencimientos
      interes: calc.interestPct,
      tipo_credito: nuevoTipo,
      cantidad_cuotas: nuevasCuotas,
      modalidad_credito,
      descuento: calc.descuentoPct,
      monto_total_devolver: calc.total,
      saldo_actual: calc.total,
      interes_acumulado: 0.0,
      origen_venta_manual_financiada,
      detalle_producto
    },
    { where: { id } }
  );

  await Cuota.destroy({ where: { credito_id: id } });
  const actualizado = await Credito.findByPk(id);
  await generarCuotasServicio(actualizado);

  if (recalcular_hasta_hoy !== false) {
    await marcarVencidasYCalcularMora(actualizado.id, {
      sumarSoloVencidas: sumar_interes_solo_vencidas !== false,
      fechaCorte: fecha_corte || todayYMD()
    });
  }

  try {
    await actualizarEstadoCredito(actualizado.id);
  } catch (e) {
    console.error('[actualizarCredito] No se pudo actualizar estado del crédito:', e?.message || e);
  }
};

/* ===================== Estado del crédito (no cambia para libre/refinanciado/anulado) ===================== */
export async function actualizarEstadoCredito(credito_id, transaction = null) {
  const credito = await Credito.findByPk(credito_id, transaction ? { transaction } : undefined);
  if (!credito) return;

  const estadoActual = normalizeStr(credito.estado);

  // ✅ No tocar estado si ya fue refinanciado
  if (estadoActual === 'refinanciado') {
    return;
  }

  // ✅ FIX: No permitir que el recalculador "reviva" créditos ANULADOS
  if (esEstadoAnulado(estadoActual)) {
    return;
  }

  if (esLibre(credito)) return;

  const cuotas = await Cuota.findAll({
    where: { credito_id },
    ...(transaction && { transaction })
  });

  if (!cuotas || cuotas.length === 0) {
    await Credito.update(
      { estado: 'pendiente' },
      { where: { id: credito_id }, ...(transaction && { transaction }) }
    );
    return;
  }

  const todasPagadas = cuotas.every((c) => String(c.estado).toLowerCase() === 'pagada');
  const activas = cuotas.filter((c) => String(c.estado).toLowerCase() !== 'pagada');
  const todasActivasVencidas =
    activas.length > 0 && activas.every((c) => String(c.estado).toLowerCase() === 'vencida');

  const nuevoEstado = todasPagadas ? 'pagado' : todasActivasVencidas ? 'vencido' : 'pendiente';

  await Credito.update(
    { estado: nuevoEstado },
    { where: { id: credito_id }, ...(transaction && { transaction }) }
  );
}

/* ============================================================
 *  CANCELACIÓN / PAGO ANTICIPADO
 * ============================================================ */

export const cancelarCredito = async ({
  credito_id,
  forma_pago_id,
  descuento_porcentaje = 0,
  descuento_sobre = 'mora',
  observacion = null,
  rol_id = null,
  usuario_id = null
}) => {
  if (!forma_pago_id) {
    const err = new Error('Debe indicar forma_pago_id');
    err.status = 400;
    throw err;
  }

  if (rol_id !== null && rol_id !== 0 && rol_id !== 1) {
    const err = new Error('No tenés permisos para cancelar créditos.');
    err.status = 403;
    throw err;
  }

  const credito = await Credito.findByPk(credito_id, {
    include: [
      {
        model: Cuota,
        as: 'cuotas',
        where: { estado: { [Op.in]: ['pendiente', 'parcial', 'vencida'] } },
        required: false
      }
    ]
  });
  if (!credito) throw new Error('Crédito no encontrado');

  if (esLibre(credito)) {
    // ✅ Cancelar siempre se permite: si el crédito superó el tope de ciclos, NO bloqueamos la cancelación.
    try {
      verificarTopeCiclosLibre(credito, todayYMD());
    } catch (e) {
      if (e?.code !== 'LIBRE_TOPE_3_CICLOS_SUPERADO') throw e;
    }

    return cancelarCreditoLibre({
      credito,
      forma_pago_id,
      descuento_porcentaje,
      descuento_sobre,
      observacion,
      rol_id,
      usuario_id
    });
  }

  const { recalcularMoraCuota } = await import('../cuota.service.js');

  const cuotasPend = (credito.cuotas || [])
    .filter((c) => c.estado !== 'pagada')
    .sort((a, b) => a.numero_cuota - b.numero_cuota);

  if (cuotasPend.length === 0) {
    return {
      credito_id,
      cuotas_pagadas: 0,
      total_principal_pendiente: 0,
      total_descuento_aplicado: 0,
      total_mora_cobrada: 0,
      total_pagado: 0,
      saldo_credito_antes: fix2(credito.saldo_actual),
      saldo_credito_despues: fix2(credito.saldo_actual),
      mensaje: 'El crédito ya se encuentra pagado.'
    };
  }

  const info = [];
  let totalPrincipalPendiente = 0;
  for (const c of cuotasPend) {
    const importe = fix2(c.importe_cuota);
    const descAcum = fix2(c.descuento_cuota);
    const pagadoAcum = fix2(c.monto_pagado_acumulado);
    const principalPend = Math.max(importe - descAcum - pagadoAcum, 0);
    info.push({ c, principalPend });
    totalPrincipalPendiente = fix2(totalPrincipalPendiente + principalPend);
  }

  let totalMoraDia = 0;
  const moraHoyPorCuota = {};
  for (const { c } of info) {
    const mora = await recalcularMoraCuota(c.id);
    moraHoyPorCuota[c.id] = fix2(mora);
    totalMoraDia = fix2(totalMoraDia + mora);
  }

  const pct = Math.min(Math.max(toNumber(descuento_porcentaje), 0), 100);

  if (pct > 0 && rol_id !== null && rol_id !== 0) {
    const err = new Error('Solo un superadmin puede aplicar descuentos en la cancelación del crédito.');
    err.status = 403;
    throw err;
  }

  let descSobreMoraTotal = 0;
  let descSobrePrincipalTotal = 0;

  const descuentosMora = new Map();
  const descuentosPrincipal = new Map();

  if (String(descuento_sobre) === 'total') {
    const baseTotal = fix2(totalPrincipalPendiente + totalMoraDia);
    let totalDescuento = fix2(baseTotal * (pct / 100));

    if (totalMoraDia > 0) {
      let asignadoMora = 0;
      for (let i = 0; i < info.length; i++) {
        const { c } = info[i];
        const m = toNumber(moraHoyPorCuota[c.id]);
        const d = fix2(Math.min((m / totalMoraDia) * totalDescuento, m));
        descuentosMora.set(c.id, d);
        asignadoMora = fix2(asignadoMora + d);
      }
      descSobreMoraTotal = asignadoMora;
      totalDescuento = fix2(Math.max(totalDescuento - asignadoMora, 0));
    }

    if (totalDescuento > 0 && totalPrincipalPendiente > 0) {
      let asignadoPrincipal = 0;
      for (let i = 0; i < info.length; i++) {
        const { c, principalPend } = info[i];
        const d = fix2(Math.min((principalPend / totalPrincipalPendiente) * totalDescuento, principalPend));
        descuentosPrincipal.set(c.id, d);
        asignadoPrincipal = fix2(asignadoPrincipal + d);
      }
      descSobrePrincipalTotal = asignadoPrincipal;
      const delta = fix2(totalDescuento - asignadoPrincipal);
      if (Math.abs(delta) >= 0.01) {
        const last = info[info.length - 1].c;
        descuentosPrincipal.set(last.id, fix2((descuentosPrincipal.get(last.id) || 0) + delta));
        descSobrePrincipalTotal = fix2(descSobrePrincipalTotal + delta);
      }
    }
  } else {
    const totalDescuento = fix2(totalMoraDia * (pct / 100));
    if (totalMoraDia > 0 && totalDescuento > 0) {
      let asignado = 0;
      const itemsConMora = info.filter(({ c }) => toNumber(moraHoyPorCuota[c.id]) > 0);
      for (let i = 0; i < itemsConMora.length; i++) {
        const { c } = itemsConMora[i];
        const moraC = toNumber(moraHoyPorCuota[c.id]);
        let d = fix2((moraC / totalMoraDia) * totalDescuento);
        d = Math.min(d, moraC);
        descuentosMora.set(c.id, d);
        asignado = fix2(asignado + d);
      }
      const delta = fix2(totalDescuento - asignado);
      if (Math.abs(delta) >= 0.01 && info.length > 0) {
        const last = info[info.length - 1].c;
        descuentosMora.set(last.id, fix2((descuentosMora.get(last.id) || 0) + delta));
      }
      descSobreMoraTotal = fix2(totalDescuento);
    }
  }

  const t = await Credito.sequelize.transaction();
  try {
    for (const { c } of info) {
      const descPrincipalC = fix2(descuentosPrincipal.get(c.id) || 0);
      const nuevoDescCuota = fix2(toNumber(c.descuento_cuota) + descPrincipalC);
      const nuevoPagadoAcum = fix2(toNumber(c.importe_cuota) - nuevoDescCuota);

      await Cuota.update(
        {
          estado: 'pagada',
          forma_pago_id,
          descuento_cuota: nuevoDescCuota,
          monto_pagado_acumulado: nuevoPagadoAcum,
          intereses_vencidos_acumulados: 0
        },
        { where: { id: c.id }, transaction: t }
      );
    }

    const saldoAntes = fix2(credito.saldo_actual);

    const principalNeto = fix2(Math.max(totalPrincipalPendiente - descSobrePrincipalTotal, 0));
    const moraNeta = fix2(Math.max(totalMoraDia - descSobreMoraTotal, 0));
    const totalDescuento = fix2(descSobreMoraTotal + descSobrePrincipalTotal);
    const totalPagado = fix2(principalNeto + moraNeta);

    await Credito.update(
      {
        saldo_actual: 0,
        estado: 'pagado',
        // Nota: en común/progresivo no existe “interés del ciclo” separado; esto históricamente se usó como acumulador (mora cobrada).
        interes_acumulado: fix2(toNumber(credito.interes_acumulado) + moraNeta)
      },
      { where: { id: credito_id }, transaction: t }
    );

    const cuotaAsociada = info[info.length - 1].c;
    const pagoResumen = await Pago.create(
      {
        cuota_id: cuotaAsociada.id,
        monto_pagado: totalPagado,
        fecha_pago: todayYMD(),
        forma_pago_id,
        observacion: `Cancelación crédito #${credito_id}` + (observacion ? ` - ${observacion}` : '')
      },
      { transaction: t }
    );

    const [cliente, cobrador, medio] = await Promise.all([
      Cliente.findByPk(credito.cliente_id, { transaction: t }),
      Usuario.findByPk(credito.cobrador_id, { transaction: t }),
      FormaPago.findByPk(forma_pago_id, { transaction: t })
    ]);

    const recibo = await createReciboSafe(
      {
        pago_id: pagoResumen.id,
        cuota_id: cuotaAsociada.id,
        cliente_id: credito.cliente_id,

        fecha: todayYMD(),
        hora: nowTime(),

        cliente_nombre: cliente ? `${cliente.nombre} ${cliente.apellido}` : null,
        nombre_cobrador: cobrador?.nombre_completo || 'Sin cobrador asignado',

        monto_pagado: totalPagado,
        pago_a_cuenta: totalPagado,

        concepto: `Cancelación total del crédito #${credito_id} (${info.length} cuotas)`,
        medio_pago: medio?.nombre || 'N/D',

        saldo_anterior: saldoAntes,
        saldo_actual: 0,

        mora_cobrada: moraNeta,
        principal_pagado: principalNeto,
        descuento_aplicado: totalDescuento,
        saldo_credito_anterior: saldoAntes,
        saldo_credito_actual: 0,

        saldo_mora: 0.0
      },
      { transaction: t }
    );

    await registrarIngresoDesdeReciboEnTx({
      t,
      recibo,
      forma_pago_id,
      usuario_id
    });

    await t.commit();

    return {
      credito_id,
      cuotas_pagadas: info.length,
      total_principal_pendiente: totalPrincipalPendiente,
      total_descuento_aplicado: totalDescuento,
      total_mora_cobrada: moraNeta,
      total_pagado: totalPagado,
      saldo_credito_antes: saldoAntes,
      saldo_credito_despues: 0,
      numero_recibo: recibo.numero_recibo
    };
  } catch (e) {
    if (t.finished !== 'commit') {
      try {
        await t.rollback();
      } catch (_) {}
    }
    throw e;
  }
};

export const refinanciarCredito = (payload) => refinanciarCreditoImpl(payload, { generarCuotasServicio });

/* ===================== Eliminación / utilidades ===================== */
export const esCreditoEliminable = async (id) => {
  const cuotas = await Cuota.findAll({ attributes: ['id'], where: { credito_id: id } });
  const cuotaIds = cuotas.map((c) => c.id);
  if (cuotaIds.length === 0) return { eliminable: true, cantidadPagos: 0 };

  const cantidadPagos = await Pago.count({ where: { cuota_id: cuotaIds } });
  return { eliminable: cantidadPagos === 0, cantidadPagos };
};

export const eliminarCredito = async (id) => {
  const t = await Credito.sequelize.transaction();
  try {
    const cuotas = await Cuota.findAll({
      attributes: ['id'],
      where: { credito_id: id },
      transaction: t
    });
    const cuotaIds = cuotas.map((c) => c.id);

    if (cuotaIds.length === 0) {
      await Credito.destroy({ where: { id }, transaction: t });

      // ✅ Eliminar SOLO el desembolso (egreso) asociado al crédito
      await eliminarEgresoDesembolsoCajaEnTx({ creditoId: id, t });

      await t.commit();
      return { ok: true, mensaje: 'Crédito eliminado (no tenía cuotas).' };
    }

    const cantidadPagos = await Pago.count({ where: { cuota_id: cuotaIds }, transaction: t });
    if (cantidadPagos > 0) {
      const err = new Error('No se puede eliminar el crédito porque tiene pagos registrados.');
      err.status = 409;
      await t.rollback();
      throw err;
    }

    await Recibo.destroy({ where: { cuota_id: cuotaIds }, transaction: t });
    await Cuota.destroy({ where: { credito_id: id }, transaction: t });
    await Credito.destroy({ where: { id }, transaction: t });

    // ✅ Eliminar SOLO el desembolso (egreso) asociado al crédito
    await eliminarEgresoDesembolsoCajaEnTx({ creditoId: id, t });

    await t.commit();
    return { ok: true, mensaje: 'Crédito eliminado correctamente.' };
  } catch (e) {
    if (t.finished !== 'commit') {
      try {
        await t.rollback();
      } catch (_) {}
    }
    throw e;
  }
};

/* ===================== Cliente con créditos (con filtros) ===================== */
export const obtenerCreditosPorCliente = async (clienteId, query = {}, { rol_id = null } = {}) => {
  try {
    if (rol_id !== null && rol_id !== 0 && rol_id !== 1) {
      const err = new Error('No tenés permisos para ver créditos de clientes.');
      err.status = 403;
      throw err;
    }

    const estado = query.estado ? String(query.estado).toLowerCase() : null;
    const modalidad = query.modalidad ? String(query.modalidad).toLowerCase() : null;
    const tipo = query.tipo ? String(query.tipo).toLowerCase() : null;
    const desde = query.desde || null;
    const hasta = query.hasta || null;
    const conCuotasVencidas =
      query.conCuotasVencidas === true ||
      query.conCuotasVencidas === 'true' ||
      query.conCuotasVencidas === '1';

    const whereCredito = {};
    if (estado) whereCredito.estado = estado;
    if (modalidad) whereCredito.modalidad_credito = modalidad;
    if (tipo) whereCredito.tipo_credito = tipo;

    if (desde || hasta) {
      const rango = {};
      if (desde) rango[Op.gte] = desde;
      if (hasta) rango[Op.lte] = hasta;
      whereCredito[Op.or] = [{ fecha_acreditacion: rango }, { fecha_compromiso_pago: rango }];
    }

    let cliente = await Cliente.findByPk(clienteId, {
      include: [
        {
          model: Credito,
          as: 'creditos',
          where: Object.keys(whereCredito).length ? whereCredito : undefined,
          required: false,
          include: [
            {
              model: Cuota,
              as: 'cuotas',
              include: [
                {
                  model: Pago,
                  as: 'pagos',
                  attributes: ['id', 'monto_pagado', 'fecha_pago'],
                  include: [{ model: FormaPago, as: 'formaPago', attributes: ['nombre'] }]
                }
              ]
            },
            { model: Usuario, as: 'cobradorCredito', attributes: ['id', 'nombre_completo'] }
          ]
        },
        { model: Usuario, as: 'cobradorUsuario', attributes: ['id', 'nombre_completo'] },
        { model: Zona, as: 'clienteZona', attributes: ['id', 'nombre'] }
      ]
    });
    if (!cliente) return null;

    const creditosCliente = cliente.creditos || [];
    for (const cr of creditosCliente) {
      if (esLibre(cr)) {
        await refrescarCuotaLibre(cr.id);
      } else {
        await marcarVencidasYCalcularMora(cr.id, {
          sumarSoloVencidas: true,
          fechaCorte: todayYMD()
        });
        await actualizarEstadoCredito(cr.id);
      }
    }

    cliente = await Cliente.findByPk(clienteId, {
      include: [
        {
          model: Credito,
          as: 'creditos',
          where: Object.keys(whereCredito).length ? whereCredito : undefined,
          required: false,
          include: [
            {
              model: Cuota,
              as: 'cuotas',
              include: [
                {
                  model: Pago,
                  as: 'pagos',
                  attributes: ['id', 'monto_pagado', 'fecha_pago'],
                  include: [{ model: FormaPago, as: 'formaPago', attributes: ['nombre'] }]
                }
              ]
            },
            { model: Usuario, as: 'cobradorCredito', attributes: ['id', 'nombre_completo'] }
          ]
        },
        { model: Usuario, as: 'cobradorUsuario', attributes: ['id', 'nombre_completo'] },
        { model: Zona, as: 'clienteZona', attributes: ['id', 'nombre'] }
      ]
    });

    const plain = cliente.get({ plain: true });

    if (conCuotasVencidas && Array.isArray(plain.creditos)) {
      plain.creditos = plain.creditos.filter(
        (cr) => Array.isArray(cr.cuotas) && cr.cuotas.some((ct) => String(ct.estado) === 'vencida')
      );
    }

    // ✅ Mapa: crédito original refinanciado -> crédito nuevo (más reciente)
    let mapHijosPorOrigen = new Map();
    try {
      const idsOriginalesRefi = (plain.creditos || [])
        .filter((cr) => String(cr.estado || '').toLowerCase() === 'refinanciado')
        .map((cr) => cr.id);

      if (idsOriginalesRefi.length > 0) {
        const hijos = await Credito.findAll({
          where: { id_credito_origen: { [Op.in]: idsOriginalesRefi } },
          attributes: ['id', 'id_credito_origen'],
          raw: true
        });

        // si hay más de uno, nos quedamos con el id más alto
        for (const h of hijos) {
          const origenId = h.id_credito_origen;
          const hijoId = h.id;
          const prev = mapHijosPorOrigen.get(origenId);
          if (!prev || Number(hijoId) > Number(prev)) {
            mapHijosPorOrigen.set(origenId, hijoId);
          }
        }
      }
    } catch (e) {
      console.error('[obtenerCreditosPorCliente] No se pudo armar map de hijos de refinanciación:', e?.message || e);
      mapHijosPorOrigen = new Map();
    }

    plain.creditos.sort((a, b) => b.id - a.id);

    // ✅ Importante: necesitamos await para setear total_actual LIBRE exacto + resumen
    for (const cr of plain.creditos || []) {
      if (Array.isArray(cr.cuotas)) cr.cuotas.sort((x, y) => x.numero_cuota - y.numero_cuota);

      if (esLibre(cr)) {
        const hoyYMD = todayYMD();

        let resumen = null;
        try {
          resumen = await obtenerResumenLibre(cr.id, ymdDate(hoyYMD));
        } catch (_e) {
          resumen = null;
        }

        if (resumen) {
          cr.resumen_libre = resumen;

          // “aplanado” por compat (evita cambios en front)
          cr.saldo_capital = resumen.saldo_capital;
          cr.interes_pendiente_total = resumen.interes_pendiente_total;
          cr.mora_pendiente_total = resumen.mora_pendiente_total;
          cr.interes_pendiente_hoy = resumen.interes_pendiente_hoy;
          cr.mora_pendiente_hoy = resumen.mora_pendiente_hoy;
          cr.ciclo_actual = resumen.ciclo_actual;

          cr.total_liquidacion_hoy = resumen.total_liquidacion_hoy;
          cr.total_ciclo_hoy = resumen.total_ciclo_hoy;

          if (typeof resumen.interes_cobrado_historico !== 'undefined') {
            cr.interes_cobrado_historico = resumen.interes_cobrado_historico;
          }
          if (typeof resumen.intereses_acumulados !== 'undefined') {
            cr.intereses_acumulados = resumen.intereses_acumulados;
          }

          // ✅ FIX CLAVE: interes_acumulado expuesto al front = devengado (cobrado + pendiente total)
          if (typeof resumen.intereses_acumulados !== 'undefined') {
            cr.interes_acumulado = fix2(toNumber(resumen.intereses_acumulados));
          } else if (typeof resumen.interes_cobrado_historico !== 'undefined') {
            cr.interes_acumulado = fix2(toNumber(resumen.interes_cobrado_historico));
          }

          // total_actual “al día”
          cr.total_actual = resumen.total_liquidacion_hoy;

          // ✅ compat/UI: saldo_total_actual para LIBRE = total del ciclo HOY
          cr.saldo_total_actual = resumen.total_ciclo_hoy;
        } else {
          // total_actual = fallback
          try {
            cr.total_actual = await obtenerTotalHoyLibreExacto(cr.id, ymdDate(hoyYMD));
          } catch (e) {
            cr.total_actual = calcularTotalActualCreditoPlain(cr);
            console.error('[obtenerCreditosPorCliente] Fallback total_actual LIBRE:', e?.message || e);
          }

          // compat/UI
          cr.saldo_total_actual = fix2(toNumber(cr.total_actual));
        }

        const ciclos = obtenerFechasCiclosLibre(cr);
        if (ciclos) {
          cr.fechas_ciclos_libre = ciclos;
        }
      } else {
        cr.total_actual = calcularTotalActualCreditoPlain(cr);

        // ✅ compat/UI: para no-LIBRE, saldo_total_actual = total_actual
        cr.saldo_total_actual = fix2(toNumber(cr.total_actual));
      }

      const hijoId = mapHijosPorOrigen.get(cr.id) ?? null;
      anexarFlagsRefinanciacionPlain(cr, hijoId);
    }

    return plain;
  } catch (error) {
    console.error('Error al obtener cliente con créditos (con filtros):', error);
    throw error;
  }
};

/* ===================== Anulación / tareas pendientes ===================== */
export const anularCredito = async (id) => {
  const t = await Credito.sequelize.transaction();
  try {
    const credito = await Credito.findByPk(id, { transaction: t });
    if (!credito) throw new Error('Crédito no encontrado');

    const estado = String(credito.estado || '').toLowerCase();

    if (estado === 'pagado') {
      const err = new Error('No se puede anular un crédito pagado.');
      err.status = 400;
      throw err;
    }

    // ✅ Seguridad: no permitir anulación si existen pagos (evita caja inconsistente)
    const cuotas = await Cuota.findAll({
      attributes: ['id'],
      where: { credito_id: id },
      transaction: t
    });
    const cuotaIds = cuotas.map((c) => c.id);

    if (cuotaIds.length > 0) {
      const cantidadPagos = await Pago.count({
        where: { cuota_id: cuotaIds },
        transaction: t
      });

      if (cantidadPagos > 0) {
        const err = new Error('No se puede anular el crédito porque tiene pagos registrados.');
        err.status = 409;
        throw err;
      }

      // Limpieza de recibos/cuotas (si existieran sin pagos)
      await Recibo.destroy({ where: { cuota_id: cuotaIds }, transaction: t });
      await Cuota.destroy({ where: { credito_id: id }, transaction: t });
    } else {
      // Aun si no hay cuotas, igual dejamos el crédito en anulado
      await Cuota.destroy({ where: { credito_id: id }, transaction: t });
    }

    // ✅ Eliminar el egreso del desembolso (caja)
    await eliminarEgresoDesembolsoCajaEnTx({ creditoId: id, t });

    // Marcar anulado
    await Credito.update({ estado: 'anulado' }, { where: { id }, transaction: t });

    const creditoFresh = await Credito.findByPk(id, { transaction: t });
    await t.commit();
    return creditoFresh || credito;
  } catch (e) {
    if (t.finished !== 'commit') {
      try {
        await t.rollback();
      } catch (_) {}
    }
    throw e;
  }
};

export const solicitarAnulacionCredito = async ({ creditoId, motivo, userId }) => {
  const credito = await Credito.findByPk(creditoId);
  if (!credito) {
    const err = new Error('Crédito no encontrado.');
    err.status = 404;
    throw err;
  }

  if (String(credito.estado || '').toLowerCase() === 'pagado') {
    const err = new Error('No se puede solicitar la anulación de un crédito pagado.');
    err.status = 400;
    throw err;
  }

  const existe = await TareaPendiente.findOne({
    where: { estado: 'pendiente', tipo: 'anular_credito', datos: { creditoId } }
  });
  if (existe) {
    const err = new Error('Ya existe una solicitud de anulación pendiente para este crédito.');
    err.status = 400;
    throw err;
  }

  return TareaPendiente.create({
    tipo: 'anular_credito',
    datos: { creditoId, motivo },
    creadoPor: userId
  });
};