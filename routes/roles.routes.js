import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import { obtenerRoles } from '../services/roles.service.js';

const router = Router();

// GET - Obtener todos los roles
router.get('/', verifyToken, async (req, res) => {
    try {
        const roles = await obtenerRoles();
        res.json({ success: true, data: roles });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error al obtener roles', error });
    }
});

export default router;
