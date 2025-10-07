// routes/pagos.routes.js
import express from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
  registrarPago,
  registrarPagoTotal,
  obtenerPagosPorCuota
} from '../services/pago.service.js';

const router = express.Router();

/**
 * Pago parcial de una cuota
 * - En "libre": primero interés del/los ciclo/s transcurridos, luego capital.
 * - En común/progresivo: primero mora, luego principal (acepta descuento sobre principal como MONTO).
 */
router.post('/', verifyToken, checkRole([0, 1, 2]), registrarPago);

/**
 * Pago total / liquidación
 * - En "libre": liquida interés de ciclo(s) + capital; admite descuento (%) sobre el total.
 * - En común/progresivo: paga cuota completa (mora + principal con descuento MONTO opcional).
 */
router.post('/total', verifyToken, checkRole([0, 1]), registrarPagoTotal);

/**
 * Historial de pagos de una cuota
 */
router.get('/cuota/:cuotaId', verifyToken, checkRole([0, 1, 2]), obtenerPagosPorCuota);

export default router;