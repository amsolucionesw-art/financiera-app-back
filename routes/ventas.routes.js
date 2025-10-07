// backend/src/routes/ventas.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
  crearVentaManual,
  listarVentasManuales,
  obtenerVentaManual,
  actualizarVentaManual,
  eliminarVentaManual
} from '../services/ventas.service.js';

const router = Router();

/**
 * Lectura: autenticado
 * Altas/Ediciones/Bajas: admin/superadmin (roles [0,1])
 *
 * Rutas principales:    /api/ventas/manuales
 * Alias de compat:      /api/ventas
 *
 * IMPORTANTE:
 * - Declarar SIEMPRE /manuales ANTES que las paramétricas /:id para que
 *   'manuales' no sea capturado como :id.
 */

/* ===== Rutas principales con /manuales ===== */
router.get('/manuales', verifyToken, listarVentasManuales);
router.get('/manuales/:id', verifyToken, obtenerVentaManual);
router.post('/manuales', verifyToken, checkRole([0, 1]), crearVentaManual);
router.put('/manuales/:id', verifyToken, checkRole([0, 1]), actualizarVentaManual);
router.delete('/manuales/:id', verifyToken, checkRole([0, 1]), eliminarVentaManual);

/* ===== Alias en raíz (/api/ventas) ===== */
router.get('/', verifyToken, listarVentasManuales);
router.get('/:id', verifyToken, obtenerVentaManual);
router.post('/', verifyToken, checkRole([0, 1]), crearVentaManual);
router.put('/:id', verifyToken, checkRole([0, 1]), actualizarVentaManual);
router.delete('/:id', verifyToken, checkRole([0, 1]), eliminarVentaManual);

export default router;