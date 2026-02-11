// financiera-backend/services/credito/credito.libre.service.js
// Lógica exclusiva de modalidad LIBRE (ciclos mensuales), aislada del resto.
//
// ✅ Importante:
// - La FUENTE DE VERDAD de interés/mora LIBRE es services/cuota (cuota.libre.service.js).
// - Este módulo solo:
//   - normaliza/expone resumen para UI,
//   - refresca la “cuota única” LIBRE (importe=capital; mora desde cuota.service),
//   - cancelación total (genera pago/recibo/caja).
//
// ⚠️ Evitamos duplicar cálculo exacto para no generar inconsistencias / “parpadeos”.

import Cuota from '../../models/Cuota.js';
import Usuario from '../../models/Usuario.js';
import Recibo from '../../models/Recibo.js';
import { Op } from 'sequelize';
import { Credito, Cliente } from '../../models/associations.js';

import Pago from '../../models/Pago.js';
import FormaPago from '../../models/FormaPago.js';

import { differenceInCalendarDays } from 'date-fns';

import {
  todayYMD,
  nowTime,
  toNumber,
  fix2,
  ymd,
  ymdDate,
  normalizeRate,
  clamp
} from '../cuota/cuota.utils.js';

import {
  LIBRE_MAX_CICLOS,
  VTO_FICTICIO_LIBRE,
  MORA_DIARIA_LIBRE,
  cicloLibreActual as cicloLibreActualCuota,
  vencimientoCicloLibre,
  // ✅ Fuente de verdad del resumen (evita contrato viejo del facade cuota.service.js)
  obtenerResumenLibrePorCredito as obtenerResumenLibrePorCreditoCuota
} from '../cuota/cuota.libre.service.js';

import { crearReciboEnTxCompat } from '../cuota/cuota.recibo.compat.service.js';
import { registrarIngresoDesdeReciboEnTx } from '../cuota/cuota.caja.service.js';

/* ===================== Helpers de LIBRE (compat / UI) ===================== */

// Detecta modalidad LIBRE (helper local defensivo)
const esLibre = (credito) =>
  String(credito?.modalidad_credito ?? '').toLowerCase() === 'libre';

export const fechaBaseLibre = (credito) => {
  /**
   * ✅ Nueva regla acordada:
   * - LIBRE tiene ciclos mensuales.
   * - La fecha que define el PRIMER VENCIMIENTO / inicio de cronología de ciclos es:
   *   `fecha_compromiso_pago` (vencimiento del ciclo 1).
   * - `fecha_acreditacion` se usa para caja (egreso por desembolso), NO para mora/ciclos.
   *
   * Fallback defensivo:
   * - Si falta compromiso, usamos acreditación; si falta todo, hoy.
   */
  return credito?.fecha_compromiso_pago || credito?.fecha_acreditacion || todayYMD();
};

/**
 * Compat export: devuelve 1..3
 * Acepta `hoy` como Date o YMD.
 *
 * ⚠️ Nota (regla cliente nueva):
 * Este helper sigue devolviendo el "ciclo por calendario" (por fechas fijas),
 * NO el "ciclo operativo" (que ahora se determina por el ciclo más viejo abierto).
 * Para el ciclo operativo, usar `obtenerCicloLibreActualSegunRegla()` (async).
 */
export const cicloLibreActual = (credito, hoy = new Date()) => {
  const hoyYMD = typeof hoy === 'string' ? hoy : ymd(hoy);
  return cicloLibreActualCuota(credito, hoyYMD);
};

/**
 * ✅ NUEVO (regla cliente):
 * Devuelve el "ciclo operativo" según la regla:
 * - NO avanza al siguiente hasta que el anterior se cierre (mora + interés).
 *
 * Fuente de verdad: obtenerResumenLibrePorCreditoCuota() (cuota.libre.service.js)
 */
export const obtenerCicloLibreActualSegunRegla = async (creditoId, fecha = ymdDate(todayYMD())) => {
  const hoyYMD = ymd(fecha);
  const resumen = await obtenerResumenLibrePorCreditoCuota(creditoId, ymdDate(hoyYMD));
  const c = toNumber(resumen?.ciclo_actual ?? 1);
  return clamp(c, 1, LIBRE_MAX_CICLOS);
};

/**
 * Devuelve vencimientos por ciclo (FIN INCLUSIVE de cada ciclo),
 * consistente con cuota.libre.service.js (vencimientoCicloLibre).
 */
export const obtenerFechasCiclosLibre = (credito) => {
  if (!credito) return null;

  const vto1 = vencimientoCicloLibre(credito, 1);
  const vto2 = vencimientoCicloLibre(credito, 2);
  const vto3 = vencimientoCicloLibre(credito, 3);

  return {
    vencimiento_ciclo_1: vto1,
    vencimiento_ciclo_2: vto2,
    vencimiento_ciclo_3: vto3
  };
};

/**
 * ⚠️ Mantengo el helper exportado por compat, pero NO se usa para bloquear
 * cancelación/refresh (porque si “supera el tope”, igual debe poder CANCELAR o REFINANCIAR).
 * Si alguien lo usa externamente, seguirá lanzando error como antes.
 */
export const verificarTopeCiclosLibre = (credito, hoyYMD = todayYMD()) => {
  if (!credito) return;

  const saldo = toNumber(credito?.saldo_actual);
  if (saldo <= 0) return;

  const vto3 = vencimientoCicloLibre(credito, 3);
  if (!vto3) return;

  if (String(hoyYMD) > String(vto3)) {
    const err = new Error(
      `Crédito LIBRE superó el tope de ${LIBRE_MAX_CICLOS} ciclos. Debe cancelarse o refinanciarse.`
    );
    err.status = 400;
    err.code = 'LIBRE_TOPE_3_CICLOS_SUPERADO';
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────
// Interés cobrado histórico (para “Intereses acumulados” consistentes)
// ─────────────────────────────────────────────────────────────

const obtenerInteresCobradoHistoricoLibre = async (creditoId, t = null) => {
  const cuotas = await Cuota.findAll({
    where: { credito_id: creditoId },
    attributes: ['id'],
    ...(t && { transaction: t })
  });

  const cuotaIds = cuotas.map((c) => c.id).filter(Boolean);
  if (!cuotaIds.length) return 0;

  const sum = await Recibo.sum('interes_ciclo_cobrado', {
    where: { cuota_id: { [Op.in]: cuotaIds } },
    ...(t && { transaction: t })
  });

  return fix2(toNumber(sum || 0));
};

/* ===================== Helpers fallback (solo si falla resumen exacto) ===================== */

export const calcularInteresCicloLibre = (credito) => {
  if (!credito) return 0;
  const tasa = normalizeRate(credito.interes); // 60 ó 0.60 -> 0.60
  if (!(tasa > 0)) return 0;

  const capital = toNumber(credito.saldo_actual);
  if (!(capital > 0)) return 0;

  return fix2(capital * tasa);
};

/**
 * Mora LIBRE (fallback)
 * Regla: mora_diaria = 2.5% del INTERÉS DEL CICLO, por día de atraso.
 * Nota: este fallback SOLO calcula sobre el ciclo actual (por calendario).
 */
export const calcularMoraLibre = (credito, hoy = ymdDate(todayYMD())) => {
  if (!credito) return 0;

  const hoyY = ymd(hoy);
  const ciclo = cicloLibreActualCuota(credito, hoyY);
  const vto = vencimientoCicloLibre(credito, ciclo);
  if (!vto) return 0;

  if (String(hoyY) <= String(vto)) return 0;

  const dias = Math.max(differenceInCalendarDays(ymdDate(hoyY), ymdDate(vto)), 0);
  if (dias <= 0) return 0;

  const interesCiclo = fix2(calcularInteresCicloLibre(credito));
  if (!(interesCiclo > 0)) return 0;

  return fix2(interesCiclo * MORA_DIARIA_LIBRE * dias);
};

export const calcularImporteCuotaLibre = (credito) => {
  return fix2(toNumber(credito?.saldo_actual || 0));
};

/* ===================== Fuente de verdad: resumen exacto desde cuota.libre.service.js ===================== */

const obtenerResumenLibreExactoSafe = async (creditoId, hoyYMD) => {
  try {
    const credito = await Credito.findByPk(creditoId);
    if (!credito || !esLibre(credito)) return null;

    const resumen = await obtenerResumenLibrePorCreditoCuota(creditoId, ymdDate(hoyYMD));
    if (!resumen) return null;

    const saldo_capital = fix2(toNumber(resumen?.saldo_capital ?? credito?.saldo_actual ?? 0));

    const interes_total = fix2(
      toNumber(
        resumen?.interes_pendiente_total ??
        resumen?.interes_total ??
        0
      )
    );

    const mora_total = fix2(
      toNumber(
        resumen?.mora_pendiente_total ??
        resumen?.mora_total ??
        0
      )
    );

    const cicloCalc = cicloLibreActualCuota(credito, hoyYMD);
    const ciclo_actual = Math.min(
      Math.max(toNumber(resumen?.ciclo_actual ?? resumen?.ciclo ?? cicloCalc ?? 1), 1),
      LIBRE_MAX_CICLOS
    );

    const interes_hoy = fix2(
      toNumber(
        resumen?.interes_pendiente_hoy ??
        resumen?.interes_ciclo_hoy ??
        resumen?.interes_hoy ??
        0
      )
    );

    const mora_hoy = fix2(
      toNumber(
        resumen?.mora_pendiente_hoy ??
        resumen?.mora_ciclo_hoy ??
        resumen?.mora_hoy ??
        0
      )
    );

    const total_liquidacion_hoy = fix2(
      toNumber(
        resumen?.total_liquidacion_hoy ??
        resumen?.total_actual ??
        (saldo_capital + interes_total + mora_total)
      )
    );

    const total_ciclo_hoy = fix2(
      toNumber(
        resumen?.total_ciclo_hoy ??
        (saldo_capital + interes_hoy + mora_hoy)
      )
    );

    const interes_cobrado_historico = await obtenerInteresCobradoHistoricoLibre(creditoId);
    const intereses_acumulados = fix2(interes_cobrado_historico);
    const interes_devengado_total = fix2(interes_cobrado_historico + interes_total);

    const fechas = obtenerFechasCiclosLibre(credito);

    return {
      ...resumen,

      hoy: hoyYMD,
      tasa_decimal: normalizeRate(credito?.interes),

      saldo_capital,
      interes_pendiente_total: interes_total,
      mora_pendiente_total: mora_total,
      ciclo_actual,

      interes_pendiente_hoy: interes_hoy,
      mora_pendiente_hoy: mora_hoy,

      interes_ciclo_hoy: interes_hoy,
      mora_ciclo_hoy: mora_hoy,

      total_liquidacion_hoy,
      total_actual: total_liquidacion_hoy,
      total_ciclo_hoy,

      interes_cobrado_historico,
      intereses_acumulados,
      interes_devengado_total,

      ...(fechas || {})
    };
  } catch {
    return null;
  }
};

/**
 * ✅ Refrescar cuota LIBRE
 */
export const refrescarCuotaLibre = async (creditoId, t = null) => {
  const credito = await Credito.findByPk(creditoId, t ? { transaction: t } : undefined);
  if (!credito) return;
  if (!esLibre(credito)) return;

  const hoyYMD = todayYMD();

  let cuotaLibre = await Cuota.findOne({
    where: { credito_id: credito.id },
    order: [['numero_cuota', 'ASC']],
    ...(t && { transaction: t })
  });

  const nuevoImporte = fix2(calcularImporteCuotaLibre(credito));
  const resumenExacto = await obtenerResumenLibreExactoSafe(credito.id, hoyYMD);

  const moraLibre = fix2(
    resumenExacto?.mora_pendiente_hoy ??
    resumenExacto?.mora_ciclo_hoy ??
    calcularMoraLibre(credito, ymdDate(hoyYMD))
  );

  const cicloActual = Math.min(
    Math.max(toNumber(resumenExacto?.ciclo_actual ?? cicloLibreActualCuota(credito, hoyYMD)), 1),
    LIBRE_MAX_CICLOS
  );

  const vtoCicloYMD = vencimientoCicloLibre(credito, cicloActual);

  const diasAtraso = (vtoCicloYMD && String(hoyYMD) > String(vtoCicloYMD))
    ? Math.max(differenceInCalendarDays(ymdDate(hoyYMD), ymdDate(vtoCicloYMD)), 0)
    : 0;

  const nuevoEstado = diasAtraso > 0 ? 'vencida' : 'pendiente';

  if (cuotaLibre) {
    await cuotaLibre.update(
      {
        importe_cuota: nuevoImporte,
        intereses_vencidos_acumulados: moraLibre,
        estado: nuevoEstado
      },
      { transaction: t || undefined }
    );
  } else {
    cuotaLibre = await Cuota.create(
      {
        credito_id: credito.id,
        numero_cuota: 1,
        importe_cuota: nuevoImporte,
        fecha_vencimiento: VTO_FICTICIO_LIBRE,
        estado: nuevoEstado,
        forma_pago_id: null,
        descuento_cuota: 0.0,
        intereses_vencidos_acumulados: moraLibre,
        monto_pagado_acumulado: 0.0
      },
      t ? { transaction: t } : undefined
    );
  }
};

export const obtenerTotalHoyLibreExacto = async (creditoId, fecha = ymdDate(todayYMD())) => {
  const hoyYMD = ymd(fecha);
  const resumenExacto = await obtenerResumenLibreExactoSafe(creditoId, hoyYMD);

  const totalDirecto = toNumber(resumenExacto?.total_liquidacion_hoy ?? resumenExacto?.total_actual);
  if (Number.isFinite(totalDirecto) && totalDirecto >= 0) return fix2(totalDirecto);

  const capital = fix2(toNumber(resumenExacto?.saldo_capital ?? 0));
  const interes = fix2(toNumber(resumenExacto?.interes_pendiente_total ?? 0));
  const mora = fix2(toNumber(resumenExacto?.mora_pendiente_total ?? 0));

  return fix2(capital + interes + mora);
};

export const cancelarCreditoLibre = async ({
  credito,
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

  const hoyYMD = todayYMD();

  const saldoPendiente = fix2(credito.saldo_actual || 0);
  if (saldoPendiente <= 0) {
    return {
      credito_id: credito.id,
      cuotas_pagadas: 0,
      total_interes_ciclo: 0,
      total_descuento_aplicado: 0,
      total_pagado: 0,
      saldo_credito_antes: fix2(credito.saldo_actual),
      saldo_credito_despues: fix2(credito.saldo_actual),
      mensaje: 'El crédito ya se encuentra pagado.'
    };
  }

  const resumenExacto = await obtenerResumenLibreExactoSafe(credito.id, hoyYMD);

  let interesPendiente = 0;
  let moraPendiente = 0;
  let cicloLibre = null;

  if (resumenExacto) {
    interesPendiente = fix2(resumenExacto.interes_pendiente_total ?? 0);
    moraPendiente = fix2(resumenExacto.mora_pendiente_total ?? 0);
    cicloLibre = resumenExacto.ciclo_actual ?? null;
  } else {
    interesPendiente = fix2(calcularInteresCicloLibre(credito));
    moraPendiente = fix2(calcularMoraLibre(credito, ymdDate(hoyYMD)));
    cicloLibre = cicloLibreActualCuota(credito, hoyYMD);
  }

  const pct = Math.min(Math.max(toNumber(descuento_porcentaje), 0), 100);

  if (pct > 0 && rol_id !== null && Number(rol_id) !== 0) {
    const err = new Error('Solo un superadmin puede aplicar descuentos en la cancelación del crédito.');
    err.status = 403;
    throw err;
  }

  let descSobreMora = 0;
  let descSobreInteres = 0;
  let descSobrePrincipal = 0;

  if (String(descuento_sobre) === 'total') {
    const base = fix2(saldoPendiente + interesPendiente + moraPendiente);
    let totalDescuentoTmp = fix2(base * (pct / 100));

    descSobreMora = Math.min(totalDescuentoTmp, moraPendiente);
    totalDescuentoTmp = fix2(totalDescuentoTmp - descSobreMora);

    descSobreInteres = Math.min(totalDescuentoTmp, interesPendiente);
    totalDescuentoTmp = fix2(totalDescuentoTmp - descSobreInteres);

    descSobrePrincipal = Math.min(totalDescuentoTmp, saldoPendiente);
  } else {
    descSobreMora = fix2(moraPendiente * (pct / 100));
  }

  const moraNeta = fix2(Math.max(moraPendiente - descSobreMora, 0));
  const interesNeto = fix2(Math.max(interesPendiente - descSobreInteres, 0));
  const principalNeto = fix2(Math.max(saldoPendiente - descSobrePrincipal, 0));

  const totalAPagar = fix2(principalNeto + interesNeto + moraNeta);
  const totalDescuento = fix2(descSobreMora + descSobreInteres + descSobrePrincipal);

  const cuotaLibre = await Cuota.findOne({
    where: { credito_id: credito.id },
    order: [['numero_cuota', 'ASC']]
  });
  if (!cuotaLibre) {
    throw new Error('No se encontró la cuota abierta del crédito libre.');
  }

  const t = await Credito.sequelize.transaction();
  try {
    const saldoAntes = fix2(credito.saldo_actual);

    await Credito.update(
      {
        saldo_actual: 0,
        estado: 'pagado',
        // Nota: historial real sale de Recibo.sum(interes_ciclo_cobrado)
        interes_acumulado: fix2(toNumber(credito.interes_acumulado) + interesNeto)
      },
      { where: { id: credito.id }, transaction: t }
    );

    const nuevoDescCuota = fix2(toNumber(cuotaLibre.descuento_cuota) + descSobrePrincipal);

    await Cuota.update(
      {
        estado: 'pagada',
        forma_pago_id,
        descuento_cuota: nuevoDescCuota,
        monto_pagado_acumulado: principalNeto,
        intereses_vencidos_acumulados: 0
      },
      { where: { id: cuotaLibre.id }, transaction: t }
    );

    const pagoResumen = await Pago.create(
      {
        cuota_id: cuotaLibre.id,
        monto_pagado: totalAPagar,
        fecha_pago: hoyYMD,
        forma_pago_id,
        observacion: `Cancelación crédito libre #${credito.id}` + (observacion ? ` - ${observacion}` : '')
      },
      { transaction: t }
    );

    const [cliente, cobrador, medio] = await Promise.all([
      Cliente.findByPk(credito.cliente_id, { transaction: t }),
      Usuario.findByPk(credito.cobrador_id, { transaction: t }),
      FormaPago.findByPk(forma_pago_id, { transaction: t })
    ]);

    const recibo = await crearReciboEnTxCompat(
      {
        pago_id: pagoResumen.id,
        cuota_id: cuotaLibre.id,
        cliente_id: credito.cliente_id,

        fecha: hoyYMD,
        hora: nowTime(),

        cliente_nombre: cliente ? `${cliente.nombre} ${cliente.apellido}` : null,
        nombre_cobrador: cobrador?.nombre_completo || 'Sin cobrador asignado',

        monto_pagado: totalAPagar,
        pago_a_cuenta: totalAPagar,

        concepto: `Cancelación total crédito LIBRE #${credito.id}`,
        medio_pago: medio?.nombre || 'N/D',

        saldo_anterior: saldoAntes,
        saldo_actual: 0,

        mora_cobrada: moraNeta,
        principal_pagado: principalNeto,
        interes_ciclo_cobrado: interesNeto,

        descuento_aplicado: totalDescuento,
        saldo_credito_anterior: saldoAntes,
        saldo_credito_actual: 0,

        saldo_mora: 0.0,

        ciclo_libre: cicloLibre
      },
      { transaction: t }
    );

    // ✅ Caja consistente (ingreso) en la misma transacción
    await registrarIngresoDesdeReciboEnTx({
      t,
      recibo,
      forma_pago_id,
      usuario_id
    });

    await t.commit();

    return {
      credito_id: credito.id,
      cuotas_pagadas: 1,
      total_interes_ciclo: interesNeto,
      total_descuento_aplicado: totalDescuento,
      total_pagado: totalAPagar,
      total_mora_cobrada: moraNeta,
      saldo_credito_antes: saldoAntes,
      saldo_credito_despues: 0,
      numero_recibo: recibo.numero_recibo
    };
  } catch (e) {
    try { await t.rollback(); } catch (_) {}
    throw e;
  }
};

/* ===================== Resumen LIBRE (para UI/servicios) ===================== */
export const obtenerResumenLibre = async (creditoId, fecha = ymdDate(todayYMD())) => {
  const hoyYMD = ymd(fecha);
  const resumenExacto = await obtenerResumenLibreExactoSafe(creditoId, hoyYMD);
  if (resumenExacto) return resumenExacto;

  const credito = await Credito.findByPk(creditoId);
  if (!credito) return null;

  const interes = fix2(calcularInteresCicloLibre(credito));
  const mora = fix2(calcularMoraLibre(credito, ymdDate(hoyYMD)));
  const saldo_capital = fix2(toNumber(credito.saldo_actual || 0));
  const ciclo = cicloLibreActualCuota(credito, hoyYMD);

  const interes_cobrado_historico = await obtenerInteresCobradoHistoricoLibre(creditoId);
  const intereses_acumulados = fix2(interes_cobrado_historico);
  const interes_devengado_total = fix2(interes_cobrado_historico + interes);

  return {
    credito_id: creditoId,
    hoy: hoyYMD,
    ciclo_actual: ciclo,
    tasa_decimal: normalizeRate(credito?.interes),

    saldo_capital,
    interes_pendiente_total: interes,
    mora_pendiente_total: mora,

    interes_pendiente_hoy: interes,
    mora_pendiente_hoy: mora,

    interes_ciclo_hoy: interes,
    mora_ciclo_hoy: mora,

    total_liquidacion_hoy: fix2(saldo_capital + interes + mora),
    total_actual: fix2(saldo_capital + interes + mora),

    interes_cobrado_historico,
    intereses_acumulados,
    interes_devengado_total,

    ...(obtenerFechasCiclosLibre(credito) || {})
  };
};

/* ===================== Utilidades LIBRE exportadas ===================== */
export const refreshCuotaLibre = async (creditoId) => {
  await refrescarCuotaLibre(creditoId);
};