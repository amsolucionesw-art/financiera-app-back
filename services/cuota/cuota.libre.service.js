// financiera-backend/services/cuota/cuota.libre.service.js

import Cuota from '../../models/Cuota.js';
import Credito from '../../models/Credito.js';
import Recibo from '../../models/Recibo.js';
import { Op } from 'sequelize';

import {
    asYMD,
    ymd,
    ymdDate,
    todayYMD,
    dateFromYMD,
    toNumber,
    fix2,
    clamp,
    isMissingColumnError,
    reciboTieneCicloLibreCol,
    normalizarAttributesRecibo,
    findAllReciboSafe,
    marcarReciboSinCicloLibre
} from './cuota.utils.js';

import Pago from '../../models/Pago.js';
import { createReciboSafe, armarDatosRecibo, buildReciboUI } from './cuota.recibo.service.js';
import { crearReciboEnTxCompat } from './cuota.recibo.compat.service.js';
import { registrarIngresoDesdeReciboEnTx } from './cuota.caja.service.js';

/* =============================================================================
   Constantes LIBRE
   ============================================================================= */

export const MORA_DIARIA_LIBRE = 0.025; // 2.5% por día
export const VTO_FICTICIO_LIBRE = '2099-12-31';
export const LIBRE_MAX_CICLOS = 3;

// Requerimiento cliente: interés del ciclo = 60% del capital base del ciclo
export const TASA_INTERES_CICLO_LIBRE = 0.60;

/* =============================================================================
   ✅ Recibos: compat con DBs sin columna Recibo.ciclo_libre (evita crash)
   =============================================================================
   FIX 1: la tabla `recibos` en tu DB NO tiene columna `id` (tiene `numero_recibo`).
          Por eso cualquier `attributes: ['id']` u `order: ... ['id']` rompe.
   FIX 2: la detección de `ciclo_libre` debe ser robusta: si el modelo lo tiene pero
          la DB no, NO debemos setearlo en inserts dentro de transacciones.

   FIX 3 (bug cuando NO existe Recibo.ciclo_libre):
          El fallback por FECHAS no sirve para pagos post-vencimiento.
          Solución sin migración:
            - tag determinístico en `concepto`: [ciclo_libre:N]
            - filtros siempre por where.ciclo_libre; cuota.utils lo traduce a concepto ILIKE si falta columna
   ============================================================================= */

let _cacheTieneCicloLibreCol = null;

const normalizeBoolResult = (val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    if (typeof val === 'string') {
        const s = val.trim().toLowerCase();
        if (s === 'true' || s === 't' || s === '1' || s === 'yes' || s === 'y') return true;
        if (s === 'false' || s === 'f' || s === '0' || s === 'no' || s === 'n') return false;
    }
    if (val && typeof val === 'object') {
        if (Array.isArray(val)) {
            if (val.length === 0) return false;
            if (val.length === 1) return normalizeBoolResult(val[0]);
            return false;
        }
        const keys = ['exists', 'exist', 'has', 'ok', 'tiene', 'present', 'value', 'ciclo_libre'];
        for (const k of keys) {
            if (Object.prototype.hasOwnProperty.call(val, k)) return normalizeBoolResult(val[k]);
        }
        if (Object.prototype.hasOwnProperty.call(val, 'rows')) return normalizeBoolResult(val.rows);
        if (Object.prototype.hasOwnProperty.call(val, 'count')) return normalizeBoolResult(val.count);
    }
    return false;
};

const safeTieneCicloLibreCol = async (t = null) => {
    if (_cacheTieneCicloLibreCol !== null) return _cacheTieneCicloLibreCol;

    const tryCall = async (fn) => {
        try {
            const out = await fn();
            return normalizeBoolResult(out);
        } catch {
            return null;
        }
    };

    // 1) Intento robusto contra DB (preferible)
    const r1 = await tryCall(async () => reciboTieneCicloLibreCol({ transaction: t }));
    if (r1 !== null) {
        _cacheTieneCicloLibreCol = r1;
        return _cacheTieneCicloLibreCol;
    }

    const r2 = await tryCall(async () => reciboTieneCicloLibreCol(t));
    if (r2 !== null) {
        _cacheTieneCicloLibreCol = r2;
        return _cacheTieneCicloLibreCol;
    }

    const r3 = await tryCall(async () => reciboTieneCicloLibreCol());
    if (r3 !== null) {
        _cacheTieneCicloLibreCol = r3;
        return _cacheTieneCicloLibreCol;
    }

    // 2) Fallback: si no podemos detectar por DB, usamos el modelo
    _cacheTieneCicloLibreCol = Boolean(Recibo?.rawAttributes?.ciclo_libre);
    return _cacheTieneCicloLibreCol;
};

/* =============================================================================
   ✅ Tag de ciclo (ALINEADO con cuota.utils.js)
   - Siempre se escribe en `concepto` como: [ciclo_libre:N]
   - cuota.utils.js traduce where.ciclo_libre -> concepto ILIKE '%[ciclo_libre:N]%' si falta columna
   ============================================================================= */

const CICLO_TAG_PREFIX = '[ciclo_libre:';
const buildCicloTag = (ciclo) => `${CICLO_TAG_PREFIX}${Number(ciclo)}]`;

const appendCicloTagEnReciboPayload = (payload, ciclo) => {
    const tag = buildCicloTag(ciclo);
    const prev = payload?.concepto;

    const prevStr = prev != null ? String(prev) : '';
    const next = prevStr.includes(tag)
        ? prevStr
        : (prevStr ? `${prevStr} ${tag}` : tag);

    return { ...(payload || {}), concepto: next };
};

/* =============================================================================
   Helpers LIBRE
   ============================================================================= */

export const esCreditoLibre = (credito) =>
    String(credito?.modalidad_credito || '').toLowerCase() === 'libre';

/**
 * ✅ REGLA DE FECHAS (LIBRE) — SOLO CICLOS MENSUALES
 */

const pad2 = (n) => String(n).padStart(2, '0');

const parseYMD = (s) => {
    const ymdStr = asYMD(s);
    if (!ymdStr) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]); // 1..12
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    return { y, mo, d };
};

const daysInMonth = (year, month1to12) => {
    return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
};

const addDaysYMD = (baseYMD, days) => {
    const p = parseYMD(baseYMD);
    if (!p) return null;

    const baseMs = Date.UTC(p.y, p.mo - 1, p.d);
    const msDay = 24 * 60 * 60 * 1000;
    const next = new Date(baseMs + Number(days || 0) * msDay);

    const y = next.getUTCFullYear();
    const mo = next.getUTCMonth() + 1;
    const d = next.getUTCDate();

    return `${y}-${pad2(mo)}-${pad2(d)}`;
};

const addMonthsYMD = (baseYMD, months) => {
    const p = parseYMD(baseYMD);
    if (!p) return null;

    const add = Number(months || 0);
    const total = p.y * 12 + (p.mo - 1) + add;

    const y = Math.floor(total / 12);
    const mo0 = total % 12;
    const mo0Fixed = mo0 < 0 ? mo0 + 12 : mo0;
    const yFixed = mo0 < 0 ? y - 1 : y;

    const mo = mo0Fixed + 1;
    const dim = daysInMonth(yFixed, mo);
    const d = Math.min(p.d, dim);

    return `${yFixed}-${pad2(mo)}-${pad2(d)}`;
};

const baseVencimientoCiclo1 = (credito) => {
    return asYMD(credito?.fecha_compromiso_pago) || asYMD(credito?.fecha_acreditacion) || null;
};

export const cicloLibreActual = (credito, hoyYMD = todayYMD()) => {
    const vto1 = baseVencimientoCiclo1(credito);
    if (!vto1) return 1;

    const hoy = asYMD(hoyYMD);

    const vto2 = addMonthsYMD(vto1, 1);
    const vto3 = addMonthsYMD(vto1, 2);

    if (hoy <= vto1) return 1;
    if (vto2 && hoy <= vto2) return 2;
    if (vto3 && hoy <= vto3) return 3;

    return LIBRE_MAX_CICLOS;
};

export const rangoCicloLibre = (credito, ciclo) => {
    const vto1 = baseVencimientoCiclo1(credito);
    if (!vto1) {
        const hoy = todayYMD();
        return { startYMD: hoy, endYMD: hoy };
    }

    const c = clamp(toNumber(ciclo), 1, LIBRE_MAX_CICLOS);

    const endYMD = addMonthsYMD(vto1, c - 1);

    let startYMD = null;
    if (c === 1) {
        const prevMonthSameDay = addMonthsYMD(vto1, -1);
        startYMD = addDaysYMD(prevMonthSameDay, 1);
    } else {
        const endPrev = addMonthsYMD(vto1, c - 2);
        startYMD = addDaysYMD(endPrev, 1);
    }

    return { startYMD: asYMD(startYMD), endYMD: asYMD(endYMD) };
};

export const vencimientoCicloLibre = (credito, ciclo) => {
    const { endYMD } = rangoCicloLibre(credito, ciclo);
    return endYMD;
};

export const whereRecibosLibrePorCiclo = (credito, ciclo, cuotaIds = []) => {
    const { startYMD, endYMD } = rangoCicloLibre(credito, ciclo);

    const where = {
        cliente_id: credito.cliente_id,
        fecha: { [Op.gte]: startYMD, [Op.lte]: endYMD }
    };

    if (Array.isArray(cuotaIds) && cuotaIds.length > 0) {
        where.cuota_id = { [Op.in]: cuotaIds };
    } else {
        where.cuota_id = { [Op.ne]: null };
    }

    return where;
};

/**
 * ✅ Siempre devolvemos filtro por `ciclo_libre` cuando es posible.
 * - Si la DB tiene columna: funciona directo.
 * - Si NO la tiene: findAllReciboSafe() (cuota.utils.js) lo traduce a `concepto ILIKE '%[ciclo_libre:N]%'`.
 * - Último recurso: fallback por fechas si ciclo no es numérico.
 *
 * ✅ FIX (tu bug actual):
 * En tu DB existe `ciclo_libre`, pero hay recibos con `ciclo_libre = NULL` y concepto "(Ciclo N)".
 * Entonces buscamos por OR: ciclo_libre o concepto (tag) o concepto "ciclo N".
 */
export const whereRecibosLibrePorCicloCompat = async (credito, ciclo, cuotaIds = [], t = null) => {
    const cicloNum = Number(ciclo);
    if (Number.isFinite(cicloNum)) {
        const tag = buildCicloTag(cicloNum);

        const conceptoOr = [
            { concepto: { [Op.iLike]: `%${tag}%` } },
            { concepto: { [Op.iLike]: `%ciclo ${cicloNum}%` } } // matchea "(Ciclo 1)" / "ciclo 1"
        ];

        const tieneCol = await safeTieneCicloLibreCol(t);

        const where = tieneCol
            ? { cliente_id: credito.cliente_id, [Op.or]: [{ ciclo_libre: cicloNum }, ...conceptoOr] }
            : { cliente_id: credito.cliente_id, [Op.or]: conceptoOr };

        if (Array.isArray(cuotaIds) && cuotaIds.length > 0) {
            where.cuota_id = { [Op.in]: cuotaIds };
        } else {
            where.cuota_id = { [Op.ne]: null };
        }

        return where;
    }

    // ⚠️ ciclo inválido → rango por fechas (último recurso)
    return whereRecibosLibrePorCiclo(credito, ciclo, cuotaIds);
};

export const obtenerCuotaIdsPorCredito = async ({ credito_id, t = null }) => {
    const cuotas = await Cuota.findAll({
        where: { credito_id },
        attributes: ['id'],
        order: [['numero_cuota', 'ASC']],
        transaction: t
    });
    return cuotas.map((c) => c.id);
};

export const obtenerCuotaBaseLibre = async ({ credito_id, t = null }) => {
    const cuota = await Cuota.findOne({
        where: { credito_id },
        order: [['numero_cuota', 'ASC']],
        transaction: t
    });
    return cuota;
};

export const sumRecibosCampoPorCiclo = async ({ credito, ciclo, campo, cuotaIds = [], t = null }) => {
    const where = await whereRecibosLibrePorCicloCompat(credito, ciclo, cuotaIds, t);

    const sumar = (rows) =>
        fix2(rows.reduce((acc, r) => acc + fix2(toNumber(r?.[campo] ?? 0)), 0));

    try {
        const rows = await findAllReciboSafe({
            where,
            attributes: [campo],
            transaction: t
        });
        return sumar(rows);
    } catch (e) {
        // fallback extremo: si explota por “missing column” en algún entorno raro,
        // usamos rango por fechas.
        if (isMissingColumnError?.(e)) {
            if (_cacheTieneCicloLibreCol === true) {
                _cacheTieneCicloLibreCol = false;
                const whereFallback = whereRecibosLibrePorCiclo(credito, ciclo, cuotaIds);
                try {
                    const rows2 = await findAllReciboSafe({
                        where: whereFallback,
                        attributes: [campo],
                        transaction: t
                    });
                    return sumar(rows2);
                } catch (e2) {
                    if (isMissingColumnError?.(e2)) return 0;
                    throw e2;
                }
            }
            return 0;
        }
        throw e;
    }
};

export const fechaCierreInteresCicloLibre = (credito, ciclo) => {
    return vencimientoCicloLibre(credito, ciclo);
};

/* =============================================================================
   ✅ Interés cobrado histórico (para ficha: “intereses acumulados”)
   - Se recalcula por recibos (fuente de verdad), dentro de la TX.
   ============================================================================= */

const recalcularInteresAcumuladoHistoricoLibreEnTx = async ({ creditoId, cuotaIds = null, t }) => {
    const ids = Array.isArray(cuotaIds) && cuotaIds.length
        ? cuotaIds
        : await obtenerCuotaIdsPorCredito({ credito_id: creditoId, t });

    if (!ids.length) return 0;

    const sum = await Recibo.sum('interes_ciclo_cobrado', {
        where: { cuota_id: { [Op.in]: ids } },
        transaction: t
    });

    return fix2(toNumber(sum || 0));
};

/* =============================================================================
   ✅ Capital base por ciclo
   ============================================================================= */

const capitalOriginalLibre = (credito) => {
    const cap0 = fix2(toNumber(credito?.monto_acreditar));
    if (cap0 > 0) return cap0;
    return fix2(toNumber(credito?.saldo_actual || 0));
};

const principalPagadoHastaCiclo = async ({ credito, hastaCiclo, cuotaIds = [], t = null }) => {
    let total = 0;
    for (let c = 1; c <= hastaCiclo; c++) {
        total = fix2(
            total +
            (await sumRecibosCampoPorCiclo({
                credito,
                ciclo: c,
                campo: 'principal_pagado',
                cuotaIds,
                t
            }))
        );
    }
    return fix2(total);
};

export const capitalBaseLibreParaCiclo = async ({ credito, ciclo, t = null }) => {
    const cap0 = capitalOriginalLibre(credito);
    if (!(cap0 > 0)) return 0;

    if (Number(ciclo) <= 1) return cap0;

    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t });

    const principalPrev = await principalPagadoHastaCiclo({
        credito,
        hastaCiclo: clamp(Number(ciclo) - 1, 0, LIBRE_MAX_CICLOS),
        cuotaIds,
        t
    });

    return fix2(Math.max(cap0 - principalPrev, 0));
};

export const interesBrutoLibreParaCiclo = async ({ credito, ciclo, hoyYMD, t = null }) => {
    const capital = await capitalBaseLibreParaCiclo({ credito, ciclo, t });
    if (!(capital > 0)) return 0;

    return fix2(capital * TASA_INTERES_CICLO_LIBRE);
};

export const interesPendienteLibrePorCiclo = async ({ credito, ciclo, hoyYMD, cuotaIds = [], t = null }) => {
    const interesBruto = await interesBrutoLibreParaCiclo({ credito, ciclo, hoyYMD, t });

    const interesCobrado = await sumRecibosCampoPorCiclo({
        credito,
        ciclo,
        campo: 'interes_ciclo_cobrado',
        cuotaIds,
        t
    });

    const interesPendiente = fix2(Math.max(interesBruto - interesCobrado, 0));

    return {
        ciclo,
        interes_bruto: fix2(interesBruto),
        interes_cobrado: fix2(interesCobrado),
        interes_pendiente: fix2(interesPendiente)
    };
};

export const deudaLibrePorCiclo = async ({ credito, cuotaBase, cuotaIds, ciclo, hoyYMD, t = null }) => {
    const interesInfo = await interesPendienteLibrePorCiclo({
        credito,
        ciclo,
        hoyYMD,
        cuotaIds,
        t
    });

    const moraCobrado = await sumRecibosCampoPorCiclo({
        credito,
        ciclo,
        campo: 'mora_cobrada',
        cuotaIds,
        t
    });

    const moraPendiente = await calcularMoraPendienteLibreExacto({
        credito,
        hoyYMD,
        t,
        ciclo,
        cuotaIds
    });

    return {
        ciclo,
        interes_bruto: fix2(interesInfo.interes_bruto),
        interes_cobrado: fix2(interesInfo.interes_cobrado),
        interes_pendiente: fix2(interesInfo.interes_pendiente),
        mora_cobrada: fix2(moraCobrado),
        mora_pendiente: fix2(moraPendiente)
    };
};

export const deudaLibreTotalHoy = async ({ credito, hoyYMD, t = null }) => {
    const ciclo_actual = cicloLibreActual(credito, hoyYMD);

    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t });

    let interes_pendiente_total = 0;
    let mora_pendiente_total = 0;

    for (let c = 1; c <= ciclo_actual; c++) {
        const det = await deudaLibrePorCiclo({
            credito,
            cuotaBase: await obtenerCuotaBaseLibre({ credito_id: credito.id, t }),
            cuotaIds,
            ciclo: c,
            hoyYMD,
            t
        });
        interes_pendiente_total = fix2(interes_pendiente_total + fix2(det.interes_pendiente));
        mora_pendiente_total = fix2(mora_pendiente_total + fix2(det.mora_pendiente));
    }

    return {
        ciclo_actual,
        interes_pendiente_total: fix2(interes_pendiente_total),
        mora_pendiente_total: fix2(mora_pendiente_total)
    };
};

export const cicloLibreMasViejoAbierto = async ({ credito, hoyYMD, t = null }) => {
    const cicloActual = cicloLibreActual(credito, hoyYMD);

    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t });
    const cuotaBase = await obtenerCuotaBaseLibre({ credito_id: credito.id, t });

    for (let c = 1; c <= cicloActual; c++) {
        const detalle = await deudaLibrePorCiclo({
            credito,
            cuotaBase,
            cuotaIds,
            ciclo: c,
            hoyYMD,
            t
        });

        const abierto = fix2(detalle.interes_pendiente) > 0 || fix2(detalle.mora_pendiente) > 0;
        if (abierto) return { ciclo: c, detalle };
    }

    const detalle = await deudaLibrePorCiclo({
        credito,
        cuotaBase,
        cuotaIds,
        ciclo: cicloActual,
        hoyYMD,
        t
    });

    return { ciclo: cicloActual, detalle };
};

export const calcularInteresPendienteLibre = async ({ credito, hoyYMD, t = null }) => {
    const deuda = await deudaLibreTotalHoy({ credito, hoyYMD, t });
    return fix2(deuda.interes_pendiente_total);
};

export const calcularMoraPendienteLibreExacto = async ({ credito, hoyYMD, t = null, ciclo = null, cuotaIds = null }) => {
    const cicloActual = cicloLibreActual(credito, hoyYMD);
    const cuotasIdsLocal = Array.isArray(cuotaIds)
        ? cuotaIds
        : await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t });

    const ciclosAProcesar =
        ciclo != null
            ? [clamp(toNumber(ciclo), 1, cicloActual)]
            : Array.from({ length: cicloActual }, (_, i) => i + 1);

    const hoy = ymdDate(hoyYMD);

    const msDay = 24 * 60 * 60 * 1000;
    const diffDaysFloor = (a, b) => Math.max(0, Math.floor((a.getTime() - b.getTime()) / msDay));

    let moraTotal = 0;

    for (const c of ciclosAProcesar) {
        const vto = vencimientoCicloLibre(credito, c);
        if (!vto) continue;

        const dv = ymdDate(vto);

        if (asYMD(hoy) <= asYMD(dv)) continue;

        const interesBruto = await interesBrutoLibreParaCiclo({ credito, ciclo: c, hoyYMD, t });

        const where = await whereRecibosLibrePorCicloCompat(credito, c, cuotasIdsLocal, t);
        let recibos = [];
        try {
            recibos = await findAllReciboSafe({
                where,
                attributes: ['numero_recibo', 'fecha', 'interes_ciclo_cobrado', 'mora_cobrada'],
                order: [['fecha', 'ASC'], ['numero_recibo', 'ASC']],
                transaction: t
            });
        } catch (e) {
            if (isMissingColumnError?.(e)) {
                if (_cacheTieneCicloLibreCol === true) {
                    _cacheTieneCicloLibreCol = false;
                    const whereFallback = whereRecibosLibrePorCiclo(credito, c, cuotasIdsLocal);
                    try {
                        recibos = await findAllReciboSafe({
                            where: whereFallback,
                            attributes: ['numero_recibo', 'fecha', 'interes_ciclo_cobrado', 'mora_cobrada'],
                            order: [['fecha', 'ASC'], ['numero_recibo', 'ASC']],
                            transaction: t
                        });
                    } catch (e2) {
                        if (isMissingColumnError?.(e2)) {
                            recibos = [];
                        } else {
                            throw e2;
                        }
                    }
                } else {
                    recibos = [];
                }
            } else {
                throw e;
            }
        }

        const interesCobradoHastaVto = fix2(
            recibos
                .filter((r) => asYMD(r?.fecha) && asYMD(r.fecha) <= asYMD(vto))
                .reduce((acc, r) => acc + fix2(toNumber(r?.interes_ciclo_cobrado ?? 0)), 0)
        );

        let base = fix2(Math.max(interesBruto - interesCobradoHastaVto, 0));
        if (!(base > 0)) base = 0;

        const pagosInteresPost = recibos
            .filter((r) => {
                const f = asYMD(r?.fecha);
                return f && f > asYMD(vto) && fix2(toNumber(r?.interes_ciclo_cobrado ?? 0)) > 0;
            })
            .map((r) => ({
                fecha: asYMD(r.fecha),
                monto: fix2(toNumber(r?.interes_ciclo_cobrado ?? 0))
            }));

        const mapPorFecha = new Map();
        for (const p of pagosInteresPost) {
            mapPorFecha.set(p.fecha, fix2((mapPorFecha.get(p.fecha) || 0) + p.monto));
        }
        const fechasPagos = Array.from(mapPorFecha.keys()).sort();

        let moraBruta = 0;
        let cursor = dv;
        for (const fYMD of fechasPagos) {
            if (!(base > 0)) break;

            const fDate = ymdDate(fYMD);
            if (fDate.getTime() > hoy.getTime()) break;

            const dias = diffDaysFloor(fDate, cursor);
            if (dias > 0) {
                moraBruta = fix2(moraBruta + fix2(base * MORA_DIARIA_LIBRE * dias));
            }

            const pagadoEseDia = fix2(mapPorFecha.get(fYMD) || 0);
            base = fix2(Math.max(base - pagadoEseDia, 0));
            cursor = fDate;
        }

        if (base > 0) {
            const diasFinal = diffDaysFloor(hoy, cursor);
            if (diasFinal > 0) {
                moraBruta = fix2(moraBruta + fix2(base * MORA_DIARIA_LIBRE * diasFinal));
            }
        }

        const moraCobrado = fix2(recibos.reduce((acc, r) => acc + fix2(toNumber(r?.mora_cobrada ?? 0)), 0));

        const moraPend = fix2(Math.max(moraBruta - moraCobrado, 0));
        moraTotal = fix2(moraTotal + moraPend);
    }

    return fix2(moraTotal);
};

export const assertNoPagoSiRefinanciado = ({ credito, cuota }) => {
    if (String(credito?.estado) === 'refinanciado') {
        const err = new Error('Crédito refinanciado: no se permiten pagos.');
        err.status = 409;
        throw err;
    }
};

/**
 * ✅ NUEVO: Bloquea pagos sobre créditos ANULADOS (blindaje backend).
 * Se replica acá porque estas funciones pueden ser invocadas desde otros módulos.
 */
export const assertNoPagoSiAnulado = ({ credito }) => {
    const estado = String(credito?.estado ?? '').trim().toLowerCase();
    if (estado === 'anulado' || estado === 'anulada') {
        const err = new Error('Crédito anulado: no se permiten pagos.');
        err.status = 409;
        err.code = 'CREDITO_ANULADO';
        throw err;
    }
};

/* =============================================================================
   Resumen LIBRE
   ============================================================================= */

export const obtenerResumenLibrePorCredito = async (credito_id, hoyDate = new Date()) => {
    const credito = await Credito.findByPk(credito_id);
    if (!credito) return null;

    const hoyYMD = asYMD(hoyDate);

    const deuda = await deudaLibreTotalHoy({ credito, hoyYMD, t: null });
    const ciclo_actual = clamp(toNumber(deuda?.ciclo_actual ?? 1), 1, LIBRE_MAX_CICLOS);

    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t: null });
    const cuotaBase = await obtenerCuotaBaseLibre({ credito_id: credito.id, t: null });

    const detActual = await deudaLibrePorCiclo({
        credito,
        cuotaBase,
        cuotaIds,
        ciclo: ciclo_actual,
        hoyYMD,
        t: null
    });

    const saldo_capital = fix2(toNumber(credito.saldo_actual || 0));

    const interes_pendiente_total = fix2(toNumber(deuda?.interes_pendiente_total ?? 0));
    const mora_pendiente_total = fix2(toNumber(deuda?.mora_pendiente_total ?? 0));

    const interes_pendiente_hoy = fix2(toNumber(detActual?.interes_pendiente ?? 0));
    const mora_pendiente_hoy = fix2(toNumber(detActual?.mora_pendiente ?? 0));

    const total_liquidacion_hoy = fix2(saldo_capital + interes_pendiente_total + mora_pendiente_total);
    const total_ciclo_hoy = fix2(saldo_capital + interes_pendiente_hoy + mora_pendiente_hoy);

    // Vencimientos (auditoría)
    const vto1 = baseVencimientoCiclo1(credito);
    const vencimiento_ciclo_1 = vto1;
    const vencimiento_ciclo_2 = vto1 ? addMonthsYMD(vto1, 1) : null;
    const vencimiento_ciclo_3 = vto1 ? addMonthsYMD(vto1, 2) : null;

    const interes_ciclo_hoy = interes_pendiente_hoy;
    const mora_ciclo_hoy = mora_pendiente_hoy;

    // ✅ Contrato consistente con credito.core:
    // total_actual = liquidación al día (acumulado 1..ciclo_actual)
    const total_actual = total_liquidacion_hoy;

    return {
        credito_id,
        hoy: hoyYMD,
        ciclo_actual,

        vencimiento_ciclo_1,
        vencimiento_ciclo_2,
        vencimiento_ciclo_3,

        interes_pendiente_total,
        mora_pendiente_total,

        interes_pendiente_hoy,
        mora_pendiente_hoy,

        interes_ciclo_hoy,
        mora_ciclo_hoy,

        saldo_capital,

        total_liquidacion_hoy,
        total_ciclo_hoy,

        total_actual
    };
};

/* =============================================================================
   Pagos LIBRE
   ============================================================================= */

const EPS = 0.01;
const nearlyEqual = (a, b, eps = EPS) => Math.abs(fix2(toNumber(a)) - fix2(toNumber(b))) <= eps;

/**
 * ✅ Helper NUEVO:
 * Para que el FRONT no siga mostrando "capital original" cuando paga interés/mora,
 * devolvemos también total_actual y el detalle del resumen.
 */
const buildCreditoUIConResumen = ({ credito, creditoFresh, resumen_libre }) => {
    const saldoActual = fix2(creditoFresh?.saldo_actual ?? credito?.saldo_actual ?? 0);
    const estado = creditoFresh?.estado ?? credito?.estado;

    // total_actual = liquidación hoy (acumulado)
    const total_actual = resumen_libre
        ? fix2(toNumber(resumen_libre?.total_liquidacion_hoy ?? resumen_libre?.total_actual ?? 0))
        : undefined;

    // saldo_total_actual = total del ciclo actual (compat UI)
    const saldo_total_actual = resumen_libre
        ? fix2(toNumber(resumen_libre?.total_ciclo_hoy ?? 0))
        : undefined;

    const saldo_capital = resumen_libre
        ? fix2(toNumber(resumen_libre?.saldo_capital ?? saldoActual))
        : undefined;

    const interes_pendiente_total = resumen_libre
        ? fix2(toNumber(resumen_libre?.interes_pendiente_total ?? 0))
        : undefined;

    const mora_pendiente_total = resumen_libre
        ? fix2(toNumber(resumen_libre?.mora_pendiente_total ?? 0))
        : undefined;

    const ciclo_actual = resumen_libre?.ciclo_actual != null ? clamp(toNumber(resumen_libre.ciclo_actual), 1, LIBRE_MAX_CICLOS) : undefined;

    return {
        id: credito.id,
        modalidad_credito: credito.modalidad_credito,
        saldo_actual: saldoActual,
        estado,
        total_actual,
        saldo_total_actual,
        saldo_capital,
        interes_pendiente_total,
        mora_pendiente_total,
        ciclo_actual
    };
};

/**
 * ✅ Blindaje post-actualizarEstadoCredito:
 * Re-aplica valores calculados por esta lógica LIBRE en la misma TX
 * (porque actualizarEstadoCredito puede pisarlos en algunas bases/versiones).
 */
const reapplyLibreStateEnTx = async ({
    t,
    creditoId,
    cuotaId,
    creditoPatch,
    cuotaPatch
}) => {
    if (creditoId && creditoPatch) {
        await Credito.update(creditoPatch, { where: { id: creditoId }, transaction: t });
    }
    if (cuotaId && cuotaPatch) {
        await Cuota.update(cuotaPatch, { where: { id: cuotaId }, transaction: t });
    }
};

export const pagarCuotaLibreEnTx = async ({
    t,
    cuota,
    credito,
    cliente,
    cobrador,
    medioPago,
    forma_pago_id,
    descuento = 0,
    descuento_scope = null,
    descuento_mora = null,
    observacion = null,
    usuario_id = null,
    rol_id = null,
    monto_pagado = null,
    ciclo_libre = null
}) => {
    // ✅ Blindajes backend
    assertNoPagoSiRefinanciado({ credito, cuota });
    assertNoPagoSiAnulado({ credito });

    const hoyYMD_TZ = todayYMD();

    const saldoCapitalAntes = fix2(credito.saldo_actual);

    const resumen = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD_TZ));
    const interesPendienteTotalAntes = fix2(toNumber(resumen?.interes_pendiente_total ?? 0));
    const moraPendienteTotalAntes = fix2(toNumber(resumen?.mora_pendiente_total ?? 0));
    const cicloActual = clamp(toNumber(resumen?.ciclo_actual ?? 1), 1, LIBRE_MAX_CICLOS);

    const isAdmin = Number(rol_id) === 1;
    const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);

    const pctRaw =
        scope === 'mora' || scope === 'total'
            ? descuento_mora != null
                ? toNumber(descuento_mora)
                : toNumber(descuento)
            : 0;

    const pct = clamp(fix2(pctRaw), 0, 100);

    const montoIngresado =
        monto_pagado != null && String(monto_pagado).trim() !== '' ? fix2(toNumber(monto_pagado)) : null;

    // ─────────────────────────────────────────────────────────────
    // ✅ LIQUIDACIÓN TOTAL
    // ─────────────────────────────────────────────────────────────

    const cuotaBase = await obtenerCuotaBaseLibre({ credito_id: credito.id, t });
    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t });

    let interesTotal = 0;
    let moraTotal = 0;
    let moraBonificadaTotal = 0;

    for (let c = 1; c <= cicloActual; c++) {
        const det = await deudaLibrePorCiclo({
            credito,
            cuotaBase,
            cuotaIds,
            ciclo: c,
            hoyYMD: hoyYMD_TZ,
            t
        });

        const interesPend = fix2(det?.interes_pendiente ?? 0);
        const moraPend = fix2(det?.mora_pendiente ?? 0);

        const bonif = fix2(moraPend * (pct / 100));
        const moraNeta = fix2(Math.max(moraPend - bonif, 0));

        interesTotal = fix2(interesTotal + interesPend);
        moraTotal = fix2(moraTotal + moraNeta);
        moraBonificadaTotal = fix2(moraBonificadaTotal + bonif);
    }

    const totalLiquidacionNeta = fix2(saldoCapitalAntes + interesTotal + moraTotal);

    const esIntentoLiquidacion =
        montoIngresado == null
            ? true
            : nearlyEqual(montoIngresado, totalLiquidacionNeta) || cicloActual >= LIBRE_MAX_CICLOS;

    if (esIntentoLiquidacion) {
        const montoAImputar = montoIngresado != null ? montoIngresado : totalLiquidacionNeta;

        if (!nearlyEqual(montoAImputar, totalLiquidacionNeta)) {
            const err = new Error('Monto inválido para liquidación total de crédito LIBRE.');
            err.status = 400;
            err.code = 'LIBRE_LIQUIDACION_MONTO_INVALIDO';
            err.meta = { total_liquidacion_hoy: totalLiquidacionNeta, recibido: montoAImputar };
            throw err;
        }

        const tieneCicloLibre = await safeTieneCicloLibreCol(t);

        const capital = fix2(saldoCapitalAntes);
        const interesCobrar = fix2(interesTotal);
        const moraCobrar = fix2(moraTotal);
        const moraBonificada = fix2(moraBonificadaTotal);

        const totalAplicado = fix2(capital + interesCobrar + moraCobrar);

        if (!(totalAplicado > 0)) {
            const err = new Error('No hay deuda para liquidar en este crédito LIBRE.');
            err.status = 409;
            err.code = 'LIBRE_SIN_DEUDA_PARA_LIQUIDAR';
            throw err;
        }

        const pago = await Pago.create(
            {
                cuota_id: cuota.id,
                monto_pagado: totalAplicado,
                forma_pago_id,
                observacion,
                fecha_pago: hoyYMD_TZ
            },
            { transaction: t }
        );

        // Se setea saldo/estado; el interes_acumulado (historial) se recalcula luego del recibo
        let creditoPatch = {
            saldo_actual: 0,
            estado: 'pagado'
        };

        await credito.update(creditoPatch, { transaction: t });

        const principalPrevio = fix2(toNumber(cuota.monto_pagado_acumulado));
        let cuotaPatch = {
            estado: 'pagada',
            forma_pago_id,
            monto_pagado_acumulado: fix2(principalPrevio + capital),
            intereses_vencidos_acumulados: 0
        };
        await cuota.update(cuotaPatch, { transaction: t });

        const totalAntes = fix2(totalLiquidacionNeta);
        const totalDespues = 0;

        const reciboBase = {
            credito,
            cuota,
            pago,
            cliente,
            cobrador,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: fix2(toNumber(cuota.importe_cuota || saldoCapitalAntes)),

            descuentoAplicado: moraBonificada,

            moraCobrada: moraCobrar,
            principalPagado: capital,
            interesCicloCobrado: interesCobrar,

            saldoCuotaAnterior: totalAntes,
            saldoCuotaActual: totalDespues,
            saldoMoraRestante: 0,

            conceptoExtra: `Liquidación crédito LIBRE #${credito.id}`,

            saldoPrincipalAntes: capital,
            saldoPrincipalDespues: 0,
            saldoCreditoAntes: capital,
            saldoCreditoDespues: 0
        };

        let reciboPayload = armarDatosRecibo(reciboBase);

        // ✅ SIEMPRE tag en concepto
        reciboPayload = appendCicloTagEnReciboPayload(reciboPayload, cicloActual);

        if (tieneCicloLibre) {
            reciboPayload.ciclo_libre = Number(cicloActual);
        } else {
            try { await marcarReciboSinCicloLibre({ transaction: t }); } catch { }
        }

        const recibo = await crearReciboEnTxCompat({ t, datosRecibo: reciboPayload });

        await registrarIngresoDesdeReciboEnTx({
            t,
            recibo,
            forma_pago_id,
            usuario_id: usuario_id ?? null
        });

        // ✅ Recalcular historial de interés cobrado y persistirlo en Credito.interes_acumulado
        const interesHist = await recalcularInteresAcumuladoHistoricoLibreEnTx({
            creditoId: credito.id,
            cuotaIds,
            t
        });

        creditoPatch = { ...creditoPatch, interes_acumulado: interesHist };
        await credito.update({ interes_acumulado: interesHist }, { transaction: t });

        // Compat: ejecuta side-effects, pero BLINDAMOS nuestros campos luego.
        const { actualizarEstadoCredito } = await import('../credito.service.js');
        await actualizarEstadoCredito(credito.id, t);

        // ✅ Re-lectura de resumen post-movimientos para fijar “mora HOY” en la cuota (y contrato UI)
        let resumen_after = null;
        try {
            resumen_after = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD_TZ));
        } catch {
            resumen_after = null;
        }

        cuotaPatch = {
            ...cuotaPatch,
            intereses_vencidos_acumulados: 0
        };

        await reapplyLibreStateEnTx({
            t,
            creditoId: credito.id,
            cuotaId: cuota.id,
            creditoPatch,
            cuotaPatch
        });

        const creditoFresh = await Credito.findByPk(credito.id, { transaction: t });

        const credito_ui = buildCreditoUIConResumen({ credito, creditoFresh, resumen_libre: resumen_after });

        const plain = recibo?.get ? recibo.get({ plain: true }) : recibo ?? {};
        plain.modalidad_credito = credito.modalidad_credito;

        const ui = buildReciboUI(plain);
        if (recibo?.setDataValue) {
            recibo.setDataValue('recibo_ui', ui);
            recibo.setDataValue('modalidad_credito', credito.modalidad_credito);
        }

        return { cuota, recibo, credito: credito_ui, resumen_libre: resumen_after };
    }

    // ─────────────────────────────────────────────────────────────
    // Ruta NO liquidación
    // ─────────────────────────────────────────────────────────────

    let cicloObjetivo = null;
    let detalleCiclo = null;

    if (ciclo_libre != null && String(ciclo_libre).trim() !== '') {
        cicloObjetivo = clamp(toNumber(ciclo_libre), 1, cicloActual);
        detalleCiclo = await deudaLibrePorCiclo({
            credito,
            cuotaBase,
            cuotaIds,
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
        detalleCiclo = await deudaLibrePorCiclo({
            credito,
            cuotaBase,
            cuotaIds,
            ciclo: cicloObjetivo,
            hoyYMD: hoyYMD_TZ,
            t
        });
    }

    const interesPendienteCiclo = fix2(detalleCiclo?.interes_pendiente ?? 0);
    const moraPendienteCiclo = fix2(detalleCiclo?.mora_pendiente ?? 0);

    const moraBonificada = fix2(moraPendienteCiclo * (pct / 100));
    const moraNetaCiclo = fix2(Math.max(moraPendienteCiclo - moraBonificada, 0));

    const sugeridoCerrarCiclo = fix2(Math.max(moraNetaCiclo + interesPendienteCiclo, 0));
    const montoAImputar = montoIngresado != null ? montoIngresado : sugeridoCerrarCiclo;

    if (!(montoAImputar > 0)) {
        const err = new Error('Monto inválido para registrar el pago en crédito LIBRE.');
        err.status = 400;
        throw err;
    }

    let restante = fix2(montoAImputar);
    const moraCobrada = fix2(Math.min(restante, moraNetaCiclo));
    restante = fix2(restante - moraCobrada);
    const interesCicloCobrado = fix2(Math.min(restante, interesPendienteCiclo));
    restante = fix2(restante - interesCicloCobrado);

    const puedeIrACapital =
        fix2(moraNetaCiclo - moraCobrada) <= 0 && fix2(interesPendienteCiclo - interesCicloCobrado) <= 0;

    const principalPagado = puedeIrACapital ? fix2(Math.min(restante, saldoCapitalAntes)) : 0;

    restante = fix2(restante - principalPagado);

    const totalAplicado = fix2(moraCobrada + interesCicloCobrado + principalPagado);
    if (!(totalAplicado > 0)) {
        const err = new Error('El pago no impacta sobre deuda (mora/interés/capital).');
        err.status = 400;
        throw err;
    }

    if (restante > EPS) {
        const err = new Error('El monto excede la deuda/capital pendiente del crédito LIBRE.');
        err.status = 400;
        err.code = 'LIBRE_PAGO_EXCEDE_DEUDA';
        err.meta = { excedente: fix2(restante), total_aplicado: totalAplicado, recibido: montoAImputar };
        throw err;
    }

    const moraTotalNetaAntes = fix2(Math.max(moraPendienteTotalAntes - moraBonificada, 0));
    const totalAntes = fix2(saldoCapitalAntes + interesPendienteTotalAntes + moraTotalNetaAntes);
    const totalDespues = fix2(Math.max(totalAntes - totalAplicado, 0));

    const pago = await Pago.create(
        { cuota_id: cuota.id, monto_pagado: totalAplicado, forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
        { transaction: t }
    );

    const nuevoSaldoCapital = fix2(Math.max(saldoCapitalAntes - principalPagado, 0));

    // idem: el interes_acumulado se recalcula tras crear recibo
    let creditoPatch = {
        saldo_actual: nuevoSaldoCapital
    };

    await credito.update(creditoPatch, { transaction: t });

    const principalPrevio = fix2(toNumber(cuota.monto_pagado_acumulado));
    let cuotaPatch = {
        estado: toNumber(nuevoSaldoCapital) <= 0 && totalDespues <= 0 ? 'pagada' : 'parcial',
        forma_pago_id,
        monto_pagado_acumulado: fix2(principalPrevio + principalPagado)
        // intereses_vencidos_acumulados se setea luego con resumen_after.mora_pendiente_hoy
    };

    await cuota.update(cuotaPatch, { transaction: t });

    const reciboBase = {
        credito,
        cuota,
        pago,
        cliente,
        cobrador,
        medioPagoNombre: medioPago?.nombre ?? 'N/D',
        importeOriginalCuota: fix2(toNumber(cuota.importe_cuota || saldoCapitalAntes)),
        descuentoAplicado: moraBonificada,
        moraCobrada,
        principalPagado,
        interesCicloCobrado,
        saldoCuotaAnterior: totalAntes,
        saldoCuotaActual: totalDespues,
        saldoMoraRestante: fix2(Math.max(moraNetaCiclo - moraCobrada, 0)),
        conceptoExtra: `Pago crédito LIBRE #${credito.id} - ciclo ${cicloObjetivo}`,
        saldoPrincipalAntes: saldoCapitalAntes,
        saldoPrincipalDespues: nuevoSaldoCapital,
        saldoCreditoAntes: saldoCapitalAntes,
        saldoCreditoDespues: nuevoSaldoCapital
    };

    let reciboPayload = armarDatosRecibo(reciboBase);

    reciboPayload = appendCicloTagEnReciboPayload(reciboPayload, cicloObjetivo);

    const tieneCicloLibre = await safeTieneCicloLibreCol(t);
    if (tieneCicloLibre) {
        reciboPayload.ciclo_libre = Number(cicloObjetivo);
    } else {
        try { await marcarReciboSinCicloLibre({ transaction: t }); } catch { }
    }

    const recibo = await crearReciboEnTxCompat({ t, datosRecibo: reciboPayload });

    await registrarIngresoDesdeReciboEnTx({
        t,
        recibo,
        forma_pago_id,
        usuario_id: usuario_id ?? null
    });

    // ✅ Recalcular historial de interés cobrado
    const interesHist = await recalcularInteresAcumuladoHistoricoLibreEnTx({
        creditoId: credito.id,
        cuotaIds,
        t
    });

    creditoPatch = { ...creditoPatch, interes_acumulado: interesHist };
    await credito.update({ interes_acumulado: interesHist }, { transaction: t });

    if (cicloActual >= 3) {
        const deudaTotDespues = await deudaLibreTotalHoy({ credito, hoyYMD: hoyYMD_TZ, t });
        const sinInteresMora =
            fix2(deudaTotDespues.interes_pendiente_total) <= 0 && fix2(deudaTotDespues.mora_pendiente_total) <= 0;

        const quedaCapital = fix2(credito.saldo_actual) > 0;

        if (sinInteresMora && quedaCapital) {
            const err = new Error('Crédito LIBRE en 3° ciclo: debe CANCELAR o REFINANCIAR (no se permite seguir).');
            err.status = 409;
            err.code = 'LIBRE_TOPE_3_CICLOS';
            throw err;
        }
    }

    const { actualizarEstadoCredito } = await import('../credito.service.js');
    await actualizarEstadoCredito(credito.id, t);

    // ✅ Resumen post pago para setear “mora HOY” en cuota
    let resumen_after = null;
    try {
        resumen_after = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD_TZ));
    } catch {
        resumen_after = null;
    }

    cuotaPatch = {
        ...cuotaPatch,
        intereses_vencidos_acumulados: fix2(toNumber(resumen_after?.mora_pendiente_hoy ?? resumen_after?.mora_ciclo_hoy ?? 0))
    };

    await reapplyLibreStateEnTx({
        t,
        creditoId: credito.id,
        cuotaId: cuota.id,
        creditoPatch,
        cuotaPatch
    });

    const creditoFresh = await Credito.findByPk(credito.id, { transaction: t });

    const credito_ui = buildCreditoUIConResumen({ credito, creditoFresh, resumen_libre: resumen_after });

    const plain = recibo?.get ? recibo.get({ plain: true }) : recibo ?? {};
    plain.modalidad_credito = credito.modalidad_credito;
    const ui = buildReciboUI(plain);
    if (recibo?.setDataValue) {
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);
    }

    return { cuota, recibo, credito: credito_ui, resumen_libre: resumen_after };
};

export const registrarPagoParcialLibreEnTx = async ({
    t,
    cuota,
    credito,
    cliente,
    cobrador,
    medioPago,
    cuota_id,
    monto_pagado,
    forma_pago_id,
    observacion = null,
    descuento = 0,
    descuento_scope = null,
    descuento_mora = null,
    usuario_id = null,
    rol_id = null
}) => {
    // ✅ Blindajes backend
    assertNoPagoSiRefinanciado({ credito, cuota });
    assertNoPagoSiAnulado({ credito });

    const hoyYMD_TZ = todayYMD();

    const cicloActual = cicloLibreActual(credito, hoyYMD_TZ);
    if (cicloActual >= LIBRE_MAX_CICLOS) {
        throw new Error(
            'En el 3er ciclo del crédito LIBRE no se permite pago parcial. Debe cancelar (pago total) o refinanciar.'
        );
    }

    const pagado = fix2(monto_pagado);
    if (!(pagado > 0)) {
        const err = new Error('monto_pagado debe ser > 0');
        err.status = 400;
        throw err;
    }

    const saldoAntesCapital = fix2(credito.saldo_actual);

    const deudaTotAntes = await deudaLibreTotalHoy({ credito, hoyYMD: hoyYMD_TZ, t });
    const interesTotalAntes = fix2(deudaTotAntes.interes_pendiente_total);
    const moraTotalAntes = fix2(deudaTotAntes.mora_pendiente_total);
    const totalAntesGlobal = fix2(saldoAntesCapital + interesTotalAntes + moraTotalAntes);

    const { ciclo: cicloObjetivo, detalle: detCiclo } = await cicloLibreMasViejoAbierto({
        credito,
        hoyYMD: hoyYMD_TZ,
        t
    });

    const interesPendienteCiclo = fix2(detCiclo.interes_pendiente);
    const moraPendienteCiclo = fix2(detCiclo.mora_pendiente);

    const isAdmin = Number(rol_id) === 1;
    const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);

    const pctRaw = scope === 'mora' ? (descuento_mora != null ? toNumber(descuento_mora) : toNumber(descuento)) : 0;

    const pct = clamp(fix2(pctRaw), 0, 100);
    const descuentoMoraCiclo = fix2(moraPendienteCiclo * (pct / 100));
    const moraNetaCiclo = fix2(Math.max(moraPendienteCiclo - descuentoMoraCiclo, 0));

    // ✅ Imputación estricta: Mora → Interés → Capital
    const aMora = fix2(Math.min(pagado, moraNetaCiclo));
    const restoTrasMora = fix2(pagado - aMora);

    const aInteres = fix2(Math.min(restoTrasMora, interesPendienteCiclo));
    const restoTrasInteres = fix2(restoTrasMora - aInteres);

    const puedeIrACapital = fix2(moraNetaCiclo - aMora) <= 0 && fix2(interesPendienteCiclo - aInteres) <= 0;
    const aCapital = puedeIrACapital ? fix2(Math.min(restoTrasInteres, saldoAntesCapital)) : 0;

    const restanteNoImputable = fix2(restoTrasInteres - aCapital);
    if (restanteNoImputable > EPS) {
        const err = new Error('El monto excede la deuda/capital imputable del crédito LIBRE.');
        err.status = 400;
        err.code = 'LIBRE_PAGO_EXCEDE_DEUDA';
        err.meta = {
            excedente: restanteNoImputable,
            mora_pendiente_ciclo: moraNetaCiclo,
            interes_pendiente_ciclo: interesPendienteCiclo,
            saldo_capital: saldoAntesCapital
        };
        throw err;
    }

    const nuevoSaldoCapital = fix2(Math.max(saldoAntesCapital - aCapital, 0));

    const interesTotalDespues = fix2(Math.max(interesTotalAntes - aInteres, 0));
    const moraTotalDespues = fix2(Math.max(moraTotalAntes - aMora - descuentoMoraCiclo, 0));
    const totalDespuesGlobal = fix2(nuevoSaldoCapital + interesTotalDespues + moraTotalDespues);

    const pago = await Pago.create(
        { cuota_id, monto_pagado: pagado, forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
        { transaction: t }
    );

    const capitalPagadoPrevio = fix2(cuota.monto_pagado_acumulado || 0);
    const topeCapital = Math.max(fix2(toNumber(cuota.importe_cuota) - toNumber(cuota.descuento_cuota)), 0);
    const capitalPagadoNuevo = fix2(Math.min(capitalPagadoPrevio + aCapital, topeCapital));

    const liquidado = nuevoSaldoCapital <= 0 && interesTotalDespues <= 0 && moraTotalDespues <= 0;
    const nuevoEstado = liquidado ? 'pagada' : 'parcial';

    let cuotaPatch = {
        estado: nuevoEstado,
        forma_pago_id,
        // ✅ mora en cuota = “mora HOY del ciclo actual” (se setea luego con resumen_after)
        monto_pagado_acumulado: capitalPagadoNuevo
    };

    await cuota.update(cuotaPatch, { transaction: t });

    // idem: interes_acumulado se recalcula tras crear recibo
    let creditoPatch = {
        saldo_actual: nuevoSaldoCapital,
        estado: liquidado ? 'pagado' : credito.estado
    };

    await credito.update(creditoPatch, { transaction: t });

    const reciboBase = {
        cliente,
        cobrador,
        pago,
        cuota,
        credito,
        medioPagoNombre: medioPago?.nombre ?? 'N/D',
        importeOriginalCuota: cuota.importe_cuota,
        descuentoAplicado: descuentoMoraCiclo,
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
        saldoMoraRestante: fix2(Math.max(moraNetaCiclo - aMora, 0))
    };

    let reciboPayload = armarDatosRecibo(reciboBase);

    reciboPayload = appendCicloTagEnReciboPayload(reciboPayload, cicloObjetivo);

    const tieneCicloLibre = await safeTieneCicloLibreCol(t);
    if (tieneCicloLibre) {
        reciboPayload.ciclo_libre = Number(cicloObjetivo);
    } else {
        try { await marcarReciboSinCicloLibre({ transaction: t }); } catch { }
    }

    const recibo = await crearReciboEnTxCompat({ t, datosRecibo: reciboPayload });

    await registrarIngresoDesdeReciboEnTx({
        t,
        recibo,
        forma_pago_id,
        usuario_id: usuario_id ?? null
    });

    // ✅ Recalcular historial de interés cobrado
    const cuotaIds = await obtenerCuotaIdsPorCredito({ credito_id: credito.id, t });
    const interesHist = await recalcularInteresAcumuladoHistoricoLibreEnTx({
        creditoId: credito.id,
        cuotaIds,
        t
    });

    creditoPatch = { ...creditoPatch, interes_acumulado: interesHist };
    await credito.update({ interes_acumulado: interesHist }, { transaction: t });

    const { actualizarEstadoCredito } = await import('../credito.service.js');
    await actualizarEstadoCredito(credito.id, t);

    // ✅ Resumen post pago: fija mora HOY en cuota para UI/consistencia
    let resumen_after = null;
    try {
        resumen_after = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyYMD_TZ));
    } catch {
        resumen_after = null;
    }

    cuotaPatch = {
        ...cuotaPatch,
        intereses_vencidos_acumulados: fix2(toNumber(resumen_after?.mora_pendiente_hoy ?? resumen_after?.mora_ciclo_hoy ?? 0))
    };

    await reapplyLibreStateEnTx({
        t,
        creditoId: credito.id,
        cuotaId: cuota.id,
        creditoPatch,
        cuotaPatch
    });

    const creditoFresh = await Credito.findByPk(credito.id, { transaction: t });

    const credito_ui = buildCreditoUIConResumen({ credito, creditoFresh, resumen_libre: resumen_after });

    const plain = recibo?.get ? recibo.get({ plain: true }) : recibo ?? {};
    plain.modalidad_credito = credito.modalidad_credito;
    const ui = buildReciboUI(plain);
    if (recibo?.setDataValue) {
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);
    }

    return { cuota, recibo, credito: credito_ui, resumen_libre: resumen_after };
};
