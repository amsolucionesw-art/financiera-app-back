import Cuota from '../models/Cuota.js';
import Usuario from '../models/Usuario.js';
import Zona from '../models/Zona.js';
import TareaPendiente from '../models/Tarea_pendiente.js';
import {
  addDays,
  format,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  addMonths
} from 'date-fns';
import { buildFilters } from '../utils/buildFilters.js';
import { Credito, Cliente } from '../models/associations.js';
import { Op } from 'sequelize';

import Pago from '../models/Pago.js';
import Recibo from '../models/Recibo.js';
import FormaPago from '../models/FormaPago.js';

// ⬇️ Caja
import CajaMovimiento from '../models/CajaMovimiento.js';

/* ===================== Constantes ===================== */
const MORA_DIARIA = 0.025;        // 2.5% por día
const LIBRE_MAX_CICLOS = 3;       // tope 3 meses para crédito libre

// ───────────────── Compat DB: columna ciclo_libre puede no existir ─────────────────
const isMissingColumnError = (err, col = 'ciclo_libre') => {
  const msg = String(
    err?.original?.message ||
    err?.parent?.message ||
    err?.message ||
    ''
  );
  const code = String(err?.original?.code || err?.parent?.code || '');
  const lower = msg.toLowerCase();
  const colLower = String(col).toLowerCase();

  // Postgres undefined_column = 42703
  const missing =
    code === '42703' ||
    /column .* does not exist/i.test(msg) ||
    /no existe la columna/i.test(msg);

  return missing && lower.includes(colLower);
};

const createReciboSafe = async (payload, options = {}) => {
  try {
    return await Recibo.create(payload, options);
  } catch (e) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'ciclo_libre') && isMissingColumnError(e, 'ciclo_libre')) {
      const clone = { ...payload };
      delete clone.ciclo_libre;
      return await Recibo.create(clone, options);
    }
    throw e;
  }
};
const LIBRE_VTO_FICTICIO = '2099-12-31';

/* ===================== Zona horaria negocio ===================== */
const APP_TZ = process.env.APP_TZ || 'America/Argentina/Tucuman';

// YYYY-MM-DD en TZ negocio
const todayYMD = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

// HH:mm:ss en TZ negocio
const nowTime = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
}).format(new Date());

/* ===================== Helpers numéricos ===================== */
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

/* ===================== Helpers de fecha (YMD estricto) ===================== */
const asYMD = (d) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const ymd = (dateOrStr) => asYMD(dateOrStr);
const ymdDate = (dateOrStr) => new Date(asYMD(dateOrStr));

/* ===================== Helpers formato ===================== */
const fmtARS = (n) =>
  Number(n || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });

/* Mapea modalidad para mostrar en interfaz/PDF */
const labelModalidad = (modalidad) => {
  const m = String(modalidad || '').toLowerCase();
  if (m === 'comun') return 'PLAN DE CUOTAS FIJAS';
  return m.toUpperCase();
};

/* ===================== Helpers de tasas ===================== */
/** Normaliza un valor de tasa que puede venir como "60" o "0.60" a porcentaje 60 */
const normalizePercent = (val, fallback = 60) => {
  const n = toNumber(val);
  if (!n) return fallback;
  // Si viene 0.6 ó 0.60, lo paso a 60
  if (n > 0 && n <= 1) return n * 100;
  return n;
};
/** De porcentaje (60) a decimal (0.60) */
const percentToDecimal = (pct) => toNumber(pct) / 100.0;

/* ===================== Helpers de interés / períodos ===================== */
const periodLengthFromTipo = (tipo_credito) =>
  tipo_credito === 'semanal' ? 4 :
    tipo_credito === 'quincenal' ? 2 : 1;

/**
 * Interés proporcional mínimo 60% (común / progresivo):
 *   - semanal   → 60% * (semanas / 4)
 *   - quincenal → 60% * (quincenas / 2)
 *   - mensual   → 60% * (meses)
 */
const calcularInteresProporcionalMin60 = (tipo_credito, cantidad_cuotas) => {
  const n = Math.max(toNumber(cantidad_cuotas), 1);
  const pl = periodLengthFromTipo(tipo_credito);
  const proporcional = 60 * (n / pl);
  return Math.max(60, proporcional);
};

/** Detecta si el crédito es de modalidad "libre" */
const esLibre = (credito) => {
  const mod = credito?.modalidad_credito || (credito?.get ? credito.get('modalidad_credito') : null);
  return String(mod) === 'libre';
};

/* ===================== Helpers refinanciación (flags para UI) ===================== */

/**
 * Dado un crédito "plain", adjunta banderas estables para el front:
 * - es_refinanciado: crédito original marcado como refinanciado
 * - es_credito_de_refinanciacion: crédito nuevo que nace de una refinanciación
 * - credito_origen_id: alias del id del crédito origen (además de id_credito_origen)
 * - credito_refinanciado_hacia_id: (solo para originales refinanciados) id del crédito nuevo, si existe
 */
const anexarFlagsRefinanciacionPlain = (creditoPlain, hijoId = null) => {
  if (!creditoPlain) return creditoPlain;

  const estado = String(creditoPlain.estado || '').toLowerCase();
  const origenId = creditoPlain.id_credito_origen ?? creditoPlain.credito_origen_id ?? null;

  creditoPlain.credito_origen_id = origenId ?? null;
  creditoPlain.es_credito_de_refinanciacion = Boolean(origenId);

  creditoPlain.es_refinanciado = (estado === 'refinanciado');
  creditoPlain.credito_refinanciado_hacia_id =
    creditoPlain.es_refinanciado ? (hijoId ?? creditoPlain.credito_refinanciado_hacia_id ?? null) : null;

  return creditoPlain;
};

/* ===================== Helpers internos Caja ===================== */

/**
 * Registra un EGRESO en caja por desembolso del crédito.
 * Se invoca al CREAR el crédito (no en refinanciación).
 * Ahora con usuario_id (operador que hizo el movimiento).
 */
const registrarEgresoDesembolsoCredito = async ({
  creditoId,
  clienteNombre,
  fecha_acreditacion,
  monto,
  usuario_id = null
}, { t = null } = {}) => {
  if (!monto || toNumber(monto) <= 0) return;

  const fecha = fecha_acreditacion || todayYMD();
  const hora = nowTime();

  await CajaMovimiento.create({
    fecha,
    hora,
    tipo: 'egreso',
    monto: fix2(monto),
    forma_pago_id: null,
    concepto: `Desembolso crédito #${creditoId} - ${clienteNombre || 'Cliente'}`.slice(0, 255),
    referencia_tipo: 'credito',
    referencia_id: creditoId,
    usuario_id: usuario_id ?? null
  }, t ? { transaction: t } : undefined);
};

/**
 * Registra un INGRESO en caja por un recibo generado dentro de una TX.
 * Debe llamarse DESPUÉS de crear el Recibo.
 * Ahora con usuario_id (operador que cobró).
 */
const registrarIngresoDesdeReciboEnTx = async ({
  t,
  recibo,
  forma_pago_id,
  usuario_id = null
}) => {
  if (!recibo) return;
  const fecha = recibo.fecha || todayYMD();
  const hora = recibo.hora || nowTime();
  await CajaMovimiento.create({
    fecha,
    hora,
    tipo: 'ingreso',
    monto: fix2(recibo.monto_pagado || 0),
    forma_pago_id: forma_pago_id ?? null,
    concepto: `Cobro recibo #${recibo.numero_recibo ?? ''} - ${recibo.cliente_nombre || 'Cliente'}`.slice(0, 255),
    referencia_tipo: 'recibo',
    referencia_id: recibo.numero_recibo ?? null,
    usuario_id: usuario_id ?? null
  }, { transaction: t });
};

/* ===================== Helpers de LIBRE (ciclos mensuales) ===================== */
const fechaBaseLibre = (credito) => {
  // Usamos fecha_acreditacion como inicio de ciclo; si no existe, caemos a fecha_compromiso_pago
  const f = credito?.fecha_acreditacion || credito?.fecha_compromiso_pago;
  return f || todayYMD();
};

const cicloLibreActual = (credito, hoy = ymdDate(todayYMD())) => {
  const [Y, M, D] = fechaBaseLibre(credito).split('-').map((x) => parseInt(x, 10));
  const inicio = new Date(Y, M - 1, D);
  const diffMeses = Math.max(differenceInCalendarMonths(hoy, inicio), 0);
  // ciclo 1: 0 meses; ciclo 2: 1 mes; ciclo 3: 2 meses
  return Math.min(LIBRE_MAX_CICLOS, diffMeses + 1);
};

/**
 * Calcula las fechas de vencimiento de cada ciclo del crédito LIBRE
 * Tomando como base la "Fecha de compromiso de pago" elegida en el formulario.
 * Ciclo 1: fecha_compromiso_pago
 * Ciclo 2: fecha_compromiso_pago + 1 mes
 * Ciclo 3: fecha_compromiso_pago + 2 meses
 */
const obtenerFechasCiclosLibre = (credito) => {
  if (!credito) return null;
  const baseStr = credito.fecha_compromiso_pago || credito.fecha_acreditacion;
  if (!baseStr) return null;

  const base = ymdDate(baseStr);
  const ciclo1 = ymd(base);
  const ciclo2 = ymd(addMonths(base, 1));
  const ciclo3 = ymd(addMonths(base, 2));

  return {
    vencimiento_ciclo_1: ciclo1,
    vencimiento_ciclo_2: ciclo2,
    vencimiento_ciclo_3: ciclo3
  };
};

const verificarTopeCiclosLibre = (credito, hoyYMD = todayYMD()) => {
  if (!credito) return;

  const saldo = toNumber(credito?.saldo_actual);
  if (saldo <= 0) return;

  const ciclos = obtenerFechasCiclosLibre(credito);
  const vto3 = ciclos?.vencimiento_ciclo_3;
  if (!vto3) return;

  // Si ya pasó el vencimiento del 3er ciclo y aún hay saldo, no puede seguir: debe cancelar o refinanciar.
  if (String(hoyYMD) > String(vto3)) {
    const err = new Error(
      `Crédito LIBRE superó el tope de ${LIBRE_MAX_CICLOS} ciclos. Debe cancelarse o refinanciarse.`
    );
    err.status = 400;
    throw err;
  }
};

/**
 * ✅ Cálculo de mora para LIBRE (sin contar el mismo día del compromiso)
 * Regla: mora_diaria = 2.5% del INTERÉS DEL MES (sobre capital pendiente), por día de atraso.
 * Días en mora = días completos transcurridos desde el día SIGUIENTE a fecha_compromiso_pago.
 */
const calcularMoraLibre = (credito, hoy = ymdDate(todayYMD())) => {
  if (!credito) return 0;

  const fcp = credito.fecha_compromiso_pago;
  if (!fcp) return 0;

  // No hay mora si hoy es el mismo día o antes del compromiso (comparación YMD)
  const hoyY = ymd(hoy);
  const fcpY = ymd(fcp);
  if (hoyY <= fcpY) return 0;

  // Días completos: desde el día siguiente al compromiso
  const dias = differenceInCalendarDays(ymdDate(hoy), ymdDate(fcp));
  if (dias <= 0) return 0;

  const tasaMensualPct = normalizePercent(credito.interes, 0); // % mensual guardado
  if (tasaMensualPct <= 0) return 0;

  const capital = toNumber(credito.saldo_actual);
  if (capital <= 0) return 0;

  const interesMes = fix2(capital * (tasaMensualPct / 100.0));
  const mora = fix2(interesMes * MORA_DIARIA * dias);
  return mora;
};

// ✅ Interés del ciclo (mes) para LIBRE (sobre capital pendiente)
const calcularInteresCicloLibre = (credito) => {
  if (!credito) return 0;
  const tasaMensualPct = normalizePercent(credito.interes, 0);
  if (tasaMensualPct <= 0) return 0;
  const capital = toNumber(credito.saldo_actual);
  if (capital <= 0) return 0;
  return fix2(capital * (tasaMensualPct / 100.0));
};

// En LIBRE, el importe visible de la cuota es SOLO capital pendiente
const calcularImporteCuotaLibre = (credito) => {
  return fix2(toNumber(credito?.saldo_actual || 0));
};

/**
 * ✅ Refrescar cuota LIBRE
 * - Importe = capital
 * - Mora = según regla
 * - Estado 'vencida' SOLO si ya pasó el día del compromiso (no el mismo día)
 */
const refrescarCuotaLibre = async (creditoId, t = null) => {
  const credito = await Credito.findByPk(creditoId, t ? { transaction: t } : undefined);
  if (!credito) return;
  if (!esLibre(credito)) return;

  const hoyYMD = todayYMD();
  verificarTopeCiclosLibre(credito, hoyYMD);

  // Buscar/crear cuota 1
  let cuotaLibre = await Cuota.findOne({
    where: { credito_id: credito.id },
    order: [['numero_cuota', 'ASC']],
    ...(t && { transaction: t })
  });

  const nuevoImporte = fix2(calcularImporteCuotaLibre(credito));

  // ✅ Fuente de verdad: cuota.service (resumen LIBRE)
  let resumen = null;
  try {
    const { obtenerResumenLibrePorCredito } = await import('./cuota.service.js');
    resumen = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD));
  } catch (e) {
    resumen = null;
  }

  const moraLibre = fix2(
    resumen?.mora_pendiente_total ?? resumen?.mora_pendiente_hoy ?? calcularMoraLibre(credito, ymdDate(hoyYMD))
  );

  const ciclos = obtenerFechasCiclosLibre(credito);
  const cicloActual = Math.min(Math.max(toNumber(resumen?.ciclo_actual || 1), 1), LIBRE_MAX_CICLOS);
  const vtoCicloYMD =
    cicloActual === 1 ? ciclos?.vencimiento_ciclo_1 :
      cicloActual === 2 ? ciclos?.vencimiento_ciclo_2 :
        ciclos?.vencimiento_ciclo_3;

  const diasAtraso = (vtoCicloYMD && String(hoyYMD) > String(vtoCicloYMD))
    ? Math.max(differenceInCalendarDays(ymdDate(hoyYMD), ymdDate(vtoCicloYMD)), 0)
    : 0;

  const nuevoEstado = diasAtraso > 0 ? 'vencida' : 'pendiente';

  if (cuotaLibre) {
    await cuotaLibre.update({
      importe_cuota: nuevoImporte,
      intereses_vencidos_acumulados: moraLibre,
      estado: nuevoEstado
    }, { transaction: t || undefined });
  } else {
    // defensivo: creamos la cuota única libre si faltara
    cuotaLibre = await Cuota.create({
      credito_id: credito.id,
      numero_cuota: 1,
      importe_cuota: fix2(nuevoImporte),
      fecha_vencimiento: LIBRE_VTO_FICTICIO,
      estado: nuevoEstado,
      forma_pago_id: null,
      descuento_cuota: 0.0,
      intereses_vencidos_acumulados: fix2(moraLibre),
      monto_pagado_acumulado: 0.0
    }, t ? { transaction: t } : undefined);
  }
};

/* ===================== TOTAL ACTUAL (campo calculado) ===================== */
/**
 * Calcula el total actual del crédito (sin tocar DB):
 * - LIBRE: ✅ TOTAL DEL CICLO HOY (interpretación correcta para UI):
 *          capital pendiente + interés del ciclo + mora (si hubiera).
 *          (Nota: para exactitud con pagos parciales de interés, se recomienda usar el resumen
 *           de cuota.service (obtenerResumenLibrePorCredito), que descuenta interés ya cobrado.)
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
      fix2(toNumber(c.importe_cuota) - toNumber(c.descuento_cuota) - toNumber(c.monto_pagado_acumulado)), 0
    );
    const mora = fix2(toNumber(c.intereses_vencidos_acumulados));
    total = fix2(total + principalPend + mora);
  }
  return total;
};

/**
 * ✅ Obtiene el TOTAL "HOY" de un crédito LIBRE usando la fuente de verdad:
 * cuota.service.obtenerResumenLibrePorCredito (descuenta interés del ciclo ya cobrado).
 */
const obtenerTotalHoyLibreExacto = async (creditoId, fecha = ymdDate(todayYMD())) => {
  const { obtenerResumenLibrePorCredito } = await import('./cuota.service.js');
  const resumen = await obtenerResumenLibrePorCredito(creditoId, fecha);
  const total = toNumber(resumen?.total_liquidacion_hoy);
  return fix2(total);
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
    verificarTopeCiclosLibre(credito, hoyYMD);

    const importe = calcularImporteCuotaLibre(credito);

    // ✅ Fuente de verdad: cuota.service (resumen LIBRE)
    let resumen = null;
    try {
      const { obtenerResumenLibrePorCredito } = await import('./cuota.service.js');
      resumen = await obtenerResumenLibrePorCredito(credito_id, ymdDate(hoyYMD));
    } catch (e) {
      resumen = null;
    }

    const moraLibre = fix2(
      resumen?.mora_pendiente_total ?? resumen?.mora_pendiente_hoy ?? calcularMoraLibre(credito, ymdDate(hoyYMD))
    );

    const ciclos = obtenerFechasCiclosLibre(credito);
    const cicloActual = Math.min(Math.max(toNumber(resumen?.ciclo_actual || 1), 1), LIBRE_MAX_CICLOS);
    const vtoCicloYMD =
      cicloActual === 1 ? ciclos?.vencimiento_ciclo_1 :
        cicloActual === 2 ? ciclos?.vencimiento_ciclo_2 :
          ciclos?.vencimiento_ciclo_3;

    const diasAtraso = (vtoCicloYMD && String(hoyYMD) > String(vtoCicloYMD))
      ? Math.max(differenceInCalendarDays(ymdDate(hoyYMD), ymdDate(vtoCicloYMD)), 0)
      : 0;

    const estado = diasAtraso > 0 ? 'vencida' : 'pendiente';

    await Cuota.create({
      credito_id,
      numero_cuota: 1,
      importe_cuota: fix2(importe),
      fecha_vencimiento: LIBRE_VTO_FICTICIO,
      estado,
      forma_pago_id: null,
      descuento_cuota: 0.00,
      intereses_vencidos_acumulados: fix2(moraLibre),
      monto_pagado_acumulado: 0.00
    }, t ? { transaction: t } : undefined);
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
    cuotasArr[n - 1].importe_cuota = parseFloat(
      (cuotasArr[n - 1].importe_cuota + diff).toFixed(2)
    );
  } else {
    const fija = parseFloat((M / n).toFixed(2));
    for (let i = 1; i <= n; i++) {
      cuotasArr.push({ numero_cuota: i, importe_cuota: fija });
    }
    const totalCalc = fija * n;
    const diff = parseFloat((M - totalCalc).toFixed(2));
    cuotasArr[n - 1].importe_cuota = parseFloat(
      (cuotasArr[n - 1].importe_cuota + diff).toFixed(2)
    );
  }

  // Fecha base = fecha_compromiso_pago
  const [year, month, day] = fecha_compromiso_pago
    .split('-')
    .map((x) => parseInt(x, 10));
  const fechaBase = new Date(year, month - 1, day);

  // Crear registros
  const bulk = cuotasArr.map(({ numero_cuota, importe_cuota }) => {
    const dias =
      tipo_credito === 'semanal' ? 7 :
        tipo_credito === 'quincenal' ? 15 : 30;
    const venc = addDays(fechaBase, dias * numero_cuota);
    return {
      credito_id,
      numero_cuota,
      importe_cuota,
      fecha_vencimiento: format(venc, 'yyyy-MM-dd'),
      estado: 'pendiente',
      forma_pago_id: null,
      descuento_cuota: 0.00,
      intereses_vencidos_acumulados: 0.00,
      monto_pagado_acumulado: 0.00
    };
  });

  await Cuota.bulkCreate(bulk, t ? { transaction: t } : undefined);
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

  let totalBase = Number((capital * (1 + interestPct / 100)).toFixed(2));

  // Descuento opcional (solo para superadmin)
  let descuentoPct = 0;
  if (rol_id === 0 && Number(descuento) > 0) {
    descuentoPct = Number(descuento);
    const discMonto = Number((totalBase * descuentoPct) / 100).toFixed(2);
    totalBase = Number((totalBase - discMonto).toFixed(2));
  }

  const M = totalBase;

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
    cuotasArr[n - 1].importe_cuota = parseFloat(
      (cuotasArr[n - 1].importe_cuota + diff).toFixed(2)
    );
  } else {
    const fija = parseFloat((M / n).toFixed(2));
    for (let i = 1; i <= n; i++) {
      cuotasArr.push({ numero_cuota: i, importe_cuota: fija });
    }
    const totalCalc = fija * n;
    const diff = parseFloat((M - totalCalc).toFixed(2));
    cuotasArr[n - 1].importe_cuota = parseFloat(
      (cuotasArr[n - 1].importe_cuota + diff).toFixed(2)
    );
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

  const dias =
    tipo_credito === 'semanal' ? 7 :
      tipo_credito === 'quincenal' ? 15 : 30;

  const cuotasSimuladas = cuotasArr.map(({ numero_cuota, importe_cuota }) => {
    const venc = addDays(fechaBase, dias * numero_cuota);
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
    interes_pct: interestPct,
    descuento_pct: descuentoPct,
    monto_total_devolver: fix2(M),
    cuotas: cuotasSimuladas
  };
};

/* ===================== Precálculo para CRÉDITOS ANTIGUOS ===================== */
const marcarVencidasYCalcularMora = async (
  creditoId,
  {
    sumarSoloVencidas = true,
    fechaCorte // opcional YYYY-MM-DD
  } = {}
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
        const { recalcularMoraPorCredito } = await import('./cuota.service.js');
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

  // 3) total_actual calculado + fechas de ciclos para LIBRE
  const plain = cred.get({ plain: true });

  // ✅ IMPORTANTE: Para LIBRE usamos el total del ciclo HOY exacto (incluye capital + interés pendiente real + mora).
  let totalActual = 0;
  if (esLibre(plain)) {
    try {
      totalActual = await obtenerTotalHoyLibreExacto(pk, ymdDate(todayYMD()));
    } catch (e) {
      // fallback seguro si algo falla (no deja el front sin dato)
      totalActual = calcularTotalActualCreditoPlain(plain);
      console.error('[obtenerCreditoPorId] Fallback total_actual LIBRE:', e?.message || e);
    }
  } else {
    totalActual = calcularTotalActualCreditoPlain(plain);
  }

  cred.setDataValue('total_actual', totalActual);

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
    usuario_id = null
  } = data;

  // —— Modalidad LIBRE —— 
  if (modalidad_credito === 'libre') {
    // ✅ Regla negocio: en LIBRE, si no se especifica tasa, por defecto es 60% por ciclo.
    const tasaPorCicloPct = normalizePercent(interesInput, 60);

    const nuevo = await Credito.create({
      cliente_id,
      cobrador_id,
      monto_acreditar,
      fecha_solicitud: fecha_solicitud || todayYMD(),
      fecha_acreditacion,
      fecha_compromiso_pago,
      interes: tasaPorCicloPct,
      tipo_credito: 'mensual',
      cantidad_cuotas: 1,
      modalidad_credito,
      descuento: 0,
      monto_total_devolver: fix2(monto_acreditar),
      saldo_actual: fix2(monto_acreditar),
      interes_acumulado: 0.00,
      origen_venta_manual_financiada,
      detalle_producto
    }, t ? { transaction: t } : undefined);

    verificarTopeCiclosLibre(nuevo);
    await generarCuotasServicio(nuevo, t || null);

    if (!origen_venta_manual_financiada) {
      try {
        const cli = await Cliente.findByPk(cliente_id, t ? { transaction: t } : undefined);
        const clienteNombre = cli ? `${cli.nombre} ${cli.apellido}` : null;
        await registrarEgresoDesembolsoCredito({
          creditoId: nuevo.id,
          clienteNombre,
          fecha_acreditacion,
          monto: monto_acreditar,
          usuario_id
        }, { t });
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

  let totalBase = Number((monto_acreditar * (1 + interestPct / 100)).toFixed(2));

  let descuentoPct = 0;
  if (rol_id === 0 && Number(descuento) > 0) {
    descuentoPct = Number(descuento);
    const discMonto = Number((totalBase * descuentoPct) / 100).toFixed(2);
    totalBase = Number((totalBase - discMonto).toFixed(2));
  }

  const nuevo = await Credito.create({
    cliente_id,
    cobrador_id,
    monto_acreditar,
    fecha_solicitud: fecha_solicitud || todayYMD(),
    fecha_acreditacion,
    fecha_compromiso_pago,
    interes: interestPct,
    tipo_credito,
    cantidad_cuotas,
    modalidad_credito,
    descuento: descuentoPct,
    monto_total_devolver: totalBase,
    saldo_actual: totalBase,
    interes_acumulado: 0.00,
    origen_venta_manual_financiada,
    detalle_producto
  }, t ? { transaction: t } : undefined);

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
      await registrarEgresoDesembolsoCredito({
        creditoId: nuevo.id,
        clienteNombre,
        fecha_acreditacion,
        monto: monto_acreditar,
        usuario_id
      }, { t });
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

    await Credito.update(
      {
        monto_acreditar: capital,
        fecha_solicitud: fecha_solicitud || existente.fecha_solicitud || todayYMD(),
        fecha_acreditacion: fecha_acreditacion || existente.fecha_acreditacion,
        fecha_compromiso_pago: fecha_compromiso_pago || existente.fecha_compromiso_pago,
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
  let totalBase = Number((capitalBase * (1 + interestPct / 100)).toFixed(2));

  let descuentoPct = 0;
  if (rol_id === 0 && Number(descuento) > 0) {
    descuentoPct = Number(descuento);
    totalBase = Number((totalBase - (totalBase * descuentoPct) / 100).toFixed(2));
  }

  await Credito.update(
    {
      monto_acreditar: capitalBase,
      fecha_solicitud: fecha_solicitud || existente.fecha_solicitud || todayYMD(),
      fecha_acreditacion: fecha_acreditacion || existente.fecha_acreditacion,
      fecha_compromiso_pago: fecha_compromiso_pago || existente.fecha_compromiso_pago,
      interes: interestPct,
      tipo_credito: nuevoTipo,
      cantidad_cuotas: nuevasCuotas,
      modalidad_credito,
      descuento: descuentoPct,
      monto_total_devolver: totalBase,
      saldo_actual: totalBase,
      interes_acumulado: 0.00,
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

/* ===================== Estado del crédito (no cambia para libre/refinanciado) ===================== */
export async function actualizarEstadoCredito(credito_id, transaction = null) {
  const credito = await Credito.findByPk(
    credito_id,
    transaction ? { transaction } : undefined
  );
  if (!credito) return;

  const estadoActual = String(credito.estado || '').toLowerCase();

  if (estadoActual === 'refinanciado') {
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

  const todasPagadas = cuotas.every(c => String(c.estado).toLowerCase() === 'pagada');
  const activas = cuotas.filter(c => String(c.estado).toLowerCase() !== 'pagada');
  const todasActivasVencidas = activas.length > 0 && activas.every(c => String(c.estado).toLowerCase() === 'vencida');

  const nuevoEstado = todasPagadas
    ? 'pagado'
    : (todasActivasVencidas ? 'vencido' : 'pendiente');

  await Credito.update(
    { estado: nuevoEstado },
    { where: { id: credito_id }, ...(transaction && { transaction }) }
  );
}

/* ============================================================
 *  CANCELACIÓN / PAGO ANTICIPADO
 * ============================================================ */

const cancelarCreditoLibre = async ({
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
  verificarTopeCiclosLibre(credito, hoyYMD);

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

  // ✅ Resumen LIBRE (interés/mora) calculado en cuota.service
  let resumen = null;
  let interesPendiente = 0;
  let moraPendiente = 0;
  let cicloLibre = null;
  try {
    const { obtenerResumenLibrePorCredito } = await import('./cuota.service.js');
    resumen = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD));
    interesPendiente = fix2(resumen?.interes_pendiente_total ?? resumen?.interes_pendiente_hoy ?? 0);
    moraPendiente = fix2(resumen?.mora_pendiente_total ?? resumen?.mora_pendiente_hoy ?? 0);
    cicloLibre = resumen?.ciclo_actual ?? null;
  } catch (_) {
    interesPendiente = 0;
    moraPendiente = fix2(calcularMoraLibre(credito, ymdDate(hoyYMD)));
    cicloLibre = null;
  }

  const pct = Math.min(Math.max(toNumber(descuento_porcentaje), 0), 100);

  if (pct > 0 && rol_id !== null && rol_id !== 0) {
    const err = new Error('Solo un superadmin puede aplicar descuentos en la cancelación del crédito.');
    err.status = 403;
    throw err;
  }

  // ✅ Descuento: si es sobre TOTAL, se aplica en orden Mora → Interés → Capital.
  let descSobreMora = 0;
  let descSobreInteres = 0;
  let descSobrePrincipal = 0;

  if (String(descuento_sobre) === 'total') {
    const base = fix2(saldoPendiente + interesPendiente + moraPendiente);
    let totalDescuento = fix2(base * (pct / 100));

    descSobreMora = Math.min(totalDescuento, moraPendiente);
    totalDescuento = fix2(totalDescuento - descSobreMora);

    descSobreInteres = Math.min(totalDescuento, interesPendiente);
    totalDescuento = fix2(totalDescuento - descSobreInteres);

    descSobrePrincipal = Math.min(totalDescuento, saldoPendiente);
  } else {
    descSobreMora = fix2(moraPendiente * (pct / 100));
    descSobreInteres = 0;
    descSobrePrincipal = 0;
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
        // mantenemos el comportamiento anterior: acumular mora en interes_acumulado
        interes_acumulado: fix2(toNumber(credito.interes_acumulado) + moraNeta)
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

    const recibo = await createReciboSafe(
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

        saldo_mora: 0.00,

        // ✅ nuevo campo (nullable) para tracking de ciclo
        ciclo_libre: cicloLibre
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
    await t.rollback();
    throw e;
  }
};


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
    verificarTopeCiclosLibre(credito);
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

  const { recalcularMoraCuota } = await import('./cuota.service.js');

  const cuotasPend = (credito.cuotas || [])
    .filter(c => c.estado !== 'pagada')
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

        saldo_mora: 0.00
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
      try { await t.rollback(); } catch (_) { }
    }
    throw e;
  }
};

/* ===================== Refinanciación ===================== */
export const refinanciarCredito = async ({
  creditoId,
  opcion,
  tasaManual = 0,
  cantidad_cuotas,
  tipo_credito,
  rol_id = null
}) => {
  let original = await Credito.findByPk(creditoId, {
    include: [{ model: Cuota, as: 'cuotas' }]
  });
  if (!original) throw new Error('Crédito no encontrado');

  const estadoOriginal = String(original.estado || '').toLowerCase();
  if (estadoOriginal === 'refinanciado') {
    const err = new Error('Este crédito ya fue refinanciado y no puede volver a refinanciarse.');
    err.status = 400;
    throw err;
  }

  const modalidad = String(original.modalidad_credito || '').toLowerCase();

  if (!['comun', 'progresivo', 'libre'].includes(modalidad)) {
    const err = new Error('Solo se permite refinanciar créditos de modalidad "comun", "progresivo" o "libre".');
    err.status = 400;
    throw err;
  }

  if (modalidad === 'libre') {
    try {
      await refrescarCuotaLibre(creditoId);
      original = await Credito.findByPk(creditoId, {
        include: [{ model: Cuota, as: 'cuotas' }]
      });
    } catch (e) {
      console.error('[refinanciarCredito] Error al refrescar crédito LIBRE antes de refinanciar:', e?.message || e);
    }
  }

  if (opcion === 'manual' && rol_id !== null && rol_id !== 0) {
    const err = new Error('Solo un superadmin puede usar la tasa manual (P3) en la refinanciación.');
    err.status = 403;
    throw err;
  }

  // ✅ Base refinanciable:
  // - LIBRE: usar TOTAL LIQUIDACIÓN HOY exacto (capital + interés pendiente real + mora)
  // - COMUN/PROGRESIVO: saldo_actual + mora pendiente de cuotas activas
  const cuotasNP = (original.cuotas || []).filter(q => q.estado !== 'pagada');
  const moraPendiente = cuotasNP.reduce((acc, q) => acc + toNumber(q.intereses_vencidos_acumulados), 0);

  let saldoBase = 0;
  if (modalidad === 'libre') {
    try {
      saldoBase = await obtenerTotalHoyLibreExacto(creditoId, ymdDate(todayYMD()));
    } catch (e) {
      // fallback por si algo raro pasa: al menos capital + interesCiclo + mora
      const capitalPend = fix2(toNumber(original.saldo_actual));
      const interesCiclo = fix2(calcularInteresCicloLibre(original));
      saldoBase = fix2(capitalPend + interesCiclo + moraPendiente);
      console.error('[refinanciarCredito] Fallback saldoBase LIBRE:', e?.message || e);
    }
  } else {
    saldoBase = fix2(toNumber(original.saldo_actual) + moraPendiente);
  }

  let tasaMensual;
  if (opcion === 'P1') tasaMensual = 25;
  else if (opcion === 'P2') tasaMensual = 15;
  else if (opcion === 'manual') tasaMensual = toNumber(tasaManual);
  else throw new Error('Opción de refinanciación inválida');

  if (tasaMensual < 0) {
    const err = new Error('La tasa mensual no puede ser negativa.');
    err.status = 400;
    throw err;
  }

  const nuevoTipo = tipo_credito || original.tipo_credito;
  const nuevasCuotas = Number.isFinite(Number(cantidad_cuotas)) && Number(cantidad_cuotas) > 0
    ? Number(cantidad_cuotas)
    : original.cantidad_cuotas;

  const pl = periodLengthFromTipo(nuevoTipo);
  const tasaPorPeriodo = tasaMensual / pl;

  const interesTotalPct = tasaPorPeriodo * nuevasCuotas;
  const interesTotalMonto = fix2(saldoBase * (interesTotalPct / 100.0));
  const nuevoMonto = fix2(saldoBase + interesTotalMonto);

  const t = await Credito.sequelize.transaction();
  try {
    await original.update({
      estado: 'refinanciado',
      opcion_refinanciamiento: opcion,
      tasa_refinanciacion: tasaMensual
    }, { transaction: t });

    const cuotasAfectadas = await Cuota.findAll({
      where: {
        credito_id: creditoId,
        estado: { [Op.in]: ['pendiente', 'parcial', 'vencida'] }
      },
      transaction: t
    });
    const idsAfectadas = cuotasAfectadas.map(c => c.id);

    const pagosPorCuota = await Pago.findAll({
      attributes: ['cuota_id'],
      where: { cuota_id: { [Op.in]: idsAfectadas } },
      transaction: t
    });
    const setConPagos = new Set(pagosPorCuota.map(p => p.cuota_id));

    const idsConPagos = idsAfectadas.filter(id => setConPagos.has(id));
    const idsSinPagos = idsAfectadas.filter(id => !setConPagos.has(id));

    if (idsSinPagos.length > 0) {
      await Recibo.destroy({ where: { cuota_id: { [Op.in]: idsSinPagos } }, transaction: t });
      await Cuota.destroy({ where: { id: { [Op.in]: idsSinPagos } }, transaction: t });
    }

    if (idsConPagos.length > 0) {
      await Cuota.update(
        { estado: 'refinanciada', intereses_vencidos_acumulados: 0 },
        { where: { id: { [Op.in]: idsConPagos } }, transaction: t }
      );
    }

    const hoy = todayYMD();

    const nuevo = await Credito.create({
      cliente_id: original.cliente_id,
      cobrador_id: original.cobrador_id,

      // ✅ principal refinanciado (deuda base real)
      monto_acreditar: saldoBase,

      fecha_solicitud: hoy,
      fecha_acreditacion: hoy,
      fecha_compromiso_pago: hoy,

      interes: tasaMensual,
      tipo_credito: nuevoTipo,
      cantidad_cuotas: nuevasCuotas,
      modalidad_credito: 'comun',
      descuento: 0,

      // ✅ total del nuevo plan
      monto_total_devolver: nuevoMonto,
      saldo_actual: nuevoMonto,

      interes_acumulado: fix2(toNumber(original.interes_acumulado) + 0),
      id_credito_origen: original.id,
      origen_venta_manual_financiada: original.origen_venta_manual_financiada ?? false,
      detalle_producto: original.detalle_producto
    }, { transaction: t });

    await generarCuotasServicio(nuevo, t);

    await t.commit();
    return nuevo.id;
  } catch (e) {
    if (t.finished !== 'commit') {
      try { await t.rollback(); } catch (_) { }
    }
    throw e;
  }
};

/* ===================== Eliminación / utilidades ===================== */
export const esCreditoEliminable = async (id) => {
  const cuotas = await Cuota.findAll({ attributes: ['id'], where: { credito_id: id } });
  const cuotaIds = cuotas.map(c => c.id);
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
    const cuotaIds = cuotas.map(c => c.id);

    if (cuotaIds.length === 0) {
      await Credito.destroy({ where: { id }, transaction: t });
      await CajaMovimiento.destroy({
        where: { referencia_tipo: 'credito', referencia_id: id },
        transaction: t
      });
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

    await CajaMovimiento.destroy({
      where: { referencia_tipo: 'credito', referencia_id: id },
      transaction: t
    });

    await t.commit();
    return { ok: true, mensaje: 'Crédito eliminado correctamente.' };
  } catch (e) {
    if (t.finished !== 'commit') {
      try { await t.rollback(); } catch (_) { }
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
    const conCuotasVencidas = query.conCuotasVencidas === true || query.conCuotasVencidas === 'true' || query.conCuotasVencidas === '1';

    const whereCredito = {};
    if (estado) whereCredito.estado = estado;
    if (modalidad) whereCredito.modalidad_credito = modalidad;
    if (tipo) whereCredito.tipo_credito = tipo;

    if (desde || hasta) {
      const rango = {};
      if (desde) rango[Op.gte] = desde;
      if (hasta) rango[Op.lte] = hasta;
      whereCredito[Op.or] = [
        { fecha_acreditacion: rango },
        { fecha_compromiso_pago: rango }
      ];
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
      plain.creditos = plain.creditos.filter(cr =>
        Array.isArray(cr.cuotas) && cr.cuotas.some(ct => String(ct.estado) === 'vencida')
      );
    }

    // ✅ Mapa: crédito original refinanciado -> crédito nuevo (más reciente)
    let mapHijosPorOrigen = new Map();
    try {
      const idsOriginalesRefi = (plain.creditos || [])
        .filter(cr => String(cr.estado || '').toLowerCase() === 'refinanciado')
        .map(cr => cr.id);

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

    // ✅ Importante: necesitamos await para setear total_actual LIBRE exacto
    for (const cr of (plain.creditos || [])) {
      if (Array.isArray(cr.cuotas)) cr.cuotas.sort((x, y) => x.numero_cuota - y.numero_cuota);

      if (esLibre(cr)) {
        // total_actual = total del ciclo HOY exacto (capital + interés pendiente real + mora)
        try {
          cr.total_actual = await obtenerTotalHoyLibreExacto(cr.id, ymdDate(todayYMD()));
        } catch (e) {
          cr.total_actual = calcularTotalActualCreditoPlain(cr);
          console.error('[obtenerCreditosPorCliente] Fallback total_actual LIBRE:', e?.message || e);
        }

        const ciclos = obtenerFechasCiclosLibre(cr);
        if (ciclos) {
          cr.fechas_ciclos_libre = ciclos;
        }
      } else {
        cr.total_actual = calcularTotalActualCreditoPlain(cr);
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
  const credito = await Credito.findByPk(id);
  if (!credito) throw new Error('Crédito no encontrado');

  if (String(credito.estado || '').toLowerCase() === 'pagado') {
    const err = new Error('No se puede anular un crédito pagado.');
    err.status = 400;
    throw err;
  }

  await Cuota.destroy({ where: { credito_id: id } });
  credito.estado = 'anulado';
  await credito.save();
  return credito;
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

/* ===================== Resumen LIBRE (para UI/servicios) ===================== */
export const obtenerResumenLibre = async (creditoId, fecha = ymdDate(todayYMD())) => {
  const { obtenerResumenLibrePorCredito } = await import('./cuota.service.js');
  return obtenerResumenLibrePorCredito(creditoId, fecha);
};

/* ===================== Utilidades LIBRE exportadas ===================== */
export const refreshCuotaLibre = async (creditoId) => {
  await refrescarCuotaLibre(creditoId);
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
    const total_actual = toNumber(c.total_actual ?? calcularTotalActualCreditoPlain(c));
    const fechaEmision = todayYMD();

    const ciclosLibre = esLibre(c) ? obtenerFechasCiclosLibre(c) : null;

    const vtosValidos = cuotas
      .map(ct => ct.fecha_vencimiento)
      .filter(f => f && f !== LIBRE_VTO_FICTICIO)
      .map(f => ymd(f))
      .sort();

    let primerVto = vtosValidos[0]
      || (c.fecha_compromiso_pago ? ymd(c.fecha_compromiso_pago) : '-');

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
      try { res.end(); } catch (_) { }
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
        .text(`Vto 1er ciclo: ${ciclosLibre.vencimiento_ciclo_1}`)
        .text(`Vto 2° ciclo: ${ciclosLibre.vencimiento_ciclo_2}`)
        .text(`Vto 3er ciclo: ${ciclosLibre.vencimiento_ciclo_3}`);
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
        fix2(toNumber(ct.importe_cuota) - toNumber(ct.descuento_cuota) - toNumber(ct.monto_pagado_acumulado)), 0
      );
      const mora = fix2(toNumber(ct.intereses_vencidos_acumulados));
      totalPrincipalPend = fix2(totalPrincipalPend + principalPend);
      totalMora = fix2(totalMora + mora);

      const vto =
        ct.fecha_vencimiento === LIBRE_VTO_FICTICIO ? '—' :
          (ct.fecha_vencimiento ? ymd(ct.fecha_vencimiento) : '-');

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
      .text('Nota: Esta ficha es informativa. Los importes pueden variar según pagos registrados y recálculos de mora.', { align: 'left' });

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