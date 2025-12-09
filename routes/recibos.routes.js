// src/routes/recibos.routes.js
import { Router } from 'express';
import Recibo from '../models/Recibo.js';
import Cuota from '../models/Cuota.js';
import Credito from '../models/Credito.js';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';

const router = Router();

/* ================= Helpers de formateo/UI ================= */
const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const formatARS = (n) =>
    Number(n || 0).toLocaleString('es-AR', {
        style: 'currency',
        currency: 'ARS',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

const formatYMDToDMY = (ymdStr) => {
    if (!ymdStr) return '';
    const [Y, M, D] = String(ymdStr).split('-');
    if (!Y || !M || !D) return String(ymdStr);
    return `${D.padStart(2, '0')}/${M.padStart(2, '0')}/${Y}`;
};

const nonAplicaIfZero = (value) => {
    const n = toNumber(value);
    return n === 0 ? 'No aplica' : formatARS(n);
};

// Detecta modalidad LIBRE con seguridad (usa modalidad_credito si viene o el concepto como fallback)
const esReciboLibre = (reciboPlain = {}) => {
    const mod = String(reciboPlain.modalidad_credito || '').toLowerCase();
    if (mod === 'libre') return true;
    const concepto = String(reciboPlain.concepto || '');
    return /LIBRE/i.test(concepto);
};

/**
 * Construye un objeto "recibo_ui" listo para el front.
 * Reglas:
 *  - SIEMPRE: saldo_anterior, pago (monto_pagado/pago_a_cuenta), saldo_actual, mora_cobrada, descuento_aplicado e importe_cuota_original.
 *  - SOLO LIBRE: principal_pagado, interes_ciclo_cobrado y saldos de capital del crédito.
 */
const buildReciboUI = (reciboPlain) => {
    if (!reciboPlain) return null;

    const libre = esReciboLibre(reciboPlain);
    const {
        numero_recibo,
        fecha,
        hora,
        cliente_nombre,
        concepto,
        medio_pago,
        nombre_cobrador,
        modalidad_credito,

        // desglose
        importe_cuota_original,
        descuento_aplicado,
        mora_cobrada,
        principal_pagado,
        interes_ciclo_cobrado,

        // montos y saldos
        monto_pagado,
        pago_a_cuenta,
        saldo_anterior,
        saldo_actual,

        // capital del crédito
        saldo_credito_anterior,
        saldo_credito_actual
    } = reciboPlain;

    const base = {
        numero_recibo: numero_recibo ?? null,
        fecha: formatYMDToDMY(fecha),
        hora: hora || '',
        cliente: cliente_nombre || '',
        cobrador: nombre_cobrador || '',
        medio_pago: medio_pago || '',
        concepto: concepto || '',
        modalidad_credito: modalidad_credito || undefined,

        // totales
        monto_pagado: formatARS(monto_pagado ?? pago_a_cuenta ?? 0),
        pago_a_cuenta: formatARS(pago_a_cuenta ?? monto_pagado ?? 0),

        // saldos de la cuota (siempre monetarios)
        saldo_anterior: formatARS(saldo_anterior),
        saldo_actual: formatARS(saldo_actual),

        // desglose base
        importe_cuota_original:
            importe_cuota_original !== undefined ? formatARS(importe_cuota_original) : undefined,
        descuento_aplicado:
            descuento_aplicado !== undefined ? nonAplicaIfZero(descuento_aplicado) : undefined,
        mora_cobrada:
            mora_cobrada !== undefined ? nonAplicaIfZero(mora_cobrada) : undefined
    };

    if (!libre) {
        // NO-LIBRE → oculto capital/interés de ciclo y saldos de capital del crédito
        return base;
    }

    // LIBRE → agrego campos específicos si existen
    return {
        ...base,
        principal_pagado: principal_pagado !== undefined ? formatARS(principal_pagado) : undefined,
        interes_ciclo_cobrado:
            interes_ciclo_cobrado !== undefined ? nonAplicaIfZero(interes_ciclo_cobrado) : undefined,
        saldo_credito_anterior:
            saldo_credito_anterior !== undefined ? formatARS(saldo_credito_anterior) : undefined,
        saldo_credito_actual:
            saldo_credito_actual !== undefined ? formatARS(saldo_credito_actual) : undefined
    };
};

/**
 * Adjunta modalidad_credito y credito_id al plain del recibo y construye recibo_ui.
 * Acepta:
 *  - modalidadForzada: si ya la conocemos (ej, por /credito/:id), evitamos otra consulta.
 *  - Si no hay modalidadForzada, resuelve por cuota_id → credito → modalidad_credito + credito_id.
 */
const withUI = async (reciboInstanceOrPlain, modalidadForzada = null) => {
    if (!reciboInstanceOrPlain) return null;
    const plain = typeof reciboInstanceOrPlain.get === 'function'
        ? reciboInstanceOrPlain.get({ plain: true })
        : { ...reciboInstanceOrPlain };

    try {
        // Si no tenemos modalidad_credito o credito_id, intentamos resolverlos por cuota
        if (!plain.modalidad_credito || !plain.credito_id) {
            if (modalidadForzada && !plain.modalidad_credito) {
                // Modalidad ya conocida desde el crédito (ruta /credito/:id)
                plain.modalidad_credito = modalidadForzada;
            }

            if (plain.cuota_id && (!plain.modalidad_credito || !plain.credito_id)) {
                const cuota = await Cuota.findByPk(plain.cuota_id, { attributes: ['credito_id'] });
                if (cuota?.credito_id) {
                    // Siempre seteamos credito_id si lo tenemos
                    plain.credito_id = plain.credito_id || cuota.credito_id;

                    // Si aún no tenemos modalidad_credito, buscamos el crédito
                    if (!plain.modalidad_credito) {
                        const credito = await Credito.findByPk(cuota.credito_id, {
                            attributes: ['modalidad_credito']
                        });
                        if (credito) plain.modalidad_credito = credito.modalidad_credito;
                    }
                }
            }
        }
    } catch (_) {
        // si falla, seguimos con lo que tengamos; el builder se defiende con el concepto
    }

    const ui = buildReciboUI(plain);
    return {
        ...plain,
        recibo_ui: ui,
        modalidad_credito: plain.modalidad_credito
    };
};

/* ========================================================== */
/* ===============   ENDPOINTS DE RECIBOS   ================= */
/* ========================================================== */

/**
 * Obtener recibos por crédito (JOIN a cuotas)
 * GET /api/recibos/credito/:creditoId
 */
router.get('/credito/:creditoId', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const creditoId = Number(req.params.creditoId);
        if (!Number.isFinite(creditoId) || creditoId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de crédito inválido' });
        }

        // Tomo modalidad del crédito una sola vez (evita N consultas)
        const credito = await Credito.findByPk(creditoId, { attributes: ['id', 'modalidad_credito'] });
        const modalidad = credito?.modalidad_credito || null;

        const recibos = await Recibo.findAll({
            include: [
                {
                    model: Cuota,
                    as: 'cuota',
                    attributes: ['id', 'numero_cuota', 'credito_id'],
                    where: { credito_id: creditoId }
                }
            ],
            order: [['numero_recibo', 'DESC']]
        });

        const data = [];
        for (const r of recibos) {
            // Enriquecemos con UI y, si hiciera falta, reforzamos credito_id con la ruta
            const enriched = await withUI(r, modalidad);
            data.push({
                ...enriched,
                credito_id: enriched.credito_id || creditoId
            });
        }

        res.json({ success: true, data });
    } catch (error) {
        console.error('Error al listar recibos por crédito:', error);
        res.status(500).json({ success: false, message: 'Error al listar recibos por crédito' });
    }
});

/**
 * Obtener recibos por cuota
 * GET /api/recibos/cuota/:cuotaId
 */
router.get('/cuota/:cuotaId', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const cuotaId = Number(req.params.cuotaId);
        if (!Number.isFinite(cuotaId) || cuotaId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de cuota inválido' });
        }

        // Resuelvo modalidad a partir de la cuota → crédito
        let modalidad = null;
        const cuota = await Cuota.findByPk(cuotaId, { attributes: ['credito_id'] });
        if (cuota?.credito_id) {
            const credito = await Credito.findByPk(cuota.credito_id, { attributes: ['modalidad_credito'] });
            modalidad = credito?.modalidad_credito || null;
        }

        const recibos = await Recibo.findAll({
            where: { cuota_id: cuotaId },
            order: [['numero_recibo', 'DESC']]
        });

        const data = [];
        for (const r of recibos) {
            const enriched = await withUI(r, modalidad);
            data.push(enriched);
        }

        res.json({ success: true, data });
    } catch (error) {
        console.error('Error al listar recibos por cuota:', error);
        res.status(500).json({ success: false, message: 'Error al listar recibos por cuota' });
    }
});

/**
 * Obtener un recibo por pago_id
 * GET /api/recibos/pago/:pagoId
 */
router.get('/pago/:pagoId', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const pagoId = Number(req.params.pagoId);
        if (!Number.isFinite(pagoId) || pagoId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de pago inválido' });
        }

        const recibo = await Recibo.findOne({ where: { pago_id: pagoId } });
        if (!recibo) {
            return res.status(404).json({ success: false, message: 'Recibo no encontrado para ese pago' });
        }

        const enriched = await withUI(recibo);
        res.json({ success: true, data: enriched });
    } catch (error) {
        console.error('Error al obtener recibo por pago_id:', error);
        res.status(500).json({ success: false, message: 'Error al obtener recibo por pago_id' });
    }
});

/**
 * Obtener un recibo por su número (PK)
 * GET /api/recibos/:id
 */
router.get('/:id', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'ID de recibo inválido' });
        }

        const recibo = await Recibo.findByPk(id);
        if (!recibo) {
            return res.status(404).json({ success: false, message: 'Recibo no encontrado' });
        }

        const enriched = await withUI(recibo);
        res.json({ success: true, data: enriched });
    } catch (error) {
        console.error('Error al obtener recibo:', error);
        res.status(500).json({ success: false, message: 'Error al obtener recibo' });
    }
});

export default router;