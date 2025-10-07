// backend/src/routes/proveedores.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    listarProveedores,
    obtenerProveedor,
    crearProveedor,
    actualizarProveedor,
    eliminarProveedor,
} from '../services/proveedor.service.js';

const router = Router();

/**
 * Política de acceso:
 * - Lectura: autenticado (cualquier rol: [0,1,2])
 * - Altas/Ediciones/Bajas: admin/superadmin (roles [0,1])
 */

router.get('/', verifyToken, checkRole([0, 1, 2]), listarProveedores);
router.get('/:id', verifyToken, checkRole([0, 1, 2]), obtenerProveedor);
router.post('/', verifyToken, checkRole([0, 1]), crearProveedor);
router.put('/:id', verifyToken, checkRole([0, 1]), actualizarProveedor);
router.delete('/:id', verifyToken, checkRole([0, 1]), eliminarProveedor);

export default router;
