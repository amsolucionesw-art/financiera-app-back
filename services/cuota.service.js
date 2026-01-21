// backend/src/services/cuota.service.js
import Cuota from '../models/Cuota.js';
import FormaPago from '../models/FormaPago.js';
import Pago from '../models/Pago.js';
import Credito from '../models/Credito.js';
import Cliente from '../models/Cliente.js';
import Usuario from '../models/Usuario.js';
import Recibo from '../models/Recibo.js';
import {
    addDays,
    addMonths,
    format,
    isAfter,
    differenceInCalendarDays,
    differenceInCalendarMonths
} from 'date-fns';
import { Op } from 'sequelize';
// ❌ Evitamos import estático para no crear dependencia circular con credito.service
// import { actualizarEstadoCredito } from './credito.service.js';
import sequelize from '../models/sequelize.js';
import { calcularPuntajeCliente } from './puntaje.service.js';

// ⬇️ Impacto en caja
import CajaMovimiento from '../models/CajaMovimiento.js';

/* ===================== Constantes ===================== */
const MORA_DIARIA = 0.025;              // 2,5% por día (NO libre)
const MORA_DIARIA_LIBRE = 0.025;        // 2,5% por día sobre el INTERÉS del mes (LIBRE)
const VTO_FICTICIO_LIBRE = '2099-12-31';
const LIBRE_MAX_CICLOS = 3;

// ───────────────── Compat DB: columna ciclo_libre puede no existir ─────────────────
const isMissingColumnError = (err, col = 'ciclo_libre') => {
    const msg = String(err?.original?.message || err?.parent?.message || err?.message || '');
    const lower = msg.toLowerCase();
    const colLower = String(col || '').toLowerCase();
    const missing = /column .* does not exist/i.test(msg) || /no existe la columna/i.test(msg);
    return missing && lower.includes(colLower);
};

// Cachea si la DB tiene o no la columna recibos.ciclo_libre (evita spamear errores / logs)
let _reciboHasCicloLibreCol = null;
const reciboTieneCicloLibreCol = async () => {
    if (_reciboHasCicloLibreCol !== null) return _reciboHasCicloLibreCol;
    try {
        const qi = Recibo.sequelize.getQueryInterface();
        const table = Recibo.getTableName();
        const desc = await qi.describeTable(table);
        _reciboHasCicloLibreCol = !!desc?.ciclo_libre;
    } catch (_e) {
        _reciboHasCicloLibreCol = false;
    }
    return _reciboHasCicloLibreCol;
};


/**
 * ✅ findAll seguro para Recibo cuando la DB no tiene la columna `ciclo_libre`.
 * Si falta, fuerza `attributes.exclude` para que Sequelize NO la incluya en el SELECT.
 */
const normalizarAttributesRecibo = (attributes) => {
    if (!attributes) return { exclude: ['ciclo_libre'] };

    // attributes: ['a','b']
    if (Array.isArray(attributes)) {
        return attributes.filter(a => String(a) !== 'ciclo_libre');
    }

    // attributes: { include: [...], exclude: [...] }
    if (typeof attributes === 'object') {
        const excl = Array.isArray(attributes.exclude) ? attributes.exclude.slice() : [];
        if (!excl.includes('ciclo_libre')) excl.push('ciclo_libre');
        return { ...attributes, exclude: excl };
    }

    return attributes;
};

const findAllReciboSafe = async (options = {}) => {
    const tiene = await reciboTieneCicloLibreCol();
    if (!tiene) {
        const opts = { ...options };
        opts.attributes = normalizarAttributesRecibo(options.attributes);
        return await Recibo.findAll(opts);
    }
    return await Recibo.findAll(options);
};

const findOneReciboSafe = async (options = {}) => {
    const tiene = await reciboTieneCicloLibreCol();
    if (!tiene) {
        const opts = { ...options };
        opts.attributes = normalizarAttributesRecibo(options.attributes);
        return await Recibo.findOne(opts);
    }
    return await Recibo.findOne(options);
};

const marcarReciboSinCicloLibre = () => {
    _reciboHasCicloLibreCol = false;
};

/** Construye el WHERE de Recibo para un ciclo LIBRE, compatible con DB legacy */
const whereRecibosLibrePorCiclo = async ({ cuotaIds, ciclo, credito, hoyYMD }) => {
    const c = clamp(Number(ciclo) || 1, 1, LIBRE_MAX_CICLOS);
    const { desdeYMD, hastaYMD } = rangoCicloLibre(credito, c, hoyYMD);
    const baseWhere = { cuota_id: { [Op.in]: cuotaIds } };
    if (await reciboTieneCicloLibreCol()) {
        return {
            ...baseWhere,
            [Op.or]: [
                { ciclo_libre: c },
                {
                    [Op.and]: [
                        { ciclo_libre: { [Op.is]: null } },
                        { fecha: { [Op.gte]: asYMD(desdeYMD), [Op.lte]: asYMD(hastaYMD) } }
                    ]
                }
            ]
        };
    }
    // DB legacy: sin columna ciclo_libre → solo por rango de fechas del ciclo
    return {
        ...baseWhere,
        fecha: { [Op.gte]: asYMD(desdeYMD), [Op.lte]: asYMD(hastaYMD) }
    };
};

/* ===================== Zona horaria (Tucumán) ===================== */
/** Timezone de referencia de negocio. Podés sobreescribir con APP_TZ. */
const APP_TZ = process.env.APP_TZ || 'America/Argentina/Tucuman';

/* === Helpers de TZ (consistentes) === */

/** Devuelve YYYY-MM-DD en la TZ del negocio para una fecha dada (o now). */
const toYMD_TZ = (d = new Date()) => {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
};

/** Devuelve Date “fecha-solo” (00:00 local **independiente del APP_TZ**) a partir de 'YYYY-MM-DD'. */
const dateFromYMD = (ymdStr) => {
    const [Y, M, D] = String(ymdStr).split('-').map((x) => parseInt(x, 10));
    return new Date(Y, (M || 1) - 1, D || 1); // evita el parseo UTC de 'YYYY-MM-DD'
};

/** Devuelve YYYY-MM-DD seguro en TZ negocio, a partir de Date o string. */
const asYMD = (val) => {
    // Si ya viene como 'YYYY-MM-DD', lo normalizamos (p. ej. '2025-10-09' → '2025-10-09')
    const s = String(val ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Si viene Date o string parseable, uso la misma TZ que todayYMD()
    const d = new Date(val);
    return toYMD_TZ(d);
};

/** Equivalentes semánticos previos, ahora TZ-consistentes */
const ymd = (dateOrStr) => asYMD(dateOrStr);
/** Date “fecha-solo” a partir de cualquier valor (primero lo paso a YMD TZ-consistente) */
const ymdDate = (dateOrStr) => dateFromYMD(asYMD(dateOrStr));

/** Hoy en TZ negocio, formateado */
const todayYMD = () => toYMD_TZ();

/* ===================== Helpers ===================== */
const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/** Normaliza tasa: admite 60 ó 0.60 → devuelve decimal 0.60 */
const normalizeRate = (r) => {
    const n = toNumber(r);
    if (n <= 0) return 0;
    return n > 1 ? n / 100 : n;
};

const getPeriodDays = (tipo) =>
    (tipo === 'semanal' ? 7 : tipo === 'quincenal' ? 15 : 30);

const esCreditoLibre = (credito) =>
    String(credito?.modalidad_credito ?? '') === 'libre';

/** ✅ Bloqueo duro: no permitir pagos si el crédito/cuota ya están refinanciados */
const assertNoPagoSiRefinanciado = ({ credito, cuota = null }) => {
    const creditoEstado = String(credito?.estado ?? '').toLowerCase();
    const cuotaEstado = String(cuota?.estado ?? '').toLowerCase();

    const creditoRefi = creditoEstado === 'refinanciado';
    // Por robustez: si en algún flujo marcan cuota como refinanciada/refinanciado
    const cuotaRefi = cuotaEstado === 'refinanciada' || cuotaEstado === 'refinanciado';

    if (creditoRefi || cuotaRefi) {
        const err = new Error(
            'No se puede registrar un pago: el crédito ya fue refinanciado (o la cuota pertenece a un crédito refinanciado).'
        );
        err.status = 409; // Conflict
        err.code = 'CREDITO_REFINANCIADO_NO_PAGO';
        throw err;
    }
};

/** Ciclo LIBRE actual por calendario (máx. 3): 1, 2 o 3
 *  Política cliente:
 *   - Ciclos se generan por calendario (vencimientos mensuales).
 *   - El ciclo vigente se determina comparando contra vto1/vto2/vto3.
 *
 *  Regla práctica:
 *   - si hoy <= vto1 => ciclo 1
 *   - si hoy <= vto2 => ciclo 2
 *   - si hoy >  vto2 => ciclo 3 (tope)
 */
const cicloLibreActual = (credito, refYMD = todayYMD()) => {
    const hoy = asYMD(refYMD);

    // vto1: por negocio es fecha_compromiso_pago (primer vencimiento). Fallback: acreditación.
    const vto1Base = credito?.fecha_compromiso_pago || credito?.fecha_acreditacion || hoy;
    const vto1 = asYMD(vto1Base);
    const vto2 = asYMD(addMonths(ymdDate(vto1), 1));
    const vto3 = asYMD(addMonths(ymdDate(vto1), 2));

    if (hoy <= vto1) return 1;
    if (hoy <= vto2) return 2;
    // hoy > vto2
    return Math.min(LIBRE_MAX_CICLOS, 3);
};

/** Devuelve cantidad de ciclos completos transcurridos entre dos fechas (YMD) según periodicidad. */
const ciclosTranscurridos = (desdeYMD, hastaYMD, tipo_credito) => {
    const days = differenceInCalendarDays(dateFromYMD(hastaYMD), dateFromYMD(desdeYMD));
    const period = getPeriodDays(tipo_credito);
    if (days <= 0) return 0;
    return Math.floor(days / period);
};

/** Inicio del ciclo vigente a partir de una fecha base (acreditación o compromiso) y una fecha de referencia */
const inicioCicloVigente = (fechaBaseYMD, tipo_credito, refYMD) => {
    const base = dateFromYMD(fechaBaseYMD);
    const ref = dateFromYMD(refYMD);
    const period = getPeriodDays(tipo_credito);
    const days = Math.max(differenceInCalendarDays(ref, base), 0);
    const completos = Math.floor(days / period);
    // usamos format solo para sumar días, luego convertimos a YMD TZ-consistente
    const sumado = addDays(base, completos * period);
    return asYMD(sumado);
};

/** ✅ LIBRE: rango del ciclo mensual dado (desde/hasta) */
const rangoCicloLibre = (credito, ciclo, hoyYMD) => {
    const refDate = ymdDate(hoyYMD);
    const baseYMD = credito?.fecha_acreditacion || credito?.fecha_compromiso_pago || hoyYMD;
    const baseDate = ymdDate(baseYMD);

    const c = clamp(Number(ciclo) || 1, 1, LIBRE_MAX_CICLOS);
    const desdeDate = addMonths(baseDate, Math.max(c - 1, 0));
    const hastaDate = addDays(addMonths(baseDate, Math.max(c, 1)), -1);

    return {
        ciclo: c,
        desdeYMD: asYMD(desdeDate),
        hastaYMD: asYMD(hastaDate),
        inicioYMD: asYMD(desdeDate)
    };
};

/** ✅ LIBRE: vencimiento del ciclo N (fecha_compromiso_pago + (ciclo-1) meses) */
const vencimientoCicloLibre = (credito, ciclo, hoyYMD = todayYMD()) => {
    const base = credito?.fecha_compromiso_pago || credito?.fecha_acreditacion || hoyYMD;
    const vto = addMonths(ymdDate(base), Math.max((Number(ciclo) || 1) - 1, 0));
    return asYMD(vto);
};

/** ✅ LIBRE: ids de cuotas por crédito (para sumar recibos) */
const obtenerCuotaIdsPorCredito = async ({ credito_id, t = null }) => {
    const credId = Number(credito_id);
    if (!Number.isFinite(credId) || credId <= 0) return [];

    const cuotas = await Cuota.findAll({
        where: { credito_id: credId },
        attributes: ['id'],
        raw: true,
        transaction: t
    });

    return (cuotas || []).map((r) => r.id).filter(Boolean);
};

/** ✅ LIBRE: obtener cuota “base” (primera) para calcular capital inicial */
const obtenerCuotaBaseLibre = async ({ credito_id, t = null }) => {
    const credId = Number(credito_id);
    if (!Number.isFinite(credId) || credId <= 0) return null;

    const cuota = await Cuota.findOne({
        where: { credito_id: credId },
        order: [['numero_cuota', 'ASC']],
        transaction: t
    });
    return cuota || null;
};

/** ✅ LIBRE: suma campo de Recibo por ciclo.
 *  - Nuevo: usa recibos.ciclo_libre = ciclo
 *  - Legacy: si ciclo_libre IS NULL, toma por rango de fechas del ciclo (para compatibilidad con recibos viejos).
 */
const sumRecibosCampoPorCiclo = async ({ cuotaIds, campo, ciclo, credito, hoyYMD, t = null }) => {
    if (!Array.isArray(cuotaIds) || cuotaIds.length === 0) return 0;

    const c = clamp(Number(ciclo) || 1, 1, LIBRE_MAX_CICLOS);

    try {
        const where = await whereRecibosLibrePorCiclo({ cuotaIds, ciclo: c, credito, hoyYMD });
        const sum = await Recibo.sum(campo, {
            where,
            ...(t ? { transaction: t } : {})
        });
        return fix2(sum || 0);
    } catch (e) {
        // 🔁 DB legacy: si la columna no existe, marcamos cache y reintentamos por rango de fechas
        if (isMissingColumnError(e, 'ciclo_libre')) {
            marcarReciboSinCicloLibre();
            const { desdeYMD, hastaYMD } = rangoCicloLibre(credito, c, hoyYMD);
            const sum = await Recibo.sum(campo, {
                where: {
                    cuota_id: { [Op.in]: cuotaIds },
                    fecha: { [Op.gte]: asYMD(desdeYMD), [Op.lte]: asYMD(hastaYMD) }
                },
                ...(t ? { transaction: t } : {})
            });
            return fix2(sum || 0);
        }
        throw e;
    }
};


/** ✅ LIBRE: fecha en la que se completa el pago del INTERÉS del ciclo (si se completa).
 *  Política cliente (#5): la mora (diaria sobre el interés) sigue corriendo hasta abonar la totalidad del interés del ciclo.
 *
 *  Devuelve 'YYYY-MM-DD' si el interés del ciclo quedó totalmente cubierto, o null si aún no.
 *  Nota: usa recibos.ciclo_libre cuando existe; si es NULL, cae al criterio legacy por rango de fechas del ciclo.
 */
const fechaCierreInteresCicloLibre = async ({ cuotaIds, credito, ciclo, hoyYMD, interesBruto, t = null }) => {
    if (!Array.isArray(cuotaIds) || cuotaIds.length === 0) return null;
    const bruto = fix2(interesBruto);
    if (bruto <= 0) return null;

    const c = clamp(Number(ciclo) || 1, 1, LIBRE_MAX_CICLOS);
    const { desdeYMD, hastaYMD } = rangoCicloLibre(credito, c, hoyYMD);

    let recibos = [];
    try {
        const where = await whereRecibosLibrePorCiclo({ cuotaIds, ciclo: c, credito, hoyYMD });
        recibos = await findAllReciboSafe({
            where,
            order: [['fecha', 'ASC'], ['hora', 'ASC'], ['numero_recibo', 'ASC']],
            ...(t ? { transaction: t } : {})
        });
    } catch (e) {
        if (isMissingColumnError(e, 'ciclo_libre')) {
            marcarReciboSinCicloLibre();
            recibos = await findAllReciboSafe({
                where: {
                    cuota_id: { [Op.in]: cuotaIds },
                    fecha: { [Op.gte]: asYMD(desdeYMD), [Op.lte]: asYMD(hastaYMD) }
                },
                order: [['fecha', 'ASC'], ['hora', 'ASC'], ['numero_recibo', 'ASC']],
                ...(t ? { transaction: t } : {})
            });
        } else {
            throw e;
        }
    }

    let acum = 0;
    for (const r of (recibos || [])) {
        acum = fix2(acum + fix2(r?.interes_ciclo_cobrado ?? 0));
        if (acum + 0.0001 >= bruto) {
            return asYMD(r?.fecha);
        }
    }

    return null;
};

/** ✅ LIBRE: capital base para un ciclo (para evitar que pagos de capital posteriores modifiquen el interés de ciclos ya iniciados).
 *  - capital_inicial = importe_cuota - descuento_cuota (de la cuota base)
 *  - capital_pagado_antes_del_inicio_ciclo = sum(principal_pagado) con fecha < inicio_ciclo
 *  - capital_base_ciclo = capital_inicial - pagado_antes
 */
const capitalBaseLibreParaCiclo = async ({ credito, cuotaBase, cuotaIds, ciclo, hoyYMD, t = null }) => {
    const c = clamp(Number(ciclo) || 1, 1, LIBRE_MAX_CICLOS);
    const capInicial = fix2(Math.max(toNumber(cuotaBase?.importe_cuota) - toNumber(cuotaBase?.descuento_cuota), 0));
    if (capInicial <= 0) return 0;

    const { inicioYMD } = rangoCicloLibre(credito, c, hoyYMD);

    const pagadoAntes = await Recibo.sum('principal_pagado', {
        where: {
            cuota_id: { [Op.in]: cuotaIds },
            fecha: { [Op.lt]: asYMD(inicioYMD) }
        },
        transaction: t
    });

    return fix2(Math.max(capInicial - fix2(pagadoAntes ?? 0), 0));
};

/** ✅ LIBRE: interés bruto del ciclo (capital base del ciclo * tasa mensual) */
const interesBrutoLibreParaCiclo = async ({ credito, cuotaBase, cuotaIds, ciclo, hoyYMD, t = null }) => {
    const tasa = normalizeRate(credito?.interes);
    if (tasa <= 0) return 0;

    const capBase = await capitalBaseLibreParaCiclo({ credito, cuotaBase, cuotaIds, ciclo, hoyYMD, t });
    if (capBase <= 0) return 0;

    return fix2(capBase * tasa);
};

/** ✅ LIBRE: deuda detallada por ciclo (interés/mora) */
const deudaLibrePorCiclo = async ({ credito, cuotaBase, cuotaIds, ciclo, hoyYMD = todayYMD(), t = null }) => {
    const hoy = asYMD(hoyYMD);
    const c = clamp(Number(ciclo) || 1, 1, LIBRE_MAX_CICLOS);

    const vtoY = vencimientoCicloLibre(credito, c, hoy);

    const interesBruto = await interesBrutoLibreParaCiclo({
        credito, cuotaBase, cuotaIds, ciclo: c, hoyYMD: hoy, t
    });

    const interesCobrado = await sumRecibosCampoPorCiclo({
        cuotaIds, campo: 'interes_ciclo_cobrado', ciclo: c, credito, hoyYMD: hoy, t
    });

    const interesPendiente = fix2(Math.max(interesBruto - interesCobrado, 0));
    // Mora bruta: solo si hoy > vto (comparación YMD).
    // Política cliente (#5): la mora sobre el interés corre hasta que el interés del ciclo se pague COMPLETO.
    let moraBruta = 0;
    if (String(hoy) > String(vtoY) && interesBruto > 0) {
        // Si el interés del ciclo ya se completó en una fecha previa, la mora se corta en esa fecha.
        const fechaCierreInteres = await fechaCierreInteresCicloLibre({
            cuotaIds,
            credito,
            ciclo: c,
            hoyYMD: hoy,
            interesBruto,
            t
        });

        const hastaY = (fechaCierreInteres && String(fechaCierreInteres) <= String(hoy))
            ? String(fechaCierreInteres)
            : String(hoy);

        const dias = Math.max(differenceInCalendarDays(ymdDate(hastaY), ymdDate(vtoY)), 0);
        moraBruta = fix2(interesBruto * MORA_DIARIA_LIBRE * dias);
    }

    const moraCobrada = await sumRecibosCampoPorCiclo({
        cuotaIds, campo: 'mora_cobrada', ciclo: c, credito, hoyYMD: hoy, t
    });

    // En LIBRE, descuento_aplicado = bonificación sobre mora (por regla anterior ya implementada)
    const moraBonificada = await sumRecibosCampoPorCiclo({
        cuotaIds, campo: 'descuento_aplicado', ciclo: c, credito, hoyYMD: hoy, t
    });

    const moraPendiente = fix2(Math.max(moraBruta - moraCobrada - moraBonificada, 0));

    return {
        ciclo: c,
        vtoYMD: vtoY,
        interes_bruto: interesBruto,
        interes_cobrado: interesCobrado,
        interes_pendiente: interesPendiente,
        mora_bruta: moraBruta,
        mora_cobrada: moraCobrada,
        mora_bonificada: moraBonificada,
        mora_pendiente: moraPendiente
    };
};

/** ✅ LIBRE: total pendiente hoy (interés + mora) sumando ciclos 1..ciclo_actual */
const deudaLibreTotalHoy = async ({ credito, hoyYMD = todayYMD(), t = null }) => {
    const hoy = asYMD(hoyYMD);
    const cicloActual = cicloLibreActual(credito, hoy);
    const cuotaBase = await obtenerCuotaBaseLibre({ credito_id: credito?.id, t });
    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito?.id, t });

    const detalles = [];
    let interesTotal = 0;
    let moraTotal = 0;

    for (let c = 1; c <= cicloActual; c++) {
        const det = await deudaLibrePorCiclo({
            credito,
            cuotaBase,
            cuotaIds,
            ciclo: c,
            hoyYMD: hoy,
            t
        });
        detalles.push(det);
        interesTotal = fix2(interesTotal + fix2(det.interes_pendiente));
        moraTotal = fix2(moraTotal + fix2(det.mora_pendiente));
    }

    return {
        hoyYMD: hoy,
        ciclo_actual: cicloActual,
        interes_pendiente_total: fix2(interesTotal),
        mora_pendiente_total: fix2(moraTotal),
        detalle_por_ciclo: detalles
    };
};

/** ✅ LIBRE: devuelve el ciclo más viejo abierto (con deuda) dentro de 1..ciclo_actual */
const cicloLibreMasViejoAbierto = async ({ credito, hoyYMD = todayYMD(), t = null }) => {
    const hoy = asYMD(hoyYMD);
    const cicloActual = cicloLibreActual(credito, hoy);
    const cuotaBase = await obtenerCuotaBaseLibre({ credito_id: credito?.id, t });
    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito?.id, t });

    for (let c = 1; c <= cicloActual; c++) {
        const det = await deudaLibrePorCiclo({ credito, cuotaBase, cuotaIds, ciclo: c, hoyYMD: hoy, t });
        if (fix2(det.interes_pendiente) > 0 || fix2(det.mora_pendiente) > 0) {
            return { ciclo: c, detalle: det, cuotaBase, cuotaIds };
        }
    }

    // Si no hay deuda (raro), operamos en el ciclo actual por consistencia
    const det = await deudaLibrePorCiclo({ credito, cuotaBase, cuotaIds, ciclo: cicloActual, hoyYMD: hoy, t });
    return { ciclo: cicloActual, detalle: det, cuotaBase, cuotaIds };
};

/** ✅ (compat): Interés pendiente LIBRE HOY (TOTAL, sumando ciclos) */
const calcularInteresPendienteLibre = async ({ credito, hoyYMD = todayYMD(), t = null }) => {
    const tot = await deudaLibreTotalHoy({ credito, hoyYMD, t });
    return fix2(tot.interes_pendiente_total || 0);
};

/** ✅ (compat): Mora pendiente LIBRE HOY (TOTAL, sumando ciclos) */
const calcularMoraPendienteLibreExacto = async ({ credito, hoyYMD = todayYMD(), t = null }) => {
    const tot = await deudaLibreTotalHoy({ credito, hoyYMD, t });
    return fix2(tot.mora_pendiente_total || 0);
};

/** Agrupa pagos por día (NO libre) */
const prepararPagosPorDia = (pagos = []) => {
    const porDia = {};
    for (const p of pagos) {
        const fecha = asYMD(p.fecha_pago || ymdDate(todayYMD()));
        porDia[fecha] = fix2(p.monto_pagado) + (porDia[fecha] ?? 0);
    }
    return porDia;
};

/** Simula mora día por día (NO libre) */
const simularMoraCuotaHasta = (cuota, pagos, hastaFecha = ymdDate(todayYMD())) => {
    if (!cuota) {
        return {
            moraPendiente: 0,
            principalPagadoHistorico: 0,
            saldoPrincipalPendiente: 0,
            totalMoraGenerada: 0,
            totalPagadoEnMoraHistorico: 0
        };
    }

    const importe = fix2(cuota.importe_cuota);
    const descuentoAcum = fix2(cuota.descuento_cuota);

    // 🔒 Comparaciones YMD: evitan mora el mismo día (todas en misma TZ)
    const dueY = ymd(cuota.fecha_vencimiento);
    const hastaY = ymd(hastaFecha);

    // Si hoy <= vencimiento → NO hay mora
    if (hastaY <= dueY) {
        const pagosAntes = (pagos ?? []).filter(
            p => ymd(p.fecha_pago || ymdDate(todayYMD())) <= dueY
        );
        const principalPrevio = fix2(pagosAntes.reduce((acc, p) => acc + fix2(p.monto_pagado), 0));
        const saldo = Math.max(importe - descuentoAcum - principalPrevio, 0);
        return {
            moraPendiente: 0,
            principalPagadoHistorico: principalPrevio,
            saldoPrincipalPendiente: fix2(saldo),
            totalMoraGenerada: 0,
            totalPagadoEnMoraHistorico: 0
        };
    }

    const due = ymdDate(cuota.fecha_vencimiento);
    const hasta = ymdDate(hastaFecha);
    const pagosPorDia = prepararPagosPorDia(pagos ?? []);

    const pagosHastaVenc = (pagos ?? []).filter(
        p => ymd(p.fecha_pago || ymdDate(todayYMD())) <= ymd(due)
    );
    let principalPagado = fix2(pagosHastaVenc.reduce((acc, p) => acc + fix2(p.monto_pagado), 0));

    let moraAcum = 0;
    let totalMoraGenerada = 0;
    let totalMoraPagada = 0;

    // Arranca el día SIGUIENTE al vencimiento
    let cursor = addDays(due, 1);

    while (!isAfter(cursor, hasta)) {
        const fechaKey = asYMD(cursor);

        const saldoBase = Math.max(importe - descuentoAcum - principalPagado, 0);
        if (saldoBase <= 0) break;

        const moraDelDia = fix2(saldoBase * MORA_DIARIA);
        moraAcum = fix2(moraAcum + moraDelDia);
        totalMoraGenerada = fix2(totalMoraGenerada + moraDelDia);

        const pagadoHoy = fix2(pagosPorDia[fechaKey] ?? 0);
        if (pagadoHoy > 0) {
            const aMora = Math.min(pagadoHoy, moraAcum);
            moraAcum = fix2(moraAcum - aMora);
            totalMoraPagada = fix2(totalMoraPagada + aMora);

            const aPrincipal = Math.max(pagadoHoy - aMora, 0);
            if (aPrincipal > 0) principalPagado = fix2(principalPagado + aPrincipal);
        }

        cursor = addDays(cursor, 1);
    }

    const saldoPrincipalPendiente = Math.max(importe - descuentoAcum - principalPagado, 0);
    return {
        moraPendiente: fix2(Math.max(moraAcum, 0)),
        principalPagadoHistorico: fix2(principalPagado),
        saldoPrincipalPendiente: fix2(saldoPrincipalPendiente),
        totalMoraGenerada: fix2(totalMoraGenerada),
        totalPagadoEnMoraHistorico: fix2(totalMoraPagada)
    };
};

/* ───────── Helpers de presentación de RECIBO (UI) ───────── */
const formatARS = (n) =>
    Number(n || 0).toLocaleString('es-AR', {
        style: 'currency',
        currency: 'ARS',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

const formatYMDToDMY = (ymdStr) => {
    if (!ymdStr) return '';
    const [Y, M, D] = String(ymdStr).split('-');
    if (!Y || !M || !D) return String(ymdStr);
    return `${D.padStart(2, '0')}/${M.padStart(2, '0')}/${Y}`;
};

const nonAplicaIfZero = (value) => {
    const n = toNumber(value);
    return n === 0 ? 'No aplica' : formatARS(n);
};

// Detecta modalidad LIBRE con seguridad
const esReciboLibre = (recibo = {}) => {
    const mod = String(recibo.modalidad_credito || '').toLowerCase();
    if (mod === 'libre') return true;
    const concepto = String(recibo.concepto || '');
    return /LIBRE/i.test(concepto);
};

/** Construye un objeto "recibo_ui" listo para el frontend */
const buildReciboUI = (recibo) => {
    if (!recibo) return null;

    const libre = esReciboLibre(recibo);
    const {
        numero_recibo,
        fecha,
        hora,
        cliente_nombre,
        concepto,
        medio_pago,
        nombre_cobrador,
        modalidad_credito,

        // desglose
        importe_cuota_original,
        descuento_aplicado,
        mora_cobrada,
        principal_pagado,
        interes_ciclo_cobrado,

        // 🟦 NUEVO: mora pendiente reportable al front
        saldo_mora,

        // ✅ nuevo: ciclo imputado (LIBRE)
        ciclo_libre,

        // montos y saldos
        monto_pagado,
        pago_a_cuenta,
        saldo_anterior,
        saldo_actual,

        // capital del crédito
        saldo_credito_anterior,
        saldo_credito_actual
    } = recibo;

    const base = {
        numero_recibo: numero_recibo ?? null,
        fecha: formatYMDToDMY(fecha),
        hora: hora || '',
        cliente: cliente_nombre || '',
        cobrador: nombre_cobrador || '',
        medio_pago: medio_pago || '',
        concepto: concepto || '',
        modalidad_credito: modalidad_credito || undefined,

        // totales
        monto_pagado: formatARS(monto_pagado ?? pago_a_cuenta ?? 0),
        pago_a_cuenta: formatARS(pago_a_cuenta ?? monto_pagado ?? 0),

        // saldos totales (siempre $)
        saldo_anterior: formatARS(saldo_anterior),
        saldo_actual: formatARS(saldo_actual),

        // desglose
        importe_cuota_original:
            importe_cuota_original !== undefined ? formatARS(importe_cuota_original) : undefined,
        descuento_aplicado:
            descuento_aplicado !== undefined ? nonAplicaIfZero(descuento_aplicado) : undefined,
        mora_cobrada:
            mora_cobrada !== undefined ? nonAplicaIfZero(mora_cobrada) : undefined,

        // 🟦 NUEVO: campo “Saldo de mora”
        saldo_mora:
            saldo_mora !== undefined ? nonAplicaIfZero(saldo_mora) : undefined
    };

    if (!libre) {
        return base;
    }

    return {
        ...base,
        ciclo_libre: ciclo_libre ?? undefined,
        principal_pagado: principal_pagado !== undefined ? formatARS(principal_pagado) : undefined,
        interes_ciclo_cobrado:
            interes_ciclo_cobrado !== undefined ? nonAplicaIfZero(interes_ciclo_cobrado) : undefined,
        saldo_credito_anterior:
            saldo_credito_anterior !== undefined ? formatARS(saldo_credito_anterior) : undefined,
        saldo_credito_actual:
            saldo_credito_actual !== undefined ? formatARS(saldo_credito_actual) : undefined
    };
};

/* ───────── Caja: registrar ingreso desde un Recibo dentro de la misma TX ───────── */
const registrarIngresoDesdeReciboEnTx = async ({ t, recibo, forma_pago_id, usuario_id = null }) => {
    if (!recibo) return;
    const nowYMD = todayYMD();
    const nowTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date());
    await CajaMovimiento.create({
        fecha: recibo.fecha || nowYMD,
        hora: recibo.hora || nowTime,
        tipo: 'ingreso',
        monto: fix2(recibo.monto_pagado || 0),
        forma_pago_id: forma_pago_id ?? null,
        concepto: (
            (recibo?.numero_recibo != null && recibo?.numero_recibo !== '')
                ? `Cobro recibo #${recibo.numero_recibo} - ${recibo?.cliente_nombre || 'Cliente'}`
                : `Cobro recibo - ${recibo?.cliente_nombre || 'Cliente'}`
        ).slice(0, 255),
        referencia_tipo: 'recibo',
        referencia_id: recibo.numero_recibo ?? null,
        usuario_id: usuario_id ?? null
    }, { transaction: t });
};

/* ───────────────── Vencimientos ───────────────── */
export const actualizarCuotasVencidas = async () => {
    const hoy = todayYMD(); // YMD en TZ negocio

    // Excluir LIBRE
    const libres = await Credito.findAll({
        attributes: ['id'],
        where: { modalidad_credito: 'libre' },
        raw: true
    });
    const libreIds = libres.map(r => r.id);

    // Excluir refinanciados
    const refinanciados = await Credito.findAll({
        attributes: ['id'],
        where: { estado: 'refinanciado' },
        raw: true
    });
    const refiIds = refinanciados.map(r => r.id);

    // ⚠️ Solo vencidas si fv < HOY (mismo día NO se marca vencida)
    const whereUpdate = {
        estado: { [Op.in]: ['pendiente', 'parcial'] },
        fecha_vencimiento: { [Op.lt]: hoy, [Op.ne]: VTO_FICTICIO_LIBRE }
    };
    const excluir = [...libreIds, ...refiIds];
    if (excluir.length > 0) {
        whereUpdate['credito_id'] = { [Op.notIn]: excluir };
    }

    const [total_actualizadas] = await Cuota.update(
        { estado: 'vencida' },
        { where: whereUpdate }
    );

    if (total_actualizadas > 0) {
        const creditosIds = await Cuota.findAll({
            attributes: ['credito_id'],
            where: { estado: 'vencida', fecha_vencimiento: { [Op.lt]: hoy, [Op.ne]: VTO_FICTICIO_LIBRE } },
            group: ['credito_id'],
            raw: true
        }).then(rows => rows.map(r => r.credito_id));

        // ✅ import dinámico para evitar circularidad
        const { actualizarEstadoCredito } = await import('./credito.service.js');
        for (const creditoId of creditosIds) {
            await actualizarEstadoCredito(creditoId);
        }
    }
    return total_actualizadas;
};

/* ───────────────── Mora: recalcular (idempotente) ───────────────── */
export const recalcularMoraCuota = async (cuotaId, t = null) => {
    const cuota = await Cuota.findByPk(cuotaId, {
        include: [
            {
                model: Pago,
                as: 'pagos',
                attributes: ['id', 'monto_pagado', 'fecha_pago']
            }
        ],
        transaction: t
    });
    if (!cuota) throw new Error('Cuota no encontrada');

    const credito = await Credito.findByPk(cuota.credito_id, { transaction: t });
    if (!credito) throw new Error('Crédito asociado no encontrado');

    // Usamos hoy tanto como Date truncado como YMD string
    const hoyStr = todayYMD();
    const hoyTZ = ymdDate(hoyStr);

    // ✅ LIBRE (ahora TOTAL por ciclos)
    if (esCreditoLibre(credito) || cuota.fecha_vencimiento === VTO_FICTICIO_LIBRE) {
        const moraLibre = await calcularMoraPendienteLibreExacto({ credito, hoyYMD: hoyStr, t });
        if (toNumber(cuota.intereses_vencidos_acumulados) !== moraLibre) {
            await cuota.update({ intereses_vencidos_acumulados: moraLibre }, { transaction: t });
        }
        return moraLibre;
    }

    if (String(credito.estado) === 'refinanciado') {
        if (cuota.intereses_vencidos_acumulados !== 0) {
            await cuota.update({ intereses_vencidos_acumulados: 0 }, { transaction: t });
        }
        return 0;
    }

    if (cuota.estado === 'pagada') {
        await cuota.update({ intereses_vencidos_acumulados: 0 }, { transaction: t });
        return 0;
    }

    // 💡 NO-LIBRE: además de la mora, ajustamos el estado a 'vencida' si fv < hoy
    let nuevoEstado = cuota.estado;
    if (
        cuota.fecha_vencimiento &&
        cuota.fecha_vencimiento !== VTO_FICTICIO_LIBRE &&
        (cuota.estado === 'pendiente' || cuota.estado === 'parcial')
    ) {
        const fvY = ymd(cuota.fecha_vencimiento);
        if (hoyStr > fvY) {
            nuevoEstado = 'vencida';
        }
    }

    const { moraPendiente } = simularMoraCuotaHasta(cuota, cuota.pagos, hoyTZ);

    const updates = { intereses_vencidos_acumulados: moraPendiente };
    if (nuevoEstado && nuevoEstado !== cuota.estado) {
        updates.estado = nuevoEstado;
    }

    await cuota.update(updates, { transaction: t });
    return moraPendiente;
};

export const recalcularMoraPorCredito = async (creditoId, t = null) => {
    const credito = await Credito.findByPk(creditoId, { transaction: t });
    if (!credito) throw new Error('Crédito no encontrado');

    const hoyStr = todayYMD();
    const hoyTZ = ymdDate(hoyStr);

    // ✅ LIBRE (ahora TOTAL por ciclos)
    if (esCreditoLibre(credito)) {
        const cuotaLibre = await Cuota.findOne({
            where: { credito_id: creditoId },
            order: [['numero_cuota', 'ASC']],
            transaction: t
        });
        if (!cuotaLibre) return 0;

        const moraLibre = await calcularMoraPendienteLibreExacto({ credito, hoyYMD: hoyStr, t });

        if (toNumber(cuotaLibre.intereses_vencidos_acumulados) !== moraLibre) {
            await cuotaLibre.update({ intereses_vencidos_acumulados: moraLibre }, { transaction: t });
        }
        return moraLibre;
    }

    if (String(credito.estado) === 'refinanciado') {
        await Cuota.update(
            { intereses_vencidos_acumulados: 0 },
            { where: { credito_id: creditoId }, transaction: t }
        );
        return 0;
    }

    const cuotas = await Cuota.findAll({
        where: { credito_id: creditoId },
        include: [{ model: Pago, as: 'pagos', attributes: ['id', 'monto_pagado', 'fecha_pago'] }],
        transaction: t
    });

    let total = 0;
    for (const c of cuotas) {
        // 🛡️ Si la cuota ya está pagada, garantizamos mora = 0 y NO tocamos el estado
        if (String(c.estado) === 'pagada') {
            if (toNumber(c.intereses_vencidos_acumulados) !== 0) {
                await c.update(
                    { intereses_vencidos_acumulados: 0 },
                    { transaction: t }
                );
            }
            continue;
        }

        const { moraPendiente } = simularMoraCuotaHasta(c, c.pagos, hoyTZ);

        // 💡 NO-LIBRE: sincronizamos también el estado vencida/pendiente/parcial
        let nuevoEstado = c.estado;
        if (
            c.fecha_vencimiento &&
            c.fecha_vencimiento !== VTO_FICTICIO_LIBRE &&
            c.estado !== 'pagada'
        ) {
            const fvY = ymd(c.fecha_vencimiento);
            if ((c.estado === 'pendiente' || c.estado === 'parcial') && hoyStr > fvY) {
                nuevoEstado = 'vencida';
            }
        }

        const updates = { intereses_vencidos_acumulados: moraPendiente };
        if (nuevoEstado && nuevoEstado !== c.estado) {
            updates.estado = nuevoEstado;
        }

        await c.update(updates, { transaction: t });
        total = fix2(total + moraPendiente);
    }
    return total;
};

/* ───────────────── CRUD/Queries ───────────────── */
export const obtenerCuotas = async () => {
    await actualizarCuotasVencidas();

    const vencidas = await Cuota.findAll({ attributes: ['id'], where: { estado: 'vencida' } });
    for (const v of vencidas) {
        await recalcularMoraCuota(v.id);
    }

    return Cuota.findAll({
        include: [{ model: FormaPago, attributes: ['nombre'], as: 'formaPago' }],
        order: [['fecha_vencimiento', 'ASC'], ['numero_cuota', 'ASC']]
    });
};

export const actualizarCuota = async (id, data) => {
    const cuota = await Cuota.findByPk(id);
    if (!cuota) return null;
    await cuota.update(data);
    return cuota;
};

export const obtenerCuotaPorId = async (id) => {
    await actualizarCuotasVencidas();
    await recalcularMoraCuota(id);
    return Cuota.findByPk(id, {
        include: [{ model: FormaPago, attributes: ['nombre'], as: 'formaPago' }]
    });
};

export const obtenerCuotasPorCredito = async (creditoId) => {
    await actualizarCuotasVencidas();
    await recalcularMoraPorCredito(creditoId);
    return Cuota.findAll({
        where: { credito_id: creditoId },
        include: [
            { model: FormaPago, attributes: ['nombre'], as: 'formaPago' },
            {
                model: Pago,
                as: 'pagos',
                attributes: ['id', 'monto_pagado', 'fecha_pago'],
                include: [{ model: FormaPago, as: 'formaPago', attributes: ['nombre'] }]
            }
        ],
        order: [['numero_cuota', 'ASC']]
    });
};

/**
 * Listado de cuotas vencidas (NO libre/refi)
 */
export const obtenerCuotasVencidas = async (query = {}) => {
    await actualizarCuotasVencidas();

    const hoyY = todayYMD();
    const hoy = ymdDate(hoyY);

    const whereCuota = {
        estado: 'vencida',
        fecha_vencimiento: { [Op.lt]: hoyY, [Op.ne]: VTO_FICTICIO_LIBRE }
    };

    const desde = query.desde ? asYMD(query.desde) : null;
    const hasta = query.hasta ? asYMD(query.hasta) : null;
    if (desde && hasta) {
        whereCuota.fecha_vencimiento = { [Op.gte]: desde, [Op.lte]: hasta, [Op.ne]: VTO_FICTICIO_LIBRE };
    } else if (desde) {
        whereCuota.fecha_vencimiento = { [Op.gte]: desde, [Op.lt]: hoyY, [Op.ne]: VTO_FICTICIO_LIBRE };
    } else if (hasta) {
        whereCuota.fecha_vencimiento = { [Op.lte]: hasta, [Op.ne]: VTO_FICTICIO_LIBRE };
    }

    const cuotas = await Cuota.findAll({
        where: whereCuota,
        attributes: [
            'id',
            'credito_id',
            'numero_cuota',
            'fecha_vencimiento',
            'importe_cuota',
            'descuento_cuota',
            'monto_pagado_acumulado'
        ],
        include: [{
            model: Pago,
            as: 'pagos',
            attributes: ['monto_pagado', 'fecha_pago']
        }],
        order: [['fecha_vencimiento', 'ASC']]
    });

    if (cuotas.length === 0) return [];

    const creditoIds = [...new Set(cuotas.map(c => c.credito_id))];
    const creditos = await Credito.findAll({
        where: { id: { [Op.in]: creditoIds } },
        attributes: [
            'id',
            'cliente_id',
            'cobrador_id',
            'modalidad_credito',
            'estado',
            'tipo_credito',
            'interes',
            'saldo_actual',
            'fecha_acreditacion',
            'fecha_compromiso_pago'
        ]
    });
    const mapCredito = new Map(creditos.map(cr => [cr.id, cr]));

    const clienteIds = [...new Set(creditos.map(cr => cr.cliente_id))];
    const clientes = await Cliente.findAll({
        where: { id: { [Op.in]: clienteIds } },
        attributes: ['id', 'nombre', 'apellido', 'zona']
    });
    const mapCliente = new Map(clientes.map(cl => [cl.id, cl]));

    const clienteId = query.clienteId ? Number(query.clienteId) : null;
    const cobradorId = query.cobradorId ? Number(query.cobradorId) : null;
    const zonaId = query.zonaId ?? null;
    const minDiasVencida = query.minDiasVencida ? Number(query.minDiasVencida) : null;

    const filas = [];
    for (const c of cuotas) {
        const cr = mapCredito.get(c.credito_id);
        if (!cr) continue;
        if (esCreditoLibre(cr) || String(cr.estado) === 'refinanciado') continue;

        const cl = mapCliente.get(cr.cliente_id);
        if (!cl) continue;

        if (clienteId && cl.id !== clienteId) continue;
        if (cobradorId && cr.cobrador_id !== cobradorId) continue;
        if (zonaId != null && String(cl.zona ?? '') !== String(zonaId)) continue;

        const diasVencida = differenceInCalendarDays(ymdDate(hoy), ymdDate(c.fecha_vencimiento));
        if (minDiasVencida && diasVencida < minDiasVencida) continue;

        const sim = simularMoraCuotaHasta(c, c.pagos, hoy);

        const mora_pendiente = fix2(sim.moraPendiente);
        const saldo_principal_pendiente = fix2(sim.saldoPrincipalPendiente);
        const total_a_pagar_hoy = fix2(mora_pendiente + saldo_principal_pendiente);

        filas.push({
            cuota_id: c.id,
            credito_id: c.credito_id,
            numero_cuota: c.numero_cuota,
            fecha_vencimiento: asYMD(c.fecha_vencimiento),
            cliente: {
                id: cl.id,
                nombre: cl.nombre,
                apellido: cl.apellido
            },
            importe_cuota: fix2(c.importe_cuota),
            descuento_cuota: fix2(c.descuento_cuota),
            monto_pagado_acumulado: fix2(c.monto_pagado_acumulado),
            mora_pendiente,
            saldo_principal_pendiente,
            total_a_pagar_hoy: fix2(total_a_pagar_hoy),
            dias_vencida: diasVencida
        });
    }

    filas.sort((a, b) =>
        (a.fecha_vencimiento < b.fecha_vencimiento ? -1 :
            a.fecha_vencimiento > b.fecha_vencimiento ? 1 : 0));

    return filas;
};

/* ──────────────────────────────────────────────────────────────────────────
 * NUEVO: Ruta de cobro automática para el cobrador logueado
 * ────────────────────────────────────────────────────────────────────────── */
export const obtenerRutaCobroCobrador = async ({
    cobrador_id,
    hoy = todayYMD(),
    includeVencidas = true,
    includePendientesHoy = true,
    zonaId = null,
    clienteId = null,
    modo = 'plano' // 'plano' | 'separado'
} = {}) => {
    const cobradorIdNum = Number(cobrador_id);
    if (!Number.isFinite(cobradorIdNum) || cobradorIdNum <= 0) {
        throw new Error('cobrador_id inválido');
    }

    // Normalizamos hoy
    const hoyY = asYMD(hoy);
    const hoyDate = ymdDate(hoyY);

    // Asegura estados de vencidas al día
    await actualizarCuotasVencidas();

    /* ─────────────── Zona (opcional) ─────────────── */
    const mapZonaNombre = new Map(); // key: String(id) -> nombre
    const cargarZonasSiExiste = async (zonaIds = []) => {
        const idsNum = [
            ...new Set(
                (zonaIds ?? [])
                    .map((z) => Number(z))
                    .filter((n) => Number.isFinite(n))
            )
        ];
        if (idsNum.length === 0) return;

        let Zona = null;

        // 1) intento directo
        try {
            const mod = await import('../models/Zona.js');
            Zona = mod?.default ?? null;
        } catch {
            // ignore
        }

        // 2) fallback por index (si existe)
        if (!Zona) {
            try {
                const mod2 = await import('../models/index.js');
                Zona = mod2?.Zona ?? mod2?.default?.Zona ?? null;
            } catch {
                // ignore
            }
        }

        if (!Zona) return;

        const rows = await Zona.findAll({
            where: { id: { [Op.in]: idsNum } },
            attributes: ['id', 'nombre'],
            raw: true
        });

        for (const r of rows) {
            mapZonaNombre.set(String(r.id), r.nombre ?? String(r.id));
        }
    };

    /* ─────────────── NO-LIBRE: créditos del cobrador ─────────────── */
    const creditosNoLibre = await Credito.findAll({
        where: {
            cobrador_id: cobradorIdNum,
            modalidad_credito: { [Op.ne]: 'libre' },
            estado: { [Op.ne]: 'refinanciado' }
        },
        attributes: [
            'id',
            'cliente_id',
            'cobrador_id',
            'modalidad_credito',
            'estado',
            'tipo_credito',
            'interes',
            'saldo_actual',
            'fecha_acreditacion',
            'fecha_compromiso_pago'
        ]
    });
    const creditoIdsNoLibre = creditosNoLibre.map((cr) => cr.id);
    const mapCreditoNoLibre = new Map(creditosNoLibre.map(cr => [cr.id, cr]));

    /* ─────────────── NO-LIBRE: cuotas (filtradas por esos créditos) ─────────────── */
    const orCuotas = [];
    if (includeVencidas) {
        orCuotas.push({
            estado: 'vencida',
            fecha_vencimiento: { [Op.lt]: hoyY, [Op.ne]: VTO_FICTICIO_LIBRE }
        });
    }
    if (includePendientesHoy) {
        orCuotas.push({
            estado: { [Op.in]: ['pendiente', 'parcial'] },
            fecha_vencimiento: hoyY
        });
    }

    let cuotas = [];
    if (creditoIdsNoLibre.length > 0 && orCuotas.length > 0) {
        cuotas = await Cuota.findAll({
            where: {
                credito_id: { [Op.in]: creditoIdsNoLibre },
                [Op.or]: orCuotas
            },
            attributes: [
                'id',
                'credito_id',
                'numero_cuota',
                'estado',
                'fecha_vencimiento',
                'importe_cuota',
                'descuento_cuota',
                'monto_pagado_acumulado'
            ],
            include: [{
                model: Pago,
                as: 'pagos',
                attributes: ['monto_pagado', 'fecha_pago']
            }],
            order: [['fecha_vencimiento', 'ASC'], ['numero_cuota', 'ASC']]
        });
    }

    /* ─────────────── Clientes (NO-LIBRE) ─────────────── */
    const clienteIdsNoLibre = [...new Set(creditosNoLibre.map(cr => cr.cliente_id))];
    const clientesNoLibre = clienteIdsNoLibre.length
        ? await Cliente.findAll({
            where: { id: { [Op.in]: clienteIdsNoLibre } },
            attributes: [
                'id',
                'nombre',
                'apellido',
                'dni',
                'telefono',
                'telefono_secundario',
                'direccion',
                'zona'
            ]
        })
        : [];
    const mapCliente = new Map(clientesNoLibre.map(cl => [cl.id, cl]));

    await cargarZonasSiExiste(clientesNoLibre.map(c => c.zona).filter(Boolean));

    /* ─────────────── LIBRE: créditos por fecha_compromiso_pago ─────────────── */
    const orLibre = [];
    if (includeVencidas) {
        orLibre.push({ fecha_compromiso_pago: { [Op.lt]: hoyY } });
    }
    if (includePendientesHoy) {
        orLibre.push({ fecha_compromiso_pago: hoyY });
    }

    const creditosLibres = orLibre.length
        ? await Credito.findAll({
            where: {
                cobrador_id: cobradorIdNum,
                modalidad_credito: 'libre',
                estado: { [Op.notIn]: ['refinanciado', 'pagado', 'anulado'] },
                saldo_actual: { [Op.gt]: 0 },
                fecha_compromiso_pago: { [Op.ne]: null },
                [Op.or]: orLibre
            },
            attributes: [
                'id',
                'cliente_id',
                'cobrador_id',
                'modalidad_credito',
                'estado',
                'tipo_credito',
                'interes',
                'saldo_actual',
                'fecha_acreditacion',
                'fecha_compromiso_pago'
            ]
        })
        : [];

    const libreIds = creditosLibres.map(cr => cr.id);

    // Mapear cuota_id “operable” para LIBRE (normalmente la primera/única)
    const cuotasLibresAll = libreIds.length
        ? await Cuota.findAll({
            where: { credito_id: { [Op.in]: libreIds } },
            attributes: ['id', 'credito_id', 'numero_cuota'],
            order: [['credito_id', 'ASC'], ['numero_cuota', 'ASC']]
        })
        : [];
    const mapCuotaLibre = new Map();
    for (const c of cuotasLibresAll) {
        if (!mapCuotaLibre.has(c.credito_id)) mapCuotaLibre.set(c.credito_id, c);
    }

    const clienteIdsLibre = [...new Set(creditosLibres.map(cr => cr.cliente_id))];
    const clientesLibre = clienteIdsLibre.length
        ? await Cliente.findAll({
            where: { id: { [Op.in]: clienteIdsLibre } },
            attributes: [
                'id',
                'nombre',
                'apellido',
                'dni',
                'telefono',
                'telefono_secundario',
                'direccion',
                'zona'
            ]
        })
        : [];
    for (const cl of clientesLibre) {
        if (!mapCliente.has(cl.id)) mapCliente.set(cl.id, cl);
    }

    await cargarZonasSiExiste(clientesLibre.map(c => c.zona).filter(Boolean));

    /* ─────────────── Construcción de filas ─────────────── */
    const items = [];

    // NO-LIBRE filas
    for (const c of cuotas) {
        const cr = mapCreditoNoLibre.get(c.credito_id);
        if (!cr) continue; // seguridad

        const cl = mapCliente.get(cr.cliente_id);
        if (!cl) continue;

        if (clienteId != null && Number(clienteId) && cl.id !== Number(clienteId)) continue;
        if (zonaId != null && String(cl.zona ?? '') !== String(zonaId)) continue;

        const fv = asYMD(c.fecha_vencimiento);
        const categoria =
            (String(c.estado) === 'vencida' && fv < hoyY)
                ? 'vencida'
                : (fv === hoyY ? 'hoy' : null);

        if (!categoria) continue;

        const diasVencida =
            categoria === 'vencida'
                ? Math.max(differenceInCalendarDays(hoyDate, ymdDate(fv)), 0)
                : 0;

        const sim = simularMoraCuotaHasta(c, c.pagos, hoyDate);
        const mora_pendiente = fix2(sim.moraPendiente);
        const saldo_principal_pendiente = fix2(sim.saldoPrincipalPendiente);
        const total_a_pagar_hoy = fix2(mora_pendiente + saldo_principal_pendiente);

        const zona_id = cl.zona ?? null;
        const zona_nombre = zona_id != null
            ? (mapZonaNombre.get(String(zona_id)) ?? String(zona_id))
            : null;

        items.push({
            categoria,
            modalidad_credito: cr.modalidad_credito,
            tipo_credito: cr.tipo_credito,
            credito_estado: cr.estado,

            cuota_id: c.id,
            credito_id: c.credito_id,
            numero_cuota: c.numero_cuota,
            estado_cuota: c.estado,
            fecha_vencimiento: fv,
            dias_vencida: diasVencida,

            cliente_id: cl.id,
            cliente_nombre: cl.nombre,
            cliente_apellido: cl.apellido,
            cliente_dni: cl.dni ?? null,
            cliente_telefono: cl.telefono ?? null,
            cliente_telefono_secundario: cl.telefono_secundario ?? null,
            cliente_direccion: cl.direccion ?? null,
            zona_id,
            zona_nombre,

            importe_cuota: fix2(c.importe_cuota),
            descuento_cuota: fix2(c.descuento_cuota),
            monto_pagado_acumulado: fix2(c.monto_pagado_acumulado),

            mora_pendiente,
            saldo_principal_pendiente,
            total_a_pagar_hoy
        });
    }

    // LIBRE filas (ahora totales reales por ciclos)
    let libres_sin_cuota = 0;
    for (const cr of creditosLibres) {
        const cl = mapCliente.get(cr.cliente_id);
        if (!cl) continue;

        if (clienteId != null && Number(clienteId) && cl.id !== Number(clienteId)) continue;
        if (zonaId != null && String(cl.zona ?? '') !== String(zonaId)) continue;

        const fcp = asYMD(cr.fecha_compromiso_pago);
        const categoria =
            (includeVencidas && fcp < hoyY) ? 'vencida'
                : (includePendientesHoy && fcp === hoyY) ? 'hoy'
                    : null;

        if (!categoria) continue;

        const diasVencida =
            categoria === 'vencida'
                ? Math.max(differenceInCalendarDays(hoyDate, ymdDate(fcp)), 0)
                : 0;

        const cuotaOperable = mapCuotaLibre.get(cr.id) || null;
        if (!cuotaOperable?.id) {
            libres_sin_cuota += 1;
            continue;
        }

        const saldo_capital = fix2(cr.saldo_actual || 0);

        const deudaTot = await deudaLibreTotalHoy({ credito: cr, hoyYMD: hoyY, t: null });
        const interes_pendiente_hoy = fix2(deudaTot.interes_pendiente_total);
        const mora_pendiente_hoy = fix2(deudaTot.mora_pendiente_total);
        const total_a_pagar_hoy = fix2(saldo_capital + interes_pendiente_hoy + mora_pendiente_hoy);

        const zona_id = cl.zona ?? null;
        const zona_nombre = zona_id != null
            ? (mapZonaNombre.get(String(zona_id)) ?? String(zona_id))
            : null;

        items.push({
            categoria,
            modalidad_credito: 'libre',
            tipo_credito: cr.tipo_credito,
            credito_estado: cr.estado,

            cuota_id: cuotaOperable.id,
            credito_id: cr.id,
            numero_cuota: cuotaOperable.numero_cuota ?? null,

            fecha_vencimiento: fcp,
            dias_vencida: diasVencida,

            cliente_id: cl.id,
            cliente_nombre: cl.nombre,
            cliente_apellido: cl.apellido,
            cliente_dni: cl.dni ?? null,
            cliente_telefono: cl.telefono ?? null,
            cliente_telefono_secundario: cl.telefono_secundario ?? null,
            cliente_direccion: cl.direccion ?? null,
            zona_id,
            zona_nombre,

            saldo_capital,
            interes_pendiente_hoy,
            mora_pendiente_hoy,
            total_a_pagar_hoy
        });
    }

    items.sort((a, b) => {
        const prA = a.categoria === 'vencida' ? 0 : 1;
        const prB = b.categoria === 'vencida' ? 0 : 1;
        if (prA !== prB) return prA - prB;

        if (a.fecha_vencimiento !== b.fecha_vencimiento) {
            return a.fecha_vencimiento < b.fecha_vencimiento ? -1 : 1;
        }

        const an = `${a.cliente_apellido ?? ''} ${a.cliente_nombre ?? ''}`.trim().toLowerCase();
        const bn = `${b.cliente_apellido ?? ''} ${b.cliente_nombre ?? ''}`.trim().toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;

        return (a.credito_id ?? 0) - (b.credito_id ?? 0);
    });

    const meta = {
        cobrador_id: cobradorIdNum,
        hoy: hoyY,
        total: items.length,
        total_vencidas: items.filter(i => i.categoria === 'vencida').length,
        total_hoy: items.filter(i => i.categoria === 'hoy').length,
        libres_sin_cuota
    };

    if (modo === 'separado') {
        return {
            vencidas: items.filter(i => i.categoria === 'vencida'),
            hoy: items.filter(i => i.categoria === 'hoy'),
            meta
        };
    }

    return { items, meta };
};

/* ───────────────── Recibos ───────────────── */
/** Devuelve el nombre legible de la modalidad de crédito para usar en el concepto del recibo */
const nombreModalidadCredito = (modalidadRaw) => {
    const mod = String(modalidadRaw || '').toLowerCase();
    if (mod === 'libre') return 'LIBRE';
    if (mod === 'comun') return 'PLAN DE CUOTAS FIJAS';
    if (mod === 'progresivo') return 'PROGRESIVO';
    return 'CRÉDITO';
};

const armarDatosRecibo = ({
    cliente,
    cobrador,
    pago,
    cuota,
    credito,
    medioPagoNombre,
    importeOriginalCuota,
    descuentoAplicado,
    moraCobrada,
    principalPagado,
    saldoPrincipalAntes,
    saldoPrincipalDespues,
    saldoCreditoAntes,
    saldoCreditoDespues,
    conceptoExtra = '',
    interesCicloCobrado = 0,
    saldoCuotaAnterior = undefined,
    saldoCuotaActual = undefined,
    saldoMoraRestante = undefined,
    // ✅ nuevo: ciclo libre imputado
    cicloLibre = null
}) => {
    const nowYMD = todayYMD();
    const nowTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false, second: '2-digit'
    }).format(new Date());

    const payload = {
        cliente_id: cliente.id,
        pago_id: pago.id,
        cuota_id: cuota.id,
        cliente_nombre: `${cliente.nombre} ${cliente.apellido}`,
        monto_pagado: fix2(pago.monto_pagado),
        concepto: conceptoExtra || `Pago cuota #${cuota.numero_cuota} del ${nombreModalidadCredito(credito?.modalidad_credito)} #${credito.id}`,
        fecha: nowYMD,
        hora: nowTime,

        saldo_anterior: fix2(
            typeof saldoCuotaAnterior === 'number' ? saldoCuotaAnterior : saldoPrincipalAntes
        ),
        pago_a_cuenta: fix2(pago.monto_pagado),
        saldo_actual: fix2(
            typeof saldoCuotaActual === 'number' ? saldoCuotaActual : saldoPrincipalDespues
        ),

        nombre_cobrador: cobrador?.nombre_completo || 'Sin cobrador asignado',
        medio_pago: medioPagoNombre,

        importe_cuota_original: fix2(importeOriginalCuota),
        descuento_aplicado: fix2(descuentoAplicado),
        mora_cobrada: fix2(moraCobrada),
        principal_pagado: fix2(principalPagado),

        saldo_mora: saldoMoraRestante !== undefined ? fix2(saldoMoraRestante) : undefined,

        saldo_credito_anterior: fix2(saldoCreditoAntes),
        saldo_credito_actual: fix2(saldoCreditoDespues),

        interes_ciclo_cobrado: fix2(interesCicloCobrado),

        modalidad_credito: credito?.modalidad_credito || undefined
    };

/**
 * Crea recibo de forma compatible con DB legacy (sin columna `ciclo_libre`).
 * - Intento 1: con payload completo
 * - Si falla por columna faltante, reintenta sin `ciclo_libre`
 */
const createReciboSafe = async (payload, options = {}) => {
    try {
        return await Recibo.create(payload, options);
    } catch (e) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, 'ciclo_libre') && isMissingColumnError(e, 'ciclo_libre')) {
            marcarReciboSinCicloLibre();
            const clone = { ...payload };
            delete clone.ciclo_libre;
            return await Recibo.create(clone, options);
        }
        throw e;
    }
};

    // ✅ persistimos ciclo_libre solo para LIBRE
    if (String(credito?.modalidad_credito || '').toLowerCase() === 'libre') {
        payload.ciclo_libre = (cicloLibre != null ? Number(cicloLibre) : null);
    }

    return payload;
};

/* ───────────────── Pagos ───────────────── */
export const pagarCuota = async (...args) => {
    if (args.length && typeof args[0] !== 'object') {
        const [cuotaId, formaPagoId, observacion = null, usuario_id = null] = args;
        return pagarCuotaTotal({
            cuota_id: cuotaId,
            forma_pago_id: formaPagoId,
            descuento: 0,
            observacion,
            usuario_id
        });
    }
    return pagarCuotaTotal(args[0]);
};

const pagarCuotaTotal = async ({
    cuota_id,
    forma_pago_id,
    descuento = 0,
    descuento_scope = null,   // 'mora' | 'total' | null
    descuento_mora = null,    // para 'mora' (en LIBRE se interpreta como %; en NO-LIBRE como MONTO)
    observacion = null,
    usuario_id = null,
    rol_id = null,
    monto_pagado = null,      // ✅ para LIBRE: permite pagos parciales
    ciclo_libre = null        // ✅ opcional: forzar ciclo objetivo en LIBRE
}) => {
    const t = await sequelize.transaction();
    try {
        const cuota = await Cuota.findByPk(cuota_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!cuota) throw new Error('Cuota no encontrada');

        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        assertNoPagoSiRefinanciado({ credito, cuota });

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        const isAdmin = Number(rol_id) === 1;

        // —— LIBRE → Total = CAPITAL + INTERÉS (ciclos) + MORA (ciclos) —— 
        if (esCreditoLibre(credito)) {
            const hoyYMD_TZ = todayYMD();
        
            // ✅ Política cliente:
            //  - Interés del ciclo sobre capital (base del ciclo).
            //  - Mora diaria sobre el interés del ciclo.
            //  - Imputación: MORA → INTERÉS → CAPITAL.
            //  - Se permite pago parcial; para cerrar ciclo debe cubrir mora+interés.
        
            const saldoCapitalAntes = fix2(credito.saldo_actual);
        
            // Deuda total (interés+mora) por ciclos 1..ciclo_actual
            const deudaTotAntes = await deudaLibreTotalHoy({ credito, hoyYMD: hoyYMD_TZ, t });
            const interesPendienteTotalAntes = fix2(deudaTotAntes.interes_pendiente_total);
            const moraPendienteTotalAntes = fix2(deudaTotAntes.mora_pendiente_total);
            const cicloActual = clamp(toNumber(deudaTotAntes.ciclo_actual), 1, LIBRE_MAX_CICLOS);
        
            // Ciclo objetivo: por default el más viejo abierto (con deuda)
            let cicloObjetivo = null;
            let detalleCiclo = null;
            if (ciclo_libre != null && String(ciclo_libre).trim() !== '') {
                cicloObjetivo = clamp(toNumber(ciclo_libre), 1, cicloActual);
                detalleCiclo = await deudaLibrePorCiclo({
                    credito,
                    cuotaBase: await obtenerCuotaBaseLibre({ credito_id: credito.id, t }),
                    cuotaIds: await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t }),
                    ciclo: cicloObjetivo,
                    hoyYMD: hoyYMD_TZ,
                    t
                });
            } else {
                const masViejo = await cicloLibreMasViejoAbierto({ credito, hoyYMD: hoyYMD_TZ, t });
                cicloObjetivo = masViejo?.ciclo ?? cicloActual;
                detalleCiclo = masViejo?.detalle ?? null;
            }
        
            if (!detalleCiclo) {
                const cuotaBase = await obtenerCuotaBaseLibre({ credito_id: credito.id, t });
                const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t });
                detalleCiclo = await deudaLibrePorCiclo({ credito, cuotaBase, cuotaIds, ciclo: cicloObjetivo, hoyYMD: hoyYMD_TZ, t });
            }
        
            const interesPendienteCiclo = fix2(detalleCiclo?.interes_pendiente ?? 0);
            const moraPendienteCiclo = fix2(detalleCiclo?.mora_pendiente ?? 0);
        
            // Descuento: permitido solo sobre mora (% 0..100). Admin fuerza scope=mora.
            const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
            const pctRaw = scope === 'mora'
                ? (descuento_mora != null ? toNumber(descuento_mora) : toNumber(descuento))
                : 0;
            const pct = clamp(fix2(pctRaw), 0, 100);
            const moraBonificada = fix2(moraPendienteCiclo * (pct / 100));
            const moraNetaCiclo = fix2(Math.max(moraPendienteCiclo - moraBonificada, 0));
        
            // Si no se envía monto, por defecto cobramos lo necesario para cerrar el ciclo (mora + interés).
            const montoIngresado = (monto_pagado != null && String(monto_pagado).trim() !== '') ? fix2(toNumber(monto_pagado)) : null;
            const sugeridoCerrarCiclo = fix2(Math.max(moraNetaCiclo + interesPendienteCiclo, 0));
            const montoAImputar = (montoIngresado != null ? montoIngresado : sugeridoCerrarCiclo);
        
            if (!(montoAImputar > 0)) {
                const err = new Error('Monto inválido para registrar el pago en crédito LIBRE.');
                err.status = 400;
                throw err;
            }
        
            // Imputación: MORA → INTERÉS → CAPITAL
            let restante = fix2(montoAImputar);
            const moraCobrada = fix2(Math.min(restante, moraNetaCiclo));
            restante = fix2(restante - moraCobrada);
            const interesCicloCobrado = fix2(Math.min(restante, interesPendienteCiclo));
            restante = fix2(restante - interesCicloCobrado);
            const principalPagado = fix2(Math.min(restante, saldoCapitalAntes));
            restante = fix2(restante - principalPagado);
        
            const totalAplicado = fix2(moraCobrada + interesCicloCobrado + principalPagado);
            if (!(totalAplicado > 0)) {
                const err = new Error('El pago no impacta sobre deuda (mora/interés/capital).');
                err.status = 400;
                throw err;
            }
        
            // No aceptar sobrante (más plata que deuda + capital)
            if (restante > 0.01) {
                const err = new Error('El monto excede la deuda/capital pendiente del crédito LIBRE.');
                err.status = 400;
                throw err;
            }
        
            // Saldo total antes/después (para recibo)
            const moraTotalNetaAntes = fix2(Math.max(moraPendienteTotalAntes - moraBonificada, 0));
            const totalAntes = fix2(saldoCapitalAntes + interesPendienteTotalAntes + moraTotalNetaAntes);
            const totalDespues = fix2(Math.max(totalAntes - totalAplicado, 0));
        
            // Persistencia
            const pago = await Pago.create(
                { cuota_id, monto_pagado: totalAplicado, forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
                { transaction: t }
            );
        
            // Actualizo capital (Crédito) y acumulo ingresos por mora+interés
            await credito.update({
                saldo_actual: fix2(Math.max(saldoCapitalAntes - principalPagado, 0)),
                interes_acumulado: fix2(toNumber(credito.interes_acumulado) + moraCobrada + interesCicloCobrado)
            }, { transaction: t });
        
            // Cuota “base” (LIBRE): solo refleja capital pagado
            const principalPrevio = fix2(toNumber(cuota.monto_pagado_acumulado));
            await cuota.update({
                estado: (credito.saldo_actual <= 0 && totalDespues <= 0) ? 'pagada' : 'parcial',
                forma_pago_id,
                monto_pagado_acumulado: fix2(principalPrevio + principalPagado)
            }, { transaction: t });
        
            const reciboPayload = await armarDatosRecibo({
                credito,
                cuota,
                pago,
                cliente,
                cobrador,
                medioPago,
                montoPagado: totalAplicado,
                pagoACuenta: totalAplicado,
                moraCobrada,
                principalPagado,
                interesCicloCobrado,
                descuentoAplicado: moraBonificada,
                saldoCuotaAnterior: totalAntes,
                saldoCuotaActual: totalDespues,
                saldoMoraRestante: fix2(Math.max(moraNetaCiclo - moraCobrada, 0)),
                conceptoExtra: `Pago crédito LIBRE #${credito.id} - ciclo ${cicloObjetivo}`,
                cicloLibre: cicloObjetivo
            });
        
            const recibo = await createReciboSafe(reciboPayload, { transaction: t });
        
            // Impacto en caja
            await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });
        
            // Validación tope (ciclo 3): si ya llegamos al tope y se “cerraron” mora+interés pero queda capital → debe cancelar o refinanciar
            if (cicloActual >= 3) {
                const deudaTotDespues = await deudaLibreTotalHoy({ credito, hoyYMD: hoyYMD_TZ, t });
                const sinInteresMora = fix2(deudaTotDespues.interes_pendiente_total) <= 0 && fix2(deudaTotDespues.mora_pendiente_total) <= 0;
                const quedaCapital = fix2(credito.saldo_actual) > 0;
                if (sinInteresMora && quedaCapital) {
                    const err = new Error('Crédito LIBRE en 3° ciclo: debe CANCELAR o REFINANCIAR (no se permite seguir).');
                    err.status = 409;
                    err.code = 'LIBRE_TOPE_3_CICLOS';
                    throw err;
                }
            }
        
            const { actualizarEstadoCredito } = await import('./credito.service.js');
            await actualizarEstadoCredito(credito.id, t);
        
            await t.commit();
            await calcularPuntajeCliente(cliente.id);
        
            // Resumen LIBRE post-commit (para evitar parpadeo en front)
            let resumen_libre = null;
            try {
                resumen_libre = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD_TZ));
            } catch (e) {
                resumen_libre = null;
            }
        
            const creditoFresh = await Credito.findByPk(credito.id);
            const credito_ui = {
                id: credito.id,
                modalidad_credito: credito.modalidad_credito,
                saldo_actual: fix2(creditoFresh?.saldo_actual ?? credito.saldo_actual),
                estado: creditoFresh?.estado ?? credito.estado
            };
        
            return { cuota, recibo, credito: credito_ui, resumen_libre };
        }
        // —— NO libre —— 
        const moraActual = await recalcularMoraCuota(cuota.id, t);

        const importeOriginal = fix2(cuota.importe_cuota);
        const descuentoPrevio = fix2(cuota.descuento_cuota);
        const principalPagadoPrevio = fix2(cuota.monto_pagado_acumulado);

        const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
        const descuentoMoraBruto = scope === 'mora'
            ? (descuento_mora != null ? fix2(toNumber(descuento_mora)) : fix2(toNumber(descuento)))
            : fix2(toNumber(descuento));

        const descuentoMora = Math.min(Math.max(descuentoMoraBruto, 0), fix2(moraActual));
        const moraNeta = fix2(Math.max(moraActual - descuentoMora, 0));

        const saldoPrincipalTrasDescuento = Math.max(importeOriginal - descuentoPrevio - principalPagadoPrevio, 0);

        const netoAPagar = fix2(moraNeta + saldoPrincipalTrasDescuento);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: netoAPagar, forma_pago_id, observacion, fecha_pago: todayYMD() },
            { transaction: t }
        );

        const moraCobrada = Math.min(netoAPagar, moraNeta);
        const principalPagado = Math.max(netoAPagar - moraCobrada, 0);

        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraNeta - moraCobrada, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalPagado);
        cuota.descuento_cuota = descuentoPrevio;
        cuota.estado = 'pagada';
        cuota.forma_pago_id = forma_pago_id;
        await cuota.save({ transaction: t });

        credito.interes_acumulado = fix2(toNumber(credito.interes_acumulado) + moraCobrada);
        credito.saldo_actual = fix2(Math.max(toNumber(credito.saldo_actual) - principalPagado, 0));
        await credito.save({ transaction: t });

        const totalAntes = fix2(saldoPrincipalTrasDescuento + moraActual);
        const totalDespues = 0;

        const recibo = await createReciboSafe(armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeOriginal,
            descuentoAplicado: descuentoMora,
            moraCobrada,
            principalPagado,
            saldoPrincipalAntes: Math.max(importeOriginal - descuentoPrevio - principalPagadoPrevio, 0),
            saldoPrincipalDespues: 0,
            saldoCreditoAntes: fix2(toNumber(credito.saldo_actual) + principalPagado),
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0,
            saldoCuotaAnterior: totalAntes,
            saldoCuotaActual: totalDespues,
            saldoMoraRestante: 0
        }), { transaction: t });

        const plain = recibo.get({ plain: true });
        plain.modalidad_credito = credito.modalidad_credito;
        const ui = buildReciboUI(plain);
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

        const { actualizarEstadoCredito } = await import('./credito.service.js');
        await actualizarEstadoCredito(credito.id, t);
        await t.commit();

        await calcularPuntajeCliente(cliente.id);

        return { cuota, recibo };
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

export const registrarPagoParcial = async ({
    cuota_id,
    monto_pagado,
    forma_pago_id,
    observacion = null,
    descuento = 0,
    descuento_scope = null,   // 'mora' | null
    descuento_mora = null,    // en LIBRE se interpreta como %; en NO-LIBRE como MONTO
    usuario_id = null,
    rol_id = null
}) => {
    const t = await sequelize.transaction();
    try {
        if (toNumber(monto_pagado) <= 0) throw new Error('monto_pagado debe ser > 0');

        const cuota = await Cuota.findByPk(cuota_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!cuota) throw new Error('Cuota no encontrada');

        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        assertNoPagoSiRefinanciado({ credito, cuota });

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        const hoyYMD_TZ = todayYMD();
        const isAdmin = Number(rol_id) === 1;

        // —— LIBRE → parcial: se imputa al ciclo más viejo abierto: MORA → INTERÉS → CAPITAL —— 
        if (esCreditoLibre(credito)) {
            const cicloActual = cicloLibreActual(credito, hoyYMD_TZ);
            if (cicloActual >= LIBRE_MAX_CICLOS) {
                throw new Error('En el 3er ciclo del crédito LIBRE no se permite pago parcial. Debe cancelar (pago total) o refinanciar.');
            }

            const pagado = fix2(monto_pagado);
            const saldoAntesCapital = fix2(credito.saldo_actual);

            // ✅ Totales globales antes (para recibo coherente)
            const deudaTotAntes = await deudaLibreTotalHoy({ credito, hoyYMD: hoyYMD_TZ, t });
            const interesTotalAntes = fix2(deudaTotAntes.interes_pendiente_total);
            const moraTotalAntes = fix2(deudaTotAntes.mora_pendiente_total);
            const totalAntesGlobal = fix2(saldoAntesCapital + interesTotalAntes + moraTotalAntes);

            // ✅ Encontrar ciclo objetivo (más viejo con deuda)
            const { ciclo: cicloObjetivo, detalle: detCiclo } = await cicloLibreMasViejoAbierto({
                credito,
                hoyYMD: hoyYMD_TZ,
                t
            });

            const interesPendienteCiclo = fix2(detCiclo.interes_pendiente);
            const moraPendienteCiclo = fix2(detCiclo.mora_pendiente);

            // ✅ Descuento (solo sobre mora) en LIBRE = % (0..100) aplicado al ciclo objetivo
            const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
            const pctRaw = scope === 'mora'
                ? (descuento_mora != null ? toNumber(descuento_mora) : toNumber(descuento))
                : toNumber(descuento);

            const pct = clamp(fix2(pctRaw), 0, 100);
            const descuentoMoraCiclo = fix2(moraPendienteCiclo * (pct / 100));
            const moraNetaCiclo = fix2(Math.max(moraPendienteCiclo - descuentoMoraCiclo, 0));

            // ✅ Imputación: primero MORA del ciclo objetivo, luego INTERÉS del ciclo objetivo, luego CAPITAL
            const aMora = Math.min(pagado, moraNetaCiclo);
            const restoTrasMora = fix2(pagado - aMora);

            const aInteres = Math.min(restoTrasMora, interesPendienteCiclo);
            const restoTrasInteres = fix2(restoTrasMora - aInteres);

            const aCapital = Math.min(restoTrasInteres, saldoAntesCapital);

            const nuevoSaldoCapital = fix2(Math.max(saldoAntesCapital - aCapital, 0));

            // ✅ Totales globales después (a igual fecha, la mora no “cambia” salvo lo pagado/bonificado)
            const interesTotalDespues = fix2(Math.max(interesTotalAntes - aInteres, 0));
            const moraTotalDespues = fix2(Math.max(moraTotalAntes - aMora - descuentoMoraCiclo, 0));
            const totalDespuesGlobal = fix2(nuevoSaldoCapital + interesTotalDespues + moraTotalDespues);

            // ✅ Persistencia del pago
            const pago = await Pago.create(
                { cuota_id, monto_pagado: pagado, forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
                { transaction: t }
            );

            // ✅ Cuota: solo guardamos capital pagado acumulado y mora total pendiente (para compat)
            const capitalPagadoPrevio = fix2(cuota.monto_pagado_acumulado || 0);
            const topeCapital = Math.max(fix2(toNumber(cuota.importe_cuota) - toNumber(cuota.descuento_cuota)), 0);
            const capitalPagadoNuevo = fix2(Math.min(capitalPagadoPrevio + aCapital, topeCapital));

            const moraRestanteGlobal = moraTotalDespues;

            const liquidado = (nuevoSaldoCapital <= 0 && interesTotalDespues <= 0 && moraTotalDespues <= 0);
            const nuevaEstado = liquidado ? 'pagada' : 'parcial';
            await cuota.update({
                estado: nuevaEstado,
                forma_pago_id,
                intereses_vencidos_acumulados: moraRestanteGlobal,
                monto_pagado_acumulado: capitalPagadoNuevo
            }, { transaction: t });

            await credito.update({
                saldo_actual: nuevoSaldoCapital,
                interes_acumulado: fix2(toNumber(credito.interes_acumulado) + aInteres + aMora),
                estado: liquidado ? 'pagado' : credito.estado
            }, { transaction: t });

            const recibo = await createReciboSafe(armarDatosRecibo({
                cliente,
                cobrador,
                pago,
                cuota,
                credito,
                medioPagoNombre: medioPago?.nombre ?? 'N/D',
                importeOriginalCuota: cuota.importe_cuota,
                descuentoAplicado: descuentoMoraCiclo,   // bonificación de mora sobre ciclo objetivo
                moraCobrada: aMora,
                principalPagado: aCapital,
                saldoPrincipalAntes: saldoAntesCapital,
                saldoPrincipalDespues: nuevoSaldoCapital,
                saldoCreditoAntes: saldoAntesCapital,
                saldoCreditoDespues: nuevoSaldoCapital,
                conceptoExtra: `Pago parcial LIBRE #${credito.id} (Ciclo ${cicloObjetivo})`,
                interesCicloCobrado: aInteres,
                saldoCuotaAnterior: totalAntesGlobal,
                saldoCuotaActual: totalDespuesGlobal,
                saldoMoraRestante: moraRestanteGlobal,
                cicloLibre: cicloObjetivo
            }), { transaction: t });

            const plain = recibo.get({ plain: true });
            plain.modalidad_credito = credito.modalidad_credito;
            const ui = buildReciboUI(plain);
            recibo.setDataValue('recibo_ui', ui);
            recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

            await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

            const { actualizarEstadoCredito } = await import('./credito.service.js');
            await actualizarEstadoCredito(credito.id, t);
            await t.commit();

            await calcularPuntajeCliente(credito.cliente_id);

            // ✅ Resumen LIBRE actualizado (post-commit) para evitar parpadeos/re-fetch en el front
            let resumen_libre = null;
            try {
              resumen_libre = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD_TZ));
            } catch (e) {
              resumen_libre = null;
            }

            const credito_ui = {
              id: credito.id,
              modalidad_credito: credito.modalidad_credito,
              saldo_actual: fix2(credito.saldo_actual),
              estado: credito.estado
            };

            return { cuota, recibo, credito: credito_ui, resumen_libre };
        }

        // —— NO libre —— (sin cambios sustanciales)
        const moraActual = await recalcularMoraCuota(cuota.id, t);

        const importeCuota = fix2(cuota.importe_cuota);
        const descuentoPrevio = fix2(cuota.descuento_cuota);
        const principalPagadoPrevio = fix2(cuota.monto_pagado_acumulado);
        const saldoPrincipalAntes = Math.max(importeCuota - descuentoPrevio - principalPagadoPrevio, 0);
        const saldoCreditoAntes = fix2(credito.saldo_actual);

        const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
        const descMoraRaw = scope === 'mora'
            ? (descuento_mora != null ? fix2(toNumber(descuento_mora)) : fix2(toNumber(descuento)))
            : fix2(toNumber(descuento));

        const descuentoMora = Math.min(Math.max(descMoraRaw, 0), fix2(moraActual));
        const moraNeta = fix2(Math.max(moraActual - descuentoMora, 0));

        const saldoPrincipalTrasDescuento = Math.max(importeCuota - descuentoPrevio - principalPagadoPrevio, 0);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: fix2(monto_pagado), forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
            { transaction: t }
        );

        const aMora = Math.min(fix2(monto_pagado), moraNeta);
        const aPrincipal = Math.max(fix2(monto_pagado) - aMora, 0);
        const principalEfectivo = Math.min(aPrincipal, saldoPrincipalTrasDescuento);

        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraNeta - aMora, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalEfectivo);
        cuota.descuento_cuota = descuentoPrevio;

        const principalPendienteDespues = Math.max(
            importeCuota - cuota.descuento_cuota - cuota.monto_pagado_acumulado,
            0
        );
        const moraRestante = fix2(cuota.intereses_vencidos_acumulados);

        if (principalPendienteDespues <= 0 && moraRestante <= 0) {
            cuota.estado = 'pagada';
        } else if (['pendiente', 'parcial', 'vencida'].includes(cuota.estado)) {
            cuota.estado = principalEfectivo > 0 ? 'parcial' : cuota.estado;
        }

        const tasa = normalizeRate(credito.interes);
        const principalOriginal = importeCuota / (1 + tasa);
        const interesPorCuota = importeCuota - principalOriginal;

        if (principalEfectivo >= interesPorCuota) {
            const base = dateFromYMD(cuota.fecha_vencimiento);
            const delta =
                credito.tipo_credito === 'semanal' ? 7 :
                    credito.tipo_credito === 'quincenal' ? 15 : 30;
            const nuevoVto = addDays(base, delta);
            cuota.fecha_vencimiento = asYMD(nuevoVto);
            if (cuota.estado === 'vencida') cuota.estado = 'pendiente';
        }

        await cuota.save({ transaction: t });

        credito.interes_acumulado = fix2(toNumber(credito.interes_acumulado) + aMora);
        credito.saldo_actual = fix2(Math.max(toNumber(credito.saldo_actual) - principalEfectivo, 0));
        await credito.save({ transaction: t });

        const totalAntes = fix2(saldoPrincipalTrasDescuento + moraActual);
        const totalDespues = fix2(principalPendienteDespues + moraRestante);

        const recibo = await createReciboSafe(armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeCuota,
            descuentoAplicado: descuentoMora,
            moraCobrada: aMora,
            principalPagado: principalEfectivo,
            saldoPrincipalAntes,
            saldoPrincipalDespues: fix2(principalPendienteDespues),
            saldoCreditoAntes,
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0,
            saldoCuotaAnterior: totalAntes,
            saldoCuotaActual: totalDespues,
            saldoMoraRestante: moraRestante
        }), { transaction: t });

        const plain = recibo.get({ plain: true });
        plain.modalidad_credito = credito.modalidad_credito;
        const ui = buildReciboUI(plain);
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

        const { actualizarEstadoCredito } = await import('./credito.service.js');
        await actualizarEstadoCredito(cuota.credito_id, t);
        await t.commit();

        await calcularPuntajeCliente(credito.cliente_id);

        return { cuota, recibo };
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

/* ───────────────── Soporte a rutas existentes ───────────────── */
export const crearCuota = async (data) => {
    const cuota = await Cuota.create(data);
    return cuota;
};

export const eliminarCuota = async (id) => {
    const t = await sequelize.transaction();
    try {
        const cuota = await Cuota.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!cuota) {
            await t.rollback();
            return false;
        }

        const tienePagos = await Pago.count({ where: { cuota_id: id }, transaction: t });
        if (tienePagos > 0) {
            await t.rollback();
            const err = new Error('No se puede eliminar la cuota: tiene pagos registrados.');
            err.status = 409;
            throw err;
        }

        const recibos = await findAllReciboSafe({
            where: { cuota_id: id },
            attributes: ['numero_recibo'],
            transaction: t
        });
        const numerosRecibo = recibos.map(r => r.numero_recibo);

        if (numerosRecibo.length > 0) {
            await CajaMovimiento.destroy({
                where: { referencia_tipo: 'recibo', referencia_id: { [Op.in]: numerosRecibo } },
                transaction: t
            });
            await Recibo.destroy({
                where: { numero_recibo: { [Op.in]: numerosRecibo } },
                transaction: t
            });
        }

        await cuota.destroy({ transaction: t });
        await t.commit();
        return true;
    } catch (e) {
        if (t.finished !== 'commit') {
            try { await t.rollback(); } catch (_) { }
        }
        throw e;
    }
};

/* ───────────────── Resumen LIBRE ───────────────── */
export const obtenerResumenLibrePorCredito = async (creditoId, fecha = ymdDate(todayYMD()), t = null) => {
    const credito = await Credito.findByPk(creditoId, {
            transaction: t || undefined,
            lock: t ? t.LOCK.UPDATE : undefined
        });
    if (!credito) throw new Error('Crédito no encontrado');

    const saldo = fix2(credito.saldo_actual);
    const tasaDec = normalizeRate(credito.interes);

    if (!esCreditoLibre(credito)) {
        return {
            credito_id: credito.id,
            saldo_capital: saldo,
            interes_pendiente_hoy: 0,
            mora_pendiente_hoy: 0,
            total_liquidacion_hoy: saldo,
            tasa_decimal: tasaDec,
            hoy: asYMD(fecha)
        };
    }

    // ✅ Defensive: si por alguna razón el crédito LIBRE se creó sin su cuota abierta
    // (datos viejos / migración / bug anterior), la creamos en caliente para evitar 500.
    // La cuota “abierta” es la que actúa como contenedor para pagos/recibos en modalidad LIBRE.
    let cuota = await Cuota.findOne({
        where: { credito_id: creditoId },
        order: [['numero_cuota', 'ASC']],
        transaction: t || undefined,
        lock: t ? t.LOCK.UPDATE : undefined
    });

    if (!cuota) {
        cuota = await Cuota.create(
            {
                credito_id: creditoId,
                numero_cuota: 1,
                // En LIBRE usamos importe_cuota como “capital base” para compatibilidad de UI,
                // pero el cálculo real de interés/mora se hace en esta función.
                importe_cuota: fix2(toNumber(credito.saldo_actual || 0)),
                fecha_vencimiento: VTO_FICTICIO_LIBRE,
                estado: 'pendiente',
                intereses_vencidos_acumulados: 0,
                monto_pagado_acumulado: 0,
                descuento_cuota: 0
            },
            { transaction: t || undefined }
        );
    }

    const hoyYMD = asYMD(fecha);

    const deudaTot = await deudaLibreTotalHoy({ credito, hoyYMD, t });

    const interesPendiente = fix2(deudaTot.interes_pendiente_total);
    const moraLibre = fix2(deudaTot.mora_pendiente_total);

    return {
        credito_id: credito.id,
        saldo_capital: saldo,
        interes_pendiente_hoy: interesPendiente,
        mora_pendiente_hoy: moraLibre,
        total_liquidacion_hoy: fix2(saldo + interesPendiente + moraLibre),
        tasa_decimal: tasaDec,
        hoy: hoyYMD,
        ciclo_actual: deudaTot.ciclo_actual,
        detalle_por_ciclo: deudaTot.detalle_por_ciclo
    };
};