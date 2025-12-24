import { Op } from 'sequelize';
import sequelize from '../models/sequelize.js';
import VentaManual from '../models/VentaManual.js';
import {
    registrarIngresoDesdeVentaManual,
    eliminarMovimientoDesdeVentaManual
} from './caja.service.js';

// 🔗 Para obtener el cobrador del cliente y crear el crédito
import { Cliente } from '../models/associations.js';
import { crearCredito } from './credito.service.js';

/* ───────────────── Helpers ───────────────── */
// YYYY-MM-DD timezone-safe
const asYMD = (s) => {
    if (!s) return null;
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    try {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return null;
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate() + 0).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    } catch {
        return null;
    }
};

const toNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return 0;
        const normalized = trimmed.replace(/\./g, '').replace(',', '.');
        const n = Number(normalized);
        return Number.isFinite(n) ? n : 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

const conceptoVenta = (venta) => {
    const n = (venta?.numero_comprobante || '').toString().trim();
    const c = (venta?.cliente_nombre || '').toString().trim();
    return `Venta ${n}${c ? ` - ${c}` : ''}`.slice(0, 255);
};

const isMonth = (m) => Number.isFinite(m) && m >= 1 && m <= 12;
const isYear = (y) => Number.isFinite(y) && y >= 1900 && y <= 9999;

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

const trimStr = (obj, keys) => {
    const out = { ...obj };
    keys.forEach((k) => {
        if (k in out && typeof out[k] === 'string') out[k] = out[k].trim();
    });
    return out;
};

// Tipos de crédito admitidos al crear el crédito desde venta
const TIPOS_VALIDOS = new Set(['mensual', 'semanal', 'quincenal']);
const normalizarTipoCredito = (v) => {
    const s = String(v || '').toLowerCase().trim();
    return TIPOS_VALIDOS.has(s) ? s : 'mensual';
};

/* ───────────── N° comprobante automático (FA-0001-00001234) ───────────── */
const PAD_PV = 4;
const PAD_NUM = 8;
const PUNTO_DE_VENTA = 1; // fijo 0001 (parametrizable a futuro)

const pad = (n, size) => String(n).padStart(size, '0');
const formatPV = (pv) => pad(pv, PAD_PV);
const formatNro = (n) => pad(n, PAD_NUM);

/** Construye el número de comprobante con PV fijo y correlativo por ID. */
const buildNumeroComprobante = ({ id, puntoVenta = PUNTO_DE_VENTA }) => {
    const pv = formatPV(puntoVenta);
    const corr = formatNro(Number(id || 0));
    return `FA-${pv}-${corr}`;
};

/* ───────────────── Crédito desde venta ───────────────── */
const intentarCrearCreditoDesdeVenta = async (venta, rawData, t) => {
    const cliente_id = Number(rawData?.cliente_id ?? venta?.cliente_id ?? 0);
    const capital = toNumber(rawData?.capital ?? venta?.capital ?? 0);
    const cuotas = Number(rawData?.cuotas ?? venta?.cuotas ?? 1);

    // Solo si es financiada (capital > 0 y cuotas > 1)
    if (!(capital > 0 && cuotas > 1)) return null;

    if (!(cliente_id > 0)) {
        const err = new Error('Venta financiada: se requiere cliente_id para crear el crédito automáticamente.');
        err.status = 400;
        throw err;
    }

    // Obtener cobrador del cliente (columna 'cobrador')
    const cliente = await Cliente.findByPk(cliente_id, { transaction: t });
    const cobrador_id = cliente?.cobrador ?? null;

    // Fechas base (⚠️ sin fecha_fin: se toma imputación como compromiso)
    const fecha_imputacion = asYMD(rawData?.fecha_imputacion ?? venta?.fecha_imputacion);

    // Tipo de crédito proveniente de la venta, si lo envían
    const tipo_credito = normalizarTipoCredito(rawData?.tipo_credito);

    // Detalle de producto (venta financiada) – lo usamos como metadata para el crédito
    const detalle_producto =
        (rawData?.detalle_producto ??
            venta?.detalle_producto ??
            ''
        ).toString().trim() || null;

    const payloadCredito = {
        cliente_id,
        cobrador_id,
        monto_acreditar: fix2(capital),

        fecha_solicitud: fecha_imputacion,
        fecha_acreditacion: fecha_imputacion,
        fecha_compromiso_pago: fecha_imputacion, // ✅ sin usar fecha_fin

        tipo_credito,
        cantidad_cuotas: cuotas,
        modalidad_credito: 'comun', // mantenemos modalidad
        origen_venta_manual_financiada: true, // hint no disruptivo
        detalle_producto: detalle_producto || null, // opcional
    };

    // ✅ Interés MANUAL si vino en la venta
    const interesVenta = toNumber(rawData?.interes ?? venta?.interes ?? 0);
    if (interesVenta > 0) {
        payloadCredito.interes = interesVenta; // en %
    }

    const creado = await crearCredito(payloadCredito, { transaction: t });
    const creditoId = (creado && typeof creado === 'object' && creado.id) ? creado.id : creado;

    if (!Number.isFinite(Number(creditoId))) {
        const err = new Error('No se pudo obtener el ID del crédito creado.');
        err.status = 500;
        throw err;
    }
    return { creditoId: Number(creditoId) };
};

/* ───────────────── CRUD con impacto en Caja ───────────────── */

export const crearVentaManual = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const data = req.body || {};

        // ✅ Validaciones explícitas (evitan SequelizeValidationError)
        if (!data.fecha_imputacion || !data.cliente_nombre || data.total == null) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: 'fecha_imputacion, cliente_nombre y total son obligatorios'
            });
        }

        // ⚠️ cliente_id es NOT NULL en el modelo -> si no viene, 400 claro
        const cliente_id = Number(data.cliente_id ?? 0);
        if (!(cliente_id > 0)) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: 'cliente_id es obligatorio (seleccioná un cliente válido)'
            });
        }

        const fechaImp = asYMD(data.fecha_imputacion);
        if (!fechaImp) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'fecha_imputacion inválida' });
        }

        // Derivar mes/año (UTC)
        const dImp = new Date(`${fechaImp}T00:00:00Z`);
        const mes = Number(data.mes ?? (dImp.getUTCMonth() + 1));
        const anio = Number(data.anio ?? dImp.getUTCFullYear());
        if (!isMonth(mes) || !isYear(anio)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'Mes o año inválidos' });
        }

        // 🔄 Normalizar tipo_credito y dejarlo ya coherente en la venta
        const tipo_credito = normalizarTipoCredito(data.tipo_credito);
        data.tipo_credito = tipo_credito;

        // Normalizaciones + placeholders
        let payload = {
            ...data,
            cliente_id, // aseguramos el valor normalizado
            fecha_imputacion: fechaImp,
            neto: fix2(data.neto ?? 0),
            iva: fix2(data.iva ?? 0),
            ret_gan: fix2(data.ret_gan ?? 0),
            ret_iva: fix2(data.ret_iva ?? 0),
            ret_iibb_tuc: fix2(data.ret_iibb_tuc ?? 0),
            capital: fix2(data.capital ?? 0),
            interes: fix2(data.interes ?? 0),
            cuotas: Math.max(1, Number.isFinite(Number(data.cuotas)) ? Number(data.cuotas) : 1),
            total: fix2(data.total),
            forma_pago_id: normalizeFormaPagoId(data.forma_pago_id),
            mes,
            anio,
            bonificacion: Boolean(data.bonificacion),

            // ⛳ Si no viene numero_comprobante, usamos un placeholder para cumplir NOT NULL.
            numero_comprobante: (data.numero_comprobante && String(data.numero_comprobante).trim() !== '')
                ? String(data.numero_comprobante).trim()
                : 'FA-0001-PEND'
        };

        payload = trimStr(payload, [
            'numero_comprobante',
            'cliente_nombre',
            'doc_cliente',
            'vendedor',
            'observacion',
            'detalle_producto',
        ]);

        if (!(payload.total > 0)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'El total debe ser mayor a 0' });
        }

        // 1) Crear venta con placeholder de comprobante
        const nueva = await VentaManual.create(payload, { transaction: t });

        // 1.1) Reemplazar placeholder por el número definitivo FA-0001-0000ID
        if (!nueva.numero_comprobante || nueva.numero_comprobante === 'FA-0001-PEND') {
            const nroAuto = buildNumeroComprobante({ id: nueva.id });
            await nueva.update({ numero_comprobante: nroAuto }, { transaction: t });
        }

        const usuario_id = data.usuario_id ?? req.user?.id ?? null;

        // 2) Movimiento de CAJA: siempre registramos un ingreso por la venta
        const mov = await registrarIngresoDesdeVentaManual({
            venta_id: nueva.id,
            total: nueva.total,
            fecha_imputacion: nueva.fecha_imputacion,
            forma_pago_id: nueva.forma_pago_id ?? null,
            usuario_id,
            concepto: conceptoVenta(nueva)
        }, { transaction: t });

        await nueva.update({ caja_movimiento_id: mov.id }, { transaction: t });

        // 3) Intentar crear CRÉDITO si corresponde (venta financiada)
        let creditoCreadoId = null;
        try {
            const creditoInfo = await intentarCrearCreditoDesdeVenta(nueva, data, t);
            if (creditoInfo?.creditoId) {
                creditoCreadoId = creditoInfo.creditoId;
                await nueva.update({ credito_id: creditoCreadoId }, { transaction: t });
            }
        } catch (creErr) {
            await t.rollback();
            return res.status(creErr?.status || 500).json({
                success: false,
                message: creErr?.message || 'Error al crear crédito desde la venta financiada'
            });
        }

        // 4) Confirmar
        await t.commit();

        // ✅ message para el alert del front (incluye comprobante + crédito si aplica)
        const comp = (nueva?.numero_comprobante || '').toString().trim();
        const msgBase = comp ? `Venta ${comp} registrada correctamente.` : 'Venta registrada correctamente.';
        const msg = creditoCreadoId
            ? `${msgBase} Se creó el crédito #${creditoCreadoId}.`
            : msgBase;

        res.status(201).json({ success: true, message: msg, data: nueva });
    } catch (err) {
        console.error('[crearVentaManual]', err);
        try { await t.rollback(); } catch (_) { }
        res.status(500).json({ success: false, message: 'Error al crear venta', error: err?.message });
    }
};

export const listarVentasManuales = async (req, res) => {
    try {
        const {
            desde,
            hasta,
            mes,
            anio,
            q,
            forma_pago_id,
            doc_cliente,
            vendedor,
            numero_comprobante
        } = req.query || {};

        const where = {};

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

        let d = asYMD(desde);
        let h = asYMD(hasta);
        [d, h] = ensureRange(d, h);
        if (d && h) where.fecha_imputacion = { [Op.between]: [d, h] };
        else if (d) where.fecha_imputacion = { [Op.gte]: d };
        else if (h) where.fecha_imputacion = { [Op.lte]: h };

        if (forma_pago_id !== undefined) {
            const v = String(forma_pago_id).toLowerCase();
            if (v === 'null' || v === 'none') where.forma_pago_id = { [Op.is]: null };
            else {
                const n = Number(forma_pago_id);
                if (Number.isFinite(n)) where.forma_pago_id = n;
            }
        }

        if (doc_cliente) where.doc_cliente = { [Op.iLike]: `%${String(doc_cliente).trim()}%` };
        if (vendedor) where.vendedor = { [Op.iLike]: `%${String(vendedor).trim()}%` };
        if (numero_comprobante) where.numero_comprobante = { [Op.iLike]: `%${String(numero_comprobante).trim()}%` };

        if (q && String(q).trim() !== '') {
            const qs = String(q).trim();
            where[Op.or] = [
                { cliente_nombre: { [Op.iLike]: `%${qs}%` } },
                { numero_comprobante: { [Op.iLike]: `%${qs}%` } },
                { vendedor: { [Op.iLike]: `%${qs}%` } }
            ];
        }

        const rows = await VentaManual.findAll({
            where,
            order: [['fecha_imputacion', 'ASC'], ['id', 'ASC']]
        });

        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('[listarVentasManuales]', err);
        res.status(500).json({ success: false, message: 'Error al listar ventas', error: err?.message });
    }
};

export const obtenerVentaManual = async (req, res) => {
    try {
        const row = await VentaManual.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
        res.json({ success: true, data: row });
    } catch (err) {
        console.error('[obtenerVentaManual]', err);
        res.status(500).json({ success: false, message: 'Error al obtener venta', error: err?.message });
    }
};

/**
 * ❌ EDICIÓN DESHABILITADA
 * Se deja el handler para evitar que el front "rompa" si todavía llama al endpoint.
 * Responde 405 Method Not Allowed con un mensaje claro.
 */
export const actualizarVentaManual = async (req, res) => {
    res.set('Allow', 'GET,POST,DELETE');
    return res.status(405).json({
        success: false,
        message: 'Edición de ventas deshabilitada. Solo se permite crear y eliminar.'
    });
};

export const eliminarVentaManual = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const row = await VentaManual.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!row) {
            await t.rollback();
            return res.status(404).json({ success: false, message: 'Venta no encontrada' });
        }

        const comp = (row?.numero_comprobante || '').toString().trim();

        // Eliminar movimiento asociado (idempotente)
        await eliminarMovimientoDesdeVentaManual(row.id, { transaction: t });

        await VentaManual.destroy({ where: { id: row.id }, transaction: t });

        await t.commit();

        const msg = comp ? `Venta ${comp} eliminada correctamente.` : 'Venta eliminada correctamente';

        res.json({ success: true, message: msg, deleted: true });
    } catch (err) {
        console.error('[eliminarVentaManual]', err);
        try { await t.rollback(); } catch (_) { }
        res.status(500).json({ success: false, message: 'Error al eliminar venta', error: err?.message });
    }
};