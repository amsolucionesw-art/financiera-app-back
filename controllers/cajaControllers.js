// backend/src/controllers/cajaController.js
import { Op, fn, col, literal } from 'sequelize';
import * as XLSX from 'xlsx';

import CajaMovimiento from '../models/CajaMovimiento.js';
import FormaPago from '../models/FormaPago.js';

// Para exportación (4 hojas)
import Gasto from '../models/Gasto.js';
import Compra from '../models/Compra.js';
import VentaManual from '../models/VentaManual.js';
import Recibo from '../models/Recibo.js';
import Cuota from '../models/Cuota.js';
import Credito from '../models/Credito.js';
import Cliente from '../models/Cliente.js';

/* ───────────────── Helpers ───────────────── */
const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

const sanitizeNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return 0;
        // quita separadores de miles '.' y convierte coma por punto
        const normalized = trimmed.replace(/\./g, '').replace(',', '.');
        const n = Number(normalized);
        return Number.isFinite(n) ? n : 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/** YYYY-MM-DD seguro (sin drift de huso)
 * - Si llega 'YYYY-MM-DD' lo devolvemos tal cual (literal).
 * - Si llega Date/ISO, usamos getters **UTC**.
 */
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

const addDays = (ymd, days) => {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + days);
    return asYMD(date.toISOString());
};

const TIPOS_VALIDOS = new Set(['ingreso', 'egreso', 'ajuste', 'apertura', 'cierre']);

/** Si el rango está invertido, lo corrige */
const ensureRange = (desde, hasta) => {
    if (desde && hasta) {
        const a = new Date(`${desde}T00:00:00Z`);
        const b = new Date(`${hasta}T00:00:00Z`);
        if (a > b) return [hasta, desde];
    }
    return [desde, hasta];
};

/* ───────────────── CRUD ───────────────── */

/** POST /caja/movimientos */
export const crearMovimiento = async (req, res) => {
    try {
        const {
            fecha, hora, tipo, monto,
            forma_pago_id = null,
            concepto,
            referencia_tipo = null,
            referencia_id = null,
            usuario_id = null
        } = req.body || {};

        const tipoNorm = String(tipo || '').toLowerCase().trim();
        if (!TIPOS_VALIDOS.has(tipoNorm)) {
            return res.status(400).json({ success: false, message: 'tipo inválido. Use ingreso, egreso, ajuste, apertura o cierre.' });
        }

        const montoNum = fix2(sanitizeNumber(monto));
        if (!(montoNum > 0)) {
            return res.status(400).json({ success: false, message: 'monto debe ser un número > 0' });
        }
        const conceptoTrim = String(concepto || '').trim();
        if (!conceptoTrim) {
            return res.status(400).json({ success: false, message: 'concepto es obligatorio' });
        }

        const registro = await CajaMovimiento.create({
            fecha: asYMD(fecha) || nowYMD(),
            hora: hora || nowHMS(),
            tipo: tipoNorm,
            monto: montoNum,
            forma_pago_id: forma_pago_id ?? null,
            concepto: conceptoTrim.slice(0, 255),
            referencia_tipo: referencia_tipo ?? null,
            referencia_id: referencia_id ?? null,
            usuario_id: usuario_id ?? null
        });

        res.json({ success: true, data: registro });
    } catch (err) {
        console.error('[crearMovimiento]', err);
        res.status(500).json({ success: false, message: 'Error al crear movimiento', error: err?.message });
    }
};

/** GET /caja/movimientos?... */
export const obtenerMovimientos = async (req, res) => {
    try {
        const {
            desde,
            hasta,
            tipo,
            forma_pago_id,
            referencia_tipo,
            referencia_id,
            q,
            page = 1,
            limit = 50
        } = req.query || {};

        const where = {};

        // Rango de fechas (timezone-safe)
        let d = asYMD(desde);
        let h = asYMD(hasta);
        [d, h] = ensureRange(d, h);
        if (d && h) where.fecha = { [Op.between]: [d, h] };
        else if (d) where.fecha = { [Op.gte]: d };
        else if (h) where.fecha = { [Op.lte]: h };

        // Tipos
        if (tipo) {
            const tipos = Array.isArray(tipo)
                ? tipo.map(s => String(s).trim().toLowerCase())
                : String(tipo).split(',').map(s => s.trim().toLowerCase());
            const validos = tipos.filter(t => TIPOS_VALIDOS.has(t));
            if (validos.length) where.tipo = { [Op.in]: validos };
        }

        // Forma de pago
        if (typeof forma_pago_id !== 'undefined') {
            const val = String(forma_pago_id).toLowerCase();
            if (val === 'null' || val === 'none') {
                where.forma_pago_id = { [Op.is]: null };
            } else {
                const num = Number(forma_pago_id);
                if (Number.isFinite(num)) where.forma_pago_id = num;
            }
        }

        // referencia_tipo
        if (typeof referencia_tipo !== 'undefined') {
            if (Array.isArray(referencia_tipo)) {
                const vals = referencia_tipo.map(s => String(s).trim().toLowerCase()).filter(Boolean);
                if (vals.length === 1 && (vals[0] === 'null' || vals[0] === 'none')) {
                    where.referencia_tipo = { [Op.is]: null };
                } else if (vals.length) {
                    const hasNull = vals.includes('null') || vals.includes('none');
                    where[Op.and] = where[Op.and] || [];
                    if (hasNull) {
                        const onlyVals = vals.filter(v => v !== 'null' && v !== 'none');
                        const or = [];
                        if (onlyVals.length) or.push({ referencia_tipo: { [Op.in]: onlyVals } });
                        or.push({ referencia_tipo: { [Op.is]: null } });
                        where[Op.and].push({ [Op.or]: or });
                    } else {
                        where.referencia_tipo = { [Op.in]: vals };
                    }
                }
            } else if (typeof referencia_tipo === 'string') {
                const raw = referencia_tipo.trim().toLowerCase();
                if (raw === 'null' || 'none') {
                    where.referencia_tipo = { [Op.is]: null };
                } else {
                    const vals = raw.split(',').map(s => s.trim()).filter(Boolean);
                    if (vals.length) where.referencia_tipo = { [Op.in]: vals };
                }
            }
        }

        // referencia_id
        if (typeof referencia_id !== 'undefined') {
            if (Array.isArray(referencia_id)) {
                const nums = referencia_id.map(n => Number(n)).filter(Number.isFinite);
                if (nums.length) where.referencia_id = { [Op.in]: nums };
            } else {
                const num = Number(referencia_id);
                if (Number.isFinite(num)) where.referencia_id = num;
            }
        }

        // concepto
        if (q && String(q).trim() !== '') {
            where.concepto = { [Op.iLike]: `%${String(q).trim()}%` };
        }

        const pageNum = Math.max(1, Number(page) || 1);
        const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));
        const offset = (pageNum - 1) * limitNum;

        const { rows, count } = await CajaMovimiento.findAndCountAll({
            where,
            include: [{ model: FormaPago, as: 'formaPago', attributes: ['id', 'nombre'] }],
            order: [['fecha', 'DESC'], ['hora', 'DESC'], ['id', 'DESC']],
            limit: limitNum,
            offset
        });

        // Normalizamos montos a number ya acá por seguridad
        const data = rows.map(r => ({
            ...r.get({ plain: true }),
            monto: fix2(r.monto)
        }));

        res.json({
            success: true,
            data,
            pagination: { page: pageNum, limit: limitNum, total: count }
        });
    } catch (err) {
        console.error('[obtenerMovimientos]', err);
        res.status(500).json({ success: false, message: 'Error al listar movimientos', error: err?.message });
    }
};

/* ───────────────── Resúmenes ───────────────── */

/** GET /caja/resumen-diario?fecha=YYYY-MM-DD */
export const resumenDiario = async (req, res) => {
    try {
        const { fecha } = req.query || {};
        const f = asYMD(fecha) || nowYMD();

        // Totales por tipo
        const totalesPorTipo = await CajaMovimiento.findAll({
            where: { fecha: f },
            attributes: ['tipo', [fn('SUM', col('monto')), 'total']],
            group: ['tipo'],
            raw: true
        });

        // Agrupado por forma de pago y tipo
        const porForma = await CajaMovimiento.findAll({
            where: { fecha: f },
            attributes: ['forma_pago_id', 'tipo', [fn('SUM', col('monto')), 'total']],
            group: ['forma_pago_id', 'tipo'],
            raw: true
        });

        // Catálogo formas de pago
        const formas = await FormaPago.findAll({ attributes: ['id', 'nombre'], raw: true });
        const nombreForma = (id) => {
            const found = formas.find(fp => fp.id === id);
            return found ? found.nombre : (id == null ? 'Sin especificar' : `FP #${id}`);
        };

        // Totales simplificados
        const totalIngreso = fix2(totalesPorTipo.find(t => t.tipo === 'ingreso')?.total || 0);
        const totalEgreso = fix2(totalesPorTipo.find(t => t.tipo === 'egreso')?.total || 0);
        const totalAjuste = fix2(totalesPorTipo.find(t => t.tipo === 'ajuste')?.total || 0);
        const totalApert = fix2(totalesPorTipo.find(t => t.tipo === 'apertura')?.total || 0);
        const totalCierre = fix2(totalesPorTipo.find(t => t.tipo === 'cierre')?.total || 0);

        const saldoDia = fix2(totalApert + totalIngreso - totalEgreso + totalAjuste - totalCierre);

        // Estructura agrupada por forma de pago
        const porFormaPago = {};
        for (const row of porForma) {
            const key = nombreForma(row.forma_pago_id);
            if (!porFormaPago[key]) porFormaPago[key] = { ingreso: 0, egreso: 0, ajuste: 0, apertura: 0, cierre: 0 };
            porFormaPago[key][row.tipo] = fix2(row.total);
        }

        res.json({
            success: true,
            data: {
                fecha: f,
                totales: {
                    ingreso: totalIngreso,
                    egreso: totalEgreso,
                    ajuste: totalAjuste,
                    apertura: totalApert,
                    cierre: totalCierre,
                    saldoDia
                },
                porFormaPago
            }
        });
    } catch (err) {
        console.error('[resumenDiario]', err);
        res.status(500).json({ success: false, message: 'Error al calcular resumen diario', error: err?.message });
    }
};

/** GET /caja/resumen-semanal?desde=YYYY-MM-DD */
export const resumenSemanal = async (req, res) => {
    try {
        let desde = asYMD(req.query?.desde) || nowYMD();
        let hasta = addDays(desde, 6);
        [desde, hasta] = ensureRange(desde, hasta);

        const rango = { fecha: { [Op.between]: [desde, hasta] } };

        const totalesPorTipo = await CajaMovimiento.findAll({
            where: rango,
            attributes: ['tipo', [fn('SUM', col('monto')), 'total']],
            group: ['tipo'],
            raw: true
        });

        const porDia = await CajaMovimiento.findAll({
            where: rango,
            attributes: ['fecha', 'tipo', [fn('SUM', col('monto')), 'total']],
            group: ['fecha', 'tipo'],
            order: [['fecha', 'ASC']],
            raw: true
        });

        const porForma = await CajaMovimiento.findAll({
            where: rango,
            attributes: ['forma_pago_id', 'tipo', [fn('SUM', col('monto')), 'total']],
            group: ['forma_pago_id', 'tipo'],
            raw: true
        });

        const formas = await FormaPago.findAll({ attributes: ['id', 'nombre'], raw: true });
        const nombreForma = (id) => {
            const found = formas.find(fp => fp.id === id);
            return found ? found.nombre : (id == null ? 'Sin especificar' : `FP #${id}`);
        };

        const totales = {
            ingreso: fix2(totalesPorTipo.find(t => t.tipo === 'ingreso')?.total || 0),
            egreso: fix2(totalesPorTipo.find(t => t.tipo === 'egreso')?.total || 0),
            ajuste: fix2(totalesPorTipo.find(t => t.tipo === 'ajuste')?.total || 0),
            apertura: fix2(totalesPorTipo.find(t => t.tipo === 'apertura')?.total || 0),
            cierre: fix2(totalesPorTipo.find(t => t.tipo === 'cierre')?.total || 0),
        };

        const porDiaIndex = {};
        for (const row of porDia) {
            const k = row.fecha;
            if (!porDiaIndex[k]) porDiaIndex[k] = { ingreso: 0, egreso: 0, ajuste: 0, apertura: 0, cierre: 0 };
            porDiaIndex[k][row.tipo] = fix2(row.total);
        }

        const porFormaPago = {};
        for (const row of porForma) {
            const key = nombreForma(row.forma_pago_id);
            if (!porFormaPago[key]) porFormaPago[key] = { ingreso: 0, egreso: 0, ajuste: 0, apertura: 0, cierre: 0 };
            porFormaPago[key][row.tipo] = fix2(row.total);
        }

        res.json({
            success: true,
            data: {
                desde, hasta,
                totales,
                porDia: porDiaIndex,
                porFormaPago
            }
        });
    } catch (err) {
        console.error('[resumenSemanal]', err);
        res.status(500).json({ success: false, message: 'Error al calcular resumen semanal', error: err?.message });
    }
};

/** GET /caja/resumen-mensual?anio=YYYY&mes=MM */
export const resumenMensual = async (req, res) => {
    try {
        const anio = Number(req.query?.anio) || new Date().getFullYear();
        const mes = Number(req.query?.mes) || (new Date().getMonth() + 1);
        const desde = `${anio}-${String(mes).padStart(2, '0')}-01`;

        // Rango del mes (timezone-safe)
        const rangoMes = {
            fecha: {
                [Op.gte]: desde,
                [Op.lt]: literal(`(DATE_TRUNC('month', DATE '${desde}') + INTERVAL '1 month')::date`)
            }
        };

        const totalesPorTipo = await CajaMovimiento.findAll({
            where: rangoMes,
            attributes: ['tipo', [fn('SUM', col('monto')), 'total']],
            group: ['tipo'],
            raw: true
        });

        const porDia = await CajaMovimiento.findAll({
            where: rangoMes,
            attributes: ['fecha', 'tipo', [fn('SUM', col('monto')), 'total']],
            group: ['fecha', 'tipo'],
            order: [['fecha', 'ASC']],
            raw: true
        });

        const porForma = await CajaMovimiento.findAll({
            where: rangoMes,
            attributes: ['forma_pago_id', 'tipo', [fn('SUM', col('monto')), 'total']],
            group: ['forma_pago_id', 'tipo'],
            raw: true
        });

        const formas = await FormaPago.findAll({ attributes: ['id', 'nombre'], raw: true });
        const nombreForma = (id) => {
            const found = formas.find(fp => fp.id === id);
            return found ? found.nombre : (id == null ? 'Sin especificar' : `FP #${id}`);
        };

        const totales = {
            ingreso: fix2(totalesPorTipo.find(t => t.tipo === 'ingreso')?.total || 0),
            egreso: fix2(totalesPorTipo.find(t => t.tipo === 'egreso')?.total || 0),
            ajuste: fix2(totalesPorTipo.find(t => t.tipo === 'ajuste')?.total || 0),
            apertura: fix2(totalesPorTipo.find(t => t.tipo === 'apertura')?.total || 0),
            cierre: fix2(totalesPorTipo.find(t => t.tipo === 'cierre')?.total || 0),
        };

        const porDiaIndex = {};
        for (const row of porDia) {
            const k = row.fecha;
            if (!porDiaIndex[k]) porDiaIndex[k] = { ingreso: 0, egreso: 0, ajuste: 0, apertura: 0, cierre: 0 };
            porDiaIndex[k][row.tipo] = fix2(row.total);
        }

        const porFormaPago = {};
        for (const row of porForma) {
            const key = nombreForma(row.forma_pago_id);
            if (!porFormaPago[key]) porFormaPago[key] = { ingreso: 0, egreso: 0, ajuste: 0, apertura: 0, cierre: 0 };
            porFormaPago[key][row.tipo] = fix2(row.total);
        }

        res.json({
            success: true,
            data: {
                anio,
                mes,
                totales,
                porDia: porDiaIndex,
                porFormaPago
            }
        });
    } catch (err) {
        console.error('[resumenMensual]', err);
        res.status(500).json({ success: false, message: 'Error al calcular resumen mensual', error: err?.message });
    }
};

/* ───────────────── Helpers de integración automática (créditos/recibos) ───────────────── */
export const registrarIngresoDesdeRecibo = async ({
    fecha,
    hora,
    monto,
    forma_pago_id = null,
    concepto,
    referencia_id = null,
    usuario_id = null
}, options = {}) => {
    const { transaction } = options;
    const fechaFinal = asYMD(fecha) || nowYMD();
    const horaFinal = hora || nowHMS();

    // Normalizamos lo que llega
    let montoNum = fix2(sanitizeNumber(monto));

    // 🔧 Blindaje: si viene referencia a Recibo, usamos su total cuando detectamos factor 100.
    if (referencia_id) {
        const recibo = await Recibo.findByPk(referencia_id, { attributes: ['id', 'total'], transaction, raw: true });
        if (recibo) {
            const totalRecibo = fix2(sanitizeNumber(recibo.total));
            if (totalRecibo > 0 && montoNum > 0 && Math.abs(totalRecibo - montoNum) > 0.009) {
                // Si totalRecibo ≈ montoNum*100  => monto venía dividido por 100
                // Si totalRecibo*100 ≈ montoNum  => monto venía multiplicado por 100
                if (Math.abs(totalRecibo - montoNum * 100) < 0.01) {
                    if (process.env.NODE_ENV !== 'production') {
                        console.warn(`[registrarIngresoDesdeRecibo] Ajuste +100x detectado. Recibo #${referencia_id}: usando total ${totalRecibo} en lugar de ${montoNum}`);
                    }
                    montoNum = totalRecibo;
                } else if (Math.abs(totalRecibo * 100 - montoNum) < 0.01) {
                    if (process.env.NODE_ENV !== 'production') {
                        console.warn(`[registrarIngresoDesdeRecibo] Ajuste /100 detectado. Recibo #${referencia_id}: usando total ${totalRecibo} en lugar de ${montoNum}`);
                    }
                    montoNum = totalRecibo;
                }
            }
        }
    }

    if (!(montoNum > 0)) {
        throw new Error('monto debe ser > 0 para registrar ingreso');
    }
    const conceptoFinal = String(concepto || (referencia_id ? `Cobro recibo #${referencia_id}` : 'Ingreso')).slice(0, 255);

    if (referencia_id) {
        const exists = await CajaMovimiento.findOne({
            where: {
                tipo: 'ingreso',
                referencia_tipo: 'recibo',
                referencia_id
            },
            transaction
        });
        if (exists) return { ...exists.get({ plain: true }), monto: fix2(exists.monto) };
    }

    const creado = await CajaMovimiento.create({
        fecha: fechaFinal,
        hora: horaFinal,
        tipo: 'ingreso',
        monto: montoNum,
        forma_pago_id,
        concepto: conceptoFinal,
        referencia_tipo: 'recibo',
        referencia_id,
        usuario_id
    }, { transaction });

    return { ...creado.get({ plain: true }), monto: fix2(creado.monto) };
};

export const registrarEgresoPorAcreditacionCredito = async ({
    credito_id,
    monto,
    fecha = null,
    hora = null,
    forma_pago_id = null,
    usuario_id = null,
    concepto = null
}, options = {}) => {
    const { transaction } = options;
    const fechaFinal = asYMD(fecha) || nowYMD();
    const horaFinal = hora || nowHMS();
    const montoNum = fix2(sanitizeNumber(monto));
    if (!(montoNum > 0)) {
        throw new Error('monto debe ser > 0 para registrar egreso de acreditación');
    }
    const conceptoFinal = String(concepto || `Acreditación crédito #${credito_id}`).slice(0, 255);

    if (credito_id) {
        const exists = await CajaMovimiento.findOne({
            where: {
                tipo: 'egreso',
                referencia_tipo: 'credito',
                referencia_id: credito_id
            },
            transaction
        });
        if (exists) return { ...exists.get({ plain: true }), monto: fix2(exists.monto) };
    }

    const creado = await CajaMovimiento.create({
        fecha: fechaFinal,
        hora: horaFinal,
        tipo: 'egreso',
        monto: montoNum,
        forma_pago_id,
        concepto: conceptoFinal,
        referencia_tipo: 'credito',
        referencia_id: credito_id,
        usuario_id
    }, { transaction });

    return { ...creado.get({ plain: true }), monto: fix2(creado.monto) };
};

/* ───────────────── Helpers de integración MANUAL (Gasto / Compra / VentaManual) ───────────────── */
/** EGRESO por Gasto */
export const registrarEgresoDesdeGasto = async ({
    gasto_id,
    total,
    fecha_imputacion,
    forma_pago_id = null,
    usuario_id = null,
    concepto = null
}, options = {}) => {
    const { transaction } = options;
    const fechaFinal = asYMD(fecha_imputacion) || nowYMD();
    const montoNum = fix2(sanitizeNumber(total));
    if (!(montoNum > 0)) throw new Error('total debe ser > 0 para registrar egreso (gasto)');
    const conceptoFinal = String(concepto || `Gasto #${gasto_id}`).slice(0, 255);

    // Idempotencia por referencia
    const exists = await CajaMovimiento.findOne({
        where: { tipo: 'egreso', referencia_tipo: 'gasto', referencia_id: gasto_id },
        transaction
    });
    if (exists) return { ...exists.get({ plain: true }), monto: fix2(exists.monto) };

    const creado = await CajaMovimiento.create({
        fecha: fechaFinal,
        hora: nowHMS(),
        tipo: 'egreso',
        monto: montoNum,
        forma_pago_id,
        concepto: conceptoFinal,
        referencia_tipo: 'gasto',
        referencia_id: gasto_id,
        usuario_id
    }, { transaction });

    return { ...creado.get({ plain: true }), monto: fix2(creado.monto) };
};

export const actualizarMovimientoDesdeGasto = async ({
    gasto_id,
    total,
    fecha_imputacion,
    forma_pago_id = null,
    concepto = null
}, options = {}) => {
    const { transaction } = options;
    const mov = await CajaMovimiento.findOne({
        where: { tipo: 'egreso', referencia_tipo: 'gasto', referencia_id: gasto_id },
        transaction
    });
    if (!mov) return null;

    const updates = {};
    if (total != null) updates.monto = fix2(sanitizeNumber(total));
    if (fecha_imputacion) updates.fecha = asYMD(fecha_imputacion);
    if (forma_pago_id !== undefined) updates.forma_pago_id = forma_pago_id ?? null;
    if (concepto) updates.concepto = String(concepto).slice(0, 255);

    await mov.update(updates, { transaction });
    const plain = mov.get({ plain: true });
    return { ...plain, monto: fix2(plain.monto) };
};

export const eliminarMovimientoDesdeGasto = async (gasto_id, options = {}) => {
    const { transaction } = options;
    const deleted = await CajaMovimiento.destroy({
        where: { tipo: 'egreso', referencia_tipo: 'gasto', referencia_id: gasto_id },
        transaction
    });
    return deleted; // cantidad eliminada
};

/** EGRESO por Compra */
export const registrarEgresoDesdeCompra = async ({
    compra_id,
    total,
    fecha_imputacion,
    forma_pago_id = null,
    usuario_id = null,
    concepto = null
}, options = {}) => {
    const { transaction } = options;
    const fechaFinal = asYMD(fecha_imputacion) || nowYMD();
    const montoNum = fix2(sanitizeNumber(total));
    if (!(montoNum > 0)) throw new Error('total debe ser > 0 para registrar egreso (compra)');
    const conceptoFinal = String(concepto || `Compra #${compra_id}`).slice(0, 255);

    const exists = await CajaMovimiento.findOne({
        where: { tipo: 'egreso', referencia_tipo: 'compra', referencia_id: compra_id },
        transaction
    });
    if (exists) return { ...exists.get({ plain: true }), monto: fix2(exists.monto) };

    const creado = await CajaMovimiento.create({
        fecha: fechaFinal,
        hora: nowHMS(),
        tipo: 'egreso',
        monto: montoNum,
        forma_pago_id,
        concepto: conceptoFinal,
        referencia_tipo: 'compra',
        referencia_id: compra_id,
        usuario_id
    }, { transaction });

    return { ...creado.get({ plain: true }), monto: fix2(creado.monto) };
};

export const actualizarMovimientoDesdeCompra = async ({
    compra_id,
    total,
    fecha_imputacion,
    forma_pago_id = null,
    concepto = null
}, options = {}) => {
    const { transaction } = options;
    const mov = await CajaMovimiento.findOne({
        where: { tipo: 'egreso', referencia_tipo: 'compra', referencia_id: compra_id },
        transaction
    });
    if (!mov) return null;

    const updates = {};
    if (total != null) updates.monto = fix2(sanitizeNumber(total));
    if (fecha_imputacion) updates.fecha = asYMD(fecha_imputacion);
    if (forma_pago_id !== undefined) updates.forma_pago_id = forma_pago_id ?? null;
    if (concepto) updates.concepto = String(concepto).slice(0, 255);

    await mov.update(updates, { transaction });
    const plain = mov.get({ plain: true });
    return { ...plain, monto: fix2(plain.monto) };
};

export const eliminarMovimientoDesdeCompra = async (compra_id, options = {}) => {
    const { transaction } = options;
    const deleted = await CajaMovimiento.destroy({
        where: { tipo: 'egreso', referencia_tipo: 'compra', referencia_id: compra_id },
        transaction
    });
    return deleted;
};

/** INGRESO por VentaManual */
export const registrarIngresoDesdeVentaManual = async ({
    venta_id,
    total,
    fecha_imputacion,
    forma_pago_id = null,
    usuario_id = null,
    concepto = null
}, options = {}) => {
    const { transaction } = options;
    const fechaFinal = asYMD(fecha_imputacion) || nowYMD();
    const montoNum = fix2(sanitizeNumber(total));
    if (!(montoNum > 0)) throw new Error('total debe ser > 0 para registrar ingreso (venta)');
    const conceptoFinal = String(concepto || `Venta #${venta_id}`).slice(0, 255);

    const exists = await CajaMovimiento.findOne({
        where: { tipo: 'ingreso', referencia_tipo: 'venta', referencia_id: venta_id },
        transaction
    });
    if (exists) return { ...exists.get({ plain: true }), monto: fix2(exists.monto) };

    const creado = await CajaMovimiento.create({
        fecha: fechaFinal,
        hora: nowHMS(),
        tipo: 'ingreso',
        monto: montoNum,
        forma_pago_id,
        concepto: conceptoFinal,
        referencia_tipo: 'venta',
        referencia_id: venta_id,
        usuario_id
    }, { transaction });

    return { ...creado.get({ plain: true }), monto: fix2(creado.monto) };
};

export const actualizarMovimientoDesdeVentaManual = async ({
    venta_id,
    total,
    fecha_imputacion,
    forma_pago_id = null,
    concepto = null
}, options = {}) => {
    const { transaction } = options;
    const mov = await CajaMovimiento.findOne({
        where: { tipo: 'ingreso', referencia_tipo: 'venta', referencia_id: venta_id },
        transaction
    });
    if (!mov) return null;

    const updates = {};
    if (total != null) updates.monto = fix2(sanitizeNumber(total));
    if (fecha_imputacion) updates.fecha = asYMD(fecha_imputacion);
    if (forma_pago_id !== undefined) updates.forma_pago_id = forma_pago_id ?? null;
    if (concepto) updates.concepto = String(concepto).slice(0, 255);

    await mov.update(updates, { transaction });
    const plain = mov.get({ plain: true });
    return { ...plain, monto: fix2(plain.monto) };
};

export const eliminarMovimientoDesdeVentaManual = async (venta_id, options = {}) => {
    const { transaction } = options;
    const deleted = await CajaMovimiento.destroy({
        where: { tipo: 'ingreso', referencia_tipo: 'venta', referencia_id: venta_id },
        transaction
    });
    return deleted;
};

/* ───────────────── Exportación XLSX (4 hojas) ───────────────── */
export const exportarExcel = async (req, res) => {
    try {
        let { desde, hasta, periodo } = req.query || {};
        desde = asYMD(desde);
        hasta = asYMD(hasta);

        if (!desde && periodo === 'diario') {
            desde = nowYMD(); hasta = desde;
        } else if (!desde && periodo === 'semanal') {
            desde = nowYMD(); hasta = addDays(desde, 6);
        } else if (!desde && periodo === 'mensual') {
            const d = new Date();
            const y = d.getUTCFullYear();
            const m = d.getUTCMonth() + 1;
            desde = `${y}-${String(m).padStart(2, '0')}-01`;
            const next = new Date(Date.UTC(y, m, 1));
            next.setUTCDate(next.getUTCDate() - 1);
            hasta = asYMD(next.toISOString());
        }

        if (!desde && !hasta) {
            desde = nowYMD(); hasta = desde;
        } else if (desde && !hasta) {
            hasta = desde;
        } else if (hasta && !desde) {
            desde = hasta;
        }
        [desde, hasta] = ensureRange(desde, hasta);

        const rangoFechaImput = { [Op.between]: [desde, hasta] };
        const rangoCaja = { [Op.between]: [desde, hasta] };

        const formas = await FormaPago.findAll({ attributes: ['id', 'nombre'], raw: true });
        const nombreFP = (id) => {
            const fp = formas.find(f => f.id === id);
            return fp ? fp.nombre : (id == null ? 'Sin especificar' : `FP #${id}`);
        };

        /* ── 1) GASTOS ── */
        const gastos = await Gasto.findAll({ where: { fecha_imputacion: rangoFechaImput }, raw: true });
        const sheetGastos = gastos.map(g => ({
            'FECHA IMPUTACION': g.fecha_imputacion,
            'FECHA GASTO': g.fecha_gasto || '',
            'TIPO DE COMPROBANTE': g.tipo_comprobante || '',
            'N° DE COMP': g.numero_comprobante || '',
            'PROVEEDOR': g.proveedor_nombre || '',
            'CUIT/CUIL': g.proveedor_cuit || '',
            'CONCEPTO': g.concepto || '',
            'TOTAL': Number(g.total),
            'FORMA DE PAGO': nombreFP(g.forma_pago_id),
            'CLASIFICACION': g.clasificacion || '',
            'MES': g.mes,
            'AÑO': g.anio,
            'GASTO REALIZADO POR': g.gasto_realizado_por || '',
            'OBSERVACION': g.observacion || '',
            'CajaMovID': g.caja_movimiento_id || ''
        }));

        /* ── 2) COMPRAS ── */
        const compras = await Compra.findAll({ where: { fecha_imputacion: rangoFechaImput }, raw: true });
        const sheetCompras = compras.map(c => ({
            'FECHA IMPUTACIÓN': c.fecha_imputacion,
            'FECHA DE COMPR': c.fecha_compra || '',
            'TIPO DE COMPROBANTE': c.tipo_comprobante || '',
            'N° DE COMP': c.numero_comprobante || '',
            'NOMBRE Y APELLIDO- RS': c.proveedor_nombre || '',
            'CUIT-CUIL': c.proveedor_cuit || '',
            'NETO': Number(c.neto),
            'IVA': Number(c.iva),
            'PER IVA': Number(c.per_iva),
            'PER IIBB TUC': Number(c.per_iibb_tuc),
            'PER TEM': Number(c.per_tem),
            'TOTAL': Number(c.total),
            'DEPOSITO DESTINO': c.deposito_destino || '',
            'REFERENCIA DE COMP': c.referencia_compra || '',
            'CLASIFICACION': c.clasificacion || '',
            'MES': c.mes,
            'AÑO': c.anio,
            'FACTURADO A': c.facturado_a || '',
            'GASTO REALIZADO POR': c.gasto_realizado_por || '',
            'FORMA DE PAGO': nombreFP(c.forma_pago_id),
            'CajaMovID': c.caja_movimiento_id || ''
        }));

        /* ── 3) VENTAS ── */
        const ventas = await VentaManual.findAll({ where: { fecha_imputacion: rangoFechaImput }, raw: true });
        const sheetVentas = ventas.map(v => ({
            'FECHA IMPUTACION': v.fecha_imputacion,
            'N° DE COMP': v.numero_comprobante || '',
            'NOMBRE Y APELLIDO': v.cliente_nombre || '',
            'CUIT-CUIL/ DNI': v.doc_cliente || '',
            'NETO': Number(v.neto),
            'IVA': Number(v.iva),
            'RET GAN': Number(v.ret_gan),
            'RETIVA': Number(v.ret_iva),
            'RET IIBB TUC': Number(v.ret_iibb_tuc),
            'capital': Number(v.capital),
            'interes': Number(v.interes),
            'cuotas': Number(v.cuotas),
            'TOTAL': Number(v.total),
            'FORMA DE PAGO': nombreFP(v.forma_pago_id),
            'FECHA FIN DE FINANCIACION': v.fecha_fin || '',
            'BONIFICACION (FALSO / VERD)': v.bonificacion ? 'VERDADERO' : 'FALSO',
            'VENDEDOR': v.vendedor || '',
            'MES': v.mes,
            'AÑO': v.anio,
            'CajaMovID': v.caja_movimiento_id || ''
        }));

        /* ── 4) CREDITO (Acreditaciones y Cobros) ── */
        const movsCredito = await CajaMovimiento.findAll({
            where: {
                fecha: rangoCaja,
                referencia_tipo: { [Op.in]: ['credito', 'recibo'] }
            },
            raw: true
        });

        const credIds = [...new Set(movsCredito
            .filter(m => m.referencia_tipo === 'credito')
            .map(m => m.referencia_id)
            .filter(Boolean))];

        const creditos = credIds.length ? await Credito.findAll({
            where: { id: { [Op.in]: credIds } },
            include: [{ model: Cliente, as: 'cliente', attributes: ['id', 'nombre', 'apellido'] }],
            raw: true, nest: true
        }) : [];
        const mapCreditoCliente = new Map(
            creditos.map(c => [c.id, [c.cliente?.nombre, c.cliente?.apellido].filter(Boolean).join(' ')]));
        const reciboIds = [...new Set(movsCredito
            .filter(m => m.referencia_tipo === 'recibo')
            .map(m => m.referencia_id)
            .filter(Boolean))];

        const recibos = reciboIds.length ? await Recibo.findAll({
            where: { id: { [Op.in]: reciboIds } },
            include: [{
                model: Cuota, as: 'cuota',
                include: [{
                    model: Credito, as: 'credito',
                    include: [{ model: Cliente, as: 'cliente', attributes: ['id', 'nombre', 'apellido'] }]
                }]
            }],
            raw: true, nest: true
        }) : [];
        const mapReciboCliente = new Map(
            recibos.map(r => {
                const cli = r?.cuota?.credito?.cliente;
                const nombre = [cli?.nombre, cli?.apellido].filter(Boolean).join(' ');
                return [r.id, nombre];
            })
        );

        const sheetCredito = movsCredito.map(m => {
            const tipoMov = m.referencia_tipo === 'credito' ? 'Acreditación' : 'Cobro';
            const cliente =
                m.referencia_tipo === 'credito'
                    ? (mapCreditoCliente.get(m.referencia_id) || '')
                    : (mapReciboCliente.get(m.referencia_id) || '');
            return {
                'Fecha': m.fecha,
                'Hora': m.hora || '',
                'Tipo Mov.': tipoMov,
                'CréditoID': m.referencia_tipo === 'credito' ? (m.referencia_id || '') : '',
                'ReciboID': m.referencia_tipo === 'recibo' ? (m.referencia_id || '') : '',
                'Cliente': cliente,
                'Forma de pago': nombreFP(m.forma_pago_id),
                'Concepto': m.concepto || '',
                'Monto': Number(m.monto),
                'CajaMovID': m.id
            };
        });

        const wb = XLSX.utils.book_new();

        const wsG = XLSX.utils.json_to_sheet(sheetGastos);
        const wsC = XLSX.utils.json_to_sheet(sheetCompras);
        const wsV = XLSX.utils.json_to_sheet(sheetVentas);
        const wsCr = XLSX.utils.json_to_sheet(sheetCredito);

        XLSX.utils.book_append_sheet(wb, wsG, 'GASTOS');
        XLSX.utils.book_append_sheet(wb, wsC, 'COMPRAS');
        XLSX.utils.book_append_sheet(wb, wsV, 'VENTAS');
        XLSX.utils.book_append_sheet(wb, wsCr, 'CREDITO');

        const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

        const fname = `caja_${desde}_a_${hasta}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.send(buffer);
    } catch (err) {
        console.error('[exportarExcel]', err);
        res.status(500).json({ success: false, message: 'Error al exportar Excel', error: err?.message });
    }
};
