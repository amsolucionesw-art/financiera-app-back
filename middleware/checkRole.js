// backend/src/middleware/checkRole.js

/**
 * Middleware de autorización por rol.
 * Uso:
 *   router.get('/compras', verifyToken, checkRole([0, 1]), handler)
 *   // 0 = superadmin, 1 = admin, 2 = cobrador
 */

const checkRole = (allowedRoles = []) => {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    // 1) Aseguramos autenticación previa
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: 'No autenticado (falta usuario en la request)' });
    }

    // 2) Normalizamos rol_id (acepta número o string numérico)
    const raw = req.user.rol_id;
    const rol =
      Number.isInteger(raw)
        ? raw
        : (typeof raw === 'string' && /^\d+$/.test(raw) ? parseInt(raw, 10) : null);

    if (rol === null) {
      return res
        .status(401)
        .json({ success: false, message: 'Token inválido (no contiene rol de usuario)' });
    }

    // 3) Validamos pertenencia si hay roles definidos
    if (roles.length > 0 && !roles.includes(rol)) {
      return res
        .status(403)
        .json({ success: false, message: 'Acceso denegado: rol no autorizado' });
    }

    // 4) OK
    return next();
  };
};

export default checkRole;
