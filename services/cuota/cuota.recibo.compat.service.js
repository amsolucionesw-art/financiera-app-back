// financiera-backend/services/cuota/cuota.recibo.compat.service.js
// Helper neutral para crear recibos en TX con compatibilidad para DBs sin columnas nuevas
// (Evita dependencia circular entre cuota.core.service y cuota.libre.service)

import {
    isMissingColumnError,
    reciboTieneCicloLibreCol,
    normalizarAttributesRecibo,
    marcarReciboSinCicloLibre
} from './cuota.utils.js';

import { createReciboSafe } from './cuota.recibo.service.js';

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

    // ✅ Nunca pasar { transaction: null }
    // Preferimos detectar contra DB (y si hay TX real, usarla)
    const r1 = await tryCall(async () => {
        if (!t) return null;
        return reciboTieneCicloLibreCol({ transaction: t });
    });
    if (r1 !== null) {
        _cacheTieneCicloLibreCol = r1;
        return _cacheTieneCicloLibreCol;
    }

    // Algunas implementaciones aceptan directamente el objeto options o tx.
    // Si t es null, no lo pasamos.
    const r2 = await tryCall(async () => {
        if (!t) return null;
        return reciboTieneCicloLibreCol(t);
    });
    if (r2 !== null) {
        _cacheTieneCicloLibreCol = r2;
        return _cacheTieneCicloLibreCol;
    }

    // Fallback sin TX (detector “global”)
    const r3 = await tryCall(async () => reciboTieneCicloLibreCol());
    if (r3 !== null) {
        _cacheTieneCicloLibreCol = r3;
        return _cacheTieneCicloLibreCol;
    }

    // Último fallback: no pudimos detectar => asumimos false (conservador)
    _cacheTieneCicloLibreCol = false;
    return _cacheTieneCicloLibreCol;
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const getErrMsg = (e) =>
    String(e?.original?.message || e?.parent?.message || e?.message || '');

const detectMissingColumnByMessage = (e, colName) => {
    const msg = getErrMsg(e);
    // Cobertura típica Postgres/Sequelize: 'column "xxx" does not exist'
    const safe = String(colName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${safe}\\b`, 'i');
    return re.test(msg);
};

const stripCompatColumnsIfNeeded = async ({ attrs, t }) => {
    // 1) ciclo_libre: tiene detector por DB -> lo usamos
    try {
        const okCiclo = await safeTieneCicloLibreCol(t);
        if (!okCiclo && hasOwn(attrs, 'ciclo_libre')) {
            delete attrs.ciclo_libre;
            try { marcarReciboSinCicloLibre(attrs); } catch { /* ignore */ }
        }
    } catch {
        if (hasOwn(attrs, 'ciclo_libre')) {
            delete attrs.ciclo_libre;
            try { marcarReciboSinCicloLibre(attrs); } catch { /* ignore */ }
        }
    }

    // 2) descuento_sobre / descuento_porcentaje:
    // No hacemos “check de columna” por DB para no agregar dependencias nuevas;
    // si la DB no las tiene, el create fallará y lo manejamos con retry.

    return attrs;
};

// ✅ FIX: soporta nombres alternativos del payload (datosRecibo / reciboPayload / payload / recibo_payload)
// para evitar recibos vacíos => NOT NULL violations.
export const crearReciboEnTxCompat = async ({
    t,
    datosRecibo,
    reciboPayload,
    payload,
    recibo_payload
} = {}) => {
    const input = (datosRecibo ?? reciboPayload ?? payload ?? recibo_payload ?? {});

    // Normaliza (números/strings)
    let attrs = normalizarAttributesRecibo(input || {});
    attrs = await stripCompatColumnsIfNeeded({ attrs, t });

    // 1er intento
    try {
        return await createReciboSafe(attrs, { transaction: t });
    } catch (e) {
        const msg = getErrMsg(e);

        // Retry específico: columna faltante Recibo.ciclo_libre
        const esMissingCiclo = (isMissingColumnError?.(e) || /ciclo_libre/i.test(msg));
        if (esMissingCiclo) {
            if (hasOwn(attrs, 'ciclo_libre')) delete attrs.ciclo_libre;
            try { marcarReciboSinCicloLibre(attrs); } catch { /* ignore */ }
            return await createReciboSafe(attrs, { transaction: t });
        }

        // Retry específico: columnas nuevas de descuento no existen en DB
        const missingDescSobre =
            (isMissingColumnError?.(e) && detectMissingColumnByMessage(e, 'descuento_sobre'));
        const missingDescPct =
            (isMissingColumnError?.(e) && detectMissingColumnByMessage(e, 'descuento_porcentaje'));

        // Si isMissingColumnError no es confiable en tu entorno, cubrimos por string-match
        const missingDescSobreLoose = detectMissingColumnByMessage(e, 'descuento_sobre');
        const missingDescPctLoose = detectMissingColumnByMessage(e, 'descuento_porcentaje');

        if (missingDescSobre || missingDescPct || missingDescSobreLoose || missingDescPctLoose) {
            if (hasOwn(attrs, 'descuento_sobre')) delete attrs.descuento_sobre;
            if (hasOwn(attrs, 'descuento_porcentaje')) delete attrs.descuento_porcentaje;

            // Reintento único sin esas columnas
            return await createReciboSafe(attrs, { transaction: t });
        }

        throw e;
    }
};