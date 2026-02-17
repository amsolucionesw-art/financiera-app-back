// financiera-backend/services/cuota/cuota.recibo.service.js
// Recibos: formateo UI + creación compatible con DB legacy (sin columnas nuevas)
// Importante: NO contiene lógica de negocio de pago; solo armado/compat.

import Recibo from '../../models/Recibo.js';
import {
    APP_TZ,
    todayYMD,
    nowTime,
    fix2,
    toNumber,
    isMissingColumnError,
    marcarReciboSinCicloLibre,
    reciboTieneCicloLibreCol
} from './cuota.utils.js';

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
export const buildReciboUI = (recibo) => {
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

        // ✅ observaciones (puede venir en distintas DBs)
        observaciones,
        observacion,

        // desglose
        importe_cuota_original,
        descuento_aplicado,
        mora_cobrada,
        principal_pagado,
        interes_ciclo_cobrado,

        // ✅ DB: saldo_mora_pendiente
        saldo_mora_pendiente,

        // ✅ ciclo imputado (LIBRE)
        ciclo_libre,

        // ✅ meta descuento cancelación (si existe en DB)
        descuento_sobre,
        descuento_porcentaje,

        // montos y saldos
        monto_pagado,
        pago_a_cuenta,
        saldo_anterior,
        saldo_actual,

        // capital del crédito
        saldo_credito_anterior,
        saldo_credito_actual
    } = recibo;

    // ✅ CLAVE:
    // "Cantidad de" (y lo que el usuario percibe como pago) debe priorizar pago_a_cuenta.
    // Si por cualquier razón monto_pagado viniera con "monto del crédito", no debe ganar.
    const montoDisplay = pago_a_cuenta ?? monto_pagado ?? 0;

    const obsUI =
        (typeof observaciones === 'string' && observaciones.trim() !== '')
            ? observaciones.trim()
            : ((typeof observacion === 'string' && observacion.trim() !== '') ? observacion.trim() : '');

    const base = {
        numero_recibo: numero_recibo ?? null,
        fecha: formatYMDToDMY(fecha),
        hora: hora || '',
        cliente: cliente_nombre || '',
        cobrador: nombre_cobrador || '',
        medio_pago: medio_pago || '',
        concepto: concepto || '',
        modalidad_credito: modalidad_credito || undefined,

        // ✅ observaciones para UI (si existen)
        observaciones: obsUI || undefined,

        // totales (UI)
        monto_pagado: formatARS(montoDisplay),
        pago_a_cuenta: formatARS(pago_a_cuenta ?? monto_pagado ?? 0),

        // saldos totales (siempre $)
        saldo_anterior: formatARS(saldo_anterior ?? 0),
        saldo_actual: formatARS(saldo_actual ?? 0),

        // desglose
        importe_cuota_original:
            importe_cuota_original !== undefined ? formatARS(importe_cuota_original) : undefined,
        descuento_aplicado:
            descuento_aplicado !== undefined ? nonAplicaIfZero(descuento_aplicado) : undefined,
        mora_cobrada:
            mora_cobrada !== undefined ? nonAplicaIfZero(mora_cobrada) : undefined,

        // 🟦 campo “Saldo de mora” (UI)
        saldo_mora:
            saldo_mora_pendiente !== undefined ? nonAplicaIfZero(saldo_mora_pendiente) : undefined,

        // ✅ meta descuento cancelación (opcional, solo si existe)
        descuento_sobre: descuento_sobre ?? undefined,
        descuento_porcentaje:
            descuento_porcentaje !== undefined && descuento_porcentaje !== null
                ? String(descuento_porcentaje)
                : undefined
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

/* ───────────────── Helpers de creación con SAVEPOINT ───────────────── */

/**
 * Ejecuta una operación en un SAVEPOINT si estamos dentro de una TX externa.
 * Esto evita el 25P02 cuando queremos "probar" un INSERT que puede fallar.
 */
const withSavepointIfTx = async (options, fn) => {
    const outerTx = options?.transaction;
    if (!outerTx) return await fn(options);

    // Nested transaction de Sequelize => SAVEPOINT en Postgres
    return await Recibo.sequelize.transaction({ transaction: outerTx }, async (spTx) => {
        const opts = { ...(options || {}), transaction: spTx };
        return await fn(opts);
    });
};

/**
 * Intenta extraer el nombre de la columna faltante desde errores típicos de Postgres/Sequelize.
 * Ej: 'column "ciclo_libre" of relation "recibos" does not exist'
 */
const extractMissingColumnName = (err) => {
    const msg = String(err?.original?.message || err?.parent?.message || err?.message || '');

    const m1 = msg.match(/column ["']?([a-zA-Z0-9_]+)["']?\s+of relation/i);
    if (m1?.[1]) return m1[1];

    const m2 = msg.match(/column ["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i);
    if (m2?.[1]) return m2[1];

    return null;
};

/* ───────────────── Compat: ciclo_libre en DB legacy (sin columna) ───────────────── */

const CICLO_TAG_PREFIX = '[ciclo_libre:';
const buildCicloTag = (ciclo) => `${CICLO_TAG_PREFIX}${Number(ciclo)}]`;

const appendCicloTagEnConcepto = (payload, ciclo) => {
    if (!payload || ciclo == null) return payload;

    const cicloNum = Number(ciclo);
    if (!Number.isFinite(cicloNum)) return payload;

    // Si no existe el atributo en el modelo, no tocamos nada.
    if (!Recibo?.rawAttributes?.concepto) return payload;

    const tag = buildCicloTag(cicloNum);
    const prev = payload.concepto != null ? String(payload.concepto) : '';

    if (prev.includes(tag)) return payload;

    const next = prev ? `${prev} ${tag}` : tag;
    return { ...payload, concepto: next };
};

const dropCicloLibreConTag = (payload) => {
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'ciclo_libre')) return payload;

    const ciclo = payload.ciclo_libre;

    // 1) Persistimos ciclo (en texto) para poder agrupar por ciclo aunque la DB sea legacy.
    let out = appendCicloTagEnConcepto(payload, ciclo);

    // 2) Eliminamos ciclo_libre para no romper INSERT (marca/limpia de forma centralizada).
    marcarReciboSinCicloLibre(out);
    return out;
};

/**
 * ✅ Crea recibo de forma compatible con DB legacy (sin columnas nuevas).
 * - Si NO existe la columna `ciclo_libre`, se elimina ANTES de insertar (evita abortar transacciones).
 * - Si falla por cualquier columna faltante, se elimina esa columna y se reintenta en SAVEPOINT.
 * - PLUS (LIBRE): cuando no existe ciclo_libre, se guarda el ciclo en `concepto` como tag:
 *   "[ciclo_libre:N]" para que luego podamos filtrar/sumar por ciclo sin depender de fechas.
 *
 * ✅ Importante (meta descuento):
 * - Si la DB no tiene `descuento_sobre` / `descuento_porcentaje`, este método las removerá por retry
 *   (misma mecánica que con ciclo_libre y cualquier otra columna faltante).
 *
 * ✅ Importante (observaciones):
 * - Si la DB no tiene `observaciones` / `observacion`, este método las removerá por retry.
 */
export const createReciboSafe = async (payload, options = {}) => {
    let finalPayload = payload ? { ...payload } : payload;

    // Pre-chequeo (barato y cacheado): evita el “primer INSERT que rompe la TX”
    if (finalPayload && Object.prototype.hasOwnProperty.call(finalPayload, 'ciclo_libre')) {
        const tieneCol = await reciboTieneCicloLibreCol();
        if (!tieneCol) {
            finalPayload = dropCicloLibreConTag(finalPayload);
        }
    }

    const MAX_RETRIES = 8;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await withSavepointIfTx(options, async (opts) => {
                return await Recibo.create(finalPayload, opts);
            });
        } catch (e) {
            lastError = e;

            const missingCol =
                extractMissingColumnName(e) ||
                (isMissingColumnError?.(e, 'ciclo_libre') ? 'ciclo_libre' : null) ||
                (isMissingColumnError?.(e) ? null : null);

            if (!missingCol && isMissingColumnError?.(e)) {
                if (finalPayload && Object.prototype.hasOwnProperty.call(finalPayload, 'ciclo_libre')) {
                    finalPayload = dropCicloLibreConTag(finalPayload);
                    continue;
                }
                break;
            }

            if (missingCol && finalPayload && Object.prototype.hasOwnProperty.call(finalPayload, missingCol)) {
                if (missingCol === 'ciclo_libre') {
                    finalPayload = dropCicloLibreConTag(finalPayload);
                    continue;
                }
                const clone = { ...finalPayload };
                delete clone[missingCol];
                finalPayload = clone;
                continue;
            }

            break;
        }
    }

    throw lastError;
};

/* ───────────────── Recibos (payload) ───────────────── */
/** Devuelve el nombre legible de la modalidad de crédito para usar en el concepto del recibo */
const nombreModalidadCredito = (modalidadRaw) => {
    const mod = String(modalidadRaw || '').toLowerCase();
    if (mod === 'libre') return 'LIBRE';
    if (mod === 'comun') return 'PLAN DE CUOTAS FIJAS';
    if (mod === 'progresivo') return 'PROGRESIVO';
    return 'CRÉDITO';
};

export const armarDatosRecibo = ({
    cliente,
    cobrador,
    pago,
    cuota,
    credito,
    medioPagoNombre,
    medioPago, // compat
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

    // ✅ NUEVO: observaciones del modal (texto libre)
    observaciones = undefined,

    // ✅ ciclo libre imputado
    cicloLibre = null,

    // ✅ NUEVO: meta de descuento en cancelación (si aplica)
    // - descuentoSobre: 'mora' | 'total' (string)
    // - descuentoPorcentaje: 0..100 (number)
    descuentoSobre = undefined,
    descuentoPorcentaje = undefined
}) => {
    const nowYMD = todayYMD();
    const horaNow = nowTime(new Date());

    const medioPagoFinal = (medioPagoNombre ?? medioPago?.nombre ?? 'N/D');

    const payload = {
        cliente_id: cliente?.id ?? credito?.cliente_id ?? null,
        pago_id: pago?.id ?? null,
        cuota_id: cuota?.id ?? null,

        cliente_nombre: `${cliente?.nombre ?? ''} ${cliente?.apellido ?? ''}`.trim() || 'Cliente',
        monto_pagado: fix2(toNumber(pago?.monto_pagado)),
        concepto:
            conceptoExtra ||
            `Pago cuota #${cuota?.numero_cuota} del ${nombreModalidadCredito(credito?.modalidad_credito)} #${credito?.id}`,
        fecha: nowYMD,
        hora: horaNow,

        saldo_anterior: fix2(
            typeof saldoCuotaAnterior === 'number' ? saldoCuotaAnterior : toNumber(saldoPrincipalAntes)
        ),
        pago_a_cuenta: fix2(toNumber(pago?.monto_pagado)),
        saldo_actual: fix2(
            typeof saldoCuotaActual === 'number' ? saldoCuotaActual : toNumber(saldoPrincipalDespues)
        ),

        nombre_cobrador: cobrador?.nombre_completo || 'Sin cobrador asignado',
        medio_pago: medioPagoFinal,

        // DB: NOT NULL con default 0 → enviamos número siempre
        importe_cuota_original: fix2(toNumber(importeOriginalCuota)),
        descuento_aplicado: fix2(toNumber(descuentoAplicado)),
        mora_cobrada: fix2(toNumber(moraCobrada)),
        principal_pagado: fix2(toNumber(principalPagado)),

        // ✅ DB: saldo_mora_pendiente (NOT NULL default 0)
        saldo_mora_pendiente: fix2(
            saldoMoraRestante !== undefined ? toNumber(saldoMoraRestante) : 0
        ),

        saldo_credito_anterior: fix2(toNumber(saldoCreditoAntes)),
        saldo_credito_actual: fix2(toNumber(saldoCreditoDespues)),

        interes_ciclo_cobrado: fix2(toNumber(interesCicloCobrado)),

        modalidad_credito: credito?.modalidad_credito || undefined
    };

    // ✅ Persistimos observaciones (si viene texto)
    // Mandamos ambos nombres por compat: observaciones / observacion.
    // Si la DB no tiene alguno, createReciboSafe lo elimina automáticamente.
    if (typeof observaciones === 'string' && observaciones.trim() !== '') {
        const txt = observaciones.trim().slice(0, 500); // límite defensivo
        payload.observaciones = txt;
        payload.observacion = txt;
    }

    // ✅ Persistimos ciclo_libre solo para LIBRE y SOLO si es un número válido
    // (Si la DB no tiene la columna, createReciboSafe lo taggea en concepto y lo elimina.)
    if (String(credito?.modalidad_credito || '').toLowerCase() === 'libre') {
        const cicloNum = Number(cicloLibre);
        if (Number.isFinite(cicloNum)) {
            payload.ciclo_libre = cicloNum;
        }
    }

    // ✅ NUEVO: meta de descuento (cancelación).
    // Solo lo mandamos si viene explícito y es válido.
    // Si la DB no tiene estas columnas, createReciboSafe las removerá por retry automáticamente.
    if (typeof descuentoSobre !== 'undefined' && descuentoSobre !== null && descuentoSobre !== '') {
        payload.descuento_sobre = String(descuentoSobre);
    }
    if (typeof descuentoPorcentaje !== 'undefined' && descuentoPorcentaje !== null && descuentoPorcentaje !== '') {
        const pct = Number(descuentoPorcentaje);
        if (Number.isFinite(pct)) {
            payload.descuento_porcentaje = pct;
        }
    }

    return payload;
};
