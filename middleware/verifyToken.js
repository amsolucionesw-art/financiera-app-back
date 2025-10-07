// backend/src/middleware/verifyToken.js

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

export default function verifyToken(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token requerido' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // ID de usuario (numérico)
        const rawId =
            decoded?.id ??
            decoded?.userId ??
            decoded?.user_id ??
            decoded?.uid ??
            decoded?.sub;

        let id = null;
        if (Number.isInteger(rawId)) {
            id = rawId;
        } else if (typeof rawId === 'string' && /^\d+$/.test(rawId)) {
            id = parseInt(rawId, 10);
        }

        if (!id) {
            return res.status(401).json({
                success: false,
                message: 'Token inválido (no contiene id de usuario)'
            });
        }

        // Rol (normalizado a entero)
        const rawRol =
            decoded?.rol_id ??
            decoded?.role_id ??
            decoded?.roleId ??
            decoded?.rolId ??
            null;

        let rol_id = null;
        if (Number.isInteger(rawRol)) {
            rol_id = rawRol;
        } else if (typeof rawRol === 'string' && /^\d+$/.test(rawRol)) {
            rol_id = parseInt(rawRol, 10);
        }

        req.user = { id, rol_id };
        return next();
    } catch (_err) {
        return res.status(401).json({ success: false, message: 'Token inválido' });
    }
}

