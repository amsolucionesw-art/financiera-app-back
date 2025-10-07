// backend/src/routes/informe.routes.js

import { Router } from 'express';
import { obtenerInforme } from '../controllers/informe.controller.js';

const router = Router();

/**
 * Endpoint único para todos los informes:
 *   GET /informes?tipo=clientes|creditos|cuotas&...filtros
 *
 * Filtros comunes soportados por el service (según tipo):
 * - desde, hasta (YYYY-MM-DD)
 * - cobradorId, clienteId, zonaId
 * - estadoCredito, estadoCuota, modalidad
 * - formaPagoId
 * - conCreditosPendientes (true|false)
 * - hoy (true para cuotas con vencimiento hoy si tu buildFilters lo soporta)
 * - q (búsqueda libre por cliente)
 */
router.get('/', obtenerInforme);

export default router;
