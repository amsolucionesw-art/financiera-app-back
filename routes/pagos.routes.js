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

/* ──────────────────────────────────────────────────────────────
 * Helpers para reglas de descuento por rol
 * ────────────────────────────────────────────────────────────── */
const sanitizeNumber = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return 0;
    // admite "1.234,56" / "1234,56" / "1234.56"
    const normalized = trimmed.replace(/\./g, '').replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Admin (rol 1): SOLO descuento sobre mora.
 * - Si llega "descuento" (legacy) u otros campos, lo mapeamos a "descuento_mora"
 * - Forzamos descuento_scope='mora'
 * - Eliminamos "descuento" para que NO viaje al service como campo legacy
 *
 * Nota:
 * - La validación/blindaje final de “solo mora” se sostiene en cuota.service.js
 *   (ahí el descuento se aplica únicamente sobre la mora).
 * - En créditos LIBRE puede existir mora si está vencido por fecha_compromiso_pago.
 */
const enforceAdminDiscountOnlyMora = (req, res, next) => {
  try {
    const rol_id = req.user?.rol_id ?? req.user?.rol ?? null;
    if (Number(rol_id) !== 1) return next();

    const body = req.body ?? {};

    // Prioridad: descuento_mora explícito > descuentoMora > descuento (legacy)
    const descuentoMoraRaw =
      body.descuento_mora !== undefined && body.descuento_mora !== null
        ? body.descuento_mora
        : (body.descuentoMora !== undefined && body.descuentoMora !== null
          ? body.descuentoMora
          : body.descuento);

    const dm = sanitizeNumber(descuentoMoraRaw);

    req.body = {
      ...body,
      descuento_scope: 'mora',
      descuento_mora: dm
    };

    // Limpieza: que no viaje "descuento" legacy
    if ('descuento' in req.body) delete req.body.descuento;
    if ('descuentoMora' in req.body) delete req.body.descuentoMora;

    return next();
  } catch (e) {
    console.error('[PAGOS][enforceAdminDiscountOnlyMora]', e);
    return res.status(500).json({ success: false, message: 'Error validando permisos de descuento' });
  }
};

/**
 * Pago parcial de una cuota
 *
 * 🔒 Impactar pagos: solo Superadmin (0) y Admin (1)
 * 🔒 Admin: descuento SOLO sobre mora
 */
router.post(
  '/',
  verifyToken,
  checkRole([0, 1]),
  enforceAdminDiscountOnlyMora,
  registrarPago
);

/**
 * Pago total / liquidación
 *
 * 🔒 Impactar pagos: solo Superadmin (0) y Admin (1)
 * 🔒 Admin: descuento SOLO sobre mora (en cualquier modalidad; si no hay mora, no tiene efecto)
 */
router.post(
  '/total',
  verifyToken,
  checkRole([0, 1]),
  enforceAdminDiscountOnlyMora,
  registrarPagoTotal
);

/**
 * Historial de pagos de una cuota
 * (lectura: superadmin/admin/cobrador)
 */
router.get('/cuota/:cuotaId', verifyToken, checkRole([0, 1, 2]), obtenerPagosPorCuota);

export default router;