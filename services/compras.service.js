// backend/src/services/compras.service.js
import { Op } from 'sequelize';
import sequelize from '../models/sequelize.js';
import Compra from '../models/Compra.js';
import CajaMovimiento from '../models/CajaMovimiento.js';
import Proveedor from '../models/Proveedor.js';
import {
    registrarEgresoDesdeCompra,
    actualizarMovimientoDesdeCompra,
    eliminarMovimientoDesdeCompra
} from './caja.service.js';

/* ───────────────── Helpers ───────────────── */

// YYYY-MM-DD timezone-safe:
// - Si viene 'YYYY-MM-DD' lo devolvemos literal.
// - Si viene Date/ISO, usamos getters UTC para evitar corrimientos.
const asYMD = (s) => {
    if (!s) return null;
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    try {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return null;
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    } catch {
        return null;
    }
};

const nowYMD = () => asYMD(new Date());

const nowHMS = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
};

const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

/**
 * Normaliza números conservando el decimal correcto.
 * Reglas:
 * - Si tiene coma y punto → asumo "1.234,56": quito puntos y reemplazo coma por punto.
 * - Si solo tiene coma → "1234,56" → "1234.56".
 * - Si solo tiene punto → lo dejo (punto decimal real).
 * - Sino, parseo directo.
 */
const sanitizeNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const s = value.trim();
        if (s === '') return 0;
        const hasComma = s.includes(',');
        const hasDot = s.includes('.');
        let norm = s;
        if (hasComma && hasDot) {
            norm = s.replace(/\./g, '').replace(/,/g, '.');
        } else if (hasComma) {
            norm = s.replace(/,/g, '.');
        } else {
            norm = s; // solo punto o sin separadores
        }
        const n = Number(norm);
        return Number.isFinite(n) ? n : 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

const conceptoCompra = (compra) => {
    const t = (compra?.tipo_comprobante || '').toString().trim();
    const n = (compra?.numero_comprobante || '').toString().trim();
    const p = (compra?.proveedor_nombre || '').toString().trim();
    const parteComp = [t, n].filter(Boolean).join(' ');
    return `Compra ${parteComp}${p ? ` - ${p}` : ''}`.trim().slice(0, 255);
};

const isMonth = (m) => Number.isFinite(m) && m >= 1 && m <= 12;
const isYear = (y) => Number.isFinite(y) && y >= 1900 && y <= 9999;

// Corrige rango invertido (timezone-safe)
const ensureRange = (desde, hasta) => {
    if (desde && hasta) {
        const a = new Date(`${desde}T00:00:00Z`);
        const b = new Date(`${hasta}T00:00:00Z`);
        if (a > b) return [hasta, desde];
    }
    return [desde, hasta];
};

const normalizeFormaPagoId = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'string' && v.toLowerCase() === 'null') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const normalizeId = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const trimStr = (obj, keys) => {
    const out = { ...obj };
    keys.forEach((k) => {
        if (k in out && typeof out[k] === 'string') out[k] = out[k].trim();
    });
    return out;
};

/* ───────────────── CRUD con impacto en Caja ───────────────── */

/** POST /compras */
export const crearCompra = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const data = req.body || {};

        // Requeridos mínimos
        if (!data.fecha_imputacion || !data.tipo_comprobante || !data.numero_comprobante || !data.proveedor_nombre) {
            // proveedor_nombre puede derivarse si viene proveedor_id.
        }

        const fechaImp = asYMD(data.fecha_imputacion);
        if (!fechaImp) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'fecha_imputacion inválida' });
        }

        // Derivar mes/año (UTC) si no vienen
        const dImp = new Date(`${fechaImp}T00:00:00Z`);
        const mes = Number(data.mes ?? (dImp.getUTCMonth() + 1));
        const anio = Number(data.anio ?? dImp.getUTCFullYear());
        if (!isMonth(mes) || !isYear(anio)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'Mes o año inválidos' });
        }

        // Normalizar importes (SIN heurística de centavos)
        const neto = fix2(sanitizeNumber(data.neto));
        const iva = fix2(sanitizeNumber(data.iva));
        const per_iva = fix2(sanitizeNumber(data.per_iva));
        const per_iibb_tuc = fix2(sanitizeNumber(data.per_iibb_tuc));
        const per_tem = fix2(sanitizeNumber(data.per_tem));

        let total = sanitizeNumber(data.total);
        if (!(total > 0)) {
            total = fix2(neto + iva + per_iva + per_iibb_tuc + per_tem);
        } else {
            total = fix2(total);
        }

        if (!(total > 0)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'El total debe ser mayor a 0' });
        }

        // Proveedor (normalización y derivación de redundancias)
        const proveedor_id = normalizeId(data.proveedor_id);
        let proveedor = null;
        if (proveedor_id) {
            proveedor = await Proveedor.findByPk(proveedor_id, { transaction: t });
            if (!proveedor) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'proveedor_id inválido' });
            }
        }

        // Normalizaciones varias
        let payload = {
            ...data,
            fecha_imputacion: fechaImp,
            neto,
            iva,
            per_iva,
            per_iibb_tuc,
            per_tem,
            total,
            mes,
            anio,
            forma_pago_id: normalizeFormaPagoId(data.forma_pago_id),
            proveedor_id
        };

        payload = trimStr(payload, [
            'tipo_comprobante',
            'numero_comprobante',
            'proveedor_nombre',
            'proveedor_cuit',
            'deposito_destino',
            'referencia_compra',
            'clasificacion',
            'facturado_a',
            'gasto_realizado_por',
            'observacion'
        ]);

        // Si vino proveedor_id y faltan redundancias, derivarlas del maestro
        if (proveedor && (!payload.proveedor_nombre || payload.proveedor_nombre === '')) {
            payload.proveedor_nombre = proveedor.nombre_razon_social || '';
        }
        if (proveedor && (!payload.proveedor_cuit || payload.proveedor_cuit === '')) {
            payload.proveedor_cuit = proveedor.cuil_cuit || '';
        }

        // Chequeo final de proveedor_nombre
        if (!payload.proveedor_nombre || payload.proveedor_nombre.trim() === '') {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'Proveedor no informado' });
        }

        // Crear compra
        const nueva = await Compra.create(payload, { transaction: t });

        // Usuario (si el token trae)
        const usuario_id = data.usuario_id ?? req.user?.id ?? null;

        // Crear movimiento de caja (EGRESO) y linkear
        const mov = await registrarEgresoDesdeCompra({
            compra_id: nueva.id,
            total: nueva.total,
            fecha_imputacion: nueva.fecha_imputacion,
            forma_pago_id: nueva.forma_pago_id ?? null,
            usuario_id,
            concepto: conceptoCompra(nueva)
        }, { transaction: t });

        await nueva.update({ caja_movimiento_id: mov.id }, { transaction: t });

        await t.commit();

        // Respuesta con include
        const withInclude = await Compra.findByPk(nueva.id, {
            include: [{ model: Proveedor, as: 'proveedor', attributes: ['id', 'nombre_razon_social', 'cuil_cuit'] }]
        });

        res.status(201).json({ success: true, data: withInclude || nueva });
    } catch (err) {
        console.error('[crearCompra]', err);
        try { await t.rollback(); } catch (_) { }
        res.status(500).json({ success: false, message: 'Error al crear compra', error: err?.message });
    }
};

/** GET /compras */
export const listarCompras = async (req, res) => {
    try {
        const {
            desde,
            hasta,
            mes,
            anio,
            q,
            tipo_comprobante,
            proveedor_cuit,
            proveedor_id,
            forma_pago_id,
        } = req.query || {};

        const where = {};

        // Mes/Año
        if (mes !== undefined) {
            const m = Number(mes);
            if (!isMonth(m)) return res.status(400).json({ success: false, message: 'mes inválido' });
            where.mes = m;
        }
        if (anio !== undefined) {
            const y = Number(anio);
            if (!isYear(y)) return res.status(400).json({ success: false, message: 'anio inválido' });
            where.anio = y;
        }

        // Rango por fecha_imputacion (campo contable)
        let d = asYMD(desde);
        let h = asYMD(hasta);
        [d, h] = ensureRange(d, h);
        if (d && h) where.fecha_imputacion = { [Op.between]: [d, h] };
        else if (d) where.fecha_imputacion = { [Op.gte]: d };
        else if (h) where.fecha_imputacion = { [Op.lte]: h };

        if (tipo_comprobante) where.tipo_comprobante = { [Op.iLike]: `%${String(tipo_comprobante).trim()}%` };
        if (proveedor_cuit) where.proveedor_cuit = { [Op.iLike]: `%${String(proveedor_cuit).trim()}%` };

        if (forma_pago_id !== undefined) {
            const v = String(forma_pago_id).toLowerCase();
            if (v === 'null' || v === 'none') where.forma_pago_id = { [Op.is]: null };
            else {
                const n = Number(forma_pago_id);
                if (Number.isFinite(n)) where.forma_pago_id = n;
            }
        }

        if (proveedor_id !== undefined) {
            const n = Number(proveedor_id);
            if (Number.isFinite(n)) where.proveedor_id = n;
        }

        if (q && String(q).trim() !== '') {
            const qs = String(q).trim();
            where[Op.or] = [
                { proveedor_nombre: { [Op.iLike]: `%${qs}%` } },
                { numero_comprobante: { [Op.iLike]: `%${qs}%` } },
                { tipo_comprobante: { [Op.iLike]: `%${qs}%` } },
                { clasificacion: { [Op.iLike]: `%${qs}%` } },
                { referencia_compra: { [Op.iLike]: `%${qs}%` } },
            ];
        }

        const rows = await Compra.findAll({
            where,
            include: [
                { model: Proveedor, as: 'proveedor', attributes: ['id', 'nombre_razon_social', 'cuil_cuit'] }
            ],
            order: [
                ['fecha_imputacion', 'ASC'],
                ['id', 'ASC'],
            ],
        });

        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('[listarCompras]', err);
        res.status(500).json({ success: false, message: 'Error al listar compras', error: err?.message });
    }
};

/** GET /compras/:id */
export const obtenerCompra = async (req, res) => {
    try {
        const row = await Compra.findByPk(req.params.id, {
            include: [{ model: Proveedor, as: 'proveedor', attributes: ['id', 'nombre_razon_social', 'cuil_cuit'] }]
        });
        if (!row) return res.status(404).json({ success: false, message: 'Compra no encontrada' });
        res.json({ success: true, data: row });
    } catch (err) {
        console.error('[obtenerCompra]', err);
        res.status(500).json({ success: false, message: 'Error al obtener compra', error: err?.message });
    }
};

/** PUT /compras/:id */
export const actualizarCompra = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const row = await Compra.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!row) {
            await t.rollback();
            return res.status(404).json({ success: false, message: 'Compra no encontrada' });
        }

        const data = req.body || {};

        // Validar/derivar fecha/m-a si cambia
        if (data.fecha_imputacion) {
            const f = asYMD(data.fecha_imputacion);
            if (!f) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'fecha_imputacion inválida' });
            }
            data.fecha_imputacion = f;
            const parsed = new Date(`${f}T00:00:00Z`);
            const m = Number(data.mes ?? (parsed.getUTCMonth() + 1));
            const y = Number(data.anio ?? parsed.getUTCFullYear());
            if (!isMonth(m) || !isYear(y)) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'Mes o año inválidos' });
            }
            data.mes = m;
            data.anio = y;
        } else {
            // Si vienen m/a explícitos, validarlos
            if (data.mes !== undefined && !isMonth(Number(data.mes))) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'mes inválido' });
            }
            if (data.anio !== undefined && !isYear(Number(data.anio))) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'anio inválido' });
            }
        }

        // Proveedor (si cambia)
        let proveedor = null;
        if (data.proveedor_id !== undefined) {
            const pid = normalizeId(data.proveedor_id);
            if (pid) {
                proveedor = await Proveedor.findByPk(pid, { transaction: t });
                if (!proveedor) {
                    await t.rollback();
                    return res.status(400).json({ success: false, message: 'proveedor_id inválido' });
                }
                data.proveedor_id = pid;
            } else {
                // permitir null para “desasociar”
                data.proveedor_id = null;
            }
        }

        // Normalizar importes (SIN heurística de centavos)
        const neto = data.neto !== undefined
            ? fix2(sanitizeNumber(data.neto))
            : fix2(sanitizeNumber(row.neto));
        const iva = data.iva !== undefined
            ? fix2(sanitizeNumber(data.iva))
            : fix2(sanitizeNumber(row.iva));
        const per_iva = data.per_iva !== undefined
            ? fix2(sanitizeNumber(data.per_iva))
            : fix2(sanitizeNumber(row.per_iva));
        const per_iibb_tuc = data.per_iibb_tuc !== undefined
            ? fix2(sanitizeNumber(data.per_iibb_tuc))
            : fix2(sanitizeNumber(row.per_iibb_tuc));
        const per_tem = data.per_tem !== undefined
            ? fix2(sanitizeNumber(data.per_tem))
            : fix2(sanitizeNumber(row.per_tem));

        let total;
        if (data.total !== undefined) {
            total = fix2(sanitizeNumber(data.total));
        } else if (
            data.neto !== undefined ||
            data.iva !== undefined ||
            data.per_iva !== undefined ||
            data.per_iibb_tuc !== undefined ||
            data.per_tem !== undefined
        ) {
            total = fix2(neto + iva + per_iva + per_iibb_tuc + per_tem);
        } else {
            total = fix2(sanitizeNumber(row.total));
        }

        if (!(total > 0)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'El total debe ser mayor a 0' });
        }

        // Normalizaciones adicionales
        if ('forma_pago_id' in data) data.forma_pago_id = normalizeFormaPagoId(data.forma_pago_id);
        Object.assign(data, trimStr(data, [
            'tipo_comprobante',
            'numero_comprobante',
            'proveedor_nombre',
            'proveedor_cuit',
            'deposito_destino',
            'referencia_compra',
            'clasificacion',
            'facturado_a',
            'gasto_realizado_por',
            'observacion'
        ]));

        // Si se setea proveedor_id y faltan redundancias, derivarlas
        if (proveedor && (!data.proveedor_nombre || data.proveedor_nombre === '')) {
            data.proveedor_nombre = proveedor.nombre_razon_social || '';
        }
        if (proveedor && (!data.proveedor_cuit || data.proveedor_cuit === '')) {
            data.proveedor_cuit = proveedor.cuil_cuit || '';
        }

        // Actualizar compra
        await row.update(
            {
                ...data,
                neto,
                iva,
                per_iva,
                per_iibb_tuc,
                per_tem,
                total,
            },
            { transaction: t }
        );

        // Upsert del movimiento de caja (usar helpers)
        const usuario_id = data.usuario_id ?? req.user?.id ?? null;

        // Primero intento actualizar el movimiento por referencia
        const updatedMov = await actualizarMovimientoDesdeCompra({
            compra_id: row.id,
            total,
            fecha_imputacion: row.fecha_imputacion,
            forma_pago_id: row.forma_pago_id ?? null,
            concepto: conceptoCompra(row)
        }, { transaction: t });

        if (!updatedMov) {
            // Si no existía, lo creo y linkeo
            const createdMov = await registrarEgresoDesdeCompra({
                compra_id: row.id,
                total,
                fecha_imputacion: row.fecha_imputacion,
                forma_pago_id: row.forma_pago_id ?? null,
                usuario_id,
                concepto: conceptoCompra(row)
            }, { transaction: t });

            await row.update({ caja_movimiento_id: createdMov.id }, { transaction: t });
        } else if (!row.caja_movimiento_id) {
            // Si existía por referencia pero el id no estaba linkeado, lo linkeo
            await row.update({ caja_movimiento_id: updatedMov.id }, { transaction: t });
        }

        await t.commit();

        // Responder con include
        const withInclude = await Compra.findByPk(row.id, {
            include: [{ model: Proveedor, as: 'proveedor', attributes: ['id', 'nombre_razon_social', 'cuil_cuit'] }]
        });

        res.json({ success: true, data: withInclude || row });
    } catch (err) {
        console.error('[actualizarCompra]', err);
        try { await t.rollback(); } catch (_) { }
        res.status(500).json({ success: false, message: 'Error al actualizar compra', error: err?.message });
    }
};

/** DELETE /compras/:id */
export const eliminarCompra = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const row = await Compra.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!row) {
            await t.rollback();
            return res.status(404).json({ success: false, message: 'Compra no encontrada' });
        }

        // Eliminar movimiento de caja por helper
        await eliminarMovimientoDesdeCompra(row.id, { transaction: t });

        await Compra.destroy({ where: { id: row.id }, transaction: t });

        await t.commit();
        res.json({ success: true, deleted: true });
    } catch (err) {
        console.error('[eliminarCompra]', err);
        try { await t.rollback(); } catch (_) { }
        res.status(500).json({ success: false, message: 'Error al eliminar compra', error: err?.message });
    }
};