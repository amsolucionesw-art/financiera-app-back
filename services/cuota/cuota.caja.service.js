// financiera-backend/services/cuota/cuota.caja.service.js
// Caja: registra movimientos derivados de recibos dentro de una TX

import CajaMovimiento from '../../models/CajaMovimiento.js';
import { todayYMD, nowTime, fix2, isMissingColumnError } from './cuota.utils.js';

/* ───────────────── Helpers compat DB legacy ───────────────── */

/**
 * Ejecuta una operación en un SAVEPOINT si estamos dentro de una TX externa.
 * Esto evita el 25P02 cuando queremos "probar" un INSERT que puede fallar.
 */
const withSavepointIfTx = async (options, fn) => {
    const outerTx = options?.transaction;
    if (!outerTx) return await fn(options);

    // Nested transaction de Sequelize => SAVEPOINT en Postgres
    return await CajaMovimiento.sequelize.transaction({ transaction: outerTx }, async (spTx) => {
        const opts = { ...(options || {}), transaction: spTx };
        return await fn(opts);
    });
};

/**
 * Intenta extraer el nombre de la columna faltante desde errores típicos de Postgres/Sequelize.
 * Ej: 'column "forma_pago_id" of relation "caja_movimientos" does not exist'
 */
const extractMissingColumnName = (err) => {
    const msg = String(err?.original?.message || err?.parent?.message || err?.message || '');

    const m1 = msg.match(/column ["']?([a-zA-Z0-9_]+)["']?\s+of relation/i);
    if (m1?.[1]) return m1[1];

    const m2 = msg.match(/column ["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i);
    if (m2?.[1]) return m2[1];

    return null;
};

/**
 * Crea un movimiento de caja tolerando DB legacy:
 * si falta una columna, la elimina del payload y reintenta (máx. N veces).
 *
 * Importante: si estamos dentro de una TX, se usa SAVEPOINT para que el primer error
 * no aborte la transacción completa.
 */
const createCajaMovimientoSafe = async (payload, options = {}) => {
    let finalPayload = payload ? { ...payload } : payload;

    const MAX_RETRIES = 8;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await withSavepointIfTx(options, async (opts) => {
                return await CajaMovimiento.create(finalPayload, opts);
            });
        } catch (e) {
            lastError = e;

            // Solo fallback si parece "missing column"
            const missingCol = extractMissingColumnName(e);
            const isMissing = missingCol
                ? true
                : (typeof isMissingColumnError === 'function' ? isMissingColumnError(e) : false);

            if (!isMissing) break;

            // Si detectamos qué columna falta y está en el payload, la removemos y reintentamos
            if (missingCol && finalPayload && Object.prototype.hasOwnProperty.call(finalPayload, missingCol)) {
                const clone = { ...finalPayload };
                delete clone[missingCol];
                finalPayload = clone;
                continue;
            }

            // Si no podemos detectar cuál, no arriesgamos borrar a ciegas
            break;
        }
    }

    throw lastError;
};

/* ───────── Caja: registrar ingreso desde un Recibo dentro de la misma TX ───────── */
export const registrarIngresoDesdeReciboEnTx = async ({ t, recibo, forma_pago_id, usuario_id = null }) => {
    if (!recibo) return;

    // Normalizar recibo (por si llega como instancia Sequelize)
    const r = typeof recibo?.get === 'function' ? recibo.get({ plain: true }) : recibo;

    const nowYMD = todayYMD();
    const horaNow = nowTime(new Date());

    const numeroRef = r?.numero_recibo ?? r?.id ?? null;

    const payload = {
        fecha: r?.fecha || nowYMD,
        hora: r?.hora || horaNow,
        tipo: 'ingreso',
        monto: fix2(r?.monto_pagado || 0),
        forma_pago_id: forma_pago_id ?? null,
        concepto: (
            (numeroRef != null && numeroRef !== '')
                ? `Cobro recibo #${numeroRef} - ${r?.cliente_nombre || 'Cliente'}`
                : `Cobro recibo - ${r?.cliente_nombre || 'Cliente'}`
        ).slice(0, 255),
        referencia_tipo: 'recibo',
        referencia_id: numeroRef,
        usuario_id: usuario_id ?? null
    };

    await createCajaMovimientoSafe(payload, { transaction: t });
};