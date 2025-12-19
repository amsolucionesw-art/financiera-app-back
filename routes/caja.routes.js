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
    exportarExcel,    // ⬅️ nuevo
    exportarMovimientosExcel, // ✅ Export historial de movimientos
} from '../services/caja.service.js';

const router = Router();

/**
 * Convención: montado en `${API_PREFIX}/caja`
 * Accesos:
 *  - Crear movimiento: admin o superadmin (roles 1 y 0)
 *  - Consultas: cualquier usuario autenticado
 *  - Exportación Excel (4 hojas): admin/superadmin (ajustable)
 *  - Exportación Excel (historial movimientos): cualquier usuario autenticado (solo lectura)
 */
router.post('/movimientos', verifyToken, checkRole([0, 1]), crearMovimiento);
router.get('/movimientos', verifyToken, obtenerMovimientos);

router.get('/resumen-diario', verifyToken, resumenDiario);
router.get('/resumen-semanal', verifyToken, resumenSemanal);
router.get('/resumen-mensual', verifyToken, resumenMensual);

// Export XLSX (4 hojas): restringido a admin/superadmin
router.get('/export-excel', verifyToken, checkRole([0, 1]), exportarExcel);

// ✅ Export XLSX del HISTORIAL (misma data que /movimientos con sus filtros)
// - Mantengo la ruta actual por compatibilidad
router.get(
    '/movimientos/export-excel',
    verifyToken,
    exportarMovimientosExcel
);

// - Alias “más estándar” por si el front lo prefiere
router.get(
    '/movimientos/export/excel',
    verifyToken,
    exportarMovimientosExcel
);

export default router;
