// financiera-backend/auth/controller.js

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { loginUsuario } from '../services/usuario.service.js';

dotenv.config();

export const login = async (req, res) => {
  // Compatibilidad: algunos clientes envían "username", otros "nombre_usuario"
  const usernameRaw = req.body?.username ?? req.body?.nombre_usuario;
  const passwordRaw = req.body?.password;

  const nombre_usuario =
    typeof usernameRaw === 'string' ? usernameRaw.trim() : '';
  const password = typeof passwordRaw === 'string' ? passwordRaw : '';

  if (!nombre_usuario || !password) {
    return res.status(400).json({ message: 'Faltan credenciales' });
  }

  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    return res
      .status(500)
      .json({ message: 'Configuración inválida: falta JWT_SECRET' });
  }

  const expiresIn = process.env.JWT_EXPIRES_IN || '8h';

  try {
    const usuario = await loginUsuario(nombre_usuario, password);

    if (!usuario) {
      // Mantengo el estilo del controlador viejo
      return res
        .status(401)
        .json({ message: 'Usuario o contraseña inválidos' });
    }

    const token = jwt.sign(
      { id: usuario.id, rol_id: usuario.rol_id },
      JWT_SECRET,
      { expiresIn }
    );

    return res.json({ token });
  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ message: 'Error del servidor' });
  }
};