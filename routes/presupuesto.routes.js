// src/routes/presupuesto.routes.js

import { Router } from 'express';
import {
    crearPresupuesto,
    obtenerPresupuestos,
    buscarPresupuestos,
    obtenerPresupuestoPorNumero
} from '../services/presupuesto.service.js';

const router = Router();

// POST /presupuestos
router.post('/', async (req, res) => {
    try {
        const nuevo = await crearPresupuesto(req.body);
        res.status(201).json(nuevo);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /presupuestos
// Opcionales: ?id=5&nombre_destinatario=Juan
router.get('/', async (req, res) => {
    try {
        const { id, nombre_destinatario } = req.query;
        const filtros = {};
        if (id) filtros.id = id;
        if (nombre_destinatario) filtros.nombre_destinatario = nombre_destinatario;
        const lista = (id || nombre_destinatario)
            ? await buscarPresupuestos(filtros)
            : await obtenerPresupuestos();
        res.json(lista);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /presupuestos/:numero
router.get('/:numero', async (req, res) => {
    try {
        const { numero } = req.params;
        const presupuesto = await obtenerPresupuestoPorNumero(numero);
        if (!presupuesto) {
            return res.status(404).json({ error: 'Presupuesto no encontrado' });
        }
        res.json(presupuesto);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

