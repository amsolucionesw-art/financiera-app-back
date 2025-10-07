// backend/src/routes/caja.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    crearMovimiento,
    obtenerMovimientos,
    resumenDiario,
    resumenSemanal,   // ⬅️ nuevo
    resumenMensual,
    exportarExcel     // ⬅️ nuevo
} from '../services/caja.service.js';

const router = Router();

/**
 * Convención: montado en `${API_PREFIX}/caja`
 * Accesos:
 *  - Crear movimiento: admin o superadmin (roles 1 y 0)
 *  - Consultas: cualquier usuario autenticado
 *  - Exportación Excel: admin/superadmin (ajustable)
 */
router.post('/movimientos', verifyToken, checkRole([0, 1]), crearMovimiento);
router.get('/movimientos', verifyToken, obtenerMovimientos);

router.get('/resumen-diario', verifyToken, resumenDiario);
router.get('/resumen-semanal', verifyToken, resumenSemanal);   // ⬅️ nuevo
router.get('/resumen-mensual', verifyToken, resumenMensual);

// Export XLSX (4 hojas): restringido a admin/superadmin (podés abrirlo si querés)
router.get('/export-excel', verifyToken, checkRole([0, 1]), exportarExcel); // ⬅️ nuevo

export default router;
