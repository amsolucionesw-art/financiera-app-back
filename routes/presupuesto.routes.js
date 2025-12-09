// src/routes/presupuesto.routes.js

import { Router } from 'express';
import {
    crearPresupuesto,
    obtenerPresupuestos,
    buscarPresupuestos,
    obtenerPresupuestoPorNumero
} from '../services/presupuesto.service.js';

const router = Router();

/* ───────── Helpers ───────── */

const normalizarModalidad = (raw) => {
    if (!raw) return null;
    const v = String(raw).trim().toLowerCase();
    if (v === 'libre' || v === 'comun' || v === 'progresivo') {
        return v;
    }
    return null;
};

const hoyISO = () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

/* ───────── Rutas ───────── */

// POST /presupuestos
router.post('/', async (req, res) => {
    try {
        const {
            numero,
            nombre_destinatario,
            fecha_creacion,
            monto_financiado,
            cantidad_cuotas,
            interes,
            valor_por_cuota,
            total_a_pagar,
            tipo_credito,
            modalidad_credito,
            emitido_por
        } = req.body;

        // Payload limpio y preparado para soportar planes y emisor
        const data = {
            numero,
            nombre_destinatario,
            fecha_creacion: fecha_creacion || hoyISO(),
            monto_financiado,
            cantidad_cuotas,
            interes,
            valor_por_cuota,
            total_a_pagar,
            tipo_credito,
            modalidad_credito: normalizarModalidad(modalidad_credito),
            emitido_por: emitido_por || null
        };

        const nuevo = await crearPresupuesto(data);
        res.status(201).json(nuevo);
    } catch (err) {
        console.error('Error al crear presupuesto:', err);
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
        const lista =
            id || nombre_destinatario
                ? await buscarPresupuestos(filtros)
                : await obtenerPresupuestos();
        res.json(lista);
    } catch (err) {
        console.error('Error al obtener presupuestos:', err);
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
        console.error('Error al obtener presupuesto por número:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;