// backend/src/routes/gastos.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    crearGasto,
    listarGastos,
    obtenerGasto,
    actualizarGasto,
    eliminarGasto
} from '../services/gastos.service.js';

const router = Router();

/**
 * Lectura: autenticado
 * Altas/Ediciones/Bajas: admin/superadmin (roles [0,1])
 */
router.get('/', verifyToken, listarGastos);
router.get('/:id', verifyToken, obtenerGasto);
router.post('/', verifyToken, checkRole([0, 1]), crearGasto);
router.put('/:id', verifyToken, checkRole([0, 1]), actualizarGasto);
router.delete('/:id', verifyToken, checkRole([0, 1]), eliminarGasto);

export default router;
