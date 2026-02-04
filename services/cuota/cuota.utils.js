// financiera-backend/services/cuota/cuota.utils.js
// Utilidades compartidas de cuotas (TZ, numéricos, compat DB ciclo_libre, wrappers Recibo).
// Importante: sin lógica de negocio por modalidad.

import Recibo from '../../models/Recibo.js';
import { Op } from 'sequelize';

/* ===================== Constantes ===================== */
export const MORA_DIARIA = 0.025; // 2,5% por día (NO libre)

/* ===================== Compat DB: errores "columna no existe" ===================== */
/**
 * Detecta de forma robusta "columna no existe" (Postgres):
 * - code 42703 (undefined_column)
 * - mensaje en EN/ES
 *
 * Si `col` se pasa, verifica que el mensaje mencione esa columna.
 * Si `col` es null/undefined, devuelve true para cualquier missing-column.
 */
export const isMissingColumnError = (err, col = null) => {
    const msg = String(err?.original?.message || err?.parent?.message || err?.message || '');
    const lower = msg.toLowerCase();

    // Postgres: undefined_column
    const pgCode = String(err?.original?.code || err?.parent?.code || err?.code || '');
    const byCode = pgCode === '42703';

    // PostgreSQL en ES / EN (variantes comunes)
    const byMsg =
        /column .* does not exist/i.test(msg) ||
        (/does not exist/i.test(msg) && /column/i.test(msg)) ||
        /no existe la columna/i.test(msg) ||
        /columna .* no existe/i.test(msg);

    const missing = byCode || byMsg;
    if (!missing) return false;

    // Si no se pide una columna específica => cualquier missing column
    if (col == null || String(col).trim() === '') return true;

    const colLower = String(col).toLowerCase();

    // Intentamos extraer nombre de columna desde el mensaje para comparar mejor
    const m1 = msg.match(/column ["']?([a-zA-Z0-9_]+)["']?\s+of relation/i);
    const m2 = msg.match(/column ["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i);
    const extracted = (m1?.[1] || m2?.[1] || '').toLowerCase();

    if (extracted) return extracted === colLower;

    // Fallback: contiene el nombre de la columna
    return lower.includes(colLower);
};

/* ===================== Cache de columnas de Recibo ===================== */
let _reciboHasCicloLibreCol = null;

/**
 * Soporta llamadas con o sin argumento (compat):
 * - reciboTieneCicloLibreCol()
 * - reciboTieneCicloLibreCol({ transaction })
 * - reciboTieneCicloLibreCol(transaction)
 *
 * Nota: QueryInterface.describeTable no necesita transaction; el arg se ignora.
 */
export const reciboTieneCicloLibreCol = async (_maybeTxOrOpts = null) => {
    if (_reciboHasCicloLibreCol !== null) return _reciboHasCicloLibreCol;
    try {
        const qi = Recibo.sequelize.getQueryInterface();
        const table = Recibo.getTableName();

        // Sequelize puede devolver string o { tableName, schema }
        const tableName =
            (table && typeof table === 'object' && table.tableName) ? table.tableName : table;
        const schema =
            (table && typeof table === 'object' && table.schema) ? table.schema : undefined;

        const desc = await qi.describeTable(tableName, schema ? { schema } : undefined);

        // ✅ boolean estricto
        _reciboHasCicloLibreCol = Boolean(desc && Object.prototype.hasOwnProperty.call(desc, 'ciclo_libre'));
    } catch (_e) {
        _reciboHasCicloLibreCol = false;
    }
    return _reciboHasCicloLibreCol;
};

/**
 * ✅ Normaliza "attributes" para Recibo cuando la DB no tiene la columna `ciclo_libre`.
 *
 * - Si recibe un objeto estilo attributes (tiene include/exclude): agrega `ciclo_libre` a exclude.
 * - Si recibe un objeto "payload" (no tiene include/exclude): elimina la propiedad `ciclo_libre`.
 */
export const normalizarAttributesRecibo = (input) => {
    if (input == null) return { exclude: ['ciclo_libre'] };

    if (Array.isArray(input)) {
        return input.filter((a) => String(a) !== 'ciclo_libre');
    }

    if (typeof input === 'object') {
        const hasInclude = Object.prototype.hasOwnProperty.call(input, 'include');
        const hasExclude = Object.prototype.hasOwnProperty.call(input, 'exclude');

        if (hasInclude || hasExclude) {
            const excl = Array.isArray(input.exclude) ? input.exclude.slice() : [];
            if (!excl.includes('ciclo_libre')) excl.push('ciclo_libre');
            return { ...input, exclude: excl };
        }

        if (Object.prototype.hasOwnProperty.call(input, 'ciclo_libre')) {
            const copy = { ...input };
            delete copy.ciclo_libre;
            return copy;
        }

        return input;
    }

    return input;
};

/* ===================== Compat ciclo_libre por tag en concepto ===================== */
/**
 * Cuando la DB NO tiene recibos.ciclo_libre, persistimos el ciclo en concepto como:
 *   [ciclo_libre:N]
 * Esto permite filtrar/sumar por ciclo sin depender de rangos de fecha.
 */
const CICLO_TAG_PREFIX = '[ciclo_libre:';
const buildCicloTag = (ciclo) => `${CICLO_TAG_PREFIX}${Number(ciclo)}]`;
const buildCicloTagILike = (ciclo) => `%${buildCicloTag(ciclo)}%`;

const mergeWhereWithAnd = (baseWhere, extraCond) => {
    if (!baseWhere || typeof baseWhere !== 'object') return extraCond;

    // Si ya viene un AND explícito, lo extendemos
    if (Object.prototype.hasOwnProperty.call(baseWhere, Op.and)) {
        const arr = Array.isArray(baseWhere[Op.and]) ? baseWhere[Op.and].slice() : [baseWhere[Op.and]];
        arr.push(extraCond);
        return { ...baseWhere, [Op.and]: arr };
    }

    // Caso general: envolvemos en AND para no romper semántica
    return { [Op.and]: [baseWhere, extraCond] };
};

/**
 * ✅ Normaliza options completos (where/attributes) cuando NO existe recibos.ciclo_libre.
 *
 * Importante para evitar el 25P02:
 * - Si alguien pasa where: { ciclo_libre: ... } y la columna no existe,
 *   el SELECT aborta la transacción.
 *
 * ✅ FIX extra (clave para LIBRE legacy):
 * - En vez de tirar el filtro, lo traducimos a:
 *     concepto ILIKE '%[ciclo_libre:N]%'
 *   (siempre que haya ciclo_libre en where)
 */
export const normalizarOptionsRecibo = (options = {}) => {
    const opts = { ...options };

    // attributes
    if (Object.prototype.hasOwnProperty.call(opts, 'attributes')) {
        opts.attributes = normalizarAttributesRecibo(opts.attributes);
    }

    // where (remover o traducir filtro por columna inexistente)
    if (opts.where && typeof opts.where === 'object') {
        // soporte directo: where.ciclo_libre
        if (Object.prototype.hasOwnProperty.call(opts.where, 'ciclo_libre')) {
            const cicloVal = opts.where.ciclo_libre;

            const w = { ...opts.where };
            delete w.ciclo_libre;

            const cicloNum = Number(cicloVal);
            if (Number.isFinite(cicloNum)) {
                const cond = { concepto: { [Op.iLike]: buildCicloTagILike(cicloNum) } };
                opts.where = mergeWhereWithAnd(w, cond);
            } else {
                // si es inválido, solo limpiamos para no abortar TX
                opts.where = w;
            }
        } else {
            // soporte básico: where[Op.and]/where[Op.or] (por si alguien lo arma así)
            // Nota: no hacemos deep-walk agresivo para no cambiar semántica; solo filtramos objetos planos.
            const stripInArray = (arr) =>
                Array.isArray(arr)
                    ? arr
                        .map((x) => (x && typeof x === 'object' ? (() => {
                            if (Object.prototype.hasOwnProperty.call(x, 'ciclo_libre')) {
                                const cicloVal = x.ciclo_libre;
                                const y = { ...x };
                                delete y.ciclo_libre;

                                const cicloNum = Number(cicloVal);
                                if (Number.isFinite(cicloNum)) {
                                    return mergeWhereWithAnd(y, { concepto: { [Op.iLike]: buildCicloTagILike(cicloNum) } });
                                }
                                return y;
                            }
                            return x;
                        })() : x))
                        .filter(Boolean)
                    : arr;

            // Intentamos por claves símbolo (sequelize Op.*). Sin importar Op, chequeamos todas las keys.
            for (const k of Object.keys(opts.where)) {
                const v = opts.where[k];
                if (Array.isArray(v)) {
                    const cleaned = stripInArray(v);
                    if (cleaned !== v) {
                        opts.where = { ...opts.where, [k]: cleaned };
                    }
                }
            }
        }
    }

    return opts;
};

export const findAllReciboSafe = async (options = {}) => {
    const tiene = await reciboTieneCicloLibreCol();
    if (!tiene) {
        const opts = normalizarOptionsRecibo(options);
        return await Recibo.findAll(opts);
    }
    return await Recibo.findAll(options);
};

export const findOneReciboSafe = async (options = {}) => {
    const tiene = await reciboTieneCicloLibreCol();
    if (!tiene) {
        const opts = normalizarOptionsRecibo(options);
        return await Recibo.findOne(opts);
    }
    return await Recibo.findOne(options);
};

/**
 * ✅ Marca cache "no existe ciclo_libre" y (opcional) limpia un objeto.
 * Compat:
 * - marcarReciboSinCicloLibre()
 * - marcarReciboSinCicloLibre(payload/options)
 */
export const marcarReciboSinCicloLibre = (obj = null) => {
    _reciboHasCicloLibreCol = false;

    if (!obj || typeof obj !== 'object') return;

    // payload directo
    if (Object.prototype.hasOwnProperty.call(obj, 'ciclo_libre')) {
        try { delete obj.ciclo_libre; } catch { /* ignore */ }
    }

    // options con attributes
    if (Object.prototype.hasOwnProperty.call(obj, 'attributes')) {
        try { obj.attributes = normalizarAttributesRecibo(obj.attributes); } catch { /* ignore */ }
    }

    // options con where
    if (Object.prototype.hasOwnProperty.call(obj, 'where') && obj.where && typeof obj.where === 'object') {
        if (Object.prototype.hasOwnProperty.call(obj.where, 'ciclo_libre')) {
            try {
                const w = { ...obj.where };
                delete w.ciclo_libre;
                obj.where = w;
            } catch { /* ignore */ }
        }
    }

    // attributes-style { include/exclude }
    if (
        Object.prototype.hasOwnProperty.call(obj, 'include') ||
        Object.prototype.hasOwnProperty.call(obj, 'exclude')
    ) {
        try {
            const norm = normalizarAttributesRecibo(obj);
            for (const k of Object.keys(obj)) delete obj[k];
            Object.assign(obj, norm);
        } catch { /* ignore */ }
    }
};

/* ===================== Zona horaria (Tucumán) ===================== */
/** Timezone de referencia de negocio. Podés sobreescribir con APP_TZ. */
export const APP_TZ = process.env.APP_TZ || 'America/Argentina/Tucuman';

/** Devuelve YYYY-MM-DD en la TZ del negocio para una fecha dada (o now). */
export const toYMD_TZ = (d = new Date()) => {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
};

/** Devuelve HH:mm:ss en la TZ del negocio (para caja/recibos). */
export const nowTime = (d = new Date()) => {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: APP_TZ,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(d);
};

/** Devuelve Date “fecha-solo” (00:00 local) a partir de 'YYYY-MM-DD'. */
export const dateFromYMD = (ymdStr) => {
    const [Y, M, D] = String(ymdStr).split('-').map((x) => parseInt(x, 10));
    return new Date(Y, (M || 1) - 1, D || 1);
};

/** Devuelve YYYY-MM-DD seguro en TZ negocio, a partir de Date o string. */
export const asYMD = (val) => {
    const s = String(val ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(val);
    return toYMD_TZ(d);
};

export const ymd = (dateOrStr) => asYMD(dateOrStr);
export const ymdDate = (dateOrStr) => dateFromYMD(asYMD(dateOrStr));
export const todayYMD = () => toYMD_TZ();

/* ===================== Helpers numéricos ===================== */
export const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

export const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

export const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/** Normaliza tasa: admite 60 ó 0.60 → devuelve decimal 0.60 */
export const normalizeRate = (r) => {
    const n = toNumber(r);
    if (n <= 0) return 0;
    return n > 1 ? n / 100 : n;
};

export const getPeriodDays = (tipo) =>
    tipo === 'semanal' ? 7 : tipo === 'quincenal' ? 15 : 30;
