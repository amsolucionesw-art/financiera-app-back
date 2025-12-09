// backend/src/routes/formasPago.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    obtenerFormasPago,
    obtenerFormaPagoPorId,
    crearFormaPago,
    actualizarFormaPago,
    eliminarFormaPago
} from '../services/formaPago.service.js';

const router = Router();

/**
 * GET /api/formas-pago
 * Listado de formas de pago (para selects, etc.)
 * Acceso: cualquier usuario autenticado
 */
router.get('/', verifyToken, async (req, res) => {
    try {
        const formas = await obtenerFormasPago();
        res.json(formas);
    } catch (err) {
        console.error('Error al obtener formas de pago:', err);
        res.status(500).json({ error: 'Error al obtener formas de pago' });
    }
});

/**
 * GET /api/formas-pago/:id
 * Detalle de una forma de pago
 * Acceso: cualquier usuario autenticado
 */
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const forma = await obtenerFormaPagoPorId(req.params.id);
        if (!forma) {
            return res.status(404).json({ error: 'Forma de pago no encontrada' });
        }
        res.json(forma);
    } catch (err) {
        console.error('Error al obtener forma de pago:', err);
        res.status(500).json({ error: 'Error al obtener la forma de pago' });
    }
});

/**
 * POST /api/formas-pago
 * Crear nueva forma de pago
 * Acceso: sólo superadmin / admin (roles 0 y 1)
 */
router.post('/', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const nueva = await crearFormaPago(req.body);
        res.status(201).json(nueva);
    } catch (err) {
        console.error('Error al crear forma de pago:', err);

        // Ejemplo: validaciones de modelo (campos requeridos, unique, etc.)
        if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: err.message });
        }

        res.status(500).json({ error: 'Error al crear la forma de pago' });
    }
});

/**
 * PUT /api/formas-pago/:id
 * Actualizar forma de pago existente
 * Acceso: sólo superadmin / admin (roles 0 y 1)
 */
router.put('/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const actualizada = await actualizarFormaPago(req.params.id, req.body);
        if (!actualizada) {
            return res.status(404).json({ error: 'Forma de pago no encontrada' });
        }
        res.json(actualizada);
    } catch (err) {
        console.error('Error al actualizar forma de pago:', err);

        if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: err.message });
        }

        res.status(500).json({ error: 'Error al actualizar la forma de pago' });
    }
});

/**
 * DELETE /api/formas-pago/:id
 * Eliminar forma de pago
 * Acceso: sólo superadmin / admin (roles 0 y 1)
 *
 * Si tiene pagos/cuotas/movimientos asociados y hay FK en la BD,
 * Sequelize lanzará un error de constraint: devolvemos 409 en ese caso.
 */
router.delete('/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const deleted = await eliminarFormaPago(req.params.id);

        if (!deleted) {
            return res.status(404).json({ error: 'Forma de pago no encontrada' });
        }

        res.json({ mensaje: 'Forma de pago eliminada correctamente' });
    } catch (err) {
        console.error('Error al eliminar forma de pago:', err);

        // Si hay FK en la BD y está en uso
        if (
            err.status === 409 ||
            err.name === 'SequelizeForeignKeyConstraintError' ||
            err.original?.code === '23503' // FK violation en Postgres
        ) {
            return res.status(409).json({
                error: 'No se puede eliminar la forma de pago porque está asociada a pagos/cuotas/movimientos de caja.'
            });
        }

        res.status(500).json({ error: 'Error al eliminar la forma de pago' });
    }
});

export default router;