// financiera-backend/services/credito/credito.refinanciacion.service.js
// Refinanciación aislada para reducir acoplamiento y riesgo de regresiones.
// Importante: este módulo NO debe importar credito.core.service.js para evitar ciclos.

import Cuota from '../../models/Cuota.js';
import { Credito } from '../../models/associations.js';
import { Op } from 'sequelize';

import { toNumber, fix2, todayYMD } from './credito.utils.js';

import {
  refrescarCuotaLibre,
  obtenerTotalHoyLibreExacto
} from './credito.libre.service.js';

// ✅ Para pasar fechas YMD a Date consistente con el resto del backend
import { ymdDate } from '../cuota/cuota.utils.js';

/* ===================== Helpers locales ===================== */

const assertPermisoRefinanciar = (rol_id) => {
  // según tu convención: superadmin=0, admin=1
  if (rol_id !== null && rol_id !== 0 && rol_id !== 1) {
    const err = new Error('No tenés permisos para refinanciar créditos.');
    err.status = 403;
    throw err;
  }
};

/**
 * Normaliza string para comparaciones:
 * - trim
 * - lowercase
 * - sin diacríticos (por si aparece "anuládo", etc.)
 */
const normalizeStr = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // diacríticos

const assertCreditoNoAnulado = (credito) => {
  const estado = normalizeStr(credito?.estado);

  // Bloqueo robusto:
  // - "anulado", "anulada"
  // - cualquier variante que empiece con "anul" (por si usan "anulacion", etc.)
  if (estado === 'anulado' || estado === 'anulada' || estado.startsWith('anul')) {
    const err = new Error('El crédito está ANULADO. No se permite refinanciar.');
    err.status = 409;
    err.code = 'CREDITO_ANULADO';
    throw err;
  }
};

const normalizarOpcionRefi = (opcion) => String(opcion || '').toUpperCase();

const esOpcionManual = (opcionUpper) =>
  opcionUpper === 'MANUAL' || opcionUpper === 'P3'; // ✅ P3 = manual por definición del negocio

const mapearOpcionRefinanciamientoEnum = (opcionUpper) => {
  if (esOpcionManual(opcionUpper)) return 'manual';
  if (opcionUpper === 'P1') return 'P1';
  if (opcionUpper === 'P2') return 'P2';
  return 'manual';
};

/**
 * Definición de tasas base (MENSUAL) para refinanciación:
 * - P1: 25% mensual
 * - P2: 15% mensual
 * - P3/MANUAL: tasaManual mensual
 */
const tasaMensualBasePctDesdeOpcion = (opcionUpper, tasaManual) => {
  if (esOpcionManual(opcionUpper)) {
    const tm = toNumber(tasaManual);
    return fix2(tm > 0 ? tm : 0);
  }
  if (opcionUpper === 'P1') return 25;
  if (opcionUpper === 'P2') return 15;
  // fallback razonable
  return 25;
};

/**
 * Convierte una tasa MENSUAL a tasa POR PERIODO según tipo_credito.
 * (Alineado al criterio típico del negocio: 1 mes = 2 quincenas = 4 semanas)
 * Si tu negocio quiere semanal = mensual/4.33, se cambia acá.
 */
const tasaPeriodoPctDesdeMensual = (tasaMensualPct, tipo_credito) => {
  const tipo = String(tipo_credito || '').toLowerCase();

  if (tipo === 'quincenal') return fix2(tasaMensualPct / 2);
  if (tipo === 'semanal') return fix2(tasaMensualPct / 4);
  // default mensual (y también cubre "mensual" o vacíos)
  return fix2(tasaMensualPct);
};

/**
 * ✅ Saldo base LIBRE para refinanciar = TOTAL DEL CICLO "HOY"
 * (capital hoy + interés del ciclo actual + mora del ciclo actual)
 *
 * Fuente: cuota.service -> obtenerResumenLibrePorCredito()
 * (ahí "HOY" está definido como solo ciclo actual).
 *
 * Fallback: si falla, usamos obtenerTotalHoyLibreExacto (comportamiento previo).
 */
const obtenerSaldoBaseLibreCicloHoyExacto = async (creditoId, hoyYMD) => {
  try {
    const { obtenerResumenLibrePorCredito } = await import('../cuota.service.js');
    const resumen = await obtenerResumenLibrePorCredito(creditoId, ymdDate(hoyYMD));
    if (!resumen) return null;

    const saldo = fix2(toNumber(resumen?.saldo_capital ?? 0));
    const interesHoy = fix2(toNumber(resumen?.interes_pendiente_hoy ?? 0));
    const moraHoy = fix2(toNumber(resumen?.mora_pendiente_hoy ?? 0));

    const total = fix2(saldo + interesHoy + moraHoy);
    return total >= 0 ? total : 0;
  } catch {
    return null;
  }
};

/**
 * ===================== NO-LIBRE: BASE + MORA =====================
 *
 * Para evitar perder mora por desincronización:
 * - Base (principal pendiente) se calcula desde cuotas activas.
 * - Mora se toma como:
 *    - suma desde cuotas (si existe), y/o
 *    - campos agregados del crédito
 *   y se usa el MAYOR.
 */

const esCuotaActivaParaPendiente = (estado) => {
  const e = String(estado || '').toLowerCase();
  return ['pendiente', 'parcial', 'vencida'].includes(e);
};

const calcularPendienteBaseNoLibreDesdeCuotas = (cuotas = []) => {
  let base = 0;

  for (const c of cuotas) {
    if (!esCuotaActivaParaPendiente(c.estado)) continue;

    const importe = fix2(toNumber(c.importe_cuota));
    const desc = fix2(toNumber(c.descuento_cuota));
    const pagado = fix2(toNumber(c.monto_pagado_acumulado));

    const principalPend = fix2(Math.max(importe - desc - pagado, 0));
    base = fix2(base + principalPend);
  }

  return fix2(base);
};

const calcularMoraNoLibreDesdeCuotas = (cuotas = []) => {
  let mora = 0;

  for (const c of cuotas) {
    if (!esCuotaActivaParaPendiente(c.estado)) continue;

    // Soporta distintos nombres (según cómo esté tu modelo/DB)
    const m =
      toNumber(c.intereses_vencidos_acumulados ?? 0) ||
      toNumber(c.mora_acumulada ?? 0) ||
      toNumber(c.mora_pendiente ?? 0) ||
      toNumber(c.saldo_mora_pendiente ?? 0) ||
      0;

    mora = fix2(mora + fix2(m));
  }

  return fix2(mora);
};

const obtenerMoraNoLibreDesdeCredito = (original) => {
  // Soporta distintos nombres (según tu esquema)
  const m =
    toNumber(original?.saldo_mora_pendiente ?? 0) ||
    toNumber(original?.mora_acumulada ?? 0) ||
    toNumber(original?.mora_pendiente ?? 0) ||
    toNumber(original?.mora ?? 0) ||
    0;

  return fix2(m);
};

const obtenerSaldoBaseNoLibre = (original) => {
  const cuotas = Array.isArray(original?.cuotas) ? original.cuotas : [];

  const baseDesdeCuotas = calcularPendienteBaseNoLibreDesdeCuotas(cuotas);
  const moraDesdeCuotas = calcularMoraNoLibreDesdeCuotas(cuotas);
  const moraDesdeCredito = obtenerMoraNoLibreDesdeCredito(original);

  // Usamos el mayor para no “perder” mora si una de las dos fuentes quedó vieja.
  const moraFinal = fix2(Math.max(moraDesdeCuotas, moraDesdeCredito));

  if (baseDesdeCuotas > 0) {
    return fix2(baseDesdeCuotas + moraFinal);
  }

  // fallback: si por alguna razón no hay cuotas o vienen vacías
  const saldoActual = fix2(toNumber(original?.saldo_actual ?? 0));
  if (saldoActual > 0) {
    // si saldo_actual no incluye mora, acá la suma; si la incluyera, la UI/DB debería tener 0 en mora.
    return fix2(saldoActual + moraFinal);
  }

  return 0;
};

/* ===================== Refinanciación ===================== */

export const refinanciarCredito = async (payload = {}, deps = {}) => {
  const { generarCuotasServicio } = deps;
  if (typeof generarCuotasServicio !== 'function') {
    throw new Error('Dependencia requerida: generarCuotasServicio');
  }

  const {
    creditoId,
    opcion,
    tasaManual = 0,
    cantidad_cuotas,
    tipo_credito,
    rol_id = null
  } = payload;

  assertPermisoRefinanciar(rol_id);

  // 1) Buscar crédito original con cuotas
  const original = await Credito.findByPk(creditoId, {
    include: [{ model: Cuota, as: 'cuotas' }]
  });
  if (!original) throw new Error('Crédito no encontrado');

  // ✅ Bloqueo: si está anulado, no se puede refinanciar
  assertCreditoNoAnulado(original);

  const estadoOriginal = normalizeStr(original.estado);
  if (estadoOriginal === 'refinanciado') {
    const err = new Error('Este crédito ya fue refinanciado');
    err.code = 'CREDITO_YA_REFINANCIADO';
    err.status = 409;
    throw err;
  }

  const modalidadOriginal = String(original.modalidad_credito || '').toLowerCase();

  // 2) Determinar saldo base a refinanciar
  //    - LIBRE: saldoBase = TOTAL del ciclo HOY (capital + interes_hoy + mora_hoy)
  //    - NO-LIBRE: saldoBase = (saldo pendiente base) + (mora acumulada/pendiente)
  let saldoBase = 0;

  if (modalidadOriginal === 'libre') {
    const hoyYMD = todayYMD();

    // Refresca cuota única (mora/estado) - no define el saldo base por sí solo
    await refrescarCuotaLibre(creditoId);

    // ✅ Base correcta: ciclo "HOY"
    const baseHoy = await obtenerSaldoBaseLibreCicloHoyExacto(creditoId, hoyYMD);

    // fallback al comportamiento anterior si no se pudo obtener el resumen
    if (baseHoy !== null && baseHoy !== undefined) {
      saldoBase = baseHoy;
    } else {
      saldoBase = await obtenerTotalHoyLibreExacto(creditoId, ymdDate(hoyYMD));
    }
  } else {
    saldoBase = obtenerSaldoBaseNoLibre(original);
  }

  saldoBase = fix2(saldoBase);

  if (!(saldoBase > 0)) {
    const err = new Error('No hay saldo para refinanciar');
    err.code = 'SIN_SALDO';
    err.status = 409;
    throw err;
  }

  // 3) Calcular tasa/interés del nuevo crédito (IGUAL al modal)
  // Modal: total = saldoBase * (1 + tasaPeriodo * cantidadCuotas)
  const opcionUpper = normalizarOpcionRefi(opcion);

  const n = Math.max(
    toNumber(cantidad_cuotas) || toNumber(original.cantidad_cuotas) || 1,
    1
  );

  const tipoNuevo = tipo_credito || original.tipo_credito || 'mensual';

  // tasa base mensual según opción
  const tasaMensualPct = fix2(
    Math.max(tasaMensualBasePctDesdeOpcion(opcionUpper, tasaManual), 0)
  );

  // tasa por período según periodicidad del nuevo crédito
  const tasaPeriodoPct = fix2(Math.max(tasaPeriodoPctDesdeMensual(tasaMensualPct, tipoNuevo), 0));
  const tasaPeriodoDec = tasaPeriodoPct / 100;

  // interés simple acumulado por períodos (n cuotas)
  const interesTotalMonto = fix2(saldoBase * (tasaPeriodoDec * n));
  const totalNuevo = fix2(saldoBase + interesTotalMonto);

  // Para compatibilidad con el sistema:
  // - interes (%) como tasa total equivalente sobre capital (ej: 25% x 4 = 100%)
  const interesTotalPctEquivalente = fix2(tasaPeriodoPct * n);

  // 4) Crear crédito nuevo + marcar original como refinanciado dentro de TX
  const t = await Credito.sequelize.transaction();
  try {
    // 4.1) Marcar original refinanciado (y evitar que siga “cobrable”)
    await original.update(
      {
        estado: 'refinanciado',
        saldo_actual: 0
      },
      { transaction: t }
    );

    // 4.2) Pisar cuotas activas a "refinanciada" (para bloquear pagos)
    await Cuota.update(
      { estado: 'refinanciada' },
      {
        where: {
          credito_id: original.id,
          estado: { [Op.in]: ['pendiente', 'parcial', 'vencida'] }
        },
        transaction: t
      }
    );

    // 4.3) Crear crédito nuevo (SIEMPRE COMUN)
    const hoy = todayYMD();
    const modalidadNueva = 'comun';

    const opcionRefi = mapearOpcionRefinanciamientoEnum(opcionUpper);

    const nuevo = await Credito.create(
      {
        cliente_id: original.cliente_id,
        cobrador_id: original.cobrador_id ?? null,

        // Capital del nuevo crédito = saldo base refinanciado (BASE + MORA)
        monto_acreditar: fix2(saldoBase),

        fecha_solicitud: hoy,
        fecha_acreditacion: hoy,
        fecha_compromiso_pago: hoy,

        // Guardado de tasas:
        // - interes: % total equivalente (para que el sistema no “pierda” el interés)
        // - tasa_refinanciacion: % por período (para UI/consistencia con el modal)
        interes: fix2(interesTotalPctEquivalente),
        tasa_refinanciacion: fix2(tasaPeriodoPct),
        opcion_refinanciamiento: opcionRefi,

        tipo_credito: tipoNuevo,
        cantidad_cuotas: n,

        modalidad_credito: modalidadNueva, // ✅ SIEMPRE COMUN

        monto_total_devolver: fix2(totalNuevo),
        saldo_actual: fix2(totalNuevo),
        interes_acumulado: 0.0,
        descuento: 0.0,

        estado: 'pendiente',
        id_credito_origen: original.id,

        origen_venta_manual_financiada: false,
        detalle_producto: original.detalle_producto ?? null
      },
      { transaction: t }
    );

    // 5) Generar cuotas del crédito nuevo (inyectado desde core para evitar ciclos)
    await generarCuotasServicio(nuevo, t);

    await t.commit();

    return {
      ok: true,
      credito_original_id: original.id,
      credito_nuevo_id: nuevo.id,

      // ahora este saldo_base ya incluye mora cuando corresponde
      saldo_base: fix2(saldoBase),

      tasa_mensual_pct: fix2(tasaMensualPct),
      tasa_periodo_pct: fix2(tasaPeriodoPct),
      cuotas: n,

      interes_monto: fix2(interesTotalMonto),
      interes_total_pct_equivalente: fix2(interesTotalPctEquivalente),

      total_nuevo: fix2(totalNuevo),

      opcion_refinanciamiento: opcionRefi,
      modalidad_nueva: modalidadNueva,
      rol_id
    };
  } catch (e) {
    try {
      await t.rollback();
    } catch (_) {}
    throw e;
  }
};