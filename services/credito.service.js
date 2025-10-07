// backend/src/services/credito.service.js
import Cuota from '../models/Cuota.js';
import Usuario from '../models/Usuario.js';
import Zona from '../models/Zona.js';
import TareaPendiente from '../models/Tarea_pendiente.js';
import {
  addDays,
  format,
  differenceInCalendarDays,
  differenceInCalendarMonths
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
const MORA_DIARIA = 0.025;        // 2.5% por día en NO-libre
const LIBRE_MAX_CICLOS = 3;       // tope 3 meses para crédito libre
const LIBRE_VTO_FICTICIO = '2099-12-31';

/* ===================== Helpers numéricos ===================== */
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

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
 * Ej.: 5 semanas ⇒ 75%; 3 quincenas ⇒ 90%
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

/* ===================== Helpers internos Caja ===================== */

/**
 * Registra un EGRESO en caja por desembolso del crédito.
 * Se invoca al CREAR el crédito (no en refinanciación).
 * Acepta transacción opcional { t } para atomicidad.
 */
const registrarEgresoDesembolsoCredito = async ({
  creditoId,
  clienteNombre,
  fecha_acreditacion,
  monto
}, { t = null } = {}) => {
  if (!monto || toNumber(monto) <= 0) return;

  const now = new Date();
  await CajaMovimiento.create({
    fecha: fecha_acreditacion || format(now, 'yyyy-MM-dd'),
    hora: format(now, 'HH:mm:ss'),
    tipo: 'egreso',
    monto: fix2(monto),
    forma_pago_id: null, // si luego definís el medio de desembolso, lo pasamos aquí
    concepto: `Desembolso crédito #${creditoId} - ${clienteNombre || 'Cliente'}`.slice(0, 255),
    referencia_tipo: 'credito',
    referencia_id: creditoId,
    usuario_id: null
  }, t ? { transaction: t } : undefined);
};

/**
 * Registra un INGRESO en caja por un recibo generado dentro de una TX.
 * Debe llamarse DESPUÉS de crear el Recibo.
 */
const registrarIngresoDesdeReciboEnTx = async ({
  t,
  recibo,
  forma_pago_id
}) => {
  if (!recibo) return;
  const now = new Date();
  await CajaMovimiento.create({
    fecha: recibo.fecha || format(now, 'yyyy-MM-dd'),
    hora: recibo.hora || format(now, 'HH:mm:ss'),
    tipo: 'ingreso',
    monto: fix2(recibo.monto_pagado || 0),
    forma_pago_id: forma_pago_id ?? null,
    concepto: `Cobro recibo #${recibo.numero_recibo ?? ''} - ${recibo.cliente_nombre || 'Cliente'}`.slice(0, 255),
    referencia_tipo: 'recibo',
    referencia_id: recibo.numero_recibo ?? null,
    usuario_id: null
  }, { transaction: t });
};

/* ===================== Helpers de LIBRE (ciclos mensuales) ===================== */
const fechaBaseLibre = (credito) => {
  // Usamos fecha_acreditacion como inicio de ciclo; si no existe, caemos a fecha_compromiso_pago
  const f = credito?.fecha_acreditacion || credito?.fecha_compromiso_pago;
  return f || format(new Date(), 'yyyy-MM-dd');
};

const cicloLibreActual = (credito, hoy = new Date()) => {
  const [Y, M, D] = fechaBaseLibre(credito).split('-').map((x) => parseInt(x, 10));
  const inicio = new Date(Y, M - 1, D);
  const diffMeses = Math.max(differenceInCalendarMonths(hoy, inicio), 0);
  // ciclo 1: 0 meses; ciclo 2: 1 mes; ciclo 3: 2 meses
  return Math.min(LIBRE_MAX_CICLOS, diffMeses + 1);
};

const verificarTopeCiclosLibre = (credito, hoy = new Date()) => {
  const ciclo = cicloLibreActual(credito, hoy);
  const saldo = toNumber(credito?.saldo_actual);
  if (ciclo > LIBRE_MAX_CICLOS && saldo > 0) {
    const err = new Error(
      `Crédito LIBRE superó el tope de ${LIBRE_MAX_CICLOS} meses. Debe cancelarse el saldo pendiente.`
    );
    err.status = 400;
    throw err;
  }
};

const interesCicloLibreHoy = (credito) => {
  const tasaPct = normalizePercent(credito?.interes, 60);
  const tasaDec = percentToDecimal(tasaPct);
  const capital = toNumber(credito?.saldo_actual);
  return fix2(capital * tasaDec);
};

const calcularImporteCuotaLibre = (credito) => {
  // Mostrar SIEMPRE "capital pendiente + interés del ciclo vigente" (sin mora)
  return fix2(toNumber(credito?.saldo_actual) + interesCicloLibreHoy(credito));
};

const refrescarCuotaLibre = async (creditoId, t = null) => {
  const credito = await Credito.findByPk(creditoId, t ? { transaction: t } : undefined);
  if (!credito) return;
  if (!esLibre(credito)) return;

  // Enforzamos tope de 3 meses
  verificarTopeCiclosLibre(credito);

  const cuotaLibre = await Cuota.findOne({
    where: { credito_id: credito.id },
    order: [['numero_cuota', 'ASC']],
    ...(t && { transaction: t })
  });

  const nuevoImporte = fix2(calcularImporteCuotaLibre(credito));

  if (cuotaLibre) {
    await cuotaLibre.update({ importe_cuota: nuevoImporte }, { transaction: t || undefined });
  } else {
    // defensivo: creamos la cuota única libre si faltara
    await Cuota.create({
      credito_id: credito.id,
      numero_cuota: 1,
      importe_cuota: nuevoImporte,
      fecha_vencimiento: LIBRE_VTO_FICTICIO,
      estado: 'pendiente',
      forma_pago_id: null,
      descuento_cuota: 0.0,
      intereses_vencidos_acumulados: 0.0,
      monto_pagado_acumulado: 0.0
    }, t ? { transaction: t } : undefined);
  }
};

/* ===================== Generación de cuotas ===================== */
/**
 * Genera las cuotas de un crédito según su modalidad:
 *  - comun / progresivo: con vencimientos por período (semanal/quincenal/mensual)
 *  - libre: CREA UNA SOLA CUOTA “ABIERTA”, sin mora y con vencimiento ficticio (2099-12-31)
 *           MOSTRANDO como importe el TOTAL DEL CICLO (capital pendiente + interés del ciclo)
 * Acepta transacción opcional `t` para asegurar consistencia en refi/creación.
 */
const generarCuotasServicio = async (credito, t = null) => {
  const {
    id: credito_id,
    cantidad_cuotas: n,
    tipo_credito,
    monto_total_devolver: M,
    modalidad_credito,
    fecha_compromiso_pago
  } = credito.get ? credito.get({ plain: true }) : credito;

  // Caso LIBRE → 1 cuota abierta (importe = capital pendiente + interés del ciclo)
  if (modalidad_credito === 'libre') {
    await Cuota.destroy({ where: { credito_id }, ...(t && { transaction: t }) }); // limpieza defensiva
    // Enforzar tope 3 meses
    verificarTopeCiclosLibre(credito);
    const importe = calcularImporteCuotaLibre(credito);

    await Cuota.create({
      credito_id,
      numero_cuota: 1,
      importe_cuota: fix2(importe),
      fecha_vencimiento: LIBRE_VTO_FICTICIO,
      estado: 'pendiente',
      forma_pago_id: null,
      descuento_cuota: 0.00,
      intereses_vencidos_acumulados: 0.00,
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

  // Fecha base
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

/* ===================== Listado / detalle ===================== */
export const obtenerCreditos = async (query) => {
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

export const obtenerCreditoPorId = async (id) => {
  const cred = await Credito.findByPk(id, {
    include: [
      { model: Cliente, as: 'cliente', attributes: ['id', 'nombre', 'apellido'] },
      { model: Cuota, as: 'cuotas', separate: true, order: [['numero_cuota', 'ASC']] }
    ]
  });
  // Si es LIBRE, refresco el importe de la cuota para que muestre el ciclo vigente
  if (cred && esLibre(cred)) {
    await refrescarCuotaLibre(cred.id);
    return Credito.findByPk(id, {
      include: [
        { model: Cliente, as: 'cliente', attributes: ['id', 'nombre', 'apellido'] },
        { model: Cuota, as: 'cuotas', separate: true, order: [['numero_cuota', 'ASC']] }
      ]
    });
  }
  return cred;
};

/* ===================== Precálculo para CRÉDITOS ANTIGUOS ===================== */
const marcarVencidasYCalcularMora = async (
  creditoId,
  {
    sumarSoloVencidas = true,
    fechaCorte = format(new Date(), 'yyyy-MM-dd')
  } = {}
) => {
  const credito = await Credito.findByPk(creditoId);
  if (!credito || esLibre(credito)) return;

  const cuotas = await Cuota.findAll({ where: { credito_id: creditoId } });
  for (const c of cuotas) {
    const fv = c.fecha_vencimiento;
    if (fv && fv < fechaCorte) {
      const dias = Math.max(differenceInCalendarDays(new Date(fechaCorte), new Date(fv)), 0);
      const mora = fix2(toNumber(c.importe_cuota) * MORA_DIARIA * dias);
      await c.update({
        estado: 'vencida',
        intereses_vencidos_acumulados: mora
      });
    } else if (!sumarSoloVencidas) {
      if (toNumber(c.intereses_vencidos_acumulados) !== 0) {
        await c.update({ intereses_vencidos_acumulados: 0 });
      }
    }
  }
};

/* ===================== Crear / Actualizar ===================== */
/**
 * Ahora soporta options.transaction (t) para ejecutar TODO dentro de la misma TX:
 * - Crear crédito
 * - Generar cuotas
 * - Registrar egreso de desembolso en caja
 */
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
    origen_venta_manual_financiada = false, // ⬅️ NUEVO: prioridad a interés manual
    // banderas de precálculo histórico (NO aplican a libre)
    recalcular_hasta_hoy = true,
    sumar_interes_solo_vencidas = true,
    fecha_corte = null
  } = data;

  // —— Modalidad LIBRE — solo hasta 3 meses —— 
  if (modalidad_credito === 'libre') {
    const tasaPorCicloPct = normalizePercent(interesInput, 60);
    const tasaDec = percentToDecimal(tasaPorCicloPct);

    const nuevo = await Credito.create({
      cliente_id,
      cobrador_id,
      monto_acreditar,
      fecha_solicitud: fecha_solicitud || format(new Date(), 'yyyy-MM-dd'),
      fecha_acreditacion,
      fecha_compromiso_pago,
      interes: tasaPorCicloPct,    // 60 = 60%
      tipo_credito: 'mensual',     // para libre consideramos ciclos mensuales
      cantidad_cuotas: 1,          // 1 cuota abierta
      modalidad_credito,
      descuento: 0,
      // total de referencia del PRIMER ciclo (no se usa para saldo)
      monto_total_devolver: fix2(monto_acreditar * (1 + tasaDec)),
      // el saldo representa SIEMPRE el capital pendiente
      saldo_actual: fix2(monto_acreditar),
      interes_acumulado: 0.00
    }, t ? { transaction: t } : undefined);

    // Enforzamos ciclos y generamos cuota 1
    verificarTopeCiclosLibre(nuevo);
    await generarCuotasServicio(nuevo, t || null);

    // EGRESO en Caja por desembolso (LIBRE)
    try {
      const cli = await Cliente.findByPk(cliente_id, t ? { transaction: t } : undefined);
      const clienteNombre = cli ? `${cli.nombre} ${cli.apellido}` : null;
      await registrarEgresoDesembolsoCredito({
        creditoId: nuevo.id,
        clienteNombre,
        fecha_acreditacion,
        monto: monto_acreditar
      }, { t });
    } catch (e) {
      // Log defensivo; no interrumpe la creación del crédito
      console.error('[Caja][Desembolso libre] No se pudo registrar movimiento:', e?.message || e);
    }

    return nuevo.id;
  }

  // —— común / progresivo — interés MANUAL si proviene de venta financiada —— 
  let interestPct;
  if (origen_venta_manual_financiada && typeof interesInput !== 'undefined') {
    // Prioridad al interés manual provisto por la venta (ej. 60 ó 0.60)
    interestPct = normalizePercent(interesInput);
  } else {
    // Regla estándar (mínimo 60 proporcional por períodos)
    interestPct = calcularInteresProporcionalMin60(tipo_credito, cantidad_cuotas);
  }

  let totalBase = Number((monto_acreditar * (1 + interestPct / 100)).toFixed(2));

  // Descuento opcional (superadmin)
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
    fecha_solicitud: fecha_solicitud || format(new Date(), 'yyyy-MM-dd'),
    fecha_acreditacion,
    fecha_compromiso_pago,
    interes: interestPct,
    tipo_credito,
    cantidad_cuotas,
    modalidad_credito,
    descuento: descuentoPct,
    monto_total_devolver: totalBase,
    saldo_actual: totalBase,
    interes_acumulado: 0.00
  }, t ? { transaction: t } : undefined);

  await generarCuotasServicio(nuevo, t || null);

  // Créditos antiguos → precálculo de mora/interés por atraso (opcional)
  if (recalcular_hasta_hoy !== false) {
    await marcarVencidasYCalcularMora(nuevo.id, {
      sumarSoloVencidas: sumar_interes_solo_vencidas !== false,
      fechaCorte: fecha_corte || format(new Date(), 'yyyy-MM-dd')
    });
  }

  // EGRESO en Caja por desembolso (común/progresivo)
  try {
    const cli = await Cliente.findByPk(cliente_id, t ? { transaction: t } : undefined);
    const clienteNombre = cli ? `${cli.nombre} ${cli.apellido}` : null;
    await registrarEgresoDesembolsoCredito({
      creditoId: nuevo.id,
      clienteNombre,
      fecha_acreditacion,
      monto: monto_acreditar
    }, { t });
  } catch (e) {
    console.error('[Caja][Desembolso común/progresivo] No se pudo registrar movimiento:', e?.message || e);
  }

  return nuevo.id;
};

/**
 * Actualizar un crédito:
 *  - común/progresivo → recalcula interés (proporcional, mínimo 60) y REGENERA cuotas
 *  - libre            → recalcula total de ciclo = capital*(1+tasa) **(solo referencia)** y
 *                       ACTUALIZA la cuota abierta para que muestre capital+interés del ciclo.
 *                       **No tocamos saldo_actual** (sigue siendo capital).
 *  - Para créditos antiguos: mismas banderas de precálculo histórico
 */
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
    origen_venta_manual_financiada = false,
    recalcular_hasta_hoy = true,
    sumar_interes_solo_vencidas = true,
    fecha_corte = null
  } = data;

  // —— LIBRE → recalcular referencia de ciclo y refrescar cuota —— 
  if (modalidad_credito === 'libre') {
    const tasaPorCicloPct = normalizePercent(
      typeof interesInput !== 'undefined' ? interesInput : existente.interes,
      60
    );
    const tasaDec = percentToDecimal(tasaPorCicloPct);
    const capital = toNumber(typeof monto_acreditar !== 'undefined' ? monto_acreditar : existente.monto_acreditar);

    await Credito.update(
      {
        monto_acreditar: capital,
        fecha_solicitud: fecha_solicitud || existente.fecha_solicitud || format(new Date(), 'yyyy-MM-dd'),
        fecha_acreditacion: fecha_acreditacion || existente.fecha_acreditacion,
        fecha_compromiso_pago: fecha_compromiso_pago || existente.fecha_compromiso_pago,
        interes: tasaPorCicloPct,
        tipo_credito: 'mensual',
        cantidad_cuotas: 1,
        modalidad_credito,
        descuento: 0,
        // solo referencia del ciclo, el saldo_actual sigue siendo capital pendiente
        monto_total_devolver: fix2(capital * (1 + tasaDec))
      },
      { where: { id } }
    );

    // Refrescar cuota para mostrar capital+interés del ciclo vigente
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
      fecha_solicitud: fecha_solicitud || existente.fecha_solicitud || format(new Date(), 'yyyy-MM-dd'),
      fecha_acreditacion: fecha_acreditacion || existente.fecha_acreditacion,
      fecha_compromiso_pago: fecha_compromiso_pago || existente.fecha_compromiso_pago,
      interes: interestPct,
      tipo_credito: nuevoTipo,
      cantidad_cuotas: nuevasCuotas,
      modalidad_credito,
      descuento: descuentoPct,
      monto_total_devolver: totalBase,
      saldo_actual: totalBase,
      interes_acumulado: 0.00
    },
    { where: { id } }
  );

  await Cuota.destroy({ where: { credito_id: id } });
  const actualizado = await Credito.findByPk(id);
  await generarCuotasServicio(actualizado);

  if (recalcular_hasta_hoy !== false) {
    await marcarVencidasYCalcularMora(actualizado.id, {
      sumarSoloVencidas: sumar_interes_solo_vencidas !== false,
      fechaCorte: fecha_corte || format(new Date(), 'yyyy-MM-dd')
    });
  }
};

/* ===================== Estado del crédito (no cambia para libre) ===================== */
export const actualizarEstadoCredito = async (credito_id, transaction = null) => {
  const cuotas = await Cuota.findAll({
    where: { credito_id },
    ...(transaction && { transaction })
  });
  const todas = cuotas.every(c => c.estado === 'pagada');
  const algunaV = cuotas.some(c => c.estado === 'vencida');
  const estado = todas ? 'pagado' : algunaV ? 'vencido' : 'pendiente';
  await Credito.update(
    { estado },
    { where: { id: credito_id }, ...(transaction && { transaction }) }
  );
};

/* ============================================================
 *  CANCELACIÓN / PAGO ANTICIPADO
 * ============================================================ */

const cancelarCreditoLibre = async ({
  credito,
  forma_pago_id,
  descuento_porcentaje = 0,
  observacion = null
}) => {
  if (!forma_pago_id) {
    const err = new Error('Debe indicar forma_pago_id');
    err.status = 400;
    throw err;
  }

  verificarTopeCiclosLibre(credito);

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

  // Interés del ciclo vigente
  const interesCiclo = interesCicloLibreHoy(credito);
  const totalBase = fix2(saldoPendiente + interesCiclo);

  // Descuento opcional sobre el total (interés + capital)
  const pct = Math.min(Math.max(toNumber(descuento_porcentaje), 0), 100);
  const totalDescuento = fix2(totalBase * (pct / 100));
  const totalAPagar = fix2(totalBase - totalDescuento);

  // Cuota única libre
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

    // Actualizar crédito: liquidado
    await Credito.update(
      {
        saldo_actual: 0,
        estado: 'pagado',
        interes_acumulado: fix2(toNumber(credito.interes_acumulado) + interesCiclo)
      },
      { where: { id: credito.id }, transaction: t }
    );

    // Cerrar la cuota abierta
    await Cuota.update(
      {
        estado: 'pagada',
        forma_pago_id,
        monto_pagado_acumulado: fix2(cuotaLibre.importe_cuota),
        intereses_vencidos_acumulados: 0
      },
      { where: { id: cuotaLibre.id }, transaction: t }
    );

    // Crear pago “resumen”
    const pagoResumen = await Pago.create(
      {
        cuota_id: cuotaLibre.id,
        monto_pagado: totalAPagar,
        fecha_pago: format(new Date(), 'yyyy-MM-dd'),
        forma_pago_id,
        observacion: `Cancelación crédito libre #${credito.id}` + (observacion ? ` - ${observacion}` : '')
      },
      { transaction: t }
    );

    // Datos para el recibo
    const [cliente, cobrador, medio] = await Promise.all([
      Cliente.findByPk(credito.cliente_id, { transaction: t }),
      Usuario.findByPk(credito.cobrador_id, { transaction: t }),
      FormaPago.findByPk(forma_pago_id, { transaction: t })
    ]);
    const now = new Date();

    const recibo = await Recibo.create(
      {
        pago_id: pagoResumen.id,
        cuota_id: cuotaLibre.id,
        cliente_id: credito.cliente_id,

        fecha: format(now, 'yyyy-MM-dd'),
        hora: format(now, 'HH:mm:ss'),

        cliente_nombre: cliente ? `${cliente.nombre} ${cliente.apellido}` : null,
        nombre_cobrador: cobrador?.nombre_completo || 'Sin cobrador asignado',

        monto_pagado: totalAPagar,
        pago_a_cuenta: totalAPagar,

        concepto: `Cancelación total crédito LIBRE #${credito.id}`,
        medio_pago: medio?.nombre || 'N/D',

        saldo_anterior: saldoAntes,
        saldo_actual: 0,

        // desgloses extra
        mora_cobrada: 0,
        principal_pagado: saldoPendiente,
        interes_ciclo_cobrado: interesCiclo,
        descuento_aplicado: totalDescuento,
        saldo_credito_anterior: saldoAntes,
        saldo_credito_actual: 0
      },
      { transaction: t }
    );

    // INGRESO en Caja por el recibo (LIBRE)
    await registrarIngresoDesdeReciboEnTx({
      t,
      recibo,
      forma_pago_id
    });

    await t.commit();

    return {
      credito_id: credito.id,
      cuotas_pagadas: 1,
      total_interes_ciclo: interesCiclo,
      total_descuento_aplicado: totalDescuento,
      total_pagado: totalAPagar,
      saldo_credito_antes: saldoAntes,
      saldo_credito_despues: 0
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
  observacion = null
}) => {
  if (!forma_pago_id) {
    const err = new Error('Debe indicar forma_pago_id');
    err.status = 400;
    throw err;
  }

  // Traer crédito + cuotas no pagadas
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

  // —— LIBRE —— 
  if (esLibre(credito)) {
    verificarTopeCiclosLibre(credito);
    return cancelarCreditoLibre({
      credito,
      forma_pago_id,
      descuento_porcentaje,
      observacion
    });
  }

  // —— común / progresivo —— 
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

  // 1) Calcular principal pendiente por cuota y total
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

  // 2) Mora del día D por cuota (idempotente con pagos)
  let totalMoraDia = 0;
  const moraHoyPorCuota = {};
  for (const { c } of info) {
    const mora = await recalcularMoraCuota(c.id);
    moraHoyPorCuota[c.id] = fix2(mora);
    totalMoraDia = fix2(totalMoraDia + mora);
  }

  // 3) Descuento global (%) sobre principal total
  const pct = Math.min(Math.max(toNumber(descuento_porcentaje), 0), 100);
  const totalDescuento = fix2(totalPrincipalPendiente * (pct / 100));

  // 4) Reparto proporcional del descuento por cuota
  const descuentos = new Map();
  if (totalPrincipalPendiente > 0 && totalDescuento > 0) {
    let asignado = 0;
    for (let i = 0; i < info.length; i++) {
      const { c, principalPend } = info[i];
      if (principalPend <= 0) { descuentos.set(c.id, 0); continue; }
      let d = fix2((principalPend / totalPrincipalPendiente) * totalDescuento);
      descuentos.set(c.id, d);
      asignado = fix2(asignado + d);
    }
    const delta = fix2(totalDescuento - asignado);
    if (Math.abs(delta) >= 0.01) {
      const last = [...info].reverse().find(x => x.principalPend > 0);
      if (last) descuentos.set(last.c.id, fix2((descuentos.get(last.c.id) || 0) + delta));
    }
  } else {
    for (const { c } of info) descuentos.set(c.id, 0);
  }

  // 5) Transacción: cerrar cuotas + actualizar crédito + crear Pago y Recibo únicos
  const t = await Credito.sequelize.transaction();
  try {
    for (const { c, principalPend } of info) {
      const descAsignado = principalPend > 0 ? Math.min(descuentos.get(c.id) || 0, principalPend) : 0;
      const nuevoDescAcum = fix2(c.descuento_cuota + descAsignado);
      const nuevoPagadoAcum = fix2(c.importe_cuota - nuevoDescAcum);

      await Cuota.update(
        {
          estado: 'pagada',
          forma_pago_id,
          descuento_cuota: nuevoDescAcum,
          monto_pagado_acumulado: nuevoPagadoAcum,
          intereses_vencidos_acumulados: 0
        },
        { where: { id: c.id }, transaction: t }
      );
    }

    const saldoAntes = fix2(credito.saldo_actual);
    const totalPagado = fix2((totalPrincipalPendiente - totalDescuento) + totalMoraDia);

    await Credito.update(
      {
        saldo_actual: 0,
        estado: 'pagado',
        interes_acumulado: fix2(toNumber(credito.interes_acumulado) + totalMoraDia)
      },
      { where: { id: credito_id }, transaction: t }
    );

    const cuotaAsociada = info[info.length - 1].c;
    const pagoResumen = await Pago.create(
      {
        cuota_id: cuotaAsociada.id,
        monto_pagado: totalPagado,
        fecha_pago: format(new Date(), 'yyyy-MM-dd'),
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

    const now = new Date();

    const recibo = await Recibo.create(
      {
        pago_id: pagoResumen.id,
        cuota_id: cuotaAsociada.id,
        cliente_id: credito.cliente_id,

        fecha: format(now, 'yyyy-MM-dd'),
        hora: format(now, 'HH:mm:ss'),

        cliente_nombre: cliente ? `${cliente.nombre} ${cliente.apellido}` : null,
        nombre_cobrador: cobrador?.nombre_completo || 'Sin cobrador asignado',

        monto_pagado: totalPagado,
        pago_a_cuenta: totalPagado,

        concepto: `Cancelación total del crédito #${credito_id} (${info.length} cuotas)`,
        medio_pago: medio?.nombre || 'N/D',

        saldo_anterior: saldoAntes,
        saldo_actual: 0,

        mora_cobrada: totalMoraDia,
        principal_pagado: fix2(totalPrincipalPendiente - totalDescuento),
        descuento_aplicado: totalDescuento,
        saldo_credito_anterior: saldoAntes,
        saldo_credito_actual: 0
      },
      { transaction: t }
    );

    // INGRESO en Caja por el recibo (común/progresivo)
    await registrarIngresoDesdeReciboEnTx({
      t,
      recibo,
      forma_pago_id
    });

    await t.commit();

    return {
      credito_id,
      cuotas_pagadas: info.length,
      total_principal_pendiente: totalPrincipalPendiente,
      total_descuento_aplicado: totalDescuento,
      total_mora_cobrada: totalMoraDia,
      total_pagado: totalPagado,
      saldo_credito_antes: saldoAntes,
      saldo_credito_despues: 0
    };
  } catch (e) {
    if (t.finished !== 'commit') {
      try { await t.rollback(); } catch (_) {}
    }
    throw e;
  }
};

/* ===================== Refinanciación (transaccional y con generación de cuotas dentro de la misma TX) ===================== */
export const refinanciarCredito = async ({
  creditoId,
  opcion,           // 'P1' | 'P2' | 'manual'
  tasaManual = 0,   // tasa mensual en %
  cantidad_cuotas,
  tipo_credito      // 'mensual' | 'semanal' | 'quincenal' (opcional, si no se envía, hereda del original)
}) => {
  const original = await Credito.findByPk(creditoId);
  if (!original) throw new Error('Crédito no encontrado');

  // ✅ Solo se puede refinanciar créditos de modalidad COMÚN
  if (String(original.modalidad_credito) !== 'comun') {
    const err = new Error('Solo se permite refinanciar créditos de modalidad "comun".');
    err.status = 400;
    throw err;
  }

  const saldo = toNumber(original.saldo_actual);

  // 1) Determinar tasa mensual por opción
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

  // 2) Periodicidad y cantidad de cuotas
  const nuevoTipo = tipo_credito || original.tipo_credito; // semanal | quincenal | mensual
  const nuevasCuotas = Number.isFinite(Number(cantidad_cuotas)) && Number(cantidad_cuotas) > 0
    ? Number(cantidad_cuotas)
    : original.cantidad_cuotas;

  const pl = periodLengthFromTipo(nuevoTipo); // 4|2|1
  const tasaPorPeriodo = tasaMensual / pl;    // ej: semanal P2 -> 15/4 = 3.75% por semana

  // 3) Interés total por período * cantidad de cuotas (lineal, no compuesto)
  const interesTotalPct = tasaPorPeriodo * nuevasCuotas;              // en %
  const interesTotalMonto = fix2(saldo * (interesTotalPct / 100.0));  // en dinero
  const nuevoMonto = fix2(saldo + interesTotalMonto);                 // total a devolver

  // 4) Crear nuevo crédito COMÚN dentro de TX (y marcar original como refinanciado)
  const t = await Credito.sequelize.transaction();
  try {
    await original.update({
      estado: 'refinanciado',
      opcion_refinanciamiento: opcion,
      tasa_refinanciacion: tasaMensual
    }, { transaction: t });

    // Eliminamos cuotas pendientes del original
    await Cuota.destroy({
      where: {
        credito_id: creditoId,
        estado: { [Op.in]: ['pendiente', 'parcial', 'vencida'] }
      },
      transaction: t
    });

    const hoy = format(new Date(), 'yyyy-MM-dd');

    const nuevo = await Credito.create({
      cliente_id: original.cliente_id,
      cobrador_id: original.cobrador_id,

      // Para refi: usamos saldo + interés lineal por período
      monto_acreditar: nuevoMonto,

      fecha_solicitud: hoy,
      fecha_acreditacion: hoy,
      fecha_compromiso_pago: hoy,

      // Guardamos la tasa mensual usada para refi (25, 15 o manual)
      interes: tasaMensual,
      tipo_credito: nuevoTipo,
      cantidad_cuotas: nuevasCuotas,
      modalidad_credito: 'comun',                   // 🔒 siempre comun en refi
      descuento: 0,

      monto_total_devolver: nuevoMonto,
      saldo_actual: nuevoMonto,

      // No sumamos nada al acumulado del original; iniciamos en 0 para el nuevo crédito
      interes_acumulado: fix2(toNumber(original.interes_acumulado) + 0),
      id_credito_origen: original.id
    }, { transaction: t });

    // Generar las cuotas (partes iguales) con el monto_total_devolver calculado
    await generarCuotasServicio(nuevo, t);

    await t.commit();
    return nuevo.id;
  } catch (e) {
    if (t.finished !== 'commit') {
      try { await t.rollback(); } catch (_) {}
    }
    throw e;
  }
};

/* ===================== Eliminación / utilidades ===================== */
export const esCreditoEliminable = async (id) => {
  // Traigo IDs de cuotas del crédito
  const cuotas = await Cuota.findAll({ attributes: ['id'], where: { credito_id: id } });
  const cuotaIds = cuotas.map(c => c.id);
  if (cuotaIds.length === 0) return { eliminable: true, cantidadPagos: 0 };

  // ¿Existen pagos para alguna de esas cuotas?
  const cantidadPagos = await Pago.count({ where: { cuota_id: cuotaIds } });
  return { eliminable: cantidadPagos === 0, cantidadPagos };
};

export const eliminarCredito = async (id) => {
  const t = await Credito.sequelize.transaction();
  try {
    // 1) Traer cuotas del crédito
    const cuotas = await Cuota.findAll({
      attributes: ['id'],
      where: { credito_id: id },
      transaction: t
    });
    const cuotaIds = cuotas.map(c => c.id);

    // 2) Si no hay cuotas, borrar crédito directo (y sus movs de caja de desembolso)
    if (cuotaIds.length === 0) {
      await Credito.destroy({ where: { id }, transaction: t });
      // Limpieza de movimientos de caja referidos al crédito (desembolso)
      await CajaMovimiento.destroy({
        where: { referencia_tipo: 'credito', referencia_id: id },
        transaction: t
      });
      await t.commit();
      return { ok: true, mensaje: 'Crédito eliminado (no tenía cuotas).' };
    }

    // 3) Verificar si existen pagos asociados a esas cuotas
    const cantidadPagos = await Pago.count({ where: { cuota_id: cuotaIds }, transaction: t });
    if (cantidadPagos > 0) {
      const err = new Error('No se puede eliminar el crédito porque tiene pagos registrados.');
      err.status = 409;
      await t.rollback();
      throw err;
    }

    // 4) Limpieza de recibos por si existiera alguno suelto
    await Recibo.destroy({ where: { cuota_id: cuotaIds }, transaction: t });

    // 5) Borrar cuotas y luego el crédito
    await Cuota.destroy({ where: { credito_id: id }, transaction: t });
    await Credito.destroy({ where: { id }, transaction: t });

    // 6) Borrar movimientos de caja de desembolso del crédito
    await CajaMovimiento.destroy({
      where: { referencia_tipo: 'credito', referencia_id: id },
      transaction: t
    });

    await t.commit();
    return { ok: true, mensaje: 'Crédito eliminado correctamente.' };
  } catch (e) {
    if (t.finished !== 'commit') {
      try { await t.rollback(); } catch (_) {}
    }
    throw e;
  }
};

/* ===================== Cliente con créditos (con filtros) ===================== */
export const obtenerCreditosPorCliente = async (clienteId, query = {}) => {
  try {
    // Sanitizar filtros
    const estado = query.estado ? String(query.estado).toLowerCase() : null;
    const modalidad = query.modalidad ? String(query.modalidad).toLowerCase() : null;
    const tipo = query.tipo ? String(query.tipo).toLowerCase() : null;
    const desde = query.desde || null; // YYYY-MM-DD (validado en la ruta)
    const hasta = query.hasta || null; // YYYY-MM-DD (validado en la ruta)
    const conCuotasVencidas = query.conCuotasVencidas === true || query.conCuotasVencidas === 'true' || query.conCuotasVencidas === '1';

    // Armamos where para la include de créditos
    const whereCredito = {};

    if (estado) whereCredito.estado = estado;
    if (modalidad) whereCredito.modalidad_credito = modalidad;
    if (tipo) whereCredito.tipo_credito = tipo;

    if (desde || hasta) {
      const rango = {};
      if (desde) rango[Op.gte] = desde;
      if (hasta) rango[Op.lte] = hasta;
      // Filtramos por cualquiera de las dos fechas relevantes
      whereCredito[Op.or] = [
        { fecha_acreditacion: rango },
        { fecha_compromiso_pago: rango }
      ];
    }

    const cliente = await Cliente.findByPk(clienteId, {
      include: [
        {
          model: Credito,
          as: 'creditos',
          where: Object.keys(whereCredito).length ? whereCredito : undefined,
          required: false, // si no matchea nada, igual devolvemos el cliente con creditos: []
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

    const plain = cliente.get({ plain: true });

    // Filtro adicional: solo créditos con al menos una cuota vencida
    if (conCuotasVencidas && Array.isArray(plain.creditos)) {
      plain.creditos = plain.creditos.filter(cr =>
        Array.isArray(cr.cuotas) && cr.cuotas.some(ct => String(ct.estado) === 'vencida')
      );
    }

    // Ordenamos créditos y cuotas como venías haciendo
    plain.creditos.sort((a, b) => b.id - a.id);
    plain.creditos.forEach(cr => {
      if (Array.isArray(cr.cuotas)) cr.cuotas.sort((x, y) => x.numero_cuota - y.numero_cuota);
    });

    return plain;
  } catch (error) {
    console.error('Error al obtener cliente con créditos (con filtros):', error);
    throw error;
  }
};

/* ===================== Anulación / tareas pendientes ===================== */
export const anularCredito = async (id, aprobadoPor = null) => {
  const credito = await Credito.findByPk(id);
  if (!credito) throw new Error('Crédito no encontrado');
  await Cuota.destroy({ where: { credito_id: id } });
  credito.estado = 'anulado';
  await credito.save();
  return credito;
};

export const solicitarAnulacionCredito = async ({ creditoId, motivo, userId }) => {
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
export const obtenerResumenLibre = async (creditoId, fecha = new Date()) => {
  const { obtenerResumenLibrePorCredito } = await import('./cuota.service.js');
  return obtenerResumenLibrePorCredito(creditoId, fecha);
};

/* ===================== Utilidades LIBRE exportadas ===================== */
export const refreshCuotaLibre = async (creditoId) => {
  await refrescarCuotaLibre(creditoId);
};
