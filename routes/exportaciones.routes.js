// backend/src/routes/exportaciones.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import { exportVentasYCompras } from '../services/exportaciones.service.js';

const router = Router();

/**
 * GET /exportaciones/ventas-gastos
 * Query soportada: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *                  ó ?anio=2025&mes=9
 * Requiere usuario autenticado (podés restringir a [0,1] si querés).
 */
router.get('/ventas-gastos', verifyToken, exportVentasYCompras);

export default router;
