import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    obtenerZonas,
    obtenerZonaPorId,
    crearZona,
    actualizarZona,
    eliminarZona
} from '../services/zona.service.js';
import Cliente from '../models/Cliente.js'; // para validación antes de eliminar

const router = Router();

// Helpers
const parseId = (raw) => {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const mapErrorToStatus = (err) => {
    const msg = String(err?.message ?? '').toLowerCase();
    if (msg.includes('obligatorio')) return 400;         // nombre vacío
    if (msg.includes('ya existe')) return 409;           // duplicado
    return 500;                                          // desconocido
};

// GET - Todas las zonas (solo superadmin/admin -> lectura)
router.get('/', verifyToken, checkRole([0, 1]), async (_req, res) => {
    try {
        const zonas = await obtenerZonas();
        res.json({ success: true, data: zonas });
    } catch (err) {
        console.error('[ZONAS][GET /]', err);
        res.status(500).json({ success: false, message: 'Error al obtener zonas' });
    }
});

// GET - Zona por ID (solo superadmin/admin -> lectura)
router.get('/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ success: false, message: 'ID inválido' });
        }

        const zona = await obtenerZonaPorId(id);
        if (!zona) {
            return res.status(404).json({ success: false, message: 'Zona no encontrada' });
        }

        res.json({ success: true, data: zona });
    } catch (err) {
        console.error('[ZONAS][GET /:id]', err);
        res.status(500).json({ success: false, message: 'Error al obtener zona' });
    }
});

// POST - Crear zona (solo superadmin)
router.post('/', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const id = await crearZona(req.body);
        res.status(201).json({ success: true, message: 'Zona creada exitosamente', data: { id } });
    } catch (err) {
        console.error('[ZONAS][POST /]', err);
        const status = mapErrorToStatus(err);
        res.status(status).json({ success: false, message: err?.message || 'Error al crear zona' });
    }
});

// PUT - Actualizar zona (solo superadmin)
router.put('/:id', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ success: false, message: 'ID inválido' });
        }

        // Verifico existencia para responder 404 en lugar de actualizar ciegamente
        const zona = await obtenerZonaPorId(id);
        if (!zona) {
            return res.status(404).json({ success: false, message: 'Zona no encontrada' });
        }

        await actualizarZona(id, req.body);
        res.json({ success: true, message: 'Zona actualizada exitosamente' });
    } catch (err) {
        console.error('[ZONAS][PUT /:id]', err);
        const status = mapErrorToStatus(err);
        res.status(status).json({ success: false, message: err?.message || 'Error al actualizar zona' });
    }
});

// DELETE - Eliminar zona (solo si no tiene clientes) (solo superadmin)
router.delete('/:id', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ success: false, message: 'ID inválido' });
        }

        const existeCliente = await Cliente.findOne({ where: { zona: id } });
        if (existeCliente) {
            return res.status(400).json({
                success: false,
                message: 'No se puede eliminar la zona porque está asignada a clientes'
            });
        }

        const deleted = await eliminarZona(id);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Zona no encontrada' });
        }

        res.json({ success: true, message: 'Zona eliminada exitosamente' });
    } catch (err) {
        console.error('[ZONAS][DELETE /:id]', err);
        res.status(500).json({ success: false, message: 'Error al eliminar zona' });
    }
});

export default router;