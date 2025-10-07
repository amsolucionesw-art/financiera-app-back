// src/routes/recibos.routes.js
import { Router } from 'express';
import Recibo from '../models/Recibo.js';
import Cuota from '../models/Cuota.js';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';

const router = Router();

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

        res.json({ success: true, data: recibos });
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

        const recibos = await Recibo.findAll({
            where: { cuota_id: cuotaId },
            order: [['numero_recibo', 'DESC']]
        });

        res.json({ success: true, data: recibos });
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

        res.json({ success: true, data: recibo });
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

        res.json({ success: true, data: recibo });
    } catch (error) {
        console.error('Error al obtener recibo:', error);
        res.status(500).json({ success: false, message: 'Error al obtener recibo' });
    }
});

export default router;

