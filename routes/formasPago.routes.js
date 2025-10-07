import { Router } from 'express';
import {
    obtenerFormasPago,
    obtenerFormaPagoPorId,
    crearFormaPago,
    actualizarFormaPago,
    eliminarFormaPago
} from '../services/formaPago.service.js';

const router = Router();

// GET todas las formas de pago
router.get('/', async (req, res) => {
    const formas = await obtenerFormasPago();
    res.json(formas);
});

// GET forma de pago por ID
router.get('/:id', async (req, res) => {
    const forma = await obtenerFormaPagoPorId(req.params.id);
    if (!forma) return res.status(404).json({ error: 'Forma de pago no encontrada' });
    res.json(forma);
});

// POST nueva forma de pago
router.post('/', async (req, res) => {
    const nueva = await crearFormaPago(req.body);
    res.status(201).json(nueva);
});

// PUT actualizar forma de pago
router.put('/:id', async (req, res) => {
    const actualizada = await actualizarFormaPago(req.params.id, req.body);
    if (!actualizada) return res.status(404).json({ error: 'Forma de pago no encontrada' });
    res.json(actualizada);
});

// DELETE eliminar forma de pago
router.delete('/:id', async (req, res) => {
    await eliminarFormaPago(req.params.id);
    res.json({ mensaje: 'Forma de pago eliminada correctamente' });
});

export default router;
