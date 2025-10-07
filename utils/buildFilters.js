// backend/src/utils/buildFilters.js
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

/* ─────────── función principal ─────────── */
export const buildFilters = (query = {}, mapping = {}) => {
    const where = {};

    for (const param in mapping) {
        if (!(param in query)) continue;
        const { field, type = 'eq' } = mapping[param];
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
