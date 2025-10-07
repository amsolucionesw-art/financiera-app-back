// backend/src/routes/compras.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
  crearCompra,
  listarCompras,
  obtenerCompra,
  actualizarCompra,
  eliminarCompra
} from '../services/compras.service.js';

const router = Router();

/**
 * Ajustá roles si querés restringir creación/edición a admin/superadmin:
 * - Lectura: cualquier autenticado
 * - Altas/Bajas/Edición: roles [0,1]
 */
router.get('/', verifyToken, listarCompras);
router.get('/:id', verifyToken, obtenerCompra);
router.post('/', verifyToken, checkRole([0,1]), crearCompra);
router.put('/:id', verifyToken, checkRole([0,1]), actualizarCompra);
router.delete('/:id', verifyToken, checkRole([0,1]), eliminarCompra);

export default router;
