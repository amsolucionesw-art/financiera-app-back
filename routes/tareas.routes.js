import { Router } from 'express';

import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';

import { crearTareaTest } from '../services/tareas.service.js';
import { aprobarTarea } from '../services/tareas.service.js';
import { rechazarTarea } from '../services/tareas.service.js';
import { obtenerTareas } from '../services/tareas.service.js';
import { solicitarAnulacionCredito } from '../services/credito.service.js';

const router = Router();

router.post('/test', async (req, res) => {
    try {
        const tarea = await crearTareaTest();

        // Respuesta normal
        res.status(201).json({
            success: true,
            data: tarea
        });

    } catch (err) {
        console.error('[ERROR en /tareas/test]', err);

        // Si es un error con .status (como ValidationError), usamos ese status
        const status = err.status || 500;

        res.status(status).json({
            success: false,
            message: err.message || 'Error inesperado'
        });
    }
});

router.post(
    '/',
    verifyToken,
    checkRole([1]),
    async (req, res) => {
        try {
            const { tipo, datos } = req.body;

            if (tipo !== 'anular_credito') {
                return res.status(400).json({ success: false, message: 'Tipo de tarea no válido' });
            }

            const { creditoId, motivo } = datos;

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

router.patch('/:id/aprobar', verifyToken, checkRole([0]), async (req, res) => {
    const tarea = await aprobarTarea(req.params.id, req.user.id);
    res.json({ success: true, data: tarea });
});

router.patch('/:id/rechazar', verifyToken, checkRole([0]), async (req, res) => {
    const tarea = await rechazarTarea(req.params.id, req.user.id);
    res.json({ success: true, data: tarea });
});

router.get('/', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const estado = req.query.estado; // puede ser 'pendiente', 'aprobada', 'rechazada'
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

