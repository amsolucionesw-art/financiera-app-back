// financiera-backend/services/credito/credito.utils.js
// Helpers compartidos para crédito (sin lógica de endpoints).
// Objetivo: aislar utilidades y efectos secundarios (caja/recibo) para reducir acoplamiento.

import Recibo from '../../models/Recibo.js';
import CajaMovimiento from '../../models/CajaMovimiento.js';

/* ===================== Constantes ===================== */
export const MORA_DIARIA = 0.025;        // 2.5% por día
export const LIBRE_MAX_CICLOS = 3;       // tope 3 meses para crédito libre
export const LIBRE_VTO_FICTICIO = '2099-12-31';

/* ===================== Zona horaria negocio ===================== */
export const APP_TZ = process.env.APP_TZ || 'America/Argentina/Tucuman';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const fmtYMDInTZ = (dateObj) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj);

// YYYY-MM-DD en TZ negocio
export const todayYMD = () => fmtYMDInTZ(new Date());

// HH:mm:ss en TZ negocio
export const nowTime = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());

/* ===================== Helpers numéricos ===================== */
export const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

/* ===================== Helpers de fecha (YMD estricto y TZ-safe) ===================== */
/**
 * asYMD:
 * - Si viene 'YYYY-MM-DD' => se devuelve tal cual (NO se parsea como Date).
 * - Si viene Date / timestamp / string ISO => se formatea a YMD en APP_TZ.
 */
const asYMD = (input) => {
  if (input == null) return null;

  // String: si ya es YMD, respetarlo (evita corrimiento por UTC parsing)
  if (typeof input === 'string') {
    const s = input.slice(0, 10);
    if (YMD_RE.test(s)) return s;

    const dt = new Date(input);
    if (!Number.isFinite(dt.getTime())) return null;
    return fmtYMDInTZ(dt);
  }

  // Date o número u otro: intentar Date
  const dt = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(dt.getTime())) return null;
  return fmtYMDInTZ(dt);
};

export const ymd = (dateOrStr) => asYMD(dateOrStr);

/**
 * ymdDate:
 * - Convierte un YMD a Date sin corrimientos por timezone.
 * - Usamos mediodía UTC para que en TZ negativas/positivas no "cruce" de día.
 */
export const ymdDate = (dateOrStr) => {
  const s = asYMD(dateOrStr);
  if (!s) return new Date('Invalid Date');
  return new Date(`${s}T12:00:00.000Z`);
};

/* ===================== Helpers formato ===================== */
export const fmtARS = (n) =>
  Number(n || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });

/* Mapea modalidad para mostrar en interfaz/PDF */
export const labelModalidad = (modalidad) => {
  const m = String(modalidad || '').toLowerCase();
  if (m === 'comun') return 'PLAN DE CUOTAS FIJAS';
  return m.toUpperCase();
};

/* ===================== Helpers de tasas ===================== */
/** Normaliza un valor de tasa que puede venir como "60" o "0.60" a porcentaje 60 */
export const normalizePercent = (val, fallback = 60) => {
  const n = toNumber(val);
  if (!n) return fallback;
  // Si viene 0.6 ó 0.60, lo paso a 60
  if (n > 0 && n <= 1) return n * 100;
  return n;
};
/** De porcentaje (60) a decimal (0.60) */
export const percentToDecimal = (pct) => toNumber(pct) / 100.0;

/* ===================== Helpers de interés / períodos ===================== */
export const periodLengthFromTipo = (tipo_credito) =>
  tipo_credito === 'semanal' ? 4 :
    tipo_credito === 'quincenal' ? 2 : 1;

/**
 * Interés proporcional mínimo 60% (común / progresivo):
 *   - semanal   → 60% * (semanas / 4)
 *   - quincenal → 60% * (quincenas / 2)
 *   - mensual   → 60% * (meses)
 */
export const calcularInteresProporcionalMin60 = (tipo_credito, cantidad_cuotas) => {
  const n = Math.max(toNumber(cantidad_cuotas), 1);
  const pl = periodLengthFromTipo(tipo_credito);
  const proporcional = 60 * (n / pl);
  return Math.max(60, proporcional);
};

/** Detecta si el crédito es de modalidad "libre" */
export const esLibre = (credito) => {
  const mod = credito?.modalidad_credito || (credito?.get ? credito.get('modalidad_credito') : null);
  return String(mod) === 'libre';
};

/* ===================== Helpers refinanciación (flags para UI) ===================== */
export const anexarFlagsRefinanciacionPlain = (creditoPlain, hijoId = null) => {
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

// ───────────────── Compat DB: columna ciclo_libre puede no existir ─────────────────
export const isMissingColumnError = (err, col = 'ciclo_libre') => {
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

export const createReciboSafe = async (payload, options = {}) => {
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

/* ===================== Helpers internos Caja ===================== */

export const registrarEgresoDesembolsoCredito = async ({
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

export const registrarIngresoDesdeReciboEnTx = async ({
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