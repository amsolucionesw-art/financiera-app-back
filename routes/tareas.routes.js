import { Router } from 'express';

import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';

import { crearTareaTest } from '../services/tareas.service.js';
import { aprobarTarea } from '../services/tareas.service.js';
import { rechazarTarea } from '../services/tareas.service.js';
import { obtenerTareas } from '../services/tareas.service.js';
import { solicitarAnulacionCredito } from '../services/credito.service.js';

const router = Router();

/**
 * TEST: crea una tarea de prueba
 */
router.post('/test', async (req, res) => {
    try {
        const tarea = await crearTareaTest();

        res.status(201).json({
            success: true,
            data: tarea
        });
    } catch (err) {
        console.error('[ERROR en /tareas/test]', err);
        const status = err.status || 500;

        res.status(status).json({
            success: false,
            message: err.message || 'Error inesperado'
        });
    }
});

/**
 * CREAR TAREA (ruta canónica): actualmente solo soporta anular_credito
 * POST /tareas
 */
router.post(
    '/',
    verifyToken,
    checkRole([1]), // admin
    async (req, res) => {
        try {
            const { tipo, datos } = req.body;

            if (tipo !== 'anular_credito') {
                return res.status(400).json({ success: false, message: 'Tipo de tarea no válido' });
            }

            const { creditoId, motivo } = datos || {};

            const tarea = await solicitarAnulacionCredito({
                creditoId,
                motivo,
                userId: req.user.id
            });

            res.status(201).json({ success: true, data: tarea });
        } catch (err) {
            console.error('[ERROR en /tareas]', err);
            res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Error al solicitar anulación'
            });
        }
    }
);

/**
 * ALIAS COMPATIBLE CON EL FRONT ACTUAL:
 * El front hoy postea a /tareas/pendientes → damos soporte con la misma lógica.
 * POST /tareas/pendientes
 */
router.post(
    '/pendientes',
    verifyToken,
    checkRole([1]), // admin
    async (req, res) => {
        try {
            const { tipo, datos } = req.body;

            // Aceptamos explícitamente el tipo que hoy manda el front
            if (tipo !== 'anular_credito') {
                return res.status(400).json({ success: false, message: 'Tipo de tarea no válido' });
            }

            const { creditoId, motivo } = datos || {};

            const tarea = await solicitarAnulacionCredito({
                creditoId,
                motivo,
                userId: req.user.id
            });

            res.status(201).json({ success: true, data: tarea });
        } catch (err) {
            console.error('[ERROR en /tareas/pendientes]', err);
            res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Error al solicitar anulación (pendientes)'
            });
        }
    }
);

/**
 * APROBAR TAREA (solo superadmin)
 * PATCH /tareas/:id/aprobar
 */
router.patch('/:id/aprobar', verifyToken, checkRole([0]), async (req, res) => {
    const tarea = await aprobarTarea(req.params.id, req.user.id);
    res.json({ success: true, data: tarea });
});

/**
 * RECHAZAR TAREA (solo superadmin)
 * PATCH /tareas/:id/rechazar
 */
router.patch('/:id/rechazar', verifyToken, checkRole([0]), async (req, res) => {
    const tarea = await rechazarTarea(req.params.id, req.user.id);
    res.json({ success: true, data: tarea });
});

/**
 * LISTAR TAREAS (solo superadmin)
 * GET /tareas?estado=pendiente|aprobada|rechazada
 */
router.get('/', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const estado = req.query.estado; // 'pendiente', 'aprobada', 'rechazada'
        const tareas = await obtenerTareas({ estado });
        res.json({ success: true, data: tareas });
    } catch (err) {
        console.error('[ERROR al obtener tareas]', err);
        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Error al obtener tareas'
        });
    }
});

export default router;