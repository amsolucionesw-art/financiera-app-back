import { Op } from 'sequelize';

/* ─────────── helpers ─────────── */
const toBool = (v) =>
    v === true || v === 'true' || v === '1' || v === 1;

const toMaybeNumber = (s) => {
    if (s === '' || s == null) return s;
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
};

const toArray = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    if (v != null) return [v];
    return [];
};

// YYYY-MM-DD en UTC (sin hora, seguro contra husos)
const todayYMDUTC = () => {
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

/**
 * Normaliza el parámetro `mapping` para aceptar:
 * - Array<string>  => cada item se interpreta como { field: item, type: 'eq' } con la misma clave en query
 * - Object mapping => { param: { field, type } }
 * - Falsy/undefined=> se mapean todas las keys presentes en `query` a { field: key, type: 'eq' }
 */
const normalizeMapping = (query = {}, mapping) => {
    // Array de strings → eq directo
    if (Array.isArray(mapping)) {
        const out = {};
        for (const key of mapping) {
            out[key] = { field: key, type: 'eq' };
        }
        return out;
    }

    // Objeto mapping válido
    if (mapping && typeof mapping === 'object') {
        return mapping;
    }

    // Sin mapping → todas las keys de query como eq
    const all = {};
    for (const key of Object.keys(query || {})) {
        all[key] = { field: key, type: 'eq' };
    }
    return all;
};

/* ─────────── función principal ─────────── */
export const buildFilters = (query = {}, mapping = {}) => {
    const where = {};
    const map = normalizeMapping(query, mapping);

    for (const param in map) {
        if (!(param in query)) continue;
        const conf = map[param] || {};
        const field = conf.field ?? param;
        const type = conf.type ?? 'eq';
        const value = query[param];

        if (value === '' || value == null) continue;

        switch (type) {
            case 'eq':
                where[field] = toMaybeNumber(value);
                break;

            case 'in': {
                const arr = toArray(value).map(toMaybeNumber);
                if (arr.length > 0) {
                    where[field] = { [Op.in]: arr };
                }
                break;
            }

            case 'bool':
                where[field] = toBool(value);
                break;

            case 'dateRange': {
                // value: "YYYY-MM-DD,YYYY-MM-DD"
                const [from, to] = String(value).split(',').map((v) => v.trim());
                const cond = {};
                if (from) cond[Op.gte] = from; // trabajamos con string YYYY-MM-DD
                if (to) cond[Op.lte] = to;
                if (Object.keys(cond).length > 0) {
                    where[field] = cond;
                }
                break;
            }

            case 'today':
                // compara contra la fecha YYYY-MM-DD exacta
                where[field] = todayYMDUTC();
                break;

            default:
                // ignoramos tipos desconocidos
                break;
        }
    }

    return where;
};

export default buildFilters;

