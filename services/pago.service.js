// src/services/pago.service.js
// Controller fino de pagos. SIN lógica de negocio.
// La lógica completa (incluido LIBRE, transacciones, caja y recibos)
// vive en cuota.service.js.

import { registrarPagoParcial, pagarCuota } from './cuota.service.js';
import { Cuota, Credito } from '../models/associations.js';
import Pago from '../models/Pago.js';
import FormaPago from '../models/FormaPago.js';

/* ───────────────── Helpers básicos ───────────────── */

const sanitizeNumber = (value) => {
    if (value === null || value === undefined) return 0;
    const n = Number(String(value).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
};

const toIntOrNull = (v) => {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
};

/**
 * Resuelve el descuento que se envía a cuota.service.js
 * - Admin (rol 1): SOLO mora
 * - Otros: compat legacy
 */
const resolveDescuentoParaCuotaService = ({ rolId, descuentoLegacy, descuentoMora }) => {
    const dl = sanitizeNumber(descuentoLegacy);
    const dm = sanitizeNumber(descuentoMora);

    if (dl < 0 || dm < 0) {
        const err = new Error('El descuento no puede ser negativo.');
        err.status = 400;
        throw err;
    }

    if (rolId === 1) {
        return dm > 0 ? dm : dl;
    }

    return dl > 0 ? dl : dm;
};

/**
 * Bloquea operaciones si el crédito está anulado.
 * (Defensa backend: el front puede fallar, el server no.)
 */
const assertCreditoNoAnulado = (credito) => {
    const estado = String(credito?.estado ?? '').trim().toLowerCase();
    if (estado === 'anulado' || estado === 'anulada') {
        const err = new Error('El crédito está ANULADO. No se permiten pagos, liquidaciones ni refinanciaciones.');
        err.status = 409;
        throw err;
    }
};

/* ───────────────── PAGO PARCIAL ───────────────── */

export const registrarPago = async (req, res) => {
    try {
        const {
            cuota_id,
            monto_pagado,
            forma_pago_id,
            observacion,
            descuento = 0,
            descuento_mora = null
        } = req.body ?? {};

        const usuarioId =
            req.user?.id ??
            req.user?.usuario_id ??
            req.user?.userId ??
            null;

        const rolIdRaw = req.user?.rol_id ?? req.user?.rol ?? null;
        const rolId = typeof rolIdRaw === 'number' ? rolIdRaw : toIntOrNull(rolIdRaw);

        if (rolId === 2) {
            return res.status(403).json({
                success: false,
                error: 'Un cobrador no puede registrar pagos.'
            });
        }

        const cuotaIdInt = toIntOrNull(cuota_id);
        const formaPagoIdInt = toIntOrNull(forma_pago_id);
        const monto = sanitizeNumber(monto_pagado);

        if (!cuotaIdInt || !formaPagoIdInt || !(monto > 0)) {
            return res.status(400).json({
                success: false,
                error: 'Datos inválidos para registrar el pago.'
            });
        }

        const cuota = await Cuota.findByPk(cuotaIdInt, {
            include: [{ model: Credito, as: 'credito' }]
        });
        if (!cuota || !cuota.credito) {
            return res.status(404).json({ success: false, error: 'Cuota o crédito no encontrados.' });
        }

        // ✅ Bloqueo por estado del crédito
        assertCreditoNoAnulado(cuota.credito);

        const descuentoFinal = resolveDescuentoParaCuotaService({
            rolId,
            descuentoLegacy: descuento,
            descuentoMora: descuento_mora
        });

        const result = await registrarPagoParcial({
            cuota_id: cuotaIdInt,
            monto_pagado: monto,
            forma_pago_id: formaPagoIdInt,
            observacion,
            descuento: descuentoFinal,
            usuario_id: usuarioId ?? undefined,
            rol_id: rolId ?? undefined
        });

        return res.status(201).json({
            success: true,
            message: 'Pago parcial registrado.',
            ...result
        });
    } catch (error) {
        console.error('[registrarPago]', error);
        res.status(error?.status || 500).json({
            success: false,
            error: error?.message || 'Error al registrar el pago.'
        });
    }
};

/* ───────────────── PAGO TOTAL ───────────────── */

export const registrarPagoTotal = async (req, res) => {
    try {
        const {
            cuota_id,
            forma_pago_id,
            observacion,
            descuento = 0,
            descuento_mora = null
        } = req.body ?? {};

        const usuarioId =
            req.user?.id ??
            req.user?.usuario_id ??
            req.user?.userId ??
            null;

        const rolIdRaw = req.user?.rol_id ?? req.user?.rol ?? null;
        const rolId = typeof rolIdRaw === 'number' ? rolIdRaw : toIntOrNull(rolIdRaw);

        if (rolId === 2) {
            return res.status(403).json({
                success: false,
                error: 'Un cobrador no puede registrar pagos totales.'
            });
        }

        const cuotaIdInt = toIntOrNull(cuota_id);
        const formaPagoIdInt = toIntOrNull(forma_pago_id);

        if (!cuotaIdInt || !formaPagoIdInt) {
            return res.status(400).json({
                success: false,
                error: 'Datos inválidos para registrar el pago total.'
            });
        }

        // ✅ Traemos cuota+crédito para validar ANULADO también en pago total
        const cuota = await Cuota.findByPk(cuotaIdInt, {
            include: [{ model: Credito, as: 'credito' }]
        });
        if (!cuota || !cuota.credito) {
            return res.status(404).json({ success: false, error: 'Cuota o crédito no encontrados.' });
        }

        // ✅ Bloqueo por estado del crédito
        assertCreditoNoAnulado(cuota.credito);

        const descuentoFinal = resolveDescuentoParaCuotaService({
            rolId,
            descuentoLegacy: descuento,
            descuentoMora: descuento_mora
        });

        const result = await pagarCuota({
            cuota_id: cuotaIdInt,
            forma_pago_id: formaPagoIdInt,
            descuento: descuentoFinal,
            observacion,
            usuario_id: usuarioId ?? undefined,
            rol_id: rolId ?? undefined
        });

        return res.status(201).json({
            success: true,
            message: 'Pago total registrado.',
            ...result
        });
    } catch (error) {
        console.error('[registrarPagoTotal]', error);
        res.status(error?.status || 500).json({
            success: false,
            error: error?.message || 'Error al registrar el pago total.'
        });
    }
};

/* ───────────────── HISTORIAL ───────────────── */

export const obtenerPagosPorCuota = async (req, res) => {
    try {
        const cuotaIdInt = toIntOrNull(req.params?.cuotaId);
        if (!cuotaIdInt) {
            return res.status(400).json({ success: false, error: 'cuotaId inválido.' });
        }

        const pagos = await Pago.findAll({
            where: { cuota_id: cuotaIdInt },
            include: [{ model: FormaPago, as: 'formaPago', attributes: ['id', 'nombre'] }],
            order: [['fecha_pago', 'ASC'], ['id', 'ASC']]
        });

        res.json({ success: true, data: pagos });
    } catch (error) {
        console.error('[obtenerPagosPorCuota]', error);
        res.status(500).json({
            success: false,
            error: 'Error al obtener historial de pagos.'
        });
    }
};
