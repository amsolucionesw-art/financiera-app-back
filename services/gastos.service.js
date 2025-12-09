// backend/src/services/gasto.service.js
import { Op } from 'sequelize';
import sequelize from '../models/sequelize.js';
import Gasto from '../models/Gasto.js';
import CajaMovimiento from '../models/CajaMovimiento.js'; // opcional, por compat si lo usás en otro lado

// Centralizamos la lógica de caja usando los helpers ya definidos en caja.service
import {
    registrarEgresoDesdeGasto,
    actualizarMovimientoDesdeGasto,
    eliminarMovimientoDesdeGasto,
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

const toNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return 0;
        // admite "1.234,56" o "1234,56" o "1234.56"
        const normalized = trimmed.replace(/\./g, '').replace(',', '.');
        const n = Number(normalized);
        return Number.isFinite(n) ? n : 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

const nowHMS = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
};

const isMonth = (m) => Number.isFinite(m) && m >= 1 && m <= 12;
const isYear = (y) => Number.isFinite(y) && y >= 1900 && y <= 9999;

// Rango timezone-safe
const ensureRange = (desde, hasta) => {
    if (desde && hasta) {
        const a = new Date(`${desde}T00:00:00Z`);
        const b = new Date(`${hasta}T00:00:00Z`);
        if (a > b) return [hasta, desde];
    }
    return [desde, hasta];
};

// Arma concepto legible para Caja incluyendo el concepto del gasto si existe
const conceptoGasto = (g) => {
    const tc = (g?.tipo_comprobante || '').toString().trim();
    const n = (g?.numero_comprobante || '').toString().trim();
    const p = (g?.proveedor_nombre || '').toString().trim();
    const c = (g?.concepto || '').toString().trim();
    const base = `Gasto${tc ? ` ${tc}` : ''}${n ? ` ${n}` : ''}${p ? ` - ${p}` : ''}${c ? ` - ${c}` : ''}`;
    return base.slice(0, 255);
};

const normalizeFormaPagoId = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'string' && v.toLowerCase() === 'null') return null;
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

/** POST /gastos */
export const crearGasto = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const dataIn = req.body || {};

        // Requeridos mínimos
        if (!dataIn.fecha_imputacion || dataIn.total == null || !String(dataIn.concepto || '').trim()) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: 'fecha_imputacion, total y concepto son obligatorios',
            });
        }

        // Fechas normalizadas
        const fechaImp = asYMD(dataIn.fecha_imputacion);
        if (!fechaImp) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'fecha_imputacion inválida' });
        }
        // fallback: si fecha_gasto no es válida, usar fecha_imputacion
        const fechaGas = asYMD(dataIn.fecha_gasto) ?? fechaImp;

        // Derivar mes/año (UTC)
        const dImp = new Date(`${fechaImp}T00:00:00Z`);
        const mes = Number(dataIn.mes ?? (dImp.getUTCMonth() + 1));
        const anio = Number(dataIn.anio ?? dImp.getUTCFullYear());
        if (!isMonth(mes) || !isYear(anio)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'Mes o año inválidos' });
        }

        // Normalizaciones
        let payload = {
            ...dataIn,
            fecha_imputacion: fechaImp,
            fecha_gasto: fechaGas,
            total: fix2(dataIn.total),
            forma_pago_id: normalizeFormaPagoId(dataIn.forma_pago_id),
            mes,
            anio,
        };

        if (!(payload.total > 0)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'El total debe ser mayor a 0' });
        }

        payload = trimStr(payload, [
            'tipo_comprobante',
            'numero_comprobante',
            'proveedor_nombre',
            'proveedor_cuit',
            'concepto',
            'clasificacion',
            'gasto_realizado_por',
            'observacion',
        ]);
        if (payload.concepto) payload.concepto = payload.concepto.slice(0, 255);

        // Crear gasto
        const nuevo = await Gasto.create(payload, { transaction: t });

        // Impacto en caja (EGRESO) usando helper centralizado
        const usuario_id = dataIn.usuario_id ?? req.user?.id ?? null;

        const mov = await registrarEgresoDesdeGasto(
            {
                gasto_id: nuevo.id,
                total: nuevo.total, // ya viene normalizado a pesos reales
                fecha_imputacion: nuevo.fecha_imputacion,
                forma_pago_id: nuevo.forma_pago_id ?? null,
                usuario_id,
                concepto: conceptoGasto(nuevo),
            },
            { transaction: t }
        );

        // Vincular movimiento al gasto
        if (mov?.id) {
            await nuevo.update({ caja_movimiento_id: mov.id }, { transaction: t });
        }

        await t.commit();
        return res.status(201).json({ success: true, data: nuevo });
    } catch (err) {
        console.error('[crearGasto]', err);
        try {
            await t.rollback();
        } catch (_) {}
        return res.status(500).json({
            success: false,
            message: 'Error al crear gasto',
            error: err?.message,
        });
    }
};

/** GET /gastos */
export const listarGastos = async (req, res) => {
    try {
        const {
            desde,
            hasta,
            mes,
            anio,
            q,
            forma_pago_id,
            proveedor_cuit,
            proveedor_nombre,
            numero_comprobante,
            clasificacion,
        } = req.query || {};

        const where = {};

        // mes/año
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

        // Filtros varios
        if (forma_pago_id !== undefined) {
            const v = String(forma_pago_id).toLowerCase();
            if (v === 'null' || v === 'none') where.forma_pago_id = { [Op.is]: null };
            else {
                const n = Number(forma_pago_id);
                if (Number.isFinite(n)) where.forma_pago_id = n;
            }
        }
        if (proveedor_cuit) where.proveedor_cuit = { [Op.iLike]: `%${String(proveedor_cuit).trim()}%` };
        if (proveedor_nombre) where.proveedor_nombre = { [Op.iLike]: `%${String(proveedor_nombre).trim()}%` };
        if (numero_comprobante)
            where.numero_comprobante = { [Op.iLike]: `%${String(numero_comprobante).trim()}%` };
        if (clasificacion) where.clasificacion = { [Op.iLike]: `%${String(clasificacion).trim()}%` };

        if (q && String(q).trim() !== '') {
            const qs = String(q).trim();
            where[Op.or] = [
                { proveedor_nombre: { [Op.iLike]: `%${qs}%` } },
                { proveedor_cuit: { [Op.iLike]: `%${qs}%` } },
                { numero_comprobante: { [Op.iLike]: `%${qs}%` } },
                { concepto: { [Op.iLike]: `%${qs}%` } },
                { clasificacion: { [Op.iLike]: `%${qs}%` } },
                { gasto_realizado_por: { [Op.iLike]: `%${qs}%` } },
            ];
        }

        const rows = await Gasto.findAll({
            where,
            order: [
                ['fecha_imputacion', 'ASC'],
                ['id', 'ASC'],
            ],
        });

        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error('[listarGastos]', err);
        return res
            .status(500)
            .json({ success: false, message: 'Error al listar gastos', error: err?.message });
    }
};

/** GET /gastos/:id */
export const obtenerGasto = async (req, res) => {
    try {
        const row = await Gasto.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Gasto no encontrado' });
        return res.json({ success: true, data: row });
    } catch (err) {
        console.error('[obtenerGasto]', err);
        return res
            .status(500)
            .json({ success: false, message: 'Error al obtener gasto', error: err?.message });
    }
};

/** PUT /gastos/:id */
export const actualizarGasto = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const row = await Gasto.findByPk(req.params.id, {
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!row) {
            await t.rollback();
            return res.status(404).json({ success: false, message: 'Gasto no encontrado' });
        }

        const dataIn = req.body || {};
        const patch = { ...dataIn };

        // Fechas
        if ('fecha_imputacion' in patch || 'fecha_gasto' in patch) {
            const base = asYMD(patch.fecha_imputacion ?? row.fecha_imputacion);
            if (!base) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'fecha_imputacion inválida' });
            }
            patch.fecha_imputacion = base;
            // fecha_gasto: si viene inválida → fallback a imputación
            const fG =
                'fecha_gasto' in patch ? asYMD(patch.fecha_gasto) : asYMD(row.fecha_gasto);
            patch.fecha_gasto = fG ?? base;

            // Derivar m/a (UTC)
            const dBase = new Date(`${base}T00:00:00Z`);
            const m = Number(patch.mes ?? row.mes ?? (dBase.getUTCMonth() + 1));
            const y = Number(patch.anio ?? row.anio ?? dBase.getUTCFullYear());
            if (!isMonth(m) || !isYear(y)) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'Mes o año inválidos' });
            }
            patch.mes = m;
            patch.anio = y;
        } else {
            if (patch.mes !== undefined && !isMonth(Number(patch.mes))) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'mes inválido' });
            }
            if (patch.anio !== undefined && !isYear(Number(patch.anio))) {
                await t.rollback();
                return res.status(400).json({ success: false, message: 'anio inválido' });
            }
        }

        // Normalizaciones
        if ('total' in patch) patch.total = fix2(patch.total);
        if ('forma_pago_id' in patch)
            patch.forma_pago_id = normalizeFormaPagoId(patch.forma_pago_id);

        // Trims
        Object.assign(
            patch,
            trimStr(patch, [
                'tipo_comprobante',
                'numero_comprobante',
                'proveedor_nombre',
                'proveedor_cuit',
                'concepto',
                'clasificacion',
                'gasto_realizado_por',
                'observacion',
            ])
        );
        if ('concepto' in patch && typeof patch.concepto === 'string') {
            patch.concepto = patch.concepto.slice(0, 255);
        }

        // Validar total final
        const totalFinal = 'total' in patch ? patch.total : row.total;
        if (!(fix2(totalFinal) > 0)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'El total debe ser mayor a 0' });
        }

        // Update gasto
        await row.update(patch, { transaction: t });

        // Upsert movimiento de caja (EGRESO) usando helper
        const usuario_id = patch.usuario_id ?? req.user?.id ?? null;
        const mov = await actualizarMovimientoDesdeGasto(
            {
                gasto_id: row.id,
                total: row.total,
                fecha_imputacion: row.fecha_imputacion,
                forma_pago_id: row.forma_pago_id ?? null,
                concepto: conceptoGasto(row),
            },
            { transaction: t }
        );

        // Si por alguna razón no existía el movimiento, lo creamos
        if (!mov) {
            const creado = await registrarEgresoDesdeGasto(
                {
                    gasto_id: row.id,
                    total: row.total,
                    fecha_imputacion: row.fecha_imputacion,
                    forma_pago_id: row.forma_pago_id ?? null,
                    usuario_id,
                    concepto: conceptoGasto(row),
                },
                { transaction: t }
            );
            if (creado?.id) {
                await row.update({ caja_movimiento_id: creado.id }, { transaction: t });
            }
        } else if (mov.id && row.caja_movimiento_id !== mov.id) {
            // alineamos el link si cambió
            await row.update({ caja_movimiento_id: mov.id }, { transaction: t });
        }

        await t.commit();
        return res.json({ success: true, data: row });
    } catch (err) {
        console.error('[actualizarGasto]', err);
        try {
            await t.rollback();
        } catch (_) {}
        return res.status(500).json({
            success: false,
            message: 'Error al actualizar gasto',
            error: err?.message,
        });
    }
};

/** DELETE /gastos/:id */
export const eliminarGasto = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const row = await Gasto.findByPk(req.params.id, {
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!row) {
            await t.rollback();
            return res.status(404).json({ success: false, message: 'Gasto no encontrado' });
        }

        // Borrar movimiento de caja asociado usando helper centralizado
        await eliminarMovimientoDesdeGasto(row.id, { transaction: t });

        // Borrar gasto
        await Gasto.destroy({ where: { id: row.id }, transaction: t });

        await t.commit();
        return res.json({ success: true, deleted: true });
    } catch (err) {
        console.error('[eliminarGasto]', err);
        try {
            await t.rollback();
        } catch (_) {}
        return res.status(500).json({
            success: false,
            message: 'Error al eliminar gasto',
            error: err?.message,
        });
    }
};