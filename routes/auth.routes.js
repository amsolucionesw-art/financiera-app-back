import { Router } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { loginUsuario } from '../services/usuario.service.js';

dotenv.config(); // En producción normalmente el entorno ya está seteado; esto no molesta y ayuda en local.

const router = Router();

// POST /auth/login
router.post('/login', async (req, res) => {
  const nombre_usuario = typeof req.body?.nombre_usuario === 'string' ? req.body.nombre_usuario.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!nombre_usuario || !password) {
    return res.status(400).json({ success: false, message: 'Faltan credenciales' });
  }

  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    // Error de configuración (mejor explícito para staging/prod)
    return res.status(500).json({
      success: false,
      message: 'Configuración inválida: falta JWT_SECRET'
    });
  }

  const expiresIn = process.env.JWT_EXPIRES_IN || '8h';

  try {
    const usuario = await loginUsuario(nombre_usuario, password);

    if (!usuario) {
      return res.status(401).json({ success: false, message: 'Usuario o contraseña inválidos' });
    }

    const token = jwt.sign(
      {
        id: usuario.id,
        rol_id: usuario.rol_id
      },
      JWT_SECRET,
      { expiresIn }
    );

    return res.json({
      success: true,
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre_completo }
    });
  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

export default router;
